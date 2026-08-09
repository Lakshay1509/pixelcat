/*
 * input.js — cross-platform global input, with a source per platform reality.
 *
 * CURSOR
 * `screen.getCursorScreenPoint()` is correct on Windows, macOS and Linux/X11.
 * On Wayland it is useless. On XWayland — which is what Electron actually runs
 * as on a Wayland session unless told otherwise — it is neither: it is exact
 * while the pointer happens to be over an X surface (ours included) and frozen
 * the moment it moves over a native Wayland one.
 *
 * That third regime is the one this file used to have no name for, and so
 * handled worst. The old code picked ONE source and latched to it: the first
 * evdev delta flipped it to "estimated" and nothing could ever flip it back, so
 * a native point that was telling the truth several times a second was thrown
 * away for the rest of the session. The cat then had no position at all unless
 * the pointer was physically over its window.
 *
 * So there is no "which source" any more. There is ONE estimate, and every
 * source that can say something true about it gets to correct it:
 *
 *   - the native point, whenever it actually changes           (exact)
 *   - DOM pointer events over our own window, via syncCursor() (exact)
 *   - raw evdev deltas, integrated in between                  (drifts)
 *   - the screen edges, which the real cursor also stops at    (exact, 1 axis)
 *
 * What the estimate carries with it is a CONFIDENCE: how far wrong it expects
 * to be, given how far it has been dead-reckoned since the last correction and
 * how well it knows the one constant that reckoning depends on. Distance, not
 * time, because a mouse sitting still tells no lies. Consumers then pick a bar
 * to clear rather than being handed a boolean: eye-follow only needs a
 * direction and takes a rough fix happily, petting needs a pixel and refuses
 * anything but an exact one. Conflating those two is what made every previous
 * fix break the other half of the feature.
 *
 * Dead reckoning drifts because the compositor applies pointer acceleration we
 * cannot observe — so we measure it instead. Over any tick where the native
 * point AND a raw delta both moved, their ratio IS the acceleration, and `gain`
 * is that ratio averaged. On XWayland the pointer crosses an X surface
 * constantly, so this stays calibrated without anyone doing anything.
 *
 * `tools/cursor-sim.js` drives all of this through every session type without a
 * mouse. Every regression this file has ever had was in a regime the machine
 * doing the testing could not be in; run it before believing a change.
 *
 * KEYBOARD
 * uiohook where it works; /dev/input where it doesn't.
 *
 * WHEEL
 * A mouse wheel notches. One click is one message carrying a delta of 120, and
 * libuiohook hands that over as a rotation of ±1, so one turn of a wheel is one
 * report and it says which way.
 *
 * A Windows precision touchpad does neither of those things. It is an
 * ultra-high-resolution device and Windows treats it as one: the documented
 * default delta for a two-finger drag is 1, not 120. libuiohook floor-divides by
 * 120 to get its rotation, so 119 messages out of every 120 arrive as rotation
 * ZERO — a firehose of reports at the pad's full rate, none of which say which
 * direction the fingers are going.
 *
 * Both halves of that broke the yarn ball. The renderer bats it once per report,
 * so a touchpad batted it a hundred times a second: the ball went straight to
 * its maximum speed, hit the edge of the canvas, and stayed pinned there for the
 * whole scroll. Nothing arced, nothing came back, and it was re-kicked before it
 * could ever hop — which is what "the scroll animation doesn't show" looks like.
 *
 * So the firehose is notched here into the shape a wheel already has, at the
 * same cadence evdev-linux.js gives a Linux touchpad, carrying the last
 * direction that was actually observed rather than a guess. A real rotation
 * still goes straight through the instant it arrives: a wheel click must not
 * wait 50ms to be answered, and it is the only thing that ever teaches
 * direction.
 */
const { screen } = require("electron");

