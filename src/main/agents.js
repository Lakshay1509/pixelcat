/*
 * agents.js — notice when an AI coding agent is working, and when it finishes.
 *
 * Two signals, in order of how much they can be trusted.
 *
 * 1. THE AGENT'S OWN TRANSCRIPT (agent-sessions.js). Claude Code and Codex write
 *    every turn to disk as it happens, and the last entry says outright whether
 *    the model is mid-turn or the turn has ended. Where this answers, it is the
 *    answer: exact, instant, and free.
 *
 * 2. CPU, for the agents that keep no readable transcript — aider, goose, amp,
 *    opencode. This is a guess and is treated like one.
 *
 * WHY CPU IS ONLY A FALLBACK
 * It was the only signal here before, and it is bad at this job in both
 * directions. An agent waiting on the model uses no CPU, so "thinking" read as
 * "finished" and the cat celebrated mid-answer, over and over, once per pause. A
 * terminal that is merely being typed into redraws and burns CPU, so an idle
 * session read as work. No amount of debouncing fixes a signal that is measuring
 * the wrong thing; the debounce only made both failures slower.
 *
 * What CPU *is* good at is the gap the transcript cannot cover: a long tool call
 * writes nothing to the transcript for as long as it runs, and during exactly
 * that gap the process tree is busy. So the two compose — the transcript drives,
 * and CPU covers for it while a session is silent.
 *
 * TWO SPEEDS OF "DONE"
 * A transcript-confirmed turn ending is a fact, so it is announced almost
 * immediately. A CPU lull is not, so it still has to persist for several seconds
 * and follow enough work to have been a task at all. Missing a second answer
 * inside the cooldown is a far cheaper failure than announcing the same one
 * eight times.
 *
 * THREE PROCESS LISTS
 * /proc on Linux, `ps` on macOS, and a PowerShell reading Win32_Process on
 * Windows (win-proc.js). They differ in cost and in cadence, not in meaning, so
 * each one hands back the same rows and the same timestamp and the rest of this
 * file does not know which it is talking to.
 *
 * The Windows one can also hand back NOTHING — a machine with WMI turned off is
 * a real machine. That case is why the transcripts are no longer gated on the
 * process list being available: a signal that is exact and free must not be
 * vetoed by the absence of the guess that was only ever meant to back it up.
 * That gating is the entire reason agent detection stayed dead on Windows even
 * for Claude Code, whose transcript was sitting there being right the whole time.
 */
const fs = require("fs");
const { execFile } = require("child_process");
const { SessionWatcher } = require("./agent-sessions");
const { WinProcSource } = require("./win-proc");

// Matched against the program being run — argv0, or the package name when the
// agent is a script running under an interpreter.
const DEFAULT_AGENTS = [
  "claude",
  "codex",
  "cursor-agent",
  "opencode",
  "aider",
  "goose",
  "amp",
  "gemini",
  "copilot",
  "kiro",
  "antigravity",
  "crush",
  "droid",
  "cline",
];

const POLL_MS = 1000;

// A matched process tree burning this many centiseconds of CPU per second of
// wall clock counts as working: ~6% of one core, low enough to catch a streaming
// reply. Expressed as a RATE rather than as a per-poll count because the Windows
// source deliberately samples slower than the poll — judging two seconds of
// accumulated CPU by a one-second bar would call an idle machine busy.
const BUSY_CS_PER_SEC = 6;

/*
 * `ps` prints CPU time as `MMM:SS.hh`, and those hundredths are the whole reason
 * this needs nothing else. Apple's cputime() formats it "%3ld:%02ld.%02ld", so
 * one centisecond is the resolution — the same as a Linux jiffy. Minutes are
 * TOTAL minutes and are not carried into an hours field, which is why the
 * fields are read from the right; other Unixes do add hours and days.
 *
 * This used to also read `%cpu`, on the stated grounds that macOS resolved CPU
 * "only to the second" and could not settle a 6-jiffy delta at 1Hz. That was
 * simply untrue, and the fallback it justified actively hurt: BSD `%cpu` is a
 * DECAYING AVERAGE over roughly the last minute, and it was summed across the
 * whole process tree. So for the agents that have no transcript to read — aider,
 * goose, amp, opencode — a turn that had just finished went on looking busy for
 * as long as the average took to decay, and "finished!" arrived tens of seconds
 * late or not at all. A cumulative counter cannot do that: it stops moving the
 * moment the work stops.
 */
