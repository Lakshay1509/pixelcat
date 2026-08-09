/*
 * evdev-linux.js — global input on Linux by reading /dev/input directly.
 *
 * WHY THIS EXISTS
 * Wayland deliberately refuses to tell an application where the pointer is or
 * what keys are being pressed while it isn't focused. On a KDE Wayland session
 * `screen.getCursorScreenPoint()` returns a frozen coordinate (measured: the
 * identical point 60/60 samples) and uiohook's X11 hook fails outright with
 * `XkbGetKeyboard failed to locate a valid keyboard`. Both input tiers are
 * blind, which kills eye-follow, mouse-hunt, petting and kneading — i.e. the
 * whole personality.
 *
 * Reading the evdev character devices bypasses the display server entirely. It
 * needs no root and no portal dialog, only membership of the `input` group,
 * which most desktop distributions already grant.
 *
 * WHY THE READS ARE NON-BLOCKING AND POLLED
 * The obvious implementation — hand each device to `fs.createReadStream` — is a
 * trap that deadlocks the whole app. Node services `fs` reads on the libuv
 * threadpool, which has FOUR threads by default, and a read on an evdev node
 * blocks until that particular device has something to say. A laptop exposes
 * ~20 event nodes and most of them (lid switch, power button, PC speaker, every
 * HDMI audio jack) stay silent for the entire session, so the first four reads
 * park a worker thread each and never return. The pool is then starved: every
 * async `fs` call in the main process hangs forever, the pet window never
 * finishes loading, and the process can no longer even exit cleanly.
 *
 * It only looked fine before because without `input` group membership every
 * open() failed, so no reads were ever issued.
 *
 * The fix is to keep the reads off the threadpool entirely. libuv can't epoll
 * these — `uv_guess_handle` classifies a character device as UV_FILE, so
 * `net.Socket({ fd })` rejects it with ERR_INVALID_FD_TYPE. So the fds are
 * opened O_NONBLOCK and drained with `readSync`: an empty device returns EAGAIN
 * immediately instead of parking a thread. Nothing is lost by polling because
 * the kernel queues events per-fd between ticks.
 *
 * `drain()` does NOT run itself on a timer. input.js pumps it from the cursor
 * poll it already runs at 60 Hz, because a second timer of our own would cost a
 * redundant wakeup (measured: ~1% of a core just to wake and do nothing) and
 * would land pointer deltas a tick late — the cursor sampler would consume
 * `accum` moments before this refilled it. Draining at the top of that tick
 * makes the two exactly in phase.
 *
 * WHY SCROLL IS SYNTHESISED FROM FINGERS
 * A mouse wheel emits REL_WHEEL and there is nothing to do. A laptop touchpad
 * emits NOTHING of the sort: scrolling on one is not a hardware event, it is an
 * interpretation. The kernel reports where each finger is (EV_ABS multitouch)
 * and libinput decides in userspace that two of them moving together means
 * scroll. We bypass libinput to see the pointer at all, so we inherit that job
 * too — otherwise the yarn ball only ever answers to a plugged-in mouse, which
 * is exactly how this read.
 *
 * So a two-finger drag is turned into wheel ticks here: see touchFrame. The
 * threshold is a fraction of the pad's own height rather than a count of device
 * units, because those units have no fixed size — pads differ by around 5x in
 * how many they report per millimetre, and the range cannot be read without an
 * ioctl Node has no way to issue. The height is learned from the finger
 * positions themselves instead, which costs nothing and converges within a
 * swipe or two.
 *
 * PRIVACY
 * This can see every keystroke on the machine, so it deliberately sees as
 * little as possible: only devices that can actually produce key or pointer
 * events are opened at all, key events are reduced to "a key went down", and
 * the key CODE IS DISCARDED IMMEDIATELY. Nothing is buffered, logged or written
 * to disk. The cat only ever needs to know that you are typing and roughly how
 * fast — never what you typed. Touch positions are differenced into a scroll
 * direction on arrival and likewise never kept.
 */
const fs = require("fs");
const path = require("path");

// struct input_event on 64-bit Linux:
//   __kernel_ulong_t tv_sec, tv_usec (8 + 8)
//   __u16 type, __u16 code, __s32 value (2 + 2 + 4)
const EVENT_SIZE = 24;

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const EV_ABS = 0x03;

const SYN_REPORT = 0x00;

const REL_X = 0x00;
const REL_Y = 0x01;
const REL_HWHEEL = 0x06;
const REL_WHEEL = 0x08;

// Slot-based multitouch: which finger the following events describe, where it
// is, and whether it is still there (a tracking id of -1 means it lifted).
const ABS_MT_SLOT = 0x2f;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_TRACKING_ID = 0x39;