const status = {
  // What the cursor feed is managing, for the settings readout.
  cursor: "native", // native | hybrid | evdev | frozen
  // Is main's point good enough to gate click-through? Deliberately NOT the
  // same question as "is this sample exact", and deliberately slow to change —
  // see the verdict block below.
  hitTest: true,
  keyboard: "pending", // ok | evdev | unsupported | denied | error
  detail: "",
  source: "",
  // Live diagnostics, surfaced in settings so a bad session can be told apart
  // from an unsupported one without attaching a debugger.
  conf: 0,
  gain: 1,
  gainErr: 0.5,
};

let cursorTimer = null;
let hook = null;
let evdev = null;

function isWayland() {
  return process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
}

// Raw device deltas accumulated between cursor polls.
const accum = { dx: 0, dy: 0 };

// --- the estimate -----------------------------------------------------------
// Everything here is in logical DIP, the unit every window rect and display
// bound is already in. evdev alone speaks device pixels, and is converted on
// the way in — mixing the two is what previously made the estimate run 25% fast
// on this 1.25x display and then clamp against the wrong screen edge.
const est = { x: 0, y: 0 };
let haveEst = false;
// Has any source ever actually told us where the pointer is? Seeding from the
// native point is NOT that on Wayland, where the seed can be a coordinate from
// another era — believing it is how the estimate started out wrong and stayed
// wrong. Until something confirms a position, confidence is zero and the cat
// simply does not know where you are, which is the truth.
let anchored = false;
// Dead-reckoned distance since the last correction, per axis, because the edges
// correct one axis at a time.
let driftX = 0;
let driftY = 0;
let lastNative = null;
// Did the native point move on the previous tick? Turns a pair of readings into
// a measurement over a known interval — see the catch-up note in the tick.
let nativeRunning = false;

/*
 * How far wrong the estimate may be before it stops being worth acting on.
 *
 * Confidence is this budget against the error actually EXPECTED, rather than a
 * plain count of pixels travelled, because those are not the same thing and
 * treating them as one is what made the estimate sound sure of itself while it
 * was still learning. Dead reckoning does not go wrong at a fixed rate; it goes
 * wrong in proportion to how badly the gain is known. So a freshly started
 * session loses confidence quickly, and a calibrated one holds it for a long
 * way — which is the truth about each of them.
 */
const CONF_TOL = 150;

// Learned device-px -> physical-px pointer acceleration. 1 is the right prior:
// libinput's default curve sits near unity at ordinary speeds, so an
// uncalibrated estimate is merely imprecise rather than nonsense.
let gain = 1;
let learnRaw = 0;
let learnNative = 0;
// How well `gain` is known, as a fraction of itself. Starts frankly pessimistic
// — an uncalibrated reckoner really can be a third out — and is driven by how
// much successive measurements disagree with each other.
let gainErr = 0.5;
const GAIN_ERR_FLOOR = 0.04;
const GAIN_ERR_CEIL = 0.6;
// Learn from PATH LENGTH, not displacement. Both sums only ever take ticks
// where the two sources were live together, so they cover the same interval —
// and summing per-tick distances is immune to the pointer curving, which a
// start-to-end displacement is not (a circle back to where it started has a
// displacement of zero and would teach a gain of zero).
const LEARN_MIN_RAW = 240; // device px per sample; ~a quarter-second of moving
const LEARN_RATE = 0.15;

// --- regime evidence --------------------------------------------------------
// How much of the pointer's real travel the native point managed to witness.
// Gain-independent on purpose: it is a ratio of raw device travel against
// itself, so it means the same thing before calibration as after.
let evidenceRaw = 0;
let witnessedRaw = 0;
let lastVerdict = 0;
const VERDICT_MS = 1000;
// Enough travel to be a real opinion rather than a twitch: ~1s of moving.
const VERDICT_MIN_RAW = 900;
// Per tick, the least device travel that MUST have moved a working native point.
const EVIDENCE_MIN_RAW = 4;
const VERDICT_DECAY = 0.6; // a few seconds of memory, so the verdict can change

