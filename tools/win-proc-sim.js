/*
 * win-proc-sim.js — drive the Windows agent detection with a scripted
 * Win32_Process snapshot, deterministically, without Windows.
 *
 *   node tools/win-proc-sim.js
 *
 * WHY THIS EXISTS
 * Agent detection did nothing at all on Windows, and the reason it went
 * unnoticed for so long is that it fails in perfect silence: `execFile("ps")`
 * threw ENOENT into a bare catch once a second and the cat simply never
 * reacted. There was no wrong output to notice — there was no output.
 *
 * The replacement cannot be run here either, because it is a PowerShell reading
 * WMI. But the PowerShell is the small half. Everything that can actually be
 * wrong is on this side of the pipe: whether a snapshot split across chunk
 * boundaries reassembles, whether 100-nanosecond WMI units become the
 * centiseconds the rest of the code compares against, whether `claude.exe`
 * matches an agent called `claude`, whether a quoted Windows command line
 * survives being split back into arguments, and whether a machine with no
 * working WMI degrades to "transcripts only" instead of to nothing.
 *
 * So the snapshot is scripted, fed through the real feed() as the exact bytes
 * PowerShell would have written, and what the watcher made of it is checked.
 */
const assert = require("assert");
const { WinProcSource, parseRow, END } = require("../src/main/win-proc.js");
const { AgentWatcher, baseName, splitArgs } = require("../src/main/agents.js");

// Well clear of any real pid, so treeCpu's "skip our own process" rule can never
// collide with a scripted one and quietly change the arithmetic.
const PID = 900000;

// WMI counts CPU in 100ns units; everything downstream counts in centiseconds.
const cs = (n) => n * 100000;

/*
 * The processes every Windows machine has. Present in every scripted snapshot
 * because a real one is never three rows long — win-proc.js rejects a snapshot
 * that short as a mangled read, so a sim without them would be testing a
 * rejection path while claiming to test matching.
 */
const FILLER = ["System", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "explorer.exe"].map(
  (name, i) => ({ pid: 100 + i, ppid: 4, cpu: 1, name, cmd: name })
);

/*
 * One snapshot, exactly as the PowerShell in win-proc.js writes it: tab
 * separated, CRLF terminated, closed by the sentinel.
 */
function snapshotText(rows) {
  return (
    FILLER.concat(rows)
      .map((r) => [r.pid, r.ppid, cs(r.cpu), r.name, r.cmd || ""].join("\t"))
      .join("\r\n") +
    "\r\n" +
    END +
    "\r\n"
  );
}

// A source with no child process attached — feed() is the whole surface.
function source() {
  const s = new WinProcSource();
  s.stopped = false;
  return s;
}

/*
 * A watcher wired to a scripted process source and scripted transcripts, so
 * tick() can be run against a machine that does not exist.
 */
function watcher({ rows = [], sessions = [], live = true } = {}) {
  const seen = [];
  const w = new AgentWatcher((_ch, payload) => seen.push(payload));
  // Without this the watcher reads THIS machine's /proc, where there is a real
  // `claude` running — which is how the first draft of these tests passed while
  // exercising none of the code they name.
  w.platform = "win32";
  w.sessions = { start() {}, stop() {}, snapshot: () => sessions };
  w.win = source();
  if (live) w.win.feed(snapshotText(rows));
  w.seen = seen;
  return w;
}

/*
 * --- scenarios --------------------------------------------------------------
 *
 * Collected first and run afterwards, because tick() is async: calling an async
 * function inside a try/catch catches nothing, and every one of these would have
 * reported PASS whatever it did.
 */
const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// --- the pipe ---------------------------------------------------------------

check("a row parses, and WMI's 100ns units become centiseconds", () => {
  const r = parseRow(["4242", "17", String(cs(365)), "claude.exe", "claude --resume"].join("\t"));
  assert.deepStrictEqual(r, {
    pid: 4242,
    ppid: 17,
    cpu: 365,
    name: "claude.exe",
    cmd: "claude --resume",
  });
});

/*
 * The command line is taken as everything after the fourth tab rather than as
 * field five, because a command line is user data and may contain a tab.
 */
check("a tab inside a command line does not shear the row", () => {
  const r = parseRow(["1", "2", "0", "node.exe", "node x.js\t--flag"].join("\t"));
  assert.strictEqual(r.cmd, "node x.js\t--flag", "the command line was truncated at a tab");
});

