/*
 * input.js — cross-platform global input, with a source per platform reality.
 *
 * CURSOR
 * `screen.getCursorScreenPoint()` is correct on Windows, macOS and Linux/X11
 * and useless on Wayland, where it returns a frozen coordinate forever. So the
 * cursor is a HYBRID: we poll the native point, and whenever it actually
 * changes we trust it outright. If it stops changing while raw device deltas
 * are still arriving, we dead-reckon from those instead.
 *
 * That self-selects the right source at runtime with no platform branching:
 * on X11/Win/macOS the native point moves and always wins; on Wayland it never
 * moves and evdev drives. It also survives a session type we've never seen.
 *
 * Dead reckoning drifts, because the compositor applies pointer acceleration
 * we can't observe. The saving grace is that the real cursor stops at the
 * screen edges and so does ours — so shoving the mouse into a corner resyncs
 * the two exactly. Users do this constantly without being asked to.
 *
 * KEYBOARD
 * uiohook where it works; /dev/input where it doesn't.
 */
const { screen } = require("electron");

const status = {
  cursor: "native", // native | evdev | frozen
  keyboard: "pending", // ok | evdev | unsupported | denied | error
  detail: "",
  source: "",
};

let cursorTimer = null;
let hook = null;
let evdev = null;

// Decided once at startup, not inferred from "the pointer hasn't moved lately"
// — an idle mouse is indistinguishable from a frozen one, and flapping between
// modes would make the window steal clicks every time the user paused.
function isWayland() {
  return process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
}

// Raw device deltas accumulated between cursor polls.
const accum = { dx: 0, dy: 0 };
let virtual = null;
let lastNative = null;
let nativeStaleFor = 0;
let gain = 1;

function setGain(g) {
  gain = Math.max(0.2, Math.min(4, Number(g) || 1));
}

// Union of every display, so dead reckoning clamps to the real desktop and
// picks up the edge-resync behaviour described above.
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

function startCursor(onMove, hz = 60) {
  stopCursor();
  let prev = null;

  cursorTimer = setInterval(() => {
    let native;
    try {
      native = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    if (!virtual) virtual = { x: native.x, y: native.y };

    // The FIRST sample must not count as movement. Treating it as movement
    // flipped `frozen` straight back to `native` on the very first poll, which
    // re-enabled hit-testing against a cursor that never moves again — the cat
    // then became click-through forever and could not be hovered or petted.
    const nativeMoved =
      !!lastNative && (native.x !== lastNative.x || native.y !== lastNative.y);
    lastNative = native;

    if (nativeMoved) {
      // The display server is telling us the truth; take it and drop whatever
      // we'd accumulated, so the two sources can never fight.
      virtual.x = native.x;
      virtual.y = native.y;
      accum.dx = 0;
      accum.dy = 0;
      nativeStaleFor = 0;
      if (status.cursor === "frozen") status.cursor = "native";
    } else if (accum.dx || accum.dy) {
      const b = desktopBounds();
      virtual.x = Math.max(b.x0, Math.min(b.x1 - 1, virtual.x + accum.dx * gain));
      virtual.y = Math.max(b.y0, Math.min(b.y1 - 1, virtual.y + accum.dy * gain));
      accum.dx = 0;
      accum.dy = 0;
    } else {
      nativeStaleFor++;
    }

    const p = { x: Math.round(virtual.x), y: Math.round(virtual.y) };
    const dx = prev ? p.x - prev.x : 0;
    const dy = prev ? p.y - prev.y : 0;
    prev = p;
    onMove(p, dx, dy);
  }, Math.round(1000 / hz));
}

function stopCursor() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
}

function startGlobal({ onKey, onWheel }) {
  const isWayland =
    process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";

  // Wayland: skip uiohook entirely. It doesn't fail cleanly, it fails loudly
  // (XkbGetKeyboard errors on stderr) and then delivers nothing.
  if (process.platform === "linux" && (isWayland || !tryHook({ onKey, onWheel }))) {
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
    if (evdev.start()) {
      status.keyboard = "evdev";
      status.source = "/dev/input";
      status.cursor = "evdev";
      status.detail = isWayland
        ? "Wayland hides global input, so it is read from /dev/input instead. Key codes are discarded — only the fact that a key moved is used."
        : "Reading /dev/input directly. Key codes are discarded.";
    } else {
      evdev = null;
      status.keyboard = "unsupported";
      status.source = "none";
      // No global source at all. The renderer falls back to its own pointer
      // events, so the cat still reacts when the cursor is over it.
      status.cursor = isWayland ? "frozen" : "native";
      status.detail = isWayland
        ? "Wayland hides global input and /dev/input is not readable, so the cat only reacts when the pointer is over it. To enable full tracking: sudo usermod -aG input $USER — then log out and back in."
        : "/dev/input is not readable. Run: sudo usermod -aG input $USER, then log out and back in.";
    }
    return status;
  }

  if (process.platform !== "linux") tryHook({ onKey, onWheel });
  return status;
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
    if (onWheel) uIOhook.on("wheel", (e) => onWheel({ rotation: e.rotation || 0 }));
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

module.exports = { startCursor, stopCursor, startGlobal, stopGlobal, status, setGain };
