/*
 * cursor-probe.js — is screen.getCursorScreenPoint() actually usable here?
 *
 *   npx electron tools/cursor-probe.js
 *
 * The whole Wayland input design rests on the claim that the native cursor
 * point is frozen and useless, so evdev deltas must drive everything. That is
 * true on some compositors and not others, and getting it wrong is expensive in
 * both directions: trust a frozen point and the cat hit-tests against a stale
 * coordinate and becomes unclickable; ignore a working one and we dead-reckon
 * badly for no reason.
 *
 * So: sample the native point and the raw evdev deltas side by side while the
 * pointer is moved around, and compare how far each thinks it travelled.
 */
const { app, screen } = require("electron");
const { EvdevReader } = require("../src/main/evdev-linux.js");

const SECONDS = Number(process.argv[2]) || 20;

const box = (name) => ({
  name,
  x0: Infinity,
  y0: Infinity,
  x1: -Infinity,
  y1: -Infinity,
  n: 0,
  add(x, y) {
    this.x0 = Math.min(this.x0, x);
    this.y0 = Math.min(this.y0, y);
    this.x1 = Math.max(this.x1, x);
    this.y1 = Math.max(this.y1, y);
    this.n++;
  },
  get w() {
    return Number.isFinite(this.x0) ? Math.round(this.x1 - this.x0) : 0;
  },
  get h() {
    return Number.isFinite(this.y0) ? Math.round(this.y1 - this.y0) : 0;
  },
});

const nativeBox = box("native");
const evdevBox = box("evdev");

app.whenReady().then(() => {
  const virt = { x: 0, y: 0 };
  let relEvents = 0;
  let distinctNative = 0;
  let lastNative = null;

  const reader = new EvdevReader({
    onKey() {},
    onWheel() {},
    onButton() {},
    onMove(dx, dy) {
      relEvents++;
      virt.x += dx;
      virt.y += dy;
      evdevBox.add(virt.x, virt.y);
    },
  });
  const ok = reader.start();
  console.log(
    `evdev: ${ok ? `${reader.devices.length} devices, relative-capable: ${reader.hasRelDevice}` : "UNAVAILABLE"}`
  );
  console.log(`\nMove the pointer in a big circle around the WHOLE screen for ${SECONDS}s.\n`);

  setInterval(() => reader.drain(), 16);

  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (!lastNative || p.x !== lastNative.x || p.y !== lastNative.y) distinctNative++;
    lastNative = p;
    nativeBox.add(p.x, p.y);
  }, 25);

  let left = SECONDS;
  const tick = setInterval(() => {
    process.stdout.write(
      `  ${--left}s  native=(${lastNative.x},${lastNative.y}) spread ${nativeBox.w}x${nativeBox.h}` +
        `   evdev spread ${evdevBox.w}x${evdevBox.h} (${relEvents} events)\n`
    );
    if (left > 0) return;
    clearInterval(tick);

    const { width, height } = screen.getPrimaryDisplay().bounds;
    console.log("\n===== RESULT =====");
    console.log(`screen              : ${width}x${height}`);
    console.log(`native point spread : ${nativeBox.w}x${nativeBox.h}  (${distinctNative} distinct samples)`);
    console.log(`evdev delta spread  : ${evdevBox.w}x${evdevBox.h}  (${relEvents} REL events)`);

    const nativeWorks = nativeBox.w > width * 0.5 && nativeBox.h > height * 0.3;
    const evdevWorks = evdevBox.w > width * 0.3;
    console.log("\nVERDICT");
    if (nativeWorks) {
      console.log("  getCursorScreenPoint TRACKS THE WHOLE SCREEN — native cursor is usable here.");
    } else if (distinctNative > 5) {
      console.log("  getCursorScreenPoint moves but covers only part of the screen —");
      console.log("  it likely updates only while the pointer is over one of our own windows.");
    } else {
      console.log("  getCursorScreenPoint is FROZEN — evdev must drive the cursor.");
    }
    console.log(`  evdev relative deltas: ${evdevWorks ? "working" : "NOT usable (no mouse, or touchpad-only)"}`);
    app.exit(0);
  }, 1000);
});
