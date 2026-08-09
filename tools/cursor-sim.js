/*
 * cursor-sim.js — drive the cursor estimator through every session type that
 * exists, deterministically, without a mouse.
 *
 *   node tools/cursor-sim.js
 *
 * WHY THIS EXISTS
 * The cursor code has been broken and "fixed" repeatedly, and every time the
 * fix was verified by waving a mouse around on ONE machine — which can only
 * ever exercise the one regime that machine happens to be in. The regressions
 * all landed in the other two: a change that made Wayland work would quietly
 * make X11 hit-test against nothing, and nobody found out until someone else
 * ran it.
 *
 * So the three regimes are simulated instead. `input.js` is loaded with the
 * display server, the evdev reader and the clock all replaced, then fed a
 * scripted pointer path, and what it concludes is checked against what is
 * actually true — which the simulation knows, because it made it up.
 *
 * The pointer acceleration the estimator has to learn is applied here as a
 * constant it is never told (ACCEL), so "did the gain converge" is a real
 * question with a real answer rather than a tautology.
 */
const Module = require("module");
const path = require("path");
const assert = require("assert");

/*
 * The simulated session has to OUTLIVE the require() that sets it up.
 *
 * input.js reads the session lazily — `anchored = !isWayland()` runs on every
 * tick — so putting the real environment back before the first step() quietly
 * hands the estimator the developer's own desktop to reason about instead of
 * the scenario it was asked to simulate. On a Wayland machine the Wayland cases
 * then pass for the wrong reason, and the identical suite fails on X11, on CI,
 * and anywhere with no session at all. Which is the exact failure this file was
 * written to catch, reintroduced by its own cleanup code.
 *
 * The platform is pinned for the same reason. All three regimes are LINUX
 * regimes, and isWayland() short-circuits on process.platform — so on a Windows
 * or macOS runner every Wayland scenario silently tests X11 instead and fails
 * for a reason that has nothing to do with the code under test.
 */
const realPlatform = process.platform;
const realSessionType = process.env.XDG_SESSION_TYPE;

function enterSession(wayland) {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.env.XDG_SESSION_TYPE = wayland ? "wayland" : "x11";
}

// Put back on the way out, so requiring this harness from another script does
// not leave the process permanently claiming to be something it is not.
process.on("exit", () => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  if (realSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = realSessionType;
});

const SF = 1.25; // a scaled display, because that is what broke it last time
const DESKTOP = { width: 1536, height: 960 }; // logical DIP
const ACCEL = 1.6; // device px -> physical px. The estimator must discover this.
const TICK_MS = 1000 / 60;

// --- the fake world ---------------------------------------------------------
function makeWorld() {
  const display = {
    id: 1,
    label: "sim",
    bounds: { x: 0, y: 0, width: DESKTOP.width, height: DESKTOP.height },
    workArea: { x: 0, y: 0, width: DESKTOP.width, height: DESKTOP.height },
    scaleFactor: SF,
  };
  return {
    // Where the pointer REALLY is, in DIP. Only the simulation may read this.
    truth: { x: 700, y: 400 },
    // What getCursorScreenPoint() reports. Diverges from truth exactly as much
    // as the session type says it should.
    reported: { x: 700, y: 400 },
    screen: {
      getCursorScreenPoint: () => ({ x: Math.round(reportedOf(display)), y: 0 }),
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
    },
    display,
  };
}

// Placeholder replaced below; kept so the object literal above stays readable.
function reportedOf() {
  return 0;
}

/*
 * Load a pristine copy of input.js with electron, the evdev reader, uiohook and
 * the clock all swapped out. Every scenario gets its own, because the estimator
 * keeps learned state (the gain, the drift, the verdict) that must not leak
 * from one session type into the next.
 */
