/*
 * cat.js — turns slot grids into pixels.
 *
 * Pipeline per frame:
 *   cached slot grid (fur + pattern + generated outline)
 *     -> clone, paint eyes/mouth/overlays into the clone
 *     -> write 32x32 ImageData
 *     -> blit to the display canvas with nearest-neighbour scaling
 *
 * The clone-per-frame looks wasteful and isn't: it's 1024 array slots, and it
 * buys the freedom to draw anything into the grid at authoring resolution so
 * every added pixel lands exactly on the pixel lattice. Drawing eyes at display
 * resolution instead is what makes most pixel pets look subtly mushy.
 */
(function (root) {
  "use strict";

  const S = root.CatSprites;

  const PARTICLES = {
    heart: [".X.X.", "XXXXX", "XXXXX", ".XXX.", "..X.."],
    steam: [".XX.", "XXXX", "XXXX", ".XX."],
    z: ["XXXX", "...X", "..X.", ".X..", "XXXX"],
    spark: [".X.", "XXX", ".X."],
  };

  /*
   * A ball of yarn. `o` is the wrap thread crossing the ball, and the four
   * frames step those diagonals one pixel along, so cycling them slides the wrap
   * around the ball and it reads as rolling — forwards or backwards depending on
   * which way the cycle runs. Four is the whole period; a fifth frame would land
   * back on the first.
   *
   * The silhouette is a real circle rather than a square with the corners
   * knocked off. At 7px that difference is the whole difference between a ball
   * and a die, and a die does not look like it rolls, it looks like it tumbles.
   *
   * Denser wrap (a stripe every 3px, or a crisscross both ways) was tried and is
   * too busy at this size — the ball stops reading as round and starts reading
   * as a checkerboard.
   *
   * It is not in PARTICLES because particles are one flat colour, and a ball
   * whose wrap you cannot see turning does not look like it is rolling at all —
   * it looks like a dot sliding sideways.
   */
  const YARN = [
    ["..XXo..", ".XXoXX.", "XXoXXXo", "XoXXXoX", "oXXXoXX", ".XXoXX.", "..oXX.."],
    ["..XoX..", ".XoXXX.", "XoXXXoX", "oXXXoXX", "XXXoXXX", ".XoXXX.", "..XXX.."],
    ["..oXX..", ".oXXXo.", "oXXXoXX", "XXXoXXX", "XXoXXXo", ".oXXXo.", "..XXo.."],
    ["..XXX..", ".XXXoX.", "XXXoXXX", "XXoXXXo", "XoXXXoX", ".XXXoX.", "..XoX.."],
  ];

  const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];

  class CatRenderer {
    constructor() {
      this.paletteId = null;
      this.patternId = null;
      this.base = null; // slot grid incl. outline
      this.bbox = null; // opaque bounds in sprite coords
      this.buf = document.createElement("canvas");
      this.buf.width = S.W;
      this.buf.height = S.H;
      this.bctx = this.buf.getContext("2d", { willReadFrequently: true });
      this.img = this.bctx.createImageData(S.W, S.H);
    }

    setLook(paletteId, patternId) {
      if (paletteId === this.paletteId && patternId === this.patternId) return;
      this.paletteId = paletteId;
      this.patternId = patternId;
      this.base = this.buildSlots(patternId);
      this.bbox = this.opaqueBounds(this.base);
    }

    buildSlots(patternId) {
      const mask = (S.PATTERNS[patternId] || {}).mask;
      const g = [];
      for (let y = 0; y < S.H; y++) {
        const row = new Array(S.W);
        for (let x = 0; x < S.W; x++) {
          let ch = S.SIT[y][x];
          if (ch === "_") ch = "B"; // eye socket is fur until eyes are drawn
          // A mask recolours fur only. It never touches the nose and never
          // creates a pixel, so no pattern can deform the silhouette.
          if (mask && ch !== "." && ch !== "N") {
            const m = mask[y][x];
            if (m === "M" || m === "L") ch = m;
          }
          row[x] = ch;
        }
        g.push(row);
      }
      return this.addOutline(g);
    }

    // Dilate the alpha mask by one pixel. Authoring outlines by hand means
    // re-drawing them for every pose; generating them means every pose is
    // consistent for free.
    addOutline(g) {
      const out = g.map((r) => r.slice());
      for (let y = 0; y < S.H; y++) {
        for (let x = 0; x < S.W; x++) {
          if (g[y][x] !== ".") continue;
          let touches = false;
          for (let dy = -1; dy <= 1 && !touches; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const ny = y + dy;
              const nx = x + dx;
              if (ny < 0 || ny >= S.H || nx < 0 || nx >= S.W) continue;
              if (g[ny][nx] !== ".") {
                touches = true;
                break;
              }
            }
          }
          if (touches) out[y][x] = "O";
        }
      }
      return out;
    }

    opaqueBounds(g) {
      let x0 = S.W,
        y0 = S.H,
        x1 = 0,
        y1 = 0;
      for (let y = 0; y < S.H; y++)
        for (let x = 0; x < S.W; x++)
          if (g[y][x] !== ".") {
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
      return { x0, y0, x1, y1 };
    }

    colours(tint) {
      const p = S.PALETTES[this.paletteId] || S.PALETTES.void;
      const c = {
        B: p.B,
        M: p.M,
        O: p.O,
        L: S.BASE_SLOTS.L,
        N: S.BASE_SLOTS.N,
        E: "#ffffff",
        P: "#191919",
      };
      const out = {};
      for (const [k, v] of Object.entries(c)) {
        let rgb = hex(v);
        if (tint > 0 && k !== "O" && k !== "E" && k !== "P") {
          // Overheat: push fur toward hot red, leave eyes and outline alone so
          // the face stays readable at full blush.
          const t = Math.min(1, tint) * 0.75;
          rgb = [
            Math.round(rgb[0] + (235 - rgb[0]) * t),
            Math.round(rgb[1] + (70 - rgb[1]) * t),
            Math.round(rgb[2] + (70 - rgb[2]) * t),
          ];
        }
        out[k] = rgb;
      }
      return out;
    }

    /*
     * opts:
     *   eye     {x,y}   pupil offset in [-1,1]
     *   lids    0..1    0 open, 1 shut
     *   mouth   'neutral' | 'open' | 'smile'
     *   tint    0..1    overheat blush
     *   knead   0..1    paw phase
     */
    paintFace(g, opts) {
      const { eye = { x: 0, y: 0 }, lids = 0, mouth = "neutral" } = opts;

      for (const side of ["left", "right"]) {
        const e = S.EYES[side];
        for (let y = 0; y < e.h; y++)
          for (let x = 0; x < e.w; x++) g[e.y + y][e.x + x] = "E";

        if (lids >= 1) {
          for (let x = 0; x < e.w; x++) {
            g[e.y + 1][e.x + x] = "P";
            g[e.y + 2][e.x + x] = "P";
          }
          continue;
        }

        // A 3x3 pupil in the 5x4 socket. A smaller pupil left so much sclera
        // that the eye read as a white block rather than an eye; this keeps a
        // rim of white on every side the gaze isn't pointing at, which is the
        // part that actually communicates direction.
        const dx = Math.max(-1, Math.min(1, Math.round(eye.x)));
        const dy = Math.max(-1, Math.min(1, Math.round(eye.y)));
        const px = e.x + 1 + dx;
        const py = e.y + (dy > 0 ? 1 : 0);
        for (let y = 0; y < 3; y++)
          for (let x = 0; x < 3; x++) g[py + y][px + x] = "P";
        g[py][px] = "E"; // catchlight

        // Half-lidded: a lid bar creeping down from the top of the socket.
        if (lids > 0.35) {
          for (let x = 0; x < e.w; x++) g[e.y][e.x + x] = "P";
        }
      }

      if (mouth === "open") {
        for (let x = 14; x <= 17; x++) g[17][x] = "P";
        for (let x = 15; x <= 16; x++) g[18][x] = "P";
      } else if (mouth === "smile") {
        g[16][13] = "P";
        g[17][14] = "P";
        g[17][15] = "P";
        g[17][16] = "P";
        g[17][17] = "P";
        g[16][18] = "P";
      }
    }

    // Kneading paws: two little mitts alternating below the chest.
    paintKnead(g, phase) {
      const lift = phase < 0.5 ? [0, 2] : [2, 0];
      const xs = [9, 19];
      xs.forEach((x0, i) => {
        const y0 = 27 + lift[i];
        for (let y = 0; y < 3; y++)
          for (let x = 0; x < 4; x++) {
            const gy = y0 + y;
            const gx = x0 + x;
            if (gy >= S.H || gx >= S.W) continue;
            g[gy][gx] = y === 0 ? "O" : "L";
          }
      });
    }

    render(ctx, opts) {
      const {
        x, y, scale,
        squashX = 1, squashY = 1,
        tint = 0,
        knead = null,
      } = opts;

      const g = this.base.map((r) => r.slice());
      this.paintFace(g, opts);
      if (knead !== null) this.paintKnead(g, knead);

      const col = this.colours(tint);
      const d = this.img.data;
      for (let py = 0; py < S.H; py++) {
        for (let px = 0; px < S.W; px++) {
          const o = (py * S.W + px) * 4;
          const ch = g[py][px];
          if (ch === ".") {
            d[o + 3] = 0;
            continue;
          }
          const rgb = col[ch] || [255, 0, 255];
          d[o] = rgb[0];
          d[o + 1] = rgb[1];
          d[o + 2] = rgb[2];
          d[o + 3] = 255;
        }
      }
      this.bctx.putImageData(this.img, 0, 0);

      const w = S.W * scale * squashX;
      const h = S.H * scale * squashY;
      // Squash pivots on the feet, not the centre — a cat squashed about its
      // middle floats; squashed about its feet it presses into the desk.
      const dx = x + (S.W * scale - w) / 2;
      const dy = y + (S.H * scale - h);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.buf, dx, dy, w, h);

      const b = this.bbox;
      return {
        x: Math.round(dx + b.x0 * scale * squashX),
        y: Math.round(dy + b.y0 * scale * squashY),
        w: Math.round((b.x1 - b.x0 + 1) * scale * squashX),
        h: Math.round((b.y1 - b.y0 + 1) * scale * squashY),
      };
    }

    // Particles are drawn at display resolution but snapped to the pixel
    // lattice so they never sit on a half-pixel and blur.
    drawParticle(ctx, kind, cx, cy, scale, colour, alpha = 1) {
      const art = PARTICLES[kind];
      if (!art) return;
      const s = Math.max(1, Math.round(scale));
      const w = art[0].length * s;
      const h = art.length * s;
      const ox = Math.round(cx - w / 2);
      const oy = Math.round(cy - h / 2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      for (let y = 0; y < art.length; y++)
        for (let x = 0; x < art[y].length; x++)
          if (art[y][x] === "X") ctx.fillRect(ox + x * s, oy + y * s, s, s);
      ctx.globalAlpha = 1;
    }

    // `frame` may be any integer, including negative — the ball rolls both ways
    // and the caller should not have to think about which end of the cycle it is.
    drawYarn(ctx, cx, cy, scale, frame, colour, wrap, alpha = 1) {
      const art = YARN[((Math.round(frame) % YARN.length) + YARN.length) % YARN.length];
      const s = Math.max(1, Math.round(scale));
      const ox = Math.round(cx - (art[0].length * s) / 2);
      const oy = Math.round(cy - (art.length * s) / 2);
      ctx.globalAlpha = alpha;
      for (let y = 0; y < art.length; y++) {
        for (let x = 0; x < art[y].length; x++) {
          const c = art[y][x];
          if (c === ".") continue;
          ctx.fillStyle = c === "o" ? wrap : colour;
          ctx.fillRect(ox + x * s, oy + y * s, s, s);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  root.CatRenderer = CatRenderer;
})(window);