check("a partial or malformed line is dropped, not guessed at", () => {
  assert.strictEqual(parseRow(""), null);
  assert.strictEqual(parseRow("not a row"), null);
  assert.strictEqual(parseRow("12\t13"), null, "a clipped row was accepted");
  assert.strictEqual(parseRow("abc\t1\t0\tx.exe\t"), null, "a non-numeric pid was accepted");
});

/*
 * A pipe hands over whatever it happens to have. Publishing a snapshot that is
 * still arriving would report a machine with four processes on it.
 */
check("a snapshot split across chunks reassembles, and only lands whole", () => {
  const s = source();
  const text = snapshotText([{ pid: PID, ppid: 1, cpu: 10, name: "claude.exe", cmd: "claude" }]);
  // Byte at a time: every boundary is a chunk boundary.
  for (const ch of text.slice(0, -1)) {
    s.feed(ch);
    assert.strictEqual(s.snapshot(), null, "a half-read snapshot was published");
  }
  s.feed(text.slice(-1));
  const snap = s.snapshot();
  assert.ok(snap, "a complete snapshot never landed");
  assert.strictEqual(snap.rows.length, FILLER.length + 1);
  assert.strictEqual(snap.rows[snap.rows.length - 1].cpu, 10);
});

/*
 * The failure the PowerShell's own guard exists to prevent, checked from this
 * side too: a snapshot that is not a process list must not be published as one,
 * because `live: true` with nothing in it vetoes every transcript and is exactly
 * the state Windows was stuck in before any of this.
 */
check("a truncated snapshot is refused rather than believed", () => {
  const s = source();
  s.feed(["1\t4\t0\tSystem\tSystem", "2\t4\t0\tsmss.exe\tsmss", END, ""].join("\r\n"));
  assert.strictEqual(s.snapshot(), null, "two rows were accepted as a machine's process list");
  assert.strictEqual(s.state().ok, false);

  // And a real one straight afterwards still lands: the refusal is per snapshot,
  // not a latch.
  s.feed(snapshotText([{ pid: PID, ppid: 1, cpu: 3, name: "claude.exe", cmd: "claude" }]));
  assert.ok(s.snapshot(), "the source never recovered");
});

check("a stale snapshot stops being a process list", () => {
  const s = source();
  s.feed(snapshotText([{ pid: PID, ppid: 1, cpu: 1, name: "claude.exe", cmd: "claude" }]));
  assert.ok(s.snapshot(), "a fresh snapshot was rejected");
  s.at -= 60000;
  assert.strictEqual(s.snapshot(), null, "a minute-old snapshot was still being believed");
  assert.strictEqual(s.state().ok, false);
});

// --- matching ---------------------------------------------------------------

check("an executable suffix does not hide an agent", () => {
  const w = watcher();
  for (const name of ["claude.exe", "claude.CMD", "C:\\Users\\me\\.local\\bin\\claude.exe"]) {
    assert.strictEqual(w.matches(name), "claude", `${name} did not match`);
  }
  assert.strictEqual(baseName("C:\\Program Files\\nodejs\\node.exe"), "node");
  assert.strictEqual(w.matches("notclaude.exe"), null, "a substring matched");
});

check("a quoted Windows command line splits back into arguments", () => {
  const argv = splitArgs(
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume'
  );
  assert.strictEqual(argv[0], "C:\\Program Files\\nodejs\\node.exe");
  assert.ok(argv[1].endsWith("cli.js"), `the script path was shredded: ${argv[1]}`);
  assert.strictEqual(argv[2], "--resume");
  // Unquoted input has to come out exactly as splitting on whitespace would,
  // because macOS `ps` shares this and does not quote.
  assert.deepStrictEqual(splitArgs("/usr/bin/node /opt/x/cli.js -v"), [
    "/usr/bin/node",
    "/opt/x/cli.js",
    "-v",
  ]);
});

/*
 * The two ways Claude Code is installed on Windows look nothing alike: the
 * native installer leaves `claude.exe`, and a global npm install leaves
 * `node.exe` with the package path in its arguments. Both are the same agent.
 */
