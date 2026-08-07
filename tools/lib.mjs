/*
 * lib.mjs — shared build-time rasteriser + a minimal PNG encoder.
 *
 * The app renders the cat in a canvas at runtime; this is the same pipeline for
 * Node, used to produce contact sheets and app icons from the exact same sprite
 * data, so an icon can never drift from the cat it depicts.
 */
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const src = readFileSync(join(__dirname, "../src/renderer/pet/sprites.js"), "utf8");
new Function(src)();
export const S = globalThis.CatSprites;

// --- PNG -------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

// --- sprite -> slots -------------------------------------------------------
export function rasterise(grid, mask) {
  const { W, H } = S;
  const slots = [];
  for (let y = 0; y < H; y++) {
    const row = new Array(W);
    for (let x = 0; x < W; x++) {
      let ch = grid[y][x];
      if (ch === "_") ch = "B";
      if (mask && ch !== "." && ch !== "N") {
        const m = mask[y][x];
        if (m === "M" || m === "L") ch = m;
      }
      row[x] = ch;
    }
    slots.push(row);
  }
  const out = slots.map((r) => r.slice());
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (slots[y][x] !== ".") continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          if (slots[ny][nx] !== ".") {
            touches = true;
            break;
          }
        }
      if (touches) out[y][x] = "O";
    }
  return out;
}

export function drawEyes(slots, dir = { x: 0, y: 0 }, blink = false) {
  for (const side of ["left", "right"]) {
    const e = S.EYES[side];
    for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) slots[e.y + y][e.x + x] = "E";
    if (blink) {
      for (let x = 0; x < e.w; x++) {
        slots[e.y + 1][e.x + x] = "P";
        slots[e.y + 2][e.x + x] = "P";
      }
      continue;
    }
    const dx = Math.max(-1, Math.min(1, Math.round(dir.x)));
    const dy = Math.max(-1, Math.min(1, Math.round(dir.y)));
    const px = e.x + 1 + dx;
    const py = e.y + (dy > 0 ? 1 : 0);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) slots[py + y][px + x] = "P";
    slots[py][px] = "E"; // catchlight
  }
}

export function render(slots, palette, scale) {
  const { W, H } = S;
  const colours = {
    ...S.BASE_SLOTS,
    B: palette.B,
    M: palette.M,
    O: palette.O,
    E: "#ffffff",
    P: "#191919",
  };
  const w = W * scale;
  const h = H * scale;
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ch = slots[y][x];
      if (ch === ".") continue;
      const [r, g, b] = hex(colours[ch] || "#ff00ff");
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
          const o = ((y * scale + sy) * w + (x * scale + sx)) * 4;
          buf[o] = r;
          buf[o + 1] = g;
          buf[o + 2] = b;
          buf[o + 3] = 255;
        }
    }
  return { w, h, buf };
}

export function validate() {
  const grids = [
    ["SIT", S.SIT],
    ...Object.entries(S.PATTERNS)
      .filter(([, p]) => p.mask)
      .map(([k, p]) => [k, p.mask]),
  ];
  for (const [name, grid] of grids) {
    if (grid.length !== S.H) throw new Error(`${name}: ${grid.length} rows, expected ${S.H}`);
    grid.forEach((r, i) => {
      if (r.length !== S.W)
        throw new Error(`${name} row ${i}: ${r.length} cols, expected ${S.W}`);
    });
  }
  return grids.length;
}
