/*
 * touch-scroll-sim.js — drive the touchpad scroll reconstruction with scripted
 * fingers, deterministically, without a touchpad.
 *
 *   node tools/touch-scroll-sim.js
 *
 * WHY THIS EXISTS
 * Scrolling on a touchpad is not a hardware event. The kernel reports only
 * where each finger is, and evdev-linux.js has to decide for itself that two of
 * them moving together means scroll — the same call libinput makes, made again
 * because reading /dev/input goes around libinput entirely.
 *
 * That decision cannot be checked by scrolling on the machine that wrote it.
 * The interesting cases are the ones a person cannot perform on demand: a pinch
 * whose halves must cancel, a re-grip that must not fire a phantom tick, a pad
 * whose units are half the size of this one's. So the fingers are scripted
 * instead, fed through the real consume() as the exact byte layout the kernel
 * would have produced, and what came out the other side is checked.
 *
 * The clock is faked for the same reason cursor-sim fakes it: the reports are
 * notched in time, and a test that depended on how fast the machine ran it
 * would pass or fail by accident.
 */
const assert = require("assert");
const { EvdevReader } = require("../src/main/evdev-linux.js");

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const EV_ABS = 0x03;

const REL_WHEEL = 0x08;
const ABS_MT_SLOT = 0x2f;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_TRACKING_ID = 0x39;
const BTN_TOUCH = 0x14a;
const BTN_TOOL_DOUBLETAP = 0x14d;

// A touchpad reports about this often, and the app drains at 60Hz, so a drain
// picks up roughly two frames at a time — which the reports have to survive.
const FRAME_MS = 8;

/*
 * A scripted pad. `span` is how many units tall it claims to be, and is
 * deliberately not told to the reader: learning it from the fingers is the part
 * that has to work on hardware nobody here owns.
 */
function pad({ span = 1200, rel = false } = {}) {
  const wheel = [];
  const other = { key: 0, button: 0, move: 0 };
  const reader = new EvdevReader({
    onWheel: (v) => wheel.push(v),
    onKey: () => other.key++,
    onButton: () => other.button++,
    onMove: () => other.move++,
  });
  const dev = { node: "sim", fd: -1, rel };

  let clock = 1_000_000;
  const realNow = Date.now;

  // Fingers currently on the pad, by slot.
  const held = new Map();

  function emit(events) {
    const buf = Buffer.alloc(events.length * 24);
    events.forEach(([type, code, value], i) => {
      buf.writeUInt16LE(type, i * 24 + 16);
      buf.writeUInt16LE(code, i * 24 + 18);
      buf.writeInt32LE(value, i * 24 + 20);
    });
    Date.now = () => clock;
    try {
      reader.consume(dev, buf, buf.length);
    } finally {
      Date.now = realNow;
    }
    clock += FRAME_MS;
  }

  let nextId = 1;

  const api = {
    span,
    wheel,
    other,
    raw: emit,

    // Put fingers down at the given positions. Mirrors the kernel's ordering:
    // slot, then tracking id, then position, then the BTN_TOOL_* summary.
    down(points) {
      const ev = [];
      points.forEach((p, slot) => {
        held.set(slot, { ...p });
        ev.push([EV_ABS, ABS_MT_SLOT, slot]);
        ev.push([EV_ABS, ABS_MT_TRACKING_ID, nextId++]);
        ev.push([EV_ABS, ABS_MT_POSITION_X, p.x]);
        ev.push([EV_ABS, ABS_MT_POSITION_Y, p.y]);
      });
      ev.push([EV_KEY, BTN_TOUCH, 1]);
      if (points.length === 2) ev.push([EV_KEY, BTN_TOOL_DOUBLETAP, 1]);
      ev.push([EV_SYN, 0, 0]);
      emit(ev);
      return api;
    },

    // Move every finger by (dx, dy) per frame, for `frames` frames. `per` can
    // override the delta for one slot, which is how a pinch is expressed.
    drag({ dx = 0, dy = 0, frames = 1, per = null }) {
      for (let f = 0; f < frames; f++) {
        const ev = [];
        for (const [slot, p] of held) {
          const d = (per && per[slot]) || { dx, dy };
          const moved = { x: p.x + (d.dx || 0), y: p.y + (d.dy || 0) };
          ev.push([EV_ABS, ABS_MT_SLOT, slot]);
          if (moved.x !== p.x) ev.push([EV_ABS, ABS_MT_POSITION_X, moved.x]);
          if (moved.y !== p.y) ev.push([EV_ABS, ABS_MT_POSITION_Y, moved.y]);
          held.set(slot, moved);
        }
        ev.push([EV_SYN, 0, 0]);
        emit(ev);
      }
      return api;
    },

    up() {
      const ev = [];
      for (const slot of held.keys()) {
        ev.push([EV_ABS, ABS_MT_SLOT, slot]);
        ev.push([EV_ABS, ABS_MT_TRACKING_ID, -1]);
      }
      held.clear();
      ev.push([EV_KEY, BTN_TOUCH, 0]);
      ev.push([EV_KEY, BTN_TOOL_DOUBLETAP, 0]);
      ev.push([EV_SYN, 0, 0]);
      emit(ev);
      return api;
    },

    // Sit still long enough that the next report is not held back by the notch.
    wait(ms) {
      clock += ms;
      return api;
    },

    elapsed: () => clock - 1_000_000,
  };
  return api;
}