function desktopBounds() {
  const all = screen.getAllDisplays();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of all) {
    x0 = Math.min(x0, d.bounds.x);
    y0 = Math.min(y0, d.bounds.y);
    x1 = Math.max(x1, d.bounds.x + d.bounds.width);
    y1 = Math.max(y1, d.bounds.y + d.bounds.height);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1920, y1: 1080 };
  return { x0, y0, x1, y1 };
}

function scaleAt(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).scaleFactor || 1;
  } catch {
    return 1;
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/*
 * A correction from a source that knows where the pointer really is. Both
 * callers are exact: the native point when it changed, and a DOM pointer event
 * the renderer forwarded. Everything the estimate had drifted is discarded.
 */
function anchor(x, y) {
  est.x = x;
  est.y = y;
  haveEst = true;
  anchored = true;
  driftX = 0;
  driftY = 0;
}

/*
 * syncCursor — the renderer telling us where the pointer actually is.
 *
 * The pet window gets real DOM pointer events whenever the cursor is over it,
 * and those are exact on every platform including Wayland. That makes the cat
 * its own calibration target, and the timing could not be better: precision
 * matters most when the pointer is ABOUT to touch the cat, and that is the one
 * moment we are guaranteed the truth.
 */
function syncCursor(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  anchor(p.x, p.y);
}

/*
 * The deltas handed to onMove are the motion the mouse INTENDED, not the change
 * in the estimated position. Those differ at a screen edge: the estimate is
 * clamped to the desktop, so once it is pinned against the right-hand side,
 * sweeping further right changes it by nothing and the cat concludes the mouse
 * has stopped. The intended delta stays truthful there, and it is the only
 * thing anyone measures speed from.
 */
function startCursor(onMove, hz = 60) {
  stopCursor();

  cursorTimer = setInterval(() => {
    // This is the app's single input tick. The evdev reader deliberately owns
    // no timer of its own (see evdev-linux.js): pumping it here costs no extra
    // wakeup, and draining immediately BEFORE the sampler below means raw
    // deltas are consumed in the same tick they arrived rather than the next.
    if (evdev) evdev.drain();

    let native;
    try {
      native = screen.getCursorScreenPoint();
    } catch {
      return;
    }

    // The FIRST sample seeds the estimate but must not count as movement.
    // Treating it as movement used to promote a frozen point to "tracked" on
    // the very first poll, which re-enabled hit-testing against a coordinate
    // that never moves again — the cat then went click-through forever.
    const prev = lastNative;
    lastNative = native;
    if (!haveEst) {
      est.x = native.x;
      est.y = native.y;
      haveEst = true;
      // Everywhere but Wayland the seed is a real position and the cat can look
      // at it straight away, without waiting for the mouse to be jiggled.
      anchored = !isWayland();
    }

    const rawDx = accum.dx;
    const rawDy = accum.dy;
    accum.dx = 0;
    accum.dy = 0;
    const rawMag = Math.hypot(rawDx, rawDy);

    const nativeMoved = !!prev && (native.x !== prev.x || native.y !== prev.y);

    // How far the pointer travelled this tick, in DIP, before any clamping.
    let dx = 0;
    let dy = 0;
    let exact = false;

    if (nativeMoved) {
      /*
       * Was the native point tracking on the PREVIOUS tick too?
       *
       * This is the difference between a measurement and a catch-up. On
       * XWayland the point sits frozen for as long as the pointer is over a
       * Wayland window, and then, the instant it crosses back onto one of ours,
       * leaps the entire distance in a single tick. That leap is a true
       * position — anchoring to it is right — but it is emphatically not one
       * tick's worth of travel, and averaging it in as though it were taught a
       * gain a third too high, which then made dead reckoning overshoot every
       * time the pointer was out of sight.
       *
       * Requiring both ends of the interval to be live is what makes it an
       * interval. It costs the first tick after any pause and nothing else.
       */
      const measured = nativeRunning;
      if (measured || rawMag === 0) {
        dx = native.x - prev.x;
        dy = native.y - prev.y;
      } else {
        // A catch-up. The raw deltas are the honest account of how far the
        // mouse moved this tick; the leap on screen is bookkeeping, and
        // reporting it as speed would have the cat bolt after a stationary
        // pointer.
        const sf = scaleAt(est.x, est.y);
        dx = (rawDx * gain) / sf;
        dy = (rawDy * gain) / sf;
      }
      anchor(native.x, native.y);
      exact = true;

      // Calibrate. Only ticks where both sources spoke over the same single
      // tick are comparable, which is exactly the condition guarded above.
      if (measured && rawMag > 0) {
        learnNative += Math.hypot(native.x - prev.x, native.y - prev.y) * scaleAt(native.x, native.y);
        learnRaw += rawMag;
        if (learnRaw >= LEARN_MIN_RAW) {
          const observed = learnNative / learnRaw;
          // Reject the impossible rather than average it in: a pointer warped
          // across the screen by the compositor, or a display hotplug, would
          // otherwise teach a gain that takes minutes to unlearn.
          if (observed > 0.15 && observed < 4) {
            // How much this measurement disagrees with what we believed is the
            // best available evidence of how well we believe it.
            const rel = Math.abs(observed - gain) / Math.max(0.2, gain);
            gainErr = clamp(gainErr * 0.7 + rel * 0.3, GAIN_ERR_FLOOR, GAIN_ERR_CEIL);
            gain += (observed - gain) * LEARN_RATE;
          }
          learnNative = 0;
          learnRaw = 0;
        }
      }
    } else if (rawMag > 0) {
      const sf = scaleAt(est.x, est.y);
      dx = (rawDx * gain) / sf;
      dy = (rawDy * gain) / sf;

      const b = desktopBounds();
      const nx = clamp(est.x + dx, b.x0, b.x1 - 1);
      const ny = clamp(est.y + dy, b.y0, b.y1 - 1);

      /*
       * The edges are a free correction, and the one users perform constantly
       * without being asked to. The real cursor stops dead at the edge of the
       * desktop; so does the estimate. So if we are pinned against an edge and
       * the mouse is still being shoved further that way, that axis is not a
       * guess any more — it is known, and its drift resets.
       */
      const pinnedX = (dx < 0 && nx <= b.x0) || (dx > 0 && nx >= b.x1 - 1);
      const pinnedY = (dy < 0 && ny <= b.y0) || (dy > 0 && ny >= b.y1 - 1);
      driftX = pinnedX ? 0 : driftX + Math.abs(dx);
      driftY = pinnedY ? 0 : driftY + Math.abs(dy);

      est.x = nx;
      est.y = ny;
    }

    /*
     * Which regime is this? Answered from accumulated evidence and re-answered
     * at most once a second — never from one sample.
     *
     * This gates click-through, and click-through is the one thing that MUST
     * NOT change at pointer speed. A hit test driven by a point that is exact
     * only while the pointer is over an X surface would make the window flip
     * interactive and back several times a second, so the cat would go
     * untouchable mid-stroke. Being conservative here costs a window that
     * absorbs clicks in its padding; being wrong costs the whole personality.
     */
    // Only ticks with a decisive amount of motion are admitted as evidence. A
    // single device pixel may legitimately not move the integer native point at
    // all, and counting those misses would convict a perfectly good X11 session
    // of being frozen the moment someone nudged the mouse slowly.
    if (rawMag >= EVIDENCE_MIN_RAW) {
      evidenceRaw += rawMag;
      if (nativeMoved) witnessedRaw += rawMag;
    }
    const nowMs = Date.now();
    if (nowMs - lastVerdict >= VERDICT_MS) {
      lastVerdict = nowMs;
      // Nothing to judge without raw deltas to judge against — which is the
      // case on Windows, macOS and any X11 session where uiohook worked, so
      // those keep the startup verdict and this block never touches them.
      if (evidenceRaw >= VERDICT_MIN_RAW) {
        const seen = witnessedRaw / evidenceRaw;
        status.cursor =
          seen >= 0.95
            ? "native"
            : seen > 0.05
              ? "hybrid"
              : evdev && evdev.hasRelDevice
                ? "evdev"
                : "frozen";
        /*
         * The verdict may only ever take hit-testing AWAY, never grant it.
         *
         * The two directions are not symmetrical. Losing it costs a window that
         * absorbs clicks in its padding — irritating, survivable, and exactly
         * what this app already did. Gaining it wrongly costs the cat: the
         * window starts hit-testing against a point that is about to freeze,
         * and a frozen point away from the cat means every click falls through
         * it forever. And a hybrid session can easily look perfect for a second
         * at a time — moving the pointer ONTO the cat is motion across an X
         * surface — so a promotion rule would fire on exactly the sessions it
         * must not.
         */
        if (seen < 0.95) status.hitTest = false;
      } else if (evdev && isWayland() && !evdev.hasRelDevice) {
        /*
         * Nothing connected can report relative motion — a touchpad-only
         * machine, where the pointer genuinely cannot be followed at all. This
         * is the ONLY thing that may be called frozen without evidence: "we
         * have not seen the mouse move yet" is not the same statement, and
         * saying it as one had a perfectly working session announce itself as
         * broken for as long as nobody touched the mouse.
         */
        status.cursor = "frozen";
        status.hitTest = false;
      }
      evidenceRaw *= VERDICT_DECAY;
      witnessedRaw *= VERDICT_DECAY;
    }

    nativeRunning = nativeMoved;

    const expectedErr = Math.max(driftX, driftY) * gainErr;
    const conf = !anchored ? 0 : exact ? 1 : 1 / (1 + expectedErr / CONF_TOL);
    status.conf = Math.round(conf * 100) / 100;
    status.gain = Math.round(gain * 100) / 100;
    status.gainErr = Math.round(gainErr * 100) / 100;

    onMove({
      x: Math.round(est.x),
      y: Math.round(est.y),
      dx,
      dy,
      exact,
      conf,
      hitTest: status.hitTest,
    });
  }, Math.round(1000 / hz));
}

function stopCursor() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
}

