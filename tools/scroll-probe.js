/*
 * scroll-probe.js — does a scroll actually reach the cat, and if not, where is
 * it lost?
 *
 *   node tools/scroll-probe.js          # runs until you press Ctrl-C
 *
 * Scroll arrives by two completely different routes and they fail differently.
 * A mouse wheel emits REL_WHEEL and there is nothing to interpret. A touchpad
 * emits no wheel at all — scrolling on one is two fingers moving, and
 * evdev-linux.js has to reconstruct the gesture the way libinput would, because
 * reading /dev/input goes around libinput.
 *
 * So "the cat ignores my scroll" has three quite different causes, and guessing
 * between them wastes an afternoon:
 *
 *   1. the devices cannot be opened at all       -> not in the `input` group
 *   2. they open, but nothing arrives            -> nothing was touched, or the
 *                                                   pad reports somewhere else
 *   3. fingers arrive but no ticks come out      -> the gesture is not being
 *                                                   recognised as a scroll
 *
 * This tells them apart by counting all three layers at once: what the kernel
 * sent, and what the reader made of it.
 */
const { EvdevReader } = require("../src/main/evdev-linux.js");

const EV_KEY = 0x01;
const EV_REL = 0x02;
const EV_ABS = 0x03;
const REL_HWHEEL = 0x06;
const REL_WHEEL = 0x08;
const ABS_MT_POSITION_Y = 0x36;
const EVENT_SIZE = 24;

const MAX_SECONDS = Number(process.argv[2]) || 120;

// Friendly names, so the summary says "Touchpad" rather than "event12".
const NAMES = {};
{
  const fs = require("fs");
  let name = null;
  try {
    for (const line of fs.readFileSync("/proc/bus/input/devices", "utf8").split("\n")) {
      if (line.startsWith("N: Name=")) name = line.slice(9, -1);
      if (line.startsWith("H: Handlers=")) {
        for (const h of line.slice(13).split(/\s+/)) if (/^event\d+$/.test(h)) NAMES[h] = name;
      }
    }
  } catch {
    /* the reader copes without it too */
  }
}

/*
 * The reader itself, with a tally of what went IN bolted to the side. Counting
 * the raw codes here rather than opening the devices a second time keeps both
 * layers looking at exactly the same bytes — if they disagree, the disagreement
 * is the answer.
 */
const raw = new Map(); // node -> { wheel, fingers, keys }
class ProbeReader extends EvdevReader {
  consume(dev, buf, length) {
    let t = raw.get(dev.node);
    if (!t) raw.set(dev.node, (t = { wheel: 0, fingers: 0, keys: 0, rel: dev.rel }));
    const end = length - (length % EVENT_SIZE);
    for (let off = 0; off < end; off += EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      if (type === EV_REL && (code === REL_WHEEL || code === REL_HWHEEL)) t.wheel++;
      else if (type === EV_ABS && code === ABS_MT_POSITION_Y) t.fingers++;
      else if (type === EV_KEY) t.keys++;
    }
    super.consume(dev, buf, length);
  }
}

const ticks = [];
const reader = new ProbeReader({
  onWheel: (v) => ticks.push(v),
  onKey() {},
  onButton() {},
  onMove() {},
});

if (!reader.start()) {
  console.log(`Could not open any device: ${reader.error}`);
  console.log("Fix with:  sudo usermod -aG input $USER   then log out and back in.");
  process.exit(1);
}

console.log(`Watching ${reader.devices.length} devices.\n`);
console.log("Scroll — with the mouse wheel, with two fingers on the touchpad, or both.");
console.log("Take as long as you like; press Ctrl-C when you are done.\n");

const drain = setInterval(() => reader.drain(), 16);

let elapsed = 0;
const tick = setInterval(() => {
  elapsed++;
  const fingers = [...raw.values()].reduce((n, t) => n + t.fingers, 0);
  const wheel = [...raw.values()].reduce((n, t) => n + t.wheel, 0);
  process.stdout.write(
    `  ${elapsed}s   finger samples ${fingers}   wheel events ${wheel}` +
      `   -> scroll reported to the cat: ${ticks.length}\n`
  );
  if (elapsed >= MAX_SECONDS) finish();
}, 1000);

process.on("SIGINT", finish);

let done = false;
function finish() {
  if (done) return;
  done = true;
  clearInterval(drain);
  clearInterval(tick);
  reader.stop();

  const rows = [...raw.entries()].filter(([, t]) => t.wheel || t.fingers || t.keys);
  console.log("\n===== RESULT =====");
  for (const [node, t] of rows) {
    console.log(
      `${node.padEnd(9)} ${String(NAMES[node] || "?")
        .slice(0, 34)
        .padEnd(36)} wheel=${t.wheel} fingers=${t.fingers} keys=${t.keys}` +
        `${t.rel ? "" : "   (no wheel of its own — scroll must be reconstructed)"}`
    );
  }
  if (!rows.length) console.log("no device produced a single event");

  const fingers = [...raw.values()].reduce((n, t) => n + t.fingers, 0);
  const wheel = [...raw.values()].reduce((n, t) => n + t.wheel, 0);
  const up = ticks.filter((v) => v > 0).length;
  const down = ticks.filter((v) => v < 0).length;

  console.log("\nVERDICT");
  if (!fingers && !wheel) {
    console.log("  NOTHING WAS SCROLLED — no wheel events and no finger movement arrived,");
    console.log("  so this run proves nothing either way. Run it again and scroll during it.");
  } else if (!ticks.length) {
    console.log("  Input arrived but NO scroll was reported to the cat.");
    if (fingers) console.log("  Fingers were seen, so the two-finger gesture is not being recognised.");
    if (wheel) console.log("  A wheel was turned and was not passed on, which should be impossible.");
  } else {
    console.log(`  SCROLL REACHES THE CAT — ${ticks.length} reports (${up} up, ${down} down).`);
    console.log(`  source: ${wheel ? "mouse wheel" : ""}${wheel && fingers ? " and " : ""}${fingers ? "touchpad fingers" : ""}`);
    console.log(`  first reports: ${JSON.stringify(ticks.slice(0, 24))}`);
  }
  process.exit(0);
}
