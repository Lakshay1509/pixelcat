/*
 * make-icons.mjs — generate the app and tray icons from the sprite itself, so
 * the icon is always literally the cat rather than a drifting copy of it.
 *
 *   node tools/make-icons.mjs
 *
 * WHY THE ICON IS A HEAD AND NOT THE WHOLE CAT
 * The sprite is a cat sitting down: 32 rows, of which the face is about eight.
 * Shrink all 32 into a tray slot and the face lands on ~5 pixels, which is not
 * a face, it is a smudge — and the panel then scales that again to whatever
 * height it happens to be. Cropping to the head spends every pixel on the part
 * that identifies the app. The body reads as "some orange animal" at any size
 * an icon is actually displayed at; the eyes and ears read as a cat.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { S, rasterise, drawEyes, encodePNG, hex, validate } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = join(__dirname, "../assets");
mkdirSync(assets, { recursive: true });

validate();

/*
 * The head twice over, in sprite coordinates: FUR is the cat itself — ear tips
 * at row 2 down to the neck at row 20 — and HEAD is that plus the ring of
 * outline the dilation puts around it once everything else has been cropped
 * away. Stopping at the neck is deliberate: row 21 is where the tail pokes out
 * from behind the hip, and lifted away from the body it reads as a stray blob.
 */
const FUR = { x: 2, y: 2, w: 28, h: 19 };
const HEAD = { x: 1, y: 1, w: 30, h: 21 };

/*
 * Ginger, and solid rather than tabby. Neither matches the cat you get out of
 * the box, and both are deliberate: the default void palette is a black blob on
 * a dark dock, and the tabby's forehead M — three sprite pixels of marking — is
 * a face at 512 and a smudge of dirt at 22. An icon is only ever looked at
 * small. Legibility beats matching the settings screen.
 */
const GINGER = S.PALETTES.ginger;
const MASK = S.PATTERNS.solid.mask;

// --- canvas ----------------------------------------------------------------
const canvas = (w, h) => ({ w, h, buf: Buffer.alloc(w * h * 4, 0) });

function fill(c, x0, y0, w, h, colour, alpha = 255) {
  const [r, g, b] = hex(colour);
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= c.h) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= c.w) continue;
      const o = (y * c.w + x) * 4;
      c.buf[o] = r;
      c.buf[o + 1] = g;
      c.buf[o + 2] = b;
      c.buf[o + 3] = alpha;
    }
  }
}

/*
 * Blits a region of the sprite grid at `scale` device pixels per sprite pixel.
 * Every sprite pixel therefore lands on a whole number of device pixels, which
 * is the entire reason these icons stay crisp — one pass of bilinear resampling
 * anywhere in the chain and it stops being pixel art and starts being a smudge
 * of a smudge.
 */
function blit(c, slots, palette, scale, ox, oy, crop) {
  const colours = { ...S.BASE_SLOTS, ...palette, E: "#ffffff", P: "#191919" };
  for (let y = 0; y < crop.h; y++)
    for (let x = 0; x < crop.w; x++) {
      const ch = slots[crop.y + y][crop.x + x];
      if (ch === ".") continue;
      fill(c, ox + x * scale, oy + y * scale, scale, scale, colours[ch] || "#ff00ff");
    }
}

/*
 * A pixel-art rounded corner: a staircase, not a radius. The app's own chrome
 * refuses anti-aliased curves next to 1-bit pixel art (see pet.css) and an icon
 * that breaks that rule looks like it came from a different program. Cutting
 * the corner in `step`-sized blocks keeps the whole tile on one lattice.
 */
function stepCorners(c, step, steps) {
  for (let i = 0; i < steps; i++) {
    const cut = (steps - i) * step; // how much to remove from this band
    const y0 = i * step;
    for (const y of [y0, c.h - y0 - step]) {
      // clear leading and trailing pixels of the band
      for (let yy = y; yy < y + step; yy++) {
        if (yy < 0 || yy >= c.h) continue;
        for (let x = 0; x < cut; x++) {
          for (const xx of [x, c.w - 1 - x]) {
            const o = (yy * c.w + xx) * 4;
            c.buf[o + 3] = 0;
          }
        }
      }
    }
  }
}

function headSlots() {
  const slots = rasterise(S.SIT, MASK, FUR);
  drawEyes(slots, { x: 0, y: 0 }, false); // looking straight out of the icon
  return slots;
}

// --- app icon --------------------------------------------------------------
/*
 * 512x512 with the head at 14 device pixels per sprite pixel: 420 across, so
 * the cat owns 82% of the tile and still keeps a margin wide enough to survive
 * being masked into a circle or a squircle by whatever launcher shows it.
 *
 * On a plate, and a dark one, because an icon with no background is not an icon
 * — it is a sticker. It has to hold together on a light dock, a dark dock and a
 * grey installer dialog alike, and only its own background can promise that.
 * The outline is overridden to cream for the same reason: ginger's normal
 * near-black outline is invisible against a dark plate, and an outline that
 * cannot be seen is just a fur colour.
 */
function appIcon(size = 512) {
  const scale = 14;
  const c = canvas(size, size);
  fill(c, 0, 0, size, size, "#1b1720");
  stepCorners(c, scale, 3);
  const w = HEAD.w * scale;
  const h = HEAD.h * scale;
  blit(
    c,
    headSlots(),
    { ...GINGER, O: "#f4efe6" },
    scale,
    Math.round((size - w) / 2),
    // Optically centred rather than measured: the neck tapers away at the
    // bottom, so a head placed dead centre reads as sitting low in its tile.
    Math.round((size - h) / 2) - 4,
    HEAD
  );
  return c;
}

// --- tray icon -------------------------------------------------------------
/*
 * Panels are dark on one desktop and light on the next, and neither one is
 * something the app gets told about — so the tray cat keeps its own near-black
 * outline (which carries it on a light panel) and the fur underneath is a
 * mid-tone ginger bright enough to carry it on a dark one. The head is blitted
 * at 1:1 so nothing is resampled before the panel gets it.
 */
function trayIcon(scale) {
  const size = 32 * scale;
  const c = canvas(size, size);
  blit(
    c,
    headSlots(),
    GINGER,
    scale,
    Math.round((size - HEAD.w * scale) / 2),
    Math.round((size - HEAD.h * scale) / 2),
    HEAD
  );
  return c;
}

const write = (name, c) => {
  writeFileSync(join(assets, name), encodePNG(c.w, c.h, c.buf));
  console.log(`wrote assets/${name}  ${c.w}x${c.h}`);
};

write("icon.png", appIcon(512));
write("tray.png", trayIcon(1));
write("tray@2x.png", trayIcon(2));