function psTime(text) {
  const raw = String(text).split(/[:-]/);
  // Every component checked as a string first. `Number("")` is 0, so a field
  // that is missing or is a `-` or a `?` would otherwise parse cleanly into "no
  // CPU at all" — and a process that reads as burning nothing does not look
  // broken, it looks idle, which is a failure that never gets reported.
  if (!raw.length || raw.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const [s = 0, m = 0, h = 0, d = 0] = raw.map(Number).reverse();
  return s + m * 60 + h * 3600 + d * 86400;
}

/*
 * `ps` output into rows. Exported so tools/ps-sim.js can run real macOS output
 * through it from a machine that is not a Mac — every field here is a thing
 * that differs between `ps` implementations and would fail silently if wrong.
 */
function parsePs(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    // pid, ppid, TIME, then everything else is the command. TIME's own leading
    // padding is absorbed by the separator before it.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const secs = psTime(m[3]);
    if (secs === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      // Centiseconds, so /proc, `ps` and Win32_Process are all one unit by the
      // time anything compares them.
      cpu: Math.round(secs * 100),
      argv: m[4],
    });
  }
  return rows;
}

/*
 * `ps` consults $COLUMNS before it considers whether it is talking to a
 * terminal, and this process inherits whatever shell launched it. A width
 * inherited from someone's 80-column terminal would truncate the command and
 * cut the tail off `node …/node_modules/@anthropic-ai/claude-code/cli.js` —
 * which is the only part of that line identifying an agent.
 */
function psEnv() {
  const env = { ...process.env };
  delete env.COLUMNS;
  return env;
}

/*
 * Idle thresholds. The exact pair applies when a transcript confirmed the turn
 * ended; the fuzzy pair when CPU is all there is, where a gap has to outlast a
 * tool call before it can be believed.
 */
const IDLE_POLLS_EXACT = 2;
const IDLE_POLLS_FUZZY = 8;
const MIN_BUSY_POLLS_EXACT = 1; // a real turn is a real turn, however short
const MIN_BUSY_POLLS_FUZZY = 3; // shorter than this was a redraw, not a task
const COOLDOWN_EXACT_MS = 20000;
const COOLDOWN_FUZZY_MS = 45000;

/*
 * How long a transcript that says "working" stays believable after its last
 * write. A silent stretch this long is either a very long tool call or a session
 * someone walked away from mid-turn; both stop being evidence and hand the
 * decision to CPU, which can tell those two apart.
 */
const SILENT_MS = 180000;

// Only these hosts get their arguments inspected. Shells are deliberately absent:
// a `bash -c` command line contains whatever the agent happened to run, includes
// paths like ~/.claude/shell-snapshots, and would match itself constantly.
// Listed without extensions; everything is compared through baseName().
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl"]);

/*
 * A program name reduced to the thing worth matching: no directory, no case, no
 * executable suffix.
 *
 * The suffix is the Windows half of this. The same agent arrives under two names
 * depending on how it was installed — `claude.exe` from the native installer,
 * `node.exe` running cli.js from a global npm install — and the npm shim on the
 * PATH is `claude.cmd`. Without stripping the suffix, `claude.exe` matched
 * nothing at all, which is the second reason Windows detected no agents.
 */
const EXE_SUFFIX = /\.(exe|cmd|bat|com|ps1)$/i;