const BTN_LEFT = 0x110;
// "Two fingers are on the pad", according to the pad. Only used as a fallback
// for devices that never report tracking ids — counting live slots is exact.
const BTN_TOOL_DOUBLETAP = 0x14d;

// More than a hand, and every real pad reports far fewer. Slots beyond this are
// ignored rather than folded onto slot 9, which would difference one finger's
// position against another's.
const MAX_SLOTS = 10;

// --- turning a two-finger drag into wheel ticks ------------------------------
// How far the fingers must travel for one tick, as a fraction of the pad's
// height. 1/50 is about a millimetre on a normal pad: deliberate enough that
// resting two fingers and breathing does not scroll, small enough that the ball
// answers the moment you mean it to.
const TOUCH_SCROLL_FRACTION = 1 / 50;
// Until the pad has been used enough to have shown its height, assume this.
// Wrong by 2x in either direction merely makes the first swipe eager or lazy.
const TOUCH_SPAN_ASSUMED = 1000;
// Below this, what we have seen is one small swipe rather than the pad.
const TOUCH_SPAN_MIN = 400;
const TOUCH_UNIT_MIN = 4;
// A real wheel notches; a finger is continuous and would otherwise report at
// the pad's full ~125 Hz. This is what makes a touchpad scroll FEEL like a
// wheel rather than like a firehose.
const TOUCH_EMIT_MS = 50;
// Ticks per report, capped so a batched drain cannot hand over a wild number.
const TOUCH_MAX_TICKS = 3;

// 2730 events per read. A 1000 Hz mouse produces ~17 per tick, so one read
// normally drains a device outright and the drain loop exits on the first pass.
const READ_BUF = 64 * 1024;
// A device that somehow never stops yielding must not wedge the tick.
const MAX_READS_PER_TICK = 64;

// How often to look for devices that appeared or vanished. Plugging in a mouse
// must start it working without relaunching the app.
const RESCAN_MS = 2000;

/*
 * Which nodes are worth opening, and what each can tell us. `B: EV=` in
 * /proc/bus/input/devices is a bitmask of supported event types; we need EV_KEY
 * (bit 1) or EV_REL (bit 2) and nothing else can tell us anything. That drops
 * the switch-only and sound-only nodes — lid switch, PC speaker, every audio
 * jack — which is both less to poll and less that we can see.
 *
 * The EV_REL flag is carried per device because it is the difference between a
 * device that can drive the cursor and one that cannot. A laptop touchpad
 * reports EV_ABS (finger coordinates) and no EV_REL at all, so it contributes
 * nothing to dead reckoning no matter how much it is used — see hasRelDevice.
 * It is also what decides who gets the finger-scroll treatment: a device that
 * reports a wheel of its own is left alone, so an Apple trackpad — whose kernel
 * driver hands us BOTH touch data and a REL_WHEEL it derived from that same
 * data — cannot be counted twice.
 *
 * Returns null if /proc is unreadable or the format isn't what we expect, which
 * means "open everything" — the old behaviour, and harmless now that an idle
 * device costs one EAGAIN per tick rather than a wedged thread.
 */
function deviceCaps() {
  let text;
  try {
    text = fs.readFileSync("/proc/bus/input/devices", "utf8");
  } catch {
    return null;
  }

  const caps = new Map();
  for (const block of text.split("\n\n")) {
    const ev = /^B: EV=([0-9a-f]+)/m.exec(block);
    const handlers = /^H: Handlers=(.*)$/m.exec(block);
    if (!ev || !handlers) continue;

    // Bit N of the mask means "event type N supported", and the type constants
    // ARE those bit positions — EV_KEY is type 1, EV_REL is type 2. Event types
    // top out at 0x1f, so the mask always fits the 32 bits `>>` gives us.
    const bits = parseInt(ev[1], 16);
    if (!Number.isFinite(bits)) continue;
    const key = !!((bits >> EV_KEY) & 1);
    const rel = !!((bits >> EV_REL) & 1);
    if (!key && !rel) continue;

    for (const h of handlers[1].split(/\s+/)) {
      if (/^event\d+$/.test(h)) caps.set(h, { rel });
    }
  }
  return caps.size ? caps : null;
}

/*
 * Per-device finger bookkeeping, created only once a device turns out to have a
 * touch surface. Everything here is either a position being differenced away
 * immediately or a running total of travel; nothing about the gesture outlives
 * the gesture.
 */
function newTouch() {
  return {
    slot: 0,
    x: new Array(MAX_SLOTS).fill(NaN),
    y: new Array(MAX_SLOTS).fill(NaN),
    down: new Array(MAX_SLOTS).fill(false),
    fingers: 0,
    doubletap: false,
    // This frame's travel, summed over the fingers that reported it.
    dx: 0,
    nx: 0,
    dy: 0,
    ny: 0,
    // Travel since the last tick was emitted.
    accX: 0,
    accY: 0,
    // The pad's height, learned from where fingers have actually been.
    lo: Infinity,
    hi: -Infinity,
    lastEmit: 0,
  };
}