// A swipe expressed the way a person would describe it, in fractions of the
// pad, so the same script means the same gesture on a pad of any size.
function swipe(p, { fraction, ms, x = 0.35 }) {
  const frames = Math.max(1, Math.round(ms / FRAME_MS));
  const travel = Math.round(p.span * fraction);
  const step = Math.round(travel / frames);
  const startY = fraction < 0 ? Math.round(p.span * 0.85) : Math.round(p.span * 0.15);
  const px = Math.round(p.span * x);
  p.down([
    { x: px, y: startY },
    { x: px + Math.round(p.span * 0.12), y: startY },
  ]);
  p.drag({ dy: step, frames });
  p.up();
  return p;
}

// --- scenarios --------------------------------------------------------------
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(["PASS", name, ""]);
  } catch (err) {
    results.push(["FAIL", name, err.message]);
  }
}

/*
 * The bug this whole thing exists for: a touchpad emits no REL_WHEEL, so before
 * this the yarn ball only ever answered to a plugged-in mouse.
 */
check("two fingers moving up scroll up", () => {
  const p = swipe(pad(), { fraction: -0.5, ms: 400 });
  assert.ok(p.wheel.length > 0, "a half-pad swipe produced no scroll at all");
  assert.ok(
    p.wheel.every((v) => v > 0),
    `swiping up reported ${JSON.stringify(p.wheel)} — a wheel counts up as positive`
  );
});

check("two fingers moving down scroll down", () => {
  const p = swipe(pad(), { fraction: 0.5, ms: 400 });
  assert.ok(p.wheel.length > 0, "a half-pad swipe produced no scroll at all");
  assert.ok(
    p.wheel.every((v) => v < 0),
    `swiping down reported ${JSON.stringify(p.wheel)}`
  );
});

/*
 * A finger is continuous. Without the notch this reports at the pad's full rate
 * — around 125 a second, every one of them batting the yarn ball.
 */
check("scroll is notched, not a firehose", () => {
  const p = swipe(pad(), { fraction: -0.5, ms: 400 });
  const cap = Math.ceil(p.elapsed() / 50) + 1;
  assert.ok(
    p.wheel.length <= cap,
    `${p.wheel.length} reports in ${p.elapsed()}ms, expected at most ${cap}`
  );
});

/*
 * Pads differ by roughly 5x in how many units they report per millimetre, and
 * the range cannot be read without an ioctl. The same gesture therefore has to
 * mean the same thing on a pad half the size, from what the fingers alone said.
 */
check("a pad of a different size feels the same", () => {
  const big = swipe(pad({ span: 2400 }), { fraction: -0.5, ms: 400 });
  const small = swipe(pad({ span: 700 }), { fraction: -0.5, ms: 400 });
  assert.ok(small.wheel.length > 0 && big.wheel.length > 0, "one of the pads scrolled not at all");
  const ratio = big.wheel.length / small.wheel.length;
  assert.ok(
    ratio > 0.6 && ratio < 1.7,
    `same swipe gave ${big.wheel.length} reports on a big pad and ${small.wheel.length} on a small one`
  );
});

/*
 * The notch holds reports back; it must not drop them. Travel keeps
 * accumulating in between, so a scroll slow enough to cover less than a tick
 * per window still reports — just at a slower rate, which is the whole point of
 * measuring travel rather than sampling speed.
 */
check("a slow scroll still reports, just less often", () => {
  const slow = swipe(pad(), { fraction: -0.2, ms: 1200 });
  const fast = swipe(pad(), { fraction: -0.2, ms: 200 });
  assert.ok(slow.wheel.length > 0, "a slow deliberate scroll reported nothing");
  const slowRate = (slow.wheel.length / slow.elapsed()) * 1000;
  const fastRate = (fast.wheel.length / fast.elapsed()) * 1000;
  assert.ok(
    slowRate < fastRate,
    `slow scroll reported ${slowRate.toFixed(1)}/s, fast one ${fastRate.toFixed(1)}/s`
  );
});

// --- and the things that are NOT a scroll -----------------------------------

check("one finger is the pointer, not a scroll", () => {
  const p = pad();
  p.down([{ x: 400, y: 1000 }]);
  p.drag({ dy: -12, frames: 60 });
  p.up();
  assert.strictEqual(p.wheel.length, 0, `dragging one finger reported ${p.wheel.length} scrolls`);
});