function loadInput({ wayland, evdev, uiohookWorks }) {
  const world = makeWorld();
  let clock = 1_000_000;

  const inputPath = require.resolve("../src/main/input.js");
  const evdevPath = require.resolve("../src/main/evdev-linux.js");
  delete require.cache[inputPath];
  delete require.cache[evdevPath];

  const pending = { dx: 0, dy: 0 };
  let reader = null;

  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { screen: world.screen };
    if (request === "uiohook-napi") {
      if (!uiohookWorks) throw Object.assign(new Error("no hook"), { code: "MODULE_NOT_FOUND" });
      return { uIOhook: { on() {}, start() {}, stop() {} } };
    }
    if (parent && parent.filename === inputPath && request === "./evdev-linux") {
      return {
        EvdevReader: class {
          constructor(handlers) {
            this.handlers = handlers;
            this.hasRelDevice = !!evdev;
            this.devices = evdev ? [{ node: "event0", rel: true }] : [];
            reader = this;
          }
          start() {
            return !!evdev;
          }
          // Hand over whatever the scenario queued since the last tick.
          drain() {
            if (pending.dx || pending.dy) {
              this.handlers.onMove(pending.dx, pending.dy);
              pending.dx = 0;
              pending.dy = 0;
            }
          }
          stop() {}
        },
      };
    }
    return realLoad.apply(this, arguments);
  };

  enterSession(wayland);

  let input;
  let tick = null;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realNow = Date.now;
  try {
    input = require(inputPath);
    input.startGlobal({ onKey() {}, onWheel() {} });

    global.setInterval = (fn) => {
      tick = fn;
      return { sim: true };
    };
    global.clearInterval = () => {};
    Date.now = () => clock;
    input.startCursor((s) => {
      last = s;
    });
  } finally {
    Module._load = realLoad;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    // The session is deliberately NOT restored here — see the note at the top.
    // It has to stay in force for as long as the returned sim can be stepped.
  }

  let last = null;

  return {
    input,
    world,
    status: input.status,
    get last() {
      return last;
    },
    /*
     * Advance one frame. `rawDx/rawDy` is what the mouse hardware emitted, in
     * device px; the world moves the true cursor by that times ACCEL, and the
     * native point follows only if `nativeSees` says this session would let it.
     */
    step(rawDx, rawDy, nativeSees) {
      world.truth.x = clampTo(world.truth.x + (rawDx * ACCEL) / SF, 0, DESKTOP.width - 1);
      world.truth.y = clampTo(world.truth.y + (rawDy * ACCEL) / SF, 0, DESKTOP.height - 1);
      if (nativeSees) {
        world.reported.x = world.truth.x;
        world.reported.y = world.truth.y;
      }
      world.screen.getCursorScreenPoint = () => ({
        x: Math.round(world.reported.x),
        y: Math.round(world.reported.y),
      });
      pending.dx += rawDx;
      pending.dy += rawDy;
      Date.now = () => clock;
      clock += TICK_MS;
      tick();
      Date.now = realNow;
    },
    error() {
      return Math.hypot(last.x - world.truth.x, last.y - world.truth.y);
    },
  };
}

const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A wander that stays inside the desktop, deterministic so a failure reproduces.
function* wander(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  for (;;) yield [rnd() * 14, rnd() * 14];
}

/*
 * A pointer being USED, rather than shaken: it travels to a place, arrives, and
 * then goes somewhere else. That distinction matters here, because a random
 * walk started in the middle of a 1536x960 desktop essentially never reaches
 * any particular window — the first version of the XWayland scenario below
 * spent 3000 ticks without once crossing the surface it was meant to be
 * testing, and passed everything by never exercising anything.
 *
 * Emits raw DEVICE deltas, so the simulation's own acceleration carries the
 * pointer the rest of the way — the aiming happens in the hand, as it does.
 */
function* route(sim, targets, seed = 17) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  for (let i = 0; ; i++) {
    const tgt = targets[i % targets.length];
    for (let guard = 0; guard < 400; guard++) {
      const t = sim.world.truth;
      const dx = tgt.x - t.x;
      const dy = tgt.y - t.y;
      const d = Math.hypot(dx, dy);
      if (d < 8) break;
      const stepDip = Math.min(d, 16);
      const k = ((stepDip / d) * SF) / ACCEL;
      yield [dx * k + rnd() * 1.5, dy * k + rnd() * 1.5];
    }
    // Arrived. A hand at rest still counts as a tick of the world going by.
    for (let dwell = 0; dwell < 20; dwell++) yield [0, 0];
  }
}

