/*
 * sprites.js — pixel data for the cat.
 *
 * Pixels are stored as PALETTE SLOTS, never as colours. A pixel knows it is
 * "fur" or "marking"; it does not know it is #2b2b2b. Recolouring the whole cat
 * is therefore a map swap, not a redraw.
 *
 * Outlines are NOT authored. The renderer dilates the alpha mask by 1px and
 * paints the halo, so every pose gets a consistent outline for free.
 *
 * Slots:
 *   .  transparent
 *   B  base fur
 *   M  marking / pattern colour
 *   L  light (belly, muzzle, paw tips)
 *   N  pink (inner ear, nose)
 *   _  eye socket — painted as fur, then eyes are drawn on top procedurally
 *
 * Grid is 32x32. Column ruler:
 *            0    5    10   15   20   25   30
 *            |    |    |    |    |    |    |
 */

(function (root) {
  "use strict";

  const W = 32;
  const H = 32;

  // ---------------------------------------------------------------------------
  // Base pose: a chonky cat, sitting, facing the viewer.
  // ---------------------------------------------------------------------------
  // Everything is mirrored about x=15.5, so mirror(x) === 31 - x. The eyes and
  // ears are placed on that axis deliberately; an off-axis eye reads as a
  // squint even when you can't consciously see why.
  const SIT = [
    "................................", // 0
    "................................", // 1
    ".....BB..................BB.....", // 2   ear tips
    "....BBBB................BBBB....", // 3
    "....BNNB................BNNB....", // 4   inner ear
    "...BBNNBB..............BBNNBB...", // 5
    "...BBNNBBBBBBBBBBBBBBBBBBNNBB...", // 6   ears merge into skull
    "...BBBBBBBBBBBBBBBBBBBBBBBBBB...", // 7
    "..BBBBBBBBBBBBBBBBBBBBBBBBBBBB..", // 8
    "..BBBBBBBBBBBBBBBBBBBBBBBBBBBB..", // 9
    "..BBB_____BBBBBBBBBBBB_____BBB..", // 10  eye sockets
    "..BBB_____BBBBBBBBBBBB_____BBB..", // 11
    "..BBB_____BBBBBBBBBBBB_____BBB..", // 12
    "..BBB_____BBBBBBBBBBBB_____BBB..", // 13
    "..BBBBBBBBBBBBBNNBBBBBBBBBBBBB..", // 14  nose
    "..BBBBBBBBBBBLLLLLLBBBBBBBBBBB..", // 15  muzzle
    "...BBBBBBBBBBBLLLLBBBBBBBBBBB...", // 16  muzzle tapers, else it's a slab
    "...BBBBBBBBBBBBBBBBBBBBBBBBBB...", // 17
    "....BBBBBBBBBBBBBBBBBBBBBBBB....", // 18
    "......BBBBBBBBBBBBBBBBBBBB......", // 19
    "........BBBBBBBBBBBBBBBB........", // 20  neck
    ".......BBBBBBBBBBBBBBBBBB..BBBB.", // 21  tail: 4px core at cols 27-30.
    "......BBBBBBBBBBBBBBBBBBB..BBBB.", // 22  3px was thinner than its own
    ".....BBBBBBBBLLLLLLBBBBBBB.BBBB.", // 23  outline, so on a dark cat it read
    ".....BBBBBBBLLLLLLLLBBBBBB.BBBB.", // 24  as a white sparkle, not a tail.
    ".....BBBBBBBLLLLLLLLBBBBBB.BBBB.", // 25  A 1px gap keeps it legible until
    ".....BBBBBBBBLLLLLLBBBBBBBBBBBB.", // 26  it joins the hip here.
    ".....BBBBBBBBBBBBBBBBBBBBBBBB...", // 27
    ".....BBBBBBBBBBBBBBBBBBBBBB.....", // 28
    ".....BLLLLBBBBBBBBBBBBLLLLB.....", // 29  front paws
    "....LLLLLBBBBBBBBBBBBBLLLLL.....", // 30
    "................................", // 31
  ];

  // ---------------------------------------------------------------------------
  // Pattern masks. 'M' repaints a fur pixel in the marking colour, 'L' repaints
  // it light. Masks only ever RECOLOUR existing fur — they cannot add a pixel,
  // so no pattern can deform the silhouette or leak outside the outline.
  //
  // Tuxedo uses 'L' rather than 'M': a tuxedo bib is white on a dark cat, so
  // painting it with the marking colour gets the cat exactly backwards.
  // ---------------------------------------------------------------------------

  // Forehead 'M', cheek bars, flank bars, ringed tail.
  const TABBY = [
    "................................", // 0
    "................................", // 1
    "................................", // 2
    "................................", // 3
    "................................", // 4
    "................................", // 5
    "................................", // 6
    "..........MMM......MMM..........", // 7
    ".........MMMMM....MMMMM.........", // 8
    "...........MMMMMMMMMM...........", // 9
    "..MMM......................MMM..", // 10
    "................................", // 11
    "..MMM......................MMM..", // 12
    "................................", // 13
    "................................", // 14
    "................................", // 15
    "................................", // 16
    "................................", // 17
    "................................", // 18
    "................................", // 19
    "................................", // 20
    "...........................MMMM.", // 21  tail ring
    ".......MMMMM........MMMMM.......", // 22  flank bars
    "...........................MMMM.", // 23  tail ring
    "......MMMMM..........MMMMM......", // 24
    "................................", // 25
    "......MMMMM..........MMMMM......", // 26
    "................................", // 27
    ".......MMMMM........MMMMM.......", // 28
    "................................", // 29
    "................................", // 30
    "................................", // 31
  ];

  // 'L' — white bib flaring from the chin down over the chest.
  const TUXEDO = [
    "................................", // 0
    "................................", // 1
    "................................", // 2
    "................................", // 3
    "................................", // 4
    "................................", // 5
    "................................", // 6
    "................................", // 7
    "................................", // 8
    "..............LLLL..............", // 9   forehead blaze
    "................................", // 10
    "................................", // 11
    "................................", // 12
    "................................", // 13
    "................................", // 14
    "................................", // 15
    "................................", // 16
    "..............LLLL..............", // 17
    ".............LLLLLL.............", // 18
    "............LLLLLLLL............", // 19
    "............LLLLLLLL............", // 20
    "...........LLLLLLLLLL...........", // 21
    "...........LLLLLLLLLL...........", // 22
    "...........LLLLLLLLLL...........", // 23
    "..........LLLLLLLLLLLL..........", // 24
    "..........LLLLLLLLLLLL..........", // 25
    "...........LLLLLLLLLL...........", // 26
    "............LLLLLLLL............", // 27
    ".............LLLLLL.............", // 28
    "................................", // 29
    "................................", // 30
    "................................", // 31
  ];

  // Deliberately asymmetric — a symmetrical calico looks like a printing error.
  const CALICO = [
    "................................", // 0
    "................................", // 1
    "................................", // 2
    "....MMMM........................", // 3
    "....MMMM........................", // 4
    "...MMMMMM.......................", // 5
    "...MMMMMM.......................", // 6
    "...MMMMMMM.............MMMMM....", // 7
    "..MMMMMMM..............MMMMMM...", // 8
    "..MMMMMM...............MMMMMM...", // 9
    "..MMM.....................MMMM..", // 10
    "..........................MMMM..", // 11
    "..........................MMM...", // 12
    "................................", // 13
    "................................", // 14
    "................................", // 15
    "................................", // 16
    "................................", // 17
    "................................", // 18
    "................................", // 19
    "................................", // 20
    "...........................MMMM.", // 21  tail patch
    "...........................MMMM.", // 22
    "................................", // 23
    ".....MMMMM......................", // 24
    ".....MMMMM......................", // 25
    ".....MMMMM......................", // 26
    ".....MMMMMM.....................", // 27
    "................................", // 28
    "................................", // 29
    "................................", // 30
    "................................", // 31
  ];

  // Colourpoint: dark extremities, pale core.
  const SIAMESE = [
    "................................", // 0
    "................................", // 1
    ".....MM..................MM.....", // 2
    "....MMMM................MMMM....", // 3
    "....MMMM................MMMM....", // 4
    "...MMMMMM..............MMMMMM...", // 5
    "...MMMMMM..............MMMMMM...", // 6
    "................................", // 7
    "................................", // 8
    "................................", // 9
    "................................", // 10
    "................................", // 11
    "................................", // 12
    "................................", // 13
    ".............MMMMMM.............", // 14  mask
    "............MMMMMMMM............", // 15
    "............MMMMMMMM............", // 16
    ".............MMMMMM.............", // 17
    "................................", // 18
    "................................", // 19
    "................................", // 20
    "...........................MMMM.", // 21  tail point
    "...........................MMMM.", // 22
    "...........................MMMM.", // 23
    "................................", // 24
    "................................", // 25
    "................................", // 26
    "................................", // 27
    "................................", // 28
    ".....MMMMM............MMMMM.....", // 29  socks
    "....MMMMM..............MMMMM....", // 30
    "................................", // 31
  ];

  const PATTERNS = {
    solid: { label: "Solid", mask: null },
    tabby: { label: "Tabby", mask: TABBY },
    tuxedo: { label: "Tuxedo", mask: TUXEDO },
    calico: { label: "Calico", mask: CALICO },
    siamese: { label: "Siamese", mask: SIAMESE },
  };

  // ---------------------------------------------------------------------------
  // Palettes. `B` is the fur, `M` the marking. Everything else stays put so the
  // cat keeps reading as a cat no matter how lurid the fur gets.
  // ---------------------------------------------------------------------------
  const BASE_SLOTS = {
    L: "#f4efe6", // belly / muzzle / paw tips
    N: "#f2a0a8", // nose + inner ear
    O: "#ffffff", // generated outline
  };

  const PALETTES = {
    void: { label: "Void", B: "#26262b", M: "#3a3a42", O: "#ffffff" },
    ginger: { label: "Ginger", B: "#e08a3c", M: "#b5641f", O: "#2a2118" },
    grey: { label: "Grey", B: "#8d8d96", M: "#6a6a73", O: "#221f24" },
    cream: { label: "Cream", B: "#e8d5b5", M: "#c4a67d", O: "#2a2118" },
    snow: { label: "Snow", B: "#f2f0ea", M: "#cfcac0", O: "#2a2a2e" },
    mint: { label: "Mint", B: "#8fd6c0", M: "#5fae97", O: "#1d2a26" },
    sakura: { label: "Sakura", B: "#f0b8cc", M: "#d1859f", O: "#2c1d24" },
    cobalt: { label: "Cobalt", B: "#6f8ee0", M: "#4a66b8", O: "#181d2e" },
  };

  // ---------------------------------------------------------------------------
  // Eyes are drawn procedurally rather than baked into frames — eye-follow needs
  // sub-pixel control over the pupil, and blink/sleep/overheat are then just
  // different draws at the same anchor instead of N more 32x32 grids.
  // ---------------------------------------------------------------------------
  const EYES = {
    left: { x: 5, y: 10, w: 5, h: 4 },
    right: { x: 22, y: 10, w: 5, h: 4 },
  };

  // Anchors used by behaviours and overlays, in sprite-grid coordinates.
  const ANCHORS = {
    head: { x: 15.5, y: 11 }, // petting hit region centre
    headTop: { x: 15.5, y: 5 }, // where steam / zzz / bubbles spawn
    nose: { x: 15.5, y: 14.5 },
    paws: { x: 15.5, y: 30 }, // where kneading paws are drawn
  };

  root.CatSprites = {
    W,
    H,
    SIT,
    PATTERNS,
    PALETTES,
    BASE_SLOTS,
    EYES,
    ANCHORS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) {
  module.exports = globalThis.CatSprites;
}