function startGlobal({ onKey, onWheel }) {
  const wayland = isWayland();

  // Wayland: skip uiohook entirely. It doesn't fail cleanly, it fails loudly
  // (XkbGetKeyboard errors on stderr) and then delivers nothing.
  if (process.platform === "linux" && (wayland || !tryHook({ onKey, onWheel }))) {
    const { EvdevReader } = require("./evdev-linux");
    evdev = new EvdevReader({
      onKey: () => onKey && onKey(),
      onWheel: (v) => onWheel && onWheel({ rotation: v }),
      onMove: (dx, dy) => {
        accum.dx += dx;
        accum.dy += dy;
      },
      onButton: () => {},
    });
    // NOTE: the reader is inert until something calls drain() — startCursor()
    // is what pumps it, so it must be running for typing detection to work too.
    if (evdev.start()) {
      status.keyboard = "evdev";
      status.source = "/dev/input";
      // Start pessimistic on Wayland and let the verdict promote us if the
      // native point turns out to work after all. On X11 it always does.
      status.hitTest = !wayland;
      status.cursor = wayland ? (evdev.hasRelDevice ? "evdev" : "frozen") : "native";
      status.detail = !wayland
        ? "Reading /dev/input directly. Key codes are discarded."
        : evdev.hasRelDevice
          ? "Wayland hides global input, so it is read from /dev/input instead. Key codes are discarded — only the fact that a key moved is used. The pointer is estimated between the moments it can be seen exactly, so the cat's gaze follows it everywhere but its window stays interactive rather than hit-testing a guess."
          : "Typing is read from /dev/input. No connected device reports relative pointer motion — a laptop touchpad reports absolute finger positions, which cannot be dead-reckoned — so the cat only follows the pointer while it is near.";
    } else {
      evdev = null;
      status.keyboard = "unsupported";
      status.source = "none";
      // No global source at all. The renderer falls back to its own pointer
      // events, so the cat still reacts when the cursor is over it.
      status.hitTest = !wayland;
      status.cursor = wayland ? "frozen" : "native";
      status.detail = wayland
        ? "Wayland hides global input and /dev/input is not readable, so the cat only reacts when the pointer is over it. To enable full tracking: sudo usermod -aG input $USER — then log out and back in."
        : "/dev/input is not readable. Run: sudo usermod -aG input $USER, then log out and back in.";
    }
    return status;
  }

  if (process.platform !== "linux") tryHook({ onKey, onWheel });
  return status;
}