// The harness is worth having on its own — `require` it to script a session
// type by hand and print what the estimator makes of it.
module.exports = { loadInput, wander, route, ACCEL, SF, DESKTOP };
if (require.main !== module) return;

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
 * X11 / Windows / macOS: the display server answers every time, uiohook took
 * the keyboard, and there is no evdev reader at all. Nothing in the estimator
 * may interfere — this is the path that already worked and must keep working.
 */
check("X11: exact throughout, hit-testing kept, position never drifts", () => {
  const sim = loadInput({ wayland: false, evdev: false, uiohookWorks: true });
  const w = wander();
  for (let i = 0; i < 600; i++) {
    const [dx, dy] = w.next().value;
    sim.step(dx, dy, true);
  }
  assert.strictEqual(sim.status.hitTest, true, "hit-testing was taken away");
  assert.strictEqual(sim.last.exact, true, "samples stopped being exact");
  assert.ok(sim.error() < 1.5, `drifted ${sim.error().toFixed(1)}px from truth`);
  assert.ok(sim.last.conf > 0.99, `confidence sagged to ${sim.last.conf}`);
});

/*
 * X11 with evdev (uiohook failed, so raw deltas arrive too). The evidence
 * gathered must NOT talk itself into demoting a session whose native point is
 * answering perfectly — the failure mode that would silently turn precise
 * click-through into a window that eats clicks.
 */
check("X11 + evdev: raw deltas present, verdict still keeps hit-testing", () => {
  const sim = loadInput({ wayland: false, evdev: true, uiohookWorks: false });
  const w = wander(11);
  for (let i = 0; i < 900; i++) {
    const [dx, dy] = w.next().value;
    sim.step(dx, dy, true);
  }
  assert.strictEqual(sim.status.hitTest, true, "a working X11 session was demoted");
  assert.strictEqual(sim.status.cursor, "native", `called itself ${sim.status.cursor}`);
});

/*
 * Wayland with a genuinely frozen native point. Dead reckoning is all there is,
 * so the position must degrade gracefully — and, critically, must NOT claim to
 * be exact, because that is what would hand the hit test a lie.
 */
check("Wayland frozen: never claims exactness, never gains hit-testing", () => {
  const sim = loadInput({ wayland: true, evdev: true, uiohookWorks: false });
  const w = wander(3);
  for (let i = 0; i < 900; i++) {
    const [dx, dy] = w.next().value;
    sim.step(dx, dy, false);
  }
  assert.strictEqual(sim.status.hitTest, false, "hit-testing was granted on a frozen point");
  assert.strictEqual(sim.last.exact, false, "an estimate was labelled exact");
  assert.strictEqual(sim.status.cursor, "evdev", `called itself ${sim.status.cursor}`);
});

/*
 * The seed. On Wayland the first native reading can be a coordinate from
 * whenever the pointer last crossed one of our surfaces, so believing it is how
 * the estimate started out hundreds of pixels wrong. Until something confirms a
 * position there must be no confidence in it at all.
 */
check("Wayland: an unconfirmed seed carries no confidence", () => {
  const sim = loadInput({ wayland: true, evdev: true, uiohookWorks: false });
  sim.step(0, 0, false);
  assert.strictEqual(sim.last.conf, 0, `claimed ${sim.last.conf} confidence in a guess`);
  // ...and a position handed back by the renderer is what earns it.
  sim.input.syncCursor({ x: sim.world.truth.x, y: sim.world.truth.y });
  sim.step(0, 0, false);
  assert.strictEqual(sim.last.conf, 1, "a confirmed position did not restore confidence");
  assert.ok(sim.error() < 1.5, `snapped to ${sim.error().toFixed(1)}px off`);
});

/*
 * Shoving the pointer into a corner. The real cursor stops at the edge and so
 * does the estimate, so the two agree there no matter how far apart they had
 * drifted — the one free correction that needs no cooperation from anything.
 */
