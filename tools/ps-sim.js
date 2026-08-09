/*
 * ps-sim.js — drive the macOS agent detection with real `ps` output,
 * deterministically, without a Mac.
 *
 *   node tools/ps-sim.js
 *
 * WHY THIS EXISTS
 * Everything about `ps` on macOS is *nearly* the same as `ps` on Linux, and
 * nearly is the dangerous distance. Three of them decided whether this worked at
 * all, and none could be checked by running `ps` here:
 *
 *   - `-o pid=,ppid=,time=` prints one column or three depending on the
 *     implementation. In BSD, an '=' takes the whole rest of the argument as
 *     that column's header, which would make this ask for a single PID column
 *     headed ",ppid=,time=,args=". Apple's ps disables that (`#ifndef __APPLE__`
 *     in keyword.c) and splits on commas like everyone else, so the format works
 *     — but it is one #ifdef away from having silently asked for nothing.
 *   - the TIME column is `MMM:SS.hh`, not `hh:mm:ss`. The minutes are TOTAL
 *     minutes and are never carried into an hours field, so `120:00.00` is two
 *     hours. Read left to right that is 120 hours.
 *   - and it carries HUNDREDTHS. The code used to believe macOS resolved CPU
 *     only to the second, and fell back on `%cpu` to compensate — a decaying
 *     average that stays high for the best part of a minute after a turn ends,
 *     which is the opposite of what a "has it finished yet" check needs.
 *
 * So real output is scripted here and run through the real parser and the real
 * matcher. The lines below are in Apple's exact column layout, padding included,
 * because the padding is load-bearing: the format string is "%3ld:%02ld.%02ld"
 * and a parser that did not expect leading spaces would drop every short-running
 * process on the machine.
 */
const assert = require("assert");
const { AgentWatcher, parsePs, psTime, splitArgs } = require("../src/main/agents.js");

/*
 * `ps -A -ww -o pid=,ppid=,time=,args=` on a Mac with an agent running, both
 * ways it can be installed. Padding and column widths are Apple's.
 */
const SAMPLE = [
  "    1     0   0:37.71 /sbin/launchd",
  "   93     1   0:02.14 /usr/sbin/syslogd",
  "  402     1   4:11.09 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock",
  " 4820  4802   0:00.03 -zsh",
  " 4821  4820  12:03.45 node /Users/me/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  " 4830  4821   0:08.00 rg --json -- pattern /Users/me/My Projects/app",
  " 4900     1 120:00.00 /Users/me/.local/bin/claude",
  " 5001     1   0:00.00 /Applications/Some App.app/Contents/MacOS/Some App",
].join("\n");

function watcher() {
  const w = new AgentWatcher(() => {});
  w.platform = "darwin";
  w.sessions = { start() {}, stop() {}, snapshot: () => [] };
  return w;
}

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// --- the TIME column --------------------------------------------------------

/*
 * The bug that would have been invisible: every one of these parses to SOMETHING
 * under a naive left-to-right reading, and the something is wrong by a factor of
 * sixty.
 */
check("macOS TIME is MMM:SS.hh, and the minutes do not wrap into hours", () => {
  assert.strictEqual(psTime("0:37.71"), 37.71);
  assert.strictEqual(psTime("12:03.45"), 723.45);
  // Two hours of CPU. Read as hours:minutes this would be five days.
  assert.strictEqual(psTime("120:00.00"), 7200);
  assert.strictEqual(psTime("1440:00.00"), 86400);
});

// Other Unixes do add hours and days, and reading the fields from the right is
// what lets one parser serve both without knowing which it is looking at.
check("the [[dd-]hh:]mm:ss form still parses", () => {
  assert.strictEqual(psTime("03:04"), 184);
  assert.strictEqual(psTime("02:03:04"), 7384);
  assert.strictEqual(psTime("1-02:03:04"), 93784);
});

check("a TIME that is not a time is refused, not coerced to zero", () => {
  assert.strictEqual(psTime("?"), null);
  assert.strictEqual(psTime("-"), null);
  assert.strictEqual(psTime(""), null);
});

/*
 * The reason the hundredths matter, stated as the threshold that depends on
 * them: "busy" is 6 centiseconds of CPU per second. If TIME resolved only to the
 * second, every delta would be 0 or 100 and this bar could not be measured at
 * all — which is exactly what the old comment claimed and why it reached for
 * `%cpu`.
 */
check("one poll's worth of work is resolvable from TIME alone", () => {
  const a = psTime("0:00.00");
  const b = psTime("0:00.06");
  assert.strictEqual(Math.round((b - a) * 100), 6, "6 centiseconds did not survive the parse");
});

// --- the rows ---------------------------------------------------------------

