/*
 * input-capture.mjs — diagnose which /dev/input devices actually emit what.
 *
 * Run it, then move the pointer, scroll, click and type. It prints a live tally
 * per device so you can see immediately whether an event source is reaching us.
 *
 *   node tools/input-capture.mjs
 *
 * The thing to look for is the EV_REL row. The cat's Wayland cursor tracking is
 * dead-reckoned from REL_X/REL_Y deltas, so a device that only reports EV_ABS
 * (most laptop touchpads and every touchscreen) contributes nothing to it.
 */
import fs from "node:fs";
import path from "node:path";

const EVENT_SIZE = 24;

// Friendly names, so the output says "Touchpad" rather than "event12".
const NAMES = {};
{
  let name = null;
  for (const line of fs.readFileSync("/proc/bus/input/devices", "utf8").split("\n")) {
    if (line.startsWith("N: Name=")) name = line.slice(9, -1);
    if (line.startsWith("H: Handlers=")) {
      for (const h of line.slice(13).split(/\s+/)) if (/^event\d+$/.test(h)) NAMES[h] = name;
    }
  }
}

const TYPE = { 1: "KEY", 2: "REL", 3: "ABS", 4: "MSC", 5: "SW", 17: "LED", 18: "SND", 20: "REP" };
const REL = { 0: "X", 1: "Y", 6: "HWHEEL", 8: "WHEEL", 11: "WHEEL_HI", 12: "HWHEEL_HI" };

const devices = [];
for (const node of fs.readdirSync("/dev/input").filter((n) => /^event\d+$/.test(n))) {
  try {
    const fd = fs.openSync(
      path.join("/dev/input", node),
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
    );
    devices.push({ node, fd, counts: {} });
  } catch {
    /* not permitted — that itself is the answer, reported below */
  }
}

if (!devices.length) {
  console.error("Could not open ANY /dev/input device. Run: sudo usermod -aG input $USER");
  process.exit(1);
}

console.log(`Watching ${devices.length} devices. Move the pointer, scroll, click and type.`);
console.log("Press Ctrl-C when done.\n");

const buf = Buffer.allocUnsafe(65536);

setInterval(() => {
  for (const d of devices) {
    for (;;) {
      let bytes;
      try {
        bytes = fs.readSync(d.fd, buf, 0, buf.length, null);
      } catch {
        break; // EAGAIN: idle
      }
      if (bytes <= 0) break;
      for (let off = 0; off + EVENT_SIZE <= bytes; off += EVENT_SIZE) {
        const type = buf.readUInt16LE(off + 16);
        const code = buf.readUInt16LE(off + 18);
        if (type === 0) continue; // EV_SYN is just a frame marker
        const key = (TYPE[type] || type) + (type === 2 ? `:${REL[code] || code}` : "");
        d.counts[key] = (d.counts[key] || 0) + 1;
      }
      if (bytes < buf.length) break;
    }
  }
}, 16);

// Runs for a fixed time and prints ONE plain summary, so it works when piped or
// captured. A live redraw would need a TTY and a Ctrl-C to stop.
const SECONDS = Number(process.argv[2]) || 20;
let left = SECONDS;
const ticker = setInterval(() => {
  const seen = devices.reduce((n, d) => n + Object.keys(d.counts).length, 0);
  process.stdout.write(`  ${--left}s left — ${seen ? "receiving events" : "nothing yet"}\n`);
  if (left <= 0) {
    clearInterval(ticker);
    report();
  }
}, 1000);

function report() {
  const rows = devices.filter((d) => Object.keys(d.counts).length);
  console.log("\n===== CAPTURE RESULT =====");
  for (const d of rows) {
    const tally = Object.entries(d.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`${d.node.padEnd(9)} ${String(NAMES[d.node] || "?").slice(0, 34).padEnd(36)} ${tally}`);
  }
  if (!rows.length) console.log("NO EVENTS AT ALL — nothing was touched, so this run proves nothing.");

  const has = (fn) => rows.some((d) => Object.keys(d.counts).some(fn));
  const rel = has((k) => k.startsWith("REL:X") || k.startsWith("REL:Y"));
  const wheel = has((k) => k.includes("WHEEL"));
  const abs = has((k) => k === "ABS");
  const key = has((k) => k === "KEY");
  console.log("\nVERDICT");
  console.log(`  pointer motion (REL_X/Y) : ${rel ? "YES" : "NO   <-- cursor tracking cannot work"}`);
  console.log(`  scroll (REL_WHEEL)       : ${wheel ? "YES" : "NO   <-- scroll reaction cannot work"}`);
  console.log(`  absolute motion (EV_ABS) : ${abs ? "YES  <-- touchpad reports here instead" : "no"}`);
  console.log(`  keys (EV_KEY)            : ${key ? "YES" : "NO"}`);
  process.exit(0);
}