check("Wayland: a corner resyncs a drifted estimate", () => {
  const sim = loadInput({ wayland: true, evdev: true, uiohookWorks: false });
  sim.input.syncCursor({ x: 700, y: 400 });
  sim.step(0, 0, false);
  // Wander far enough to accumulate real drift...
  const w = wander(5);
  for (let i = 0; i < 400; i++) {
    const [dx, dy] = w.next().value;
    sim.step(dx, dy, false);
  }
  const drifted = sim.error();
  // ...then shove into the top-left corner and hold it there.
  for (let i = 0; i < 200; i++) sim.step(-30, -30, false);
  assert.ok(sim.error() < 2, `corner left it ${sim.error().toFixed(1)}px off (was ${drifted.toFixed(1)})`);
  assert.ok(sim.last.conf > 0.99, `corner did not restore confidence (${sim.last.conf})`);
});

/*
 * XWayland — the regime that caused all this. The native point is exact while
 * the pointer is over one of our X surfaces and frozen the moment it is not.
 * The estimator must notice it cannot be trusted to hit-test, learn the
 * acceleration from the moments it CAN see, and stay usable in between.
 */
check("XWayland: refuses hit-testing, learns the acceleration, stays close", () => {
  const sim = loadInput({ wayland: true, evdev: true, uiohookWorks: false });
  // One X11 window on a desktop of Wayland ones — a browser, say, or the cat.
  const xSurface = { x0: 900, y0: 500, x1: 1300, y1: 800 };
  const inside = (t) =>
    t.x >= xSurface.x0 && t.x <= xSurface.x1 && t.y >= xSurface.y0 && t.y <= xSurface.y1;
  const r = route(sim, [
    { x: 1100, y: 650 }, // into the X window
    { x: 180, y: 160 }, // off to a Wayland one
    { x: 1250, y: 720 }, // back
    { x: 300, y: 880 },
    { x: 980, y: 560 },
    { x: 1450, y: 120 },
  ]);
  let worst = 0;
  let seenTicks = 0;
  for (let i = 0; i < 4000; i++) {
    const [dx, dy] = r.next().value;
    const sees = inside(sim.world.truth);
    if (sees) seenTicks++;
    sim.step(dx, dy, sees);
    if (sim.last.conf > 0.5) worst = Math.max(worst, sim.error());
  }
  assert.ok(seenTicks > 100, `the route never used the X window (${seenTicks} ticks)`);
  assert.strictEqual(sim.status.hitTest, false, "hybrid session was granted hit-testing");
  assert.strictEqual(sim.status.cursor, "hybrid", `called itself ${sim.status.cursor}`);
  const gain = sim.status.gain;
  assert.ok(
    Math.abs(gain - ACCEL) < 0.25,
    `learned gain ${gain}, should be near ${ACCEL} — dead reckoning will run fast or slow`
  );
  // While it says it is confident, it has to actually be worth believing.
  assert.ok(worst < 150, `claimed confidence while ${worst.toFixed(0)}px from the truth`);
});

/*
 * The cat as its own calibration target. Crossing the pet window is a true
 * position the renderer can always see, so a long blind excursion must be
 * forgiven the moment the pointer comes back.
 */
check("Any session: touching the window forgives a whole excursion of drift", () => {
  const sim = loadInput({ wayland: true, evdev: true, uiohookWorks: false });
  sim.input.syncCursor({ x: 200, y: 200 });
  sim.step(0, 0, false);
  const w = wander(29);
  for (let i = 0; i < 600; i++) {
    const [dx, dy] = w.next().value;
    sim.step(dx, dy, false);
  }
  assert.ok(sim.last.conf < 0.9, "drift did not reduce confidence at all");
  sim.input.syncCursor({ x: sim.world.truth.x, y: sim.world.truth.y });
  sim.step(0, 0, false);
  assert.strictEqual(sim.last.conf, 1, "a true position did not clear the drift");
  assert.ok(sim.error() < 1.5, `still ${sim.error().toFixed(1)}px off after a resync`);
});

// --- report -----------------------------------------------------------------
let failed = 0;
for (const [state, name, why] of results) {
  if (state === "FAIL") failed++;
  console.log(`${state === "PASS" ? "  ok  " : "  FAIL"}  ${name}${why ? `\n          ${why}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