// The same 50ms evdev-linux.js notches a Linux touchpad at, for the same reason
// and so both platforms feel identical.
const WHEEL_NOTCH_MS = 50;
// Sub-notch reports needed before a drag counts as a scroll at all. A precision
// touchpad reports a resting finger's tremor; one message is not a gesture.
const WHEEL_SUBSTEPS = 3;

/*
 * Wraps a wheel consumer so it sees notches instead of whatever the platform
 * happened to send. Exported for tools/wheel-sim.js, which drives it with a
 * captured Windows precision-touchpad stream — the regime this machine cannot
 * be in, and therefore the one that has to be tested without it.
 */
function notchWheel(onWheel, now = () => Date.now()) {
  let dir = 0; // last direction actually observed — never guessed
  let steps = 0; // sub-notch reports since the last one passed on
  let last = 0;

  return (rotation) => {
    const t = now();
    if (rotation) {
      // A whole notch. A fact, so it is not delayed and not rate-limited.
      dir = Math.sign(rotation);
      steps = 0;
      last = t;
      onWheel({ rotation });
      return;
    }
    // Travel keeps accumulating while the gate is shut, so slowing a drag down
    // makes the reports sparse rather than making them stop.
    if (++steps < WHEEL_SUBSTEPS) return;
    if (t - last < WHEEL_NOTCH_MS) return;
    steps = 0;
    last = t;
    /*
     * `dir` is 0 until the first whole notch of the session, which on a
     * precision touchpad is 120 units of travel away. The renderer already has a
     * rule for a report with no direction — keep going the way the ball is
     * already going — and that is the right answer for the first flick.
     *
     * It is also deliberately not cleared between gestures, which means the
     * first 120 units of a scroll that REVERSES carry the old direction and the
     * ball sets off the wrong way before correcting itself. That is a real
     * wrongness and it is the best available: the sign of a sub-notch step is
     * discarded inside libuiohook before we are handed anything, so there is
     * nothing here to read it from. Remembering the last direction still beats
     * remembering nothing, because scrolling the same way twice is much more
     * common than turning around.
     */
    onWheel({ rotation: dir });
  };
}