function baseName(name) {
  return String(name || "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(EXE_SUFFIX, "");
}

/*
 * A command line back into arguments.
 *
 * Windows hands over one string with the parts quoted, so
 * `"C:\Program Files\nodejs\node.exe" "...\cli.js"` splits into four words on
 * whitespace and the script path — the only thing that identifies an agent
 * running under an interpreter — comes out as `"C:\Program`.
 *
 * `ps` on macOS does not quote at all, and unquoted input comes out of here
 * exactly as splitting on whitespace would, so both callers can share this.
 */
function splitArgs(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  let started = false; // an empty "" is an argument; a run of spaces is not
  for (const ch of String(line || "")) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (ch === " " || ch === "\t")) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

class AgentWatcher {
  constructor(emit) {
    this.emit = emit;
    this.timer = null;
    this.prev = new Map(); // pid -> cpu jiffies, for deltas
    this.thinking = false;
    this.idleCount = 0;
    this.busyPolls = 0;
    this.exact = false; // is the current belief transcript-backed?
    this.lastAnnounce = 0;
    this.current = "";
    this.names = DEFAULT_AGENTS.slice();
    this.enabled = true;
    this.sessions = new SessionWatcher();
    /*
     * Which process list to read. Only tools/win-proc-sim.js ever writes to it,
     * and it is the reason the Windows path can be tested at all: the machine
     * this was written on has a real /proc and a real `claude` running in it, so
     * a sim that could not say "pretend you are Windows" silently tested Linux
     * and passed.
     */
    this.platform = process.platform;
    // Windows has no process list to read, so one has to be kept running. It is
    // only constructed on Windows: everywhere else this stays null and nothing
    // spawns.
    this.win = this.platform === "win32" ? new WinProcSource() : null;
    // The last CPU verdict, and the snapshot it came from. The Windows source
    // refreshes slower than the poll, so re-deltaing the same snapshot would
    // read as "no CPU burned since last time" on every second tick and end a
    // turn in the middle of one.
    this.stamp = 0;
    this.lastBusy = [];
  }

  setAgents(list) {
    const names = (list && list.length ? list : DEFAULT_AGENTS).map((s) =>
      String(s).trim().toLowerCase()
    );
    this.names = [...new Set(names)].filter(Boolean);
  }

  start() {
    this.stop();
    this.sessions.start();
    if (this.win) this.win.start();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessions.stop();
    if (this.win) this.win.stop();
    // CPU deltas are meaningless across a gap in observation: whatever ran while
    // this was stopped would arrive as one enormous delta and read as work.
    this.prev.clear();
    this.stamp = 0;
    this.lastBusy = [];
  }

  matches(name) {
    const base = baseName(name);
    if (!base) return null;
    return this.names.find((n) => base === n || base.startsWith(`${n}-`)) || null;
  }

  /*
   * The process list, whichever way this platform has one.
   *
   * `live` is the field that matters and it is not the same as "procs is
   * non-empty": it says whether the list can be BELIEVED. An empty list from
   * /proc means no agent is running; an empty list because PowerShell could not
   * reach WMI means nothing whatsoever, and treating the two alike is what
   * silently disabled every signal on Windows.
   */
  async scan() {
    if (this.platform === "linux") {
      return { procs: this.scanProc(), stamp: Date.now(), live: true };
    }
    if (this.platform === "win32") return this.scanWin();
    return { procs: await this.scanPs(), stamp: Date.now(), live: true };
  }

  async tick() {
    if (!this.enabled) return;
    let scan;
    try {
      scan = await this.scan();
    } catch {
      // A failed scan is not evidence of anything, so nothing is concluded from
      // it — including "the agent stopped".
      return;
    }

    const now = Date.now();
    const running = new Set(scan.procs.map((p) => p.name));

    /*
     * What the transcripts claim, per agent, keeping only sessions whose CLI is
     * still running — a transcript outlives the process that wrote it, and the
     * last entry of a session someone closed mid-turn says "working" forever.
     *
     * Where there is no usable process list that check cannot be made, and it is
     * skipped rather than failed: SILENT_MS below already retires a session that
     * went quiet mid-turn, so the abandoned-terminal case is still covered, just
     * in minutes instead of instantly. Losing detection outright is much worse
     * than announcing one stale turn.
     */
    const known = new Map(); // agent -> "busy" | "idle"
    for (const s of this.sessions.snapshot()) {
      if (scan.live && !running.has(s.agent)) continue;
      if (s.state === "busy" && now - s.at > SILENT_MS) continue; // gone quiet; CPU's turn
      if (s.state === "busy") known.set(s.agent, "busy");
      else if (!known.has(s.agent)) known.set(s.agent, "idle");
    }

    let busy = false;
    let who = "";
    let exact = false;
    for (const [agent, state] of known) {
      if (state !== "busy") continue;
      busy = true;
      who = agent;
      exact = true;
      break;
    }

    // CPU, for agents the transcripts said nothing about. Only a snapshot that
    // is actually new can be deltaed; between refreshes the previous verdict
    // stands, because "we have not looked again yet" is not "nothing happened".
    let cpuBusy = this.lastBusy;
    if (scan.stamp !== this.stamp) {
      cpuBusy = this.cpuBusy(scan.procs, this.stamp ? scan.stamp - this.stamp : POLL_MS);
      this.stamp = scan.stamp;
      this.lastBusy = cpuBusy;
    }
    if (!busy) {
      for (const p of cpuBusy) {
        if (known.has(p.name)) continue; // its transcript already answered: idle
        busy = true;
        who = p.name;
        break;
      }
    }

    if (busy) {
      this.idleCount = 0;
      this.busyPolls++;
      // A turn that began as a CPU guess and is now transcript-confirmed should
      // finish on the exact timings, so this only ever upgrades.
      if (exact) this.exact = true;
      if (!this.thinking) {
        this.thinking = true;
        this.current = who;
        this.emit("agent", { state: "thinking", name: who });
      }
      return;
    }

    if (!this.thinking) return;

    // Only trust the fast path when the transcript that was driving this turn is
    // the thing now reporting it over.
    const confirmed = this.exact && known.get(this.current) === "idle";
    if (++this.idleCount < (confirmed ? IDLE_POLLS_EXACT : IDLE_POLLS_FUZZY)) return;

    const worked = this.busyPolls;
    this.thinking = false;
    this.idleCount = 0;
    this.busyPolls = 0;
    this.exact = false;

    // `quiet` still ends the thinking indicator — the cat must never be left
    // squinting at a problem nobody is working on — it only withholds the hop,
    // the bubble and the sparks.
    const minBusy = confirmed ? MIN_BUSY_POLLS_EXACT : MIN_BUSY_POLLS_FUZZY;
    const cooldown = confirmed ? COOLDOWN_EXACT_MS : COOLDOWN_FUZZY_MS;
    const quiet = worked < minBusy || Date.now() - this.lastAnnounce < cooldown;
    if (!quiet) this.lastAnnounce = Date.now();
    this.emit("agent", { state: "done", name: this.current, quiet });
  }

  // Which matched trees burned CPU over the interval this snapshot covers.
  cpuBusy(procs, elapsedMs) {
    const out = [];
    const seen = new Set();
    // The bar is a rate, so a longer interval asks for proportionally more CPU
    // and means the same thing. Clamped so a stalled poll cannot set a bar no
    // real agent could clear, or a fast one a bar everything clears.
    const span = Math.max(500, Math.min(5000, elapsedMs || POLL_MS));
    const need = Math.max(1, Math.round((BUSY_CS_PER_SEC * span) / 1000));
    for (const p of procs) {
      seen.add(p.pid);
      const before = this.prev.get(p.pid);
      this.prev.set(p.pid, p.cpu);
      if (before === undefined) continue; // first sighting has no delta yet
      if (p.cpu - before >= need) out.push(p);
    }
    for (const pid of this.prev.keys()) if (!seen.has(pid)) this.prev.delete(pid);
    return out;
  }

  /*
   * Linux: read /proc directly. No process spawn, so this can poll at 1Hz
   * without itself becoming the CPU load it is trying to measure.
   *
   * The CPU reported for an agent is its whole process tree, not just itself.
   * Most of what an agentic turn actually costs is spent in children — the test
   * run, the grep, the build — and the parent sits at zero while they work, so
   * measuring the parent alone missed precisely the busiest parts of a turn.
   */
  scanProc() {
    const stats = new Map(); // pid -> { ppid, own, reaped, comm }
    const kids = new Map(); // ppid -> [pid]

    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue; // exited between readdir and read — expected
      }
      // comm is parenthesised and may itself contain spaces and parens
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < 0) continue;
      const comm = stat.slice(open + 1, close);
      const f = stat.slice(close + 2).split(" ");
      // after comm: state is [0], ppid [1], utime [11], stime [12], and
      // cutime/cstime [13]/[14], which carry the CPU of children already reaped —
      // that is how a finished test run still registers as work.
      const pid = Number(entry);
      const ppid = Number(f[1]) || 0;
      const own = (Number(f[11]) || 0) + (Number(f[12]) || 0);
      const reaped = (Number(f[13]) || 0) + (Number(f[14]) || 0);
      stats.set(pid, { ppid, own, reaped, comm });
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }

    const out = [];
    for (const [pid, s] of stats) {
      const hit = this.matches(s.comm) || this.matchArgs(pid, s.comm);
      if (!hit) continue;
      out.push({ pid, name: hit, cpu: s.own + s.reaped + this.treeCpu(pid, kids, stats) });
    }
    return out;
  }

  // Live descendants only: anything already reaped is in the root's cutime, and
  // counting both would double it.
  treeCpu(root, kids, stats) {
    let total = 0;
    const stack = (kids.get(root) || []).slice();
    while (stack.length) {
      const pid = stack.pop();
      // pixelcat's own tree is skipped: launching it from an agent's shell would
      // otherwise make the cat's own CPU read as the agent working, forever.
      if (pid === process.pid) continue;
      const s = stats.get(pid);
      if (!s) continue;
      total += s.own;
      for (const k of kids.get(pid) || []) stack.push(k);
    }
    return total;
  }

  /*
   * `comm` is the executable's name, so an agent installed as an npm package and
   * run as `node .../@anthropic-ai/claude-code/cli.js` shows up as "node" and was
   * invisible to name matching. Interpreter processes get their arguments read.
   */
  matchArgs(pid, comm) {
    if (!INTERPRETERS.has(baseName(comm))) return null;
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      return null;
    }
    return this.matchScript(argv[1]);
  }

  /*
   * Rows -> the matched process trees. Shared by `ps` and by Win32_Process,
   * which differ only in how they spell a process and not in what one is.
   *
   * Neither has an equivalent of /proc's cutime, so on both of them a test run
   * that has already finished does not register; the live-descendant walk is
   * what covers a tool call while it is actually running, which is the part that
   * matters. Only scanProc() gets the reaped-child time as well.
   *
   * `name` is the image name where the platform has one (Windows: `claude.exe`)
   * and empty where it does not (`ps` gives a command line and nothing else).
   * Both are consulted, because a native-installer agent and an npm one look
   * nothing alike and only one of them is named after itself.
   */
  matchRows(rows) {
    const stats = new Map();
    const kids = new Map();
    for (const r of rows) {
      stats.set(r.pid, { ppid: r.ppid, own: r.cpu, name: r.name || "", argv: r.argv || "" });
      if (!kids.has(r.ppid)) kids.set(r.ppid, []);
      kids.get(r.ppid).push(r.pid);
    }

    const out = [];
    for (const [pid, s] of stats) {
      const argv = splitArgs(s.argv);
      const hit =
        (s.name && this.matches(s.name)) ||
        this.matches(argv[0]) ||
        (INTERPRETERS.has(baseName(s.name || argv[0])) ? this.matchScript(argv[1]) : null);
      if (!hit) continue;
      out.push({ pid, name: hit, cpu: s.own + this.treeCpu(pid, kids, stats) });
    }
    return out;
  }

  // Windows: whatever win-proc.js last got out of Win32_Process.
  scanWin() {
    const snap = this.win && this.win.snapshot();
    if (!snap) return { procs: [], stamp: 0, live: false };
    const rows = snap.rows.map((r) => ({ ...r, argv: r.cmd }));
    return { procs: this.matchRows(rows), stamp: snap.at, live: true };
  }

  // The script an interpreter was handed, by its own name and by the package
  // directory it lives in. Only the segment right after node_modules counts, so
  // an unrelated project that happens to sit in a folder called "gemini" does not.
  matchScript(script) {
    if (!script) return null;
    const parts = String(script).split(/[\\/]/);
    const file = parts[parts.length - 1] || "";
    const hit = this.matches(file.replace(/\.(js|mjs|cjs|ts|py)$/i, ""));
    if (hit) return hit;
    const i = parts.lastIndexOf("node_modules");
    if (i < 0) return null;
    const pkg = parts[i + 1] === undefined ? "" : parts[i + 1];
    return this.matches(pkg.startsWith("@") ? parts[i + 2] : pkg);
  }

  /*
   * macOS and other Unixes: one `ps` gives names, parents and CPU together.
   * TIME is cumulative like /proc's jiffies and, on macOS, just as fine-grained
   * — see psTime() for why that matters and what believing otherwise cost.
   *
   * `ps` has no equivalent of /proc's cutime, so a test run that has already
   * finished does not register; the live-descendant walk covers it while it is
   * actually running, which is the part that matters.
   */
  scanPs() {
    return new Promise((resolve, reject) => {
      execFile(
        "ps",
        /*
         * `-w` twice is what makes the width unlimited. Apple's `ps` already
         * goes unlimited when stdout is not a terminal — and here it never is,
         * since execFile gives it a pipe — but that decision sits downstream of
         * a $COLUMNS lookup, and pinning the width explicitly is one line
         * against a whole class of "it works in my terminal" failure.
         */
        ["-A", "-ww", "-o", "pid=,ppid=,time=,args="],
        { timeout: 4000, maxBuffer: 4 << 20, env: psEnv() },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(this.matchRows(parsePs(stdout)));
        }
      );
    });
  }
}

module.exports = { AgentWatcher, DEFAULT_AGENTS, baseName, splitArgs, parsePs, psTime };