check("both Windows install shapes are found", () => {
  const w = watcher({
    rows: [
      { pid: PID, ppid: 1, cpu: 5, name: "claude.exe", cmd: '"C:\\Users\\me\\.local\\bin\\claude.exe"' },
      {
        pid: PID + 1,
        ppid: 1,
        cpu: 7,
        name: "node.exe",
        cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
      },
      { pid: PID + 2, ppid: 1, cpu: 900, name: "chrome.exe", cmd: '"C:\\chrome.exe"' },
    ],
  });
  const found = w.scanWin();
  assert.strictEqual(found.live, true);
  assert.deepStrictEqual(found.procs.map((p) => p.name).sort(), ["claude", "codex"]);
});

check("an agent's CPU is its whole tree, not just itself", () => {
  const w = watcher({
    rows: [
      { pid: PID, ppid: 1, cpu: 10, name: "claude.exe", cmd: "claude" },
      { pid: PID + 1, ppid: PID, cpu: 200, name: "cmd.exe", cmd: "cmd /c npm test" },
      { pid: PID + 2, ppid: PID + 1, cpu: 3000, name: "node.exe", cmd: "node test.js" },
    ],
  });
  const claude = w.scanWin().procs.find((p) => p.name === "claude");
  assert.strictEqual(claude.cpu, 3210, `tree CPU came out as ${claude.cpu}`);
});

// --- the verdict ------------------------------------------------------------

/*
 * The CPU bar is a rate. The Windows source samples every two seconds because a
 * WMI enumeration is expensive, and judging two seconds of accumulated CPU by a
 * one-second bar would call an idle machine busy.
 */
check("the busy threshold scales with the interval it covers", () => {
  const w = watcher();
  const before = [{ pid: PID, name: "aider", cpu: 0, pct: 0 }];
  // 8 centiseconds of CPU: over one second that clears the 6/s bar, over two it
  // does not.
  const after = [{ pid: PID, name: "aider", cpu: 8, pct: 0 }];

  w.cpuBusy(before, 1000);
  assert.strictEqual(w.cpuBusy(after, 1000).length, 1, "8cs in 1s did not read as busy");

  w.prev.clear();
  w.cpuBusy(before, 2000);
  assert.strictEqual(w.cpuBusy(after, 2000).length, 0, "8cs in 2s read as busy");
});

/*
 * The reason detection stayed dead on Windows even for Claude Code, whose
 * transcript was sitting on disk being right the whole time: the transcripts
 * were gated on a process list that could not be produced, so the exact signal
 * was vetoed by the absence of the guess meant to back it up.
 */
check("no process list at all still detects a transcript-backed agent", async () => {
  const w = watcher({
    live: false, // WMI unavailable: snapshot() returns null
    sessions: [{ agent: "claude", state: "busy", at: Date.now() }],
  });
  assert.strictEqual(w.scanWin().live, false, "a missing snapshot claimed to be a process list");

  await w.tick();
  assert.deepStrictEqual(
    w.seen,
    [{ state: "thinking", name: "claude" }],
    "an agent with a live transcript went unnoticed with no process list"
  );
});

check("with a process list, a transcript whose CLI has exited is ignored", async () => {
  const w = watcher({
    rows: [{ pid: PID, ppid: 1, cpu: 1, name: "explorer.exe", cmd: "explorer" }],
    sessions: [{ agent: "claude", state: "busy", at: Date.now() }],
  });
  await w.tick();
  assert.deepStrictEqual(w.seen, [], "a closed session's last entry was believed");
});

check("a snapshot that has not refreshed does not read as CPU going quiet", async () => {
  const rows = [
    { pid: PID, ppid: 1, cpu: 0, name: "aider.exe", cmd: "aider" },
    { pid: PID + 1, ppid: 1, cpu: 0, name: "explorer.exe", cmd: "explorer" },
  ];
  const w = watcher({ rows });
  await w.tick(); // first sighting: no delta yet

  // Age the watcher's memory of that snapshot by one real interval. Both
  // snapshots would otherwise be stamped the same millisecond here, which
  // PowerShell's two-second sleep makes impossible in production.
  w.stamp -= 2000;
  w.win.feed(snapshotText([{ ...rows[0], cpu: 400 }, rows[1]]));
  await w.tick();
  assert.strictEqual(w.thinking, true, "400cs of CPU did not read as work");

  // Four more polls against the SAME snapshot. Nothing new has been observed, so
  // nothing new may be concluded — re-deltaing it would look like a CPU lull and
  // end the turn after IDLE_POLLS_FUZZY.
  for (let i = 0; i < 4; i++) await w.tick();
  assert.strictEqual(w.thinking, true, "the turn ended because nobody looked again");
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
