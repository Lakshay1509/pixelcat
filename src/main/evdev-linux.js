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
 * PRIVACY
 * This can see every keystroke on the machine, so it deliberately sees as
 * little as possible: key events are reduced to "a key went down" and the key
 * CODE IS DISCARDED IMMEDIATELY. Nothing is buffered, logged or written to
 * disk. The cat only ever needs to know that you are typing and roughly how
 * fast — never what you typed.
 */
const fs = require("fs");
const path = require("path");

// struct input_event on 64-bit Linux:
//   __kernel_ulong_t tv_sec, tv_usec (8 + 8)
//   __u16 type, __u16 code, __s32 value (2 + 2 + 4)
const EVENT_SIZE = 24;

const EV_KEY = 0x01;
const EV_REL = 0x02;

const REL_X = 0x00;
const REL_Y = 0x01;
const REL_HWHEEL = 0x06;
const REL_WHEEL = 0x08;

const BTN_LEFT = 0x110;

class EvdevReader {
  constructor(handlers) {
    this.handlers = handlers;
    this.streams = [];
    this.available = false;
  }

  start() {
    let dir;
    try {
      dir = fs.readdirSync("/dev/input");
    } catch (err) {
      this.error = `cannot list /dev/input: ${err.code}`;
      return false;
    }

    const nodes = dir.filter((n) => /^event\d+$/.test(n));
    for (const node of nodes) {
      const file = path.join("/dev/input", node);
      let fd;
      try {
        fd = fs.openSync(file, "r");
      } catch {
        continue; // not permitted, or the device vanished — both are fine
      }

      const stream = fs.createReadStream("", { fd, autoClose: true });
      stream.on("error", () => {}); // hot-unplug is normal, not exceptional
      stream.on("data", (buf) => this.consume(buf));
      this.streams.push(stream);
    }

    this.available = this.streams.length > 0;
    if (!this.available) {
      this.error =
        "no readable devices in /dev/input — add your user to the `input` group and log back in";
    }
    return this.available;
  }

  consume(buf) {
    // A read can straddle struct boundaries; only whole events are parsed and
    // any tail is carried into the next chunk.
    if (this.tail) {
      buf = Buffer.concat([this.tail, buf]);
      this.tail = null;
    }
    let off = 0;
    while (buf.length - off >= EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);
      off += EVENT_SIZE;

      if (type === EV_REL) {
        if (code === REL_X) this.handlers.onMove(value, 0);
        else if (code === REL_Y) this.handlers.onMove(0, value);
        else if (code === REL_WHEEL || code === REL_HWHEEL) this.handlers.onWheel(value);
      } else if (type === EV_KEY && value === 1) {
        if (code >= BTN_LEFT) this.handlers.onButton(code);
        // Keyboard: report the fact, drop the code. See PRIVACY above.
        else if (code >= 1 && code <= 255) this.handlers.onKey();
      }
    }
    if (off < buf.length) this.tail = buf.subarray(off);
  }

  stop() {
    for (const s of this.streams) {
      try {
        s.destroy();
      } catch {}
    }
    this.streams = [];
  }
}

module.exports = { EvdevReader };