function isTouchCode(code) {
  return (
    code === ABS_MT_SLOT ||
    code === ABS_MT_TRACKING_ID ||
    code === ABS_MT_POSITION_X ||
    code === ABS_MT_POSITION_Y
  );
}

// Exactly two fingers, which is what scrolling is. Three is a gesture the
// desktop owns and one is the pointer. The doubletap fallback only applies to a
// pad that never told us about slots at all.
function isScrolling(t) {
  return t.fingers === 2 || (t.fingers === 0 && t.doubletap);
}

class EvdevReader {
  constructor(handlers) {
    this.handlers = handlers;
    this.devices = [];
    this.open = new Set(); // node names we already hold an fd for
    this.available = false;
    // Whether anything currently open can report relative pointer motion. The
    // cursor logic keys off this: a box with only a touchpad has keyboard input
    // but no way to dead-reckon a pointer.
    this.hasRelDevice = false;
    this.lastScan = 0;
    this.buf = Buffer.allocUnsafe(READ_BUF);
  }

  start() {
    this.scan();
    this.available = this.devices.length > 0;
    if (!this.available) {
      this.error =
        "no readable devices in /dev/input — add your user to the `input` group and log back in";
    }
    return this.available;
  }

  /*
   * Open every device we aren't already reading.
   *
   * This re-runs periodically rather than once at startup because devices come
   * and go: a USB mouse plugged in after launch used to be invisible forever,
   * which looked exactly like broken cursor tracking — the hardware emitted
   * REL_X/REL_Y the whole time and nothing was listening. Devices that vanish
   * are dropped by the read error in drain() instead, so this only ever adds.
   */
  scan() {
    this.lastScan = Date.now();
    let dir;
    try {
      dir = fs.readdirSync("/dev/input");
    } catch (err) {
      this.error = `cannot list /dev/input: ${err.code}`;
      return;
    }

    const caps = deviceCaps();
    for (const node of dir) {
      if (!/^event\d+$/.test(node) || this.open.has(node)) continue;
      const cap = caps ? caps.get(node) : null;
      if (caps && !cap) continue; // can produce neither keys nor pointer motion

      let fd;
      try {
        // O_NONBLOCK is the whole point — see the header. Without it this read
        // parks a libuv worker thread until the device happens to fire.
        fd = fs.openSync(path.join("/dev/input", node), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      } catch {
        continue; // not permitted, or the device vanished — both are fine
      }
      // No caps at all means /proc told us nothing; assume it might be a mouse
      // rather than declaring the cursor dead on a machine we can't inspect.
      this.devices.push({ node, fd, rel: cap ? cap.rel : true });
      this.open.add(node);
    }

    this.hasRelDevice = this.devices.some((d) => d.rel);
  }

  drain() {
    if (Date.now() - this.lastScan >= RESCAN_MS) this.scan();

    // Reverse order so closing a hot-unplugged device mid-iteration is safe.
    for (let i = this.devices.length - 1; i >= 0; i--) {
      const dev = this.devices[i];
      for (let n = 0; n < MAX_READS_PER_TICK; n++) {
        let bytes;
        try {
          bytes = fs.readSync(dev.fd, this.buf, 0, this.buf.length, null);
        } catch (err) {
          // EAGAIN is the overwhelmingly common case: the device is simply idle.
          if (err.code !== "EAGAIN" && err.code !== "EWOULDBLOCK") this.closeAt(i);
          break;
        }
        if (bytes <= 0) break;
        this.consume(dev, this.buf, bytes);
        if (bytes < this.buf.length) break; // buffer wasn't filled, so it's drained
      }
    }
  }

  // evdev only ever hands back whole structs, but floor the length anyway so a
  // surprise short read can't shift every subsequent field by a few bytes.
  consume(dev, buf, length) {
    const end = length - (length % EVENT_SIZE);
    for (let off = 0; off < end; off += EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);

      if (type === EV_REL) {
        if (code === REL_X) this.handlers.onMove(value, 0);
        else if (code === REL_Y) this.handlers.onMove(0, value);
        else if (code === REL_WHEEL || code === REL_HWHEEL) this.handlers.onWheel(value);
      } else if (type === EV_KEY) {
        if (dev.touch && code === BTN_TOOL_DOUBLETAP) {
          dev.touch.doubletap = value === 1;
          // The gesture just changed shape, so travel banked under the old one
          // is not part of this scroll.
          dev.touch.accX = 0;
          dev.touch.accY = 0;
        } else if (value === 1) {
          if (code >= BTN_LEFT) this.handlers.onButton(code);
          // Keyboard: report the fact, drop the code. See PRIVACY above.
          else if (code >= 1 && code <= 255) this.handlers.onKey();
        }
      } else if (type === EV_ABS && !dev.rel && isTouchCode(code)) {
        if (!dev.touch) dev.touch = newTouch();
        this.touchAbs(dev.touch, code, value);
      } else if (type === EV_SYN && code === SYN_REPORT && dev.touch) {
        // A touch frame is only complete at SYN_REPORT: every finger that moved
        // has now reported, so this is the one moment they can be averaged.
        this.touchFrame(dev.touch);
      }
    }
  }

