/*
 * preview.mjs — contact sheet of every palette x pattern, so the sprite can be
 * eyeballed without launching Electron.
 *
 *   node tools/preview.mjs [outfile] [scale]
 */
import { writeFileSync } from "node:fs";
import { S, rasterise, drawEyes, render, encodePNG, validate } from "./lib.mjs";

const out = process.argv[2] || "/tmp/cat-preview.png";
const scale = Number(process.argv[3] || 6);

console.log(`validated ${validate()} grids`);

const patternKeys = Object.keys(S.PATTERNS);
const paletteKeys = Object.keys(S.PALETTES);

const cells = [];
for (const pk of paletteKeys)
  for (const patk of patternKeys) {
    const slots = rasterise(S.SIT, S.PATTERNS[patk].mask);
    drawEyes(slots, { x: 0, y: 0 }, false);
    cells.push(render(slots, S.PALETTES[pk], scale));
  }

const cols = patternKeys.length;
const rows = paletteKeys.length;
const cw = S.W * scale + 8;
const chh = S.H * scale + 8;
const W = cols * cw;
const H = rows * chh;

const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  sheet[i * 4] = 24;
  sheet[i * 4 + 1] = 24;
  sheet[i * 4 + 2] = 28;
  sheet[i * 4 + 3] = 255;
}

cells.forEach((cell, i) => {
  const cx = (i % cols) * cw + 4;
  const cy = Math.floor(i / cols) * chh + 4;
  for (let y = 0; y < cell.h; y++)
    for (let x = 0; x < cell.w; x++) {
      const so = (y * cell.w + x) * 4;
      if (cell.buf[so + 3] === 0) continue;
      const dof = ((cy + y) * W + cx + x) * 4;
      sheet[dof] = cell.buf[so];
      sheet[dof + 1] = cell.buf[so + 1];
      sheet[dof + 2] = cell.buf[so + 2];
      sheet[dof + 3] = 255;
    }
});

writeFileSync(out, encodePNG(W, H, sheet));
console.log(`wrote ${out}  (${cols} patterns x ${rows} palettes)`);