check("three fingers are a desktop gesture, not a scroll", () => {
  const p = pad();
  p.down([
    { x: 300, y: 1000 },
    { x: 450, y: 1000 },
    { x: 600, y: 1000 },
  ]);
  p.drag({ dy: -12, frames: 60 });
  p.up();
  assert.strictEqual(p.wheel.length, 0, `a three-finger swipe reported ${p.wheel.length} scrolls`);
});

check("two fingers resting are not a scroll", () => {
  const p = pad();
  p.down([
    { x: 400, y: 600 },
    { x: 550, y: 600 },
  ]);
  // A hand resting on a pad is never perfectly still.
  for (let i = 0; i < 80; i++) p.drag({ dy: i % 2 ? 1 : -1, frames: 1 });
  p.up();
  assert.strictEqual(p.wheel.length, 0, `resting fingers reported ${p.wheel.length} scrolls`);
});

/*
 * A pinch is two fingers travelling a long way each, and would look exactly
 * like a vigorous scroll to anything that summed them instead of averaging.
 */
check("a pinch cancels out", () => {
  const p = pad();
  p.down([
    { x: 400, y: 400 },
    { x: 400, y: 900 },
  ]);
  p.drag({ frames: 60, per: { 0: { dy: 6 }, 1: { dy: -6 } } });
  p.up();
  assert.strictEqual(p.wheel.length, 0, `a pinch reported ${p.wheel.length} scrolls`);
});

/*
 * Lifting and landing again is how anyone scrolls further than the pad is tall.
 * If a slot's new finger is differenced against the old one's last position,
 * every re-grip fires a tick in whatever direction the hand happened to move.
 */
check("re-gripping does not fire a phantom tick", () => {
  const p = pad();
  p.down([
    { x: 400, y: 200 },
    { x: 550, y: 200 },
  ]);
  p.wait(60);
  p.up();
  p.down([
    { x: 400, y: 1100 },
    { x: 550, y: 1100 },
  ]);
  p.wait(60);
  p.drag({ dy: 0, frames: 2 });
  assert.strictEqual(p.wheel.length, 0, `re-gripping reported ${p.wheel.length} scrolls`);
});

/*
 * Adding a second finger part-way through a one-finger drag: the hand is
 * already moving, so the moment the gesture becomes a scroll must not inherit
 * the travel that happened before it was one.
 */
check("a second finger joining does not import earlier travel", () => {
  const p = pad();
  p.down([{ x: 400, y: 1000 }]);
  p.drag({ dy: -20, frames: 30 });
  p.raw([
    [EV_ABS, ABS_MT_SLOT, 1],
    [EV_ABS, ABS_MT_TRACKING_ID, 900],
    [EV_ABS, ABS_MT_POSITION_X, 550],
    [EV_ABS, ABS_MT_POSITION_Y, 400],
    [EV_KEY, BTN_TOOL_DOUBLETAP, 1],
    [EV_SYN, 0, 0],
  ]);
  assert.strictEqual(p.wheel.length, 0, `the join itself reported ${p.wheel.length} scrolls`);
});

// --- and the things that must not have changed ------------------------------

/*
 * A device with a wheel of its own is left alone. hid-magicmouse hands over
 * BOTH touch data and a REL_WHEEL derived from that same data, so anything that
 * synthesised on top of it would scroll twice per gesture.
 */
check("a device with its own wheel is left alone", () => {
  const p = pad({ rel: true });
  p.raw([
    [EV_REL, REL_WHEEL, 1],
    [EV_SYN, 0, 0],
    [EV_REL, REL_WHEEL, -1],
    [EV_SYN, 0, 0],
  ]);
  assert.deepStrictEqual(p.wheel, [1, -1], "the mouse wheel path no longer passes through");
  p.down([
    { x: 400, y: 1000 },
    { x: 550, y: 1000 },
  ]);
  p.drag({ dy: -20, frames: 60 });
  p.up();
  assert.deepStrictEqual(p.wheel, [1, -1], `fingers were counted a second time: ${p.wheel}`);
});

check("keys and clicks from a touch device still get through", () => {
  const p = pad();
  p.raw([
    [EV_KEY, 30, 1],
    [EV_KEY, 0x110, 1],
    [EV_SYN, 0, 0],
  ]);
  assert.strictEqual(p.other.key, 1, "a key press was swallowed");
  assert.strictEqual(p.other.button, 1, "a click was swallowed");
});

// --- report -----------------------------------------------------------------
let failed = 0;
for (const [state, name, why] of results) {
  if (state === "FAIL") failed++;
  console.log(`${state === "PASS" ? "  ok  " : "  FAIL"}  ${name}${why ? `\n          ${why}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