  touchAbs(t, code, value) {
    if (code === ABS_MT_SLOT) {
      t.slot = value;
      return;
    }
    const s = t.slot;
    if (s < 0 || s >= MAX_SLOTS) return;

    if (code === ABS_MT_TRACKING_ID) {
      const live = value >= 0;
      if (live !== t.down[s]) {
        t.down[s] = live;
        t.fingers += live ? 1 : -1;
        // Which fingers are being averaged just changed, so a part-finished
        // tick belongs to a gesture that no longer exists.
        t.accX = 0;
        t.accY = 0;
      }
      // Either way this slot has no usable previous position: a finger that has
      // just landed has none, and one that lifted must not be differenced
      // against whichever finger next occupies its slot — that subtraction is a
      // jump across the pad, and it would fire a tick every time you re-grip.
      t.x[s] = NaN;
      t.y[s] = NaN;
      return;
    }

    if (code === ABS_MT_POSITION_X) {
      if (isScrolling(t) && Number.isFinite(t.x[s])) {
        t.dx += value - t.x[s];
        t.nx++;
      }
      t.x[s] = value;
      return;
    }

    // ABS_MT_POSITION_Y. Every finger that touches down anywhere widens what we
    // know of the pad's height, including the ones that are not scrolling.
    if (value < t.lo) t.lo = value;
    if (value > t.hi) t.hi = value;
    if (isScrolling(t) && Number.isFinite(t.y[s])) {
      t.dy += value - t.y[s];
      t.ny++;
    }
    t.y[s] = value;
  }

  touchFrame(t) {
    // Average the fingers that moved rather than summing them: two fingers
    // travelling together are one scroll, not two. It also makes a pinch cancel
    // out, which is right — a pinch is not a scroll.
    if (t.ny) {
      t.accY += t.dy / t.ny;
      t.dy = 0;
      t.ny = 0;
    }
    if (t.nx) {
      t.accX += t.dx / t.nx;
      t.dx = 0;
      t.nx = 0;
    }
    if (!t.accX && !t.accY) return;

    // Notch the scroll. Travel keeps accumulating in between, so slowing down
    // makes the ticks sparse rather than making them stop.
    const now = Date.now();
    if (now - t.lastEmit < TOUCH_EMIT_MS) return;

    const seen = t.hi - t.lo;
    const span = seen >= TOUCH_SPAN_MIN ? seen : TOUCH_SPAN_ASSUMED;
    const unit = Math.max(TOUCH_UNIT_MIN, span * TOUCH_SCROLL_FRACTION);

    // One axis at a time, so a scroll that wanders diagonally still reads as
    // the direction it is mostly going.
    const vertical = Math.abs(t.accY) >= Math.abs(t.accX);
    const travel = vertical ? t.accY : t.accX;
    if (Math.abs(travel) < unit) return;

    t.lastEmit = now;
    t.accX = 0;
    t.accY = 0;

    const ticks = Math.max(-TOUCH_MAX_TICKS, Math.min(TOUCH_MAX_TICKS, Math.trunc(travel / unit)));
    // REL_WHEEL counts upwards as positive and the pad's Y counts downwards, so
    // vertical travel is negated. REL_HWHEEL and the pad's X already agree.
    this.handlers.onWheel(vertical ? -ticks : ticks);
  }

  closeAt(i) {
    const dev = this.devices[i];
    if (!dev) return;
    try {
      fs.closeSync(dev.fd);
    } catch {}
    this.devices.splice(i, 1);
    this.open.delete(dev.node);
    // Unplugging the only mouse has to be noticed: the cursor logic falls back
    // to leaving the window interactive, otherwise the cat would hit-test
    // against a position that has quietly stopped updating.
    this.hasRelDevice = this.devices.some((d) => d.rel);
  }

  stop() {
    for (let i = this.devices.length - 1; i >= 0; i--) this.closeAt(i);
    this.available = false;
    this.hasRelDevice = false;
  }
}

module.exports = { EvdevReader };
