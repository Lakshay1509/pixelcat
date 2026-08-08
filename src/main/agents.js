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
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { SessionWatcher } = require("./agent-sessions");

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

// A matched process tree accumulating this many jiffies over the interval counts
// as working: ~6% of one core, low enough to catch a streaming reply.
const BUSY_JIFFIES = 6;

// macOS `ps` reports cumulative CPU only to the second, which cannot resolve a
// 6-jiffy delta at a 1Hz poll, so its recent-usage percentage is read too.
const PS_BUSY_PCT = 8;

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
const INTERPRETERS = new Set([
  "node", "node.exe", "bun", "deno", "python", "python3", "python.exe", "ruby", "perl",
]);

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
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessions.stop();
  }

  matches(name) {
    if (!name) return null;
    const base = String(name).split(/[\\/]/).pop().toLowerCase();
    return this.names.find((n) => base === n || base.startsWith(`${n}-`)) || null;
  }

  async tick() {
    if (!this.enabled) return;
    let procs = [];
    try {
      procs = process.platform === "linux" ? this.scanProc() : await this.scanPs();
    } catch {
      return;
    }

    const now = Date.now();
    const running = new Set(procs.map((p) => p.name));

    /*
     * What the transcripts claim, per agent, keeping only sessions whose CLI is
     * still running — a transcript outlives the process that wrote it, and the
     * last entry of a session someone closed mid-turn says "working" forever.
     */
    const known = new Map(); // agent -> "busy" | "idle"
    for (const s of this.sessions.snapshot()) {
      if (!running.has(s.agent)) continue;
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

    // CPU, for agents the transcripts said nothing about.
    const cpuBusy = this.cpuBusy(procs);
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

  // Which matched trees burned CPU since the last poll.
  cpuBusy(procs) {
    const out = [];
    const seen = new Set();
    for (const p of procs) {
      seen.add(p.pid);
      const before = this.prev.get(p.pid);
      this.prev.set(p.pid, p.cpu);
      if (before === undefined) continue; // first sighting has no delta yet
      if (p.cpu - before >= BUSY_JIFFIES || p.pct >= PS_BUSY_PCT) out.push(p);
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
      out.push({ pid, name: hit, cpu: s.own + s.reaped + this.treeCpu(pid, kids, stats), pct: 0 });
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
    if (!INTERPRETERS.has(String(comm).toLowerCase())) return null;
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      return null;
    }
    return this.matchScript(argv[1]);
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
   * TIME is cumulative like /proc's jiffies but only to the second, too coarse to
   * resolve one poll's worth of work, so %CPU — a recent-usage estimate — is
   * carried alongside and either can mark a tree busy.
   */
  scanPs() {
    return new Promise((resolve, reject) => {
      execFile("ps", ["-Ao", "pid=,ppid=,time=,%cpu=,args="], { timeout: 4000, maxBuffer: 4 << 20 },
        (err, stdout) => {
          if (err) return reject(err);
          const stats = new Map();
          const kids = new Map();
          for (const line of String(stdout).split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
            if (!m) continue;
            const pid = Number(m[1]);
            const ppid = Number(m[2]);
            // TIME is [[dd-]hh:]mm:ss — converted to centiseconds for parity with jiffies
            const p = m[3].split(/[:-]/).map(Number).reverse();
            const secs =
              (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600 + (p[3] || 0) * 86400;
            stats.set(pid, {
              ppid,
              own: secs * 100,
              reaped: 0, // ps does not expose reaped-child time
              pct: Number(m[4]) || 0,
              argv: m[5],
            });
            if (!kids.has(ppid)) kids.set(ppid, []);
            kids.get(ppid).push(pid);
          }

          const out = [];
          for (const [pid, s] of stats) {
            const argv = s.argv.split(/\s+/);
            const hit =
              this.matches(path.basename(argv[0] || "")) ||
              (INTERPRETERS.has(path.basename(argv[0] || "").toLowerCase())
                ? this.matchScript(argv[1])
                : null);
            if (!hit) continue;
            out.push({
              pid,
              name: hit,
              cpu: s.own + this.treeCpu(pid, kids, stats),
              pct: s.pct + this.treePct(pid, kids, stats),
            });
          }
          resolve(out);
        }
      );
    });
  }

  treePct(root, kids, stats) {
    let total = 0;
    const stack = (kids.get(root) || []).slice();
    while (stack.length) {
      const pid = stack.pop();
      if (pid === process.pid) continue;
      const s = stats.get(pid);
      if (!s) continue;
      total += s.pct || 0;
      for (const k of kids.get(pid) || []) stack.push(k);
    }
    return total;
  }
}

module.exports = { AgentWatcher, DEFAULT_AGENTS };