check("a real ps table parses, padding and all", () => {
  const rows = parsePs(SAMPLE);
  assert.strictEqual(rows.length, 8, `${rows.length} of 8 lines parsed`);

  const launchd = rows[0];
  assert.deepStrictEqual(
    { pid: launchd.pid, ppid: launchd.ppid, cpu: launchd.cpu, argv: launchd.argv },
    { pid: 1, ppid: 0, cpu: 3771, argv: "/sbin/launchd" }
  );
  // The leading-space case: `  0:37.71` must not lose its column to the
  // separator that precedes it.
  assert.strictEqual(rows.find((r) => r.pid === 4900).cpu, 720000);
});

check("a command containing spaces survives intact", () => {
  const rows = parsePs(SAMPLE);
  const rg = rows.find((r) => r.pid === 4830);
  assert.strictEqual(rg.argv, "rg --json -- pattern /Users/me/My Projects/app");
  // ps does not quote, so a path with a space cannot be recovered — which is
  // fine and is why nothing downstream depends on argv[2] onwards.
  assert.strictEqual(splitArgs(rg.argv)[0], "rg");
});

check("a header line or a stray blank does not become a process", () => {
  const rows = parsePs(["  PID  PPID TIME     ARGS", "", "   ", SAMPLE].join("\n"));
  assert.strictEqual(rows.length, 8, "something that was not a process row got in");
});

// --- matching ---------------------------------------------------------------

/*
 * The two ways Claude Code is installed on a Mac look nothing alike: the native
 * installer leaves `~/.local/bin/claude`, Homebrew and npm leave `node` with the
 * package path in its arguments.
 */
check("both macOS install shapes are found", () => {
  const found = watcher().matchRows(parsePs(SAMPLE));
  assert.deepStrictEqual(
    found.map((p) => `${p.name}#${p.pid}`).sort(),
    ["claude#4821", "claude#4900"],
    `matched ${JSON.stringify(found.map((p) => p.name))}`
  );
});

check("an agent's CPU is its whole tree", () => {
  const found = watcher().matchRows(parsePs(SAMPLE));
  // 12:03.45 of node, plus the 0:08.00 its ripgrep child has burned.
  const npm = found.find((p) => p.pid === 4821);
  assert.strictEqual(npm.cpu, 72345 + 800, `tree CPU came out as ${npm.cpu}`);
});

check("an ordinary Mac process is not an agent", () => {
  const found = watcher().matchRows(parsePs(SAMPLE));
  const pids = found.map((p) => p.pid);
  for (const innocent of [1, 93, 402, 4820, 5001]) {
    assert.ok(!pids.includes(innocent), `pid ${innocent} was mistaken for an agent`);
  }
});

/*
 * The failure the `-ww` flag and the scrubbed $COLUMNS exist to prevent: a
 * command line cut off at a terminal width takes the package path with it, and
 * the npm install shape becomes an anonymous `node`.
 */
check("a truncated command line is what -ww is for", () => {
  const cut = " 4821  4820  12:03.45 node /Users/me/.npm-global/lib/node_modules/@anthropic-ai/cl";
  const found = watcher().matchRows(parsePs(cut));
  assert.deepStrictEqual(found, [], "a truncated line matched anyway — the test is not testing this");
});

// --- the verdict ------------------------------------------------------------

/*
 * `%cpu` used to be able to mark a tree busy on its own. It is a decaying
 * average, so it stayed high after the work stopped and the turn never ended.
 * Cumulative CPU cannot do that: this is the same tree, sampled twice, having
 * done nothing in between.
 */
check("a tree that has stopped working reads as idle immediately", () => {
  const w = watcher();
  const rows = parsePs(SAMPLE);
  w.cpuBusy(w.matchRows(rows), 1000); // first sighting
  const again = w.cpuBusy(w.matchRows(rows), 1000); // identical CPU totals
  assert.deepStrictEqual(again, [], "an unchanged CPU total still read as work");
});

check("a tree that is working reads as busy", () => {
  const w = watcher();
  w.cpuBusy(w.matchRows(parsePs(SAMPLE)), 1000);
  // 6 centiseconds on: exactly the bar, and only visible because TIME carries
  // hundredths.
  const busier = SAMPLE.replace("12:03.45", "12:03.51");
  const out = w.cpuBusy(w.matchRows(parsePs(busier)), 1000);
  assert.deepStrictEqual(
    out.map((p) => p.pid),
    [4821],
    "6 centiseconds of new CPU did not read as work"
  );
});

// --- report -----------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    let why = "";
    try {
      await fn();
    } catch (err) {
      why = err.message;
      failed++;
    }
    console.log(`${why ? "  FAIL" : "  ok  "}  ${name}${why ? `\n          ${why}` : ""}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
