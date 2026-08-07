/*
 * make-icons.mjs — generate the app and tray icons from the sprite itself, so
 * the icon is always literally the cat rather than a drifting copy of it.
 *
 *   node tools/make-icons.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { S, rasterise, drawEyes, render, encodePNG, validate } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assets = join(__dirname, "../assets");
mkdirSync(assets, { recursive: true });

validate();

// The icon cat is a ginger tabby: at 32x32 the void palette is a black blob on
// a dark dock, and legibility beats matching the default settings.
const palette = S.PALETTES.ginger;
const mask = S.PATTERNS.tabby.mask;

function catPNG(scale) {
  const slots = rasterise(S.SIT, mask);
  drawEyes(slots, { x: 0, y: 0 }, false);
  const { w, h, buf } = render(slots, palette, scale);
  return { w, h, buf };
}

for (const [name, scale] of [
  ["icon.png", 16], // 512x512 for electron-builder
  ["tray.png", 1], // 32x32 for the system tray
  ["tray@2x.png", 2], // 64x64 for HiDPI trays
]) {
  const { w, h, buf } = catPNG(scale);
  writeFileSync(join(assets, name), encodePNG(w, h, buf));
  console.log(`wrote assets/${name}  ${w}x${h}`);
}