function tryHook({ onKey, onWheel }) {
  let uIOhook;
  try {
    ({ uIOhook } = require("uiohook-napi"));
  } catch (err) {
    status.keyboard = "unsupported";
    status.detail = `Native input hook unavailable (${err.code || err.message}).`;
    return false;
  }
  try {
    uIOhook.on("keydown", () => onKey && onKey());
    if (onWheel) {
      const notched = notchWheel(onWheel);
      uIOhook.on("wheel", (e) => notched((e && e.rotation) || 0));
    }
    uIOhook.start();
    hook = uIOhook;
    status.keyboard = "ok";
    status.source = "uiohook";
    if (process.platform === "darwin") {
      status.detail =
        "If typing reactions do nothing, grant Accessibility permission in System Settings > Privacy & Security > Accessibility.";
    }
    return true;
  } catch (err) {
    status.keyboard = process.platform === "darwin" ? "denied" : "error";
    status.detail = err.message;
    return false;
  }
}

function stopGlobal() {
  if (hook) {
    try {
      hook.stop();
    } catch {}
    hook = null;
  }
  if (evdev) {
    evdev.stop();
    evdev = null;
  }
}

module.exports = {
  startCursor,
  stopCursor,
  startGlobal,
  stopGlobal,
  syncCursor,
  notchWheel,
  status,
};
