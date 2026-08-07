/*
 * agents.js — notice when an AI coding agent is working, and when it finishes.
 *
 * There is no API for "is Claude Code thinking right now", so this infers it
 * from CPU. A matched agent process that is burning CPU is working; when it
 * goes quiet, it has answered. That single signal covers every CLI agent
 * without integrating with any of them.
 *
 * CPU *time deltas* are used rather than instantaneous %CPU: an agent that is
 * streaming a reply uses CPU in bursts, and a sampled percentage flickers
 * between 0 and 40 constantly, which would make the cat twitch. Accumulated
 * jiffies over the poll interval are smooth.
 *
 * Going idle must also be debounced. Agents pause mid-answer (waiting on the
 * network), and firing "done!" during every pause would be worse than useless,
 * so idleness has to persist for several polls before it counts as finished.
 */
const fs = require("fs");
const { execFile } = require("child_process");

// Matched against the process name / argv0 basename.
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
];

const POLL_MS = 1000;
const BUSY_JIFFIES = 6; // ~6% of one core across the interval
const IDLE_POLLS = 3; // ~3s of quiet before we call it finished

class AgentWatcher {
  constructor(emit) {
    this.emit = emit;
    this.timer = null;
    this.prev = new Map(); // pid -> cpu ticks
    this.thinking = false;
    this.idleCount = 0;
    this.current = "";
    this.names = DEFAULT_AGENTS.slice();
    this.enabled = true;
  }

  setAgents(list) {
    this.names = (list && list.length ? list : DEFAULT_AGENTS).map((s) =>
      String(s).trim().toLowerCase()
    );
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  matches(name) {
    if (!name) return null;
    const base = String(name).split("/").pop().toLowerCase();
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

    let busy = false;
    let who = "";
    const seen = new Set();
    for (const p of procs) {
      seen.add(p.pid);
      const before = this.prev.get(p.pid);
      this.prev.set(p.pid, p.cpu);
      if (before === undefined) continue; // first sighting has no delta yet
      if (p.cpu - before >= BUSY_JIFFIES) {
        busy = true;
        who = p.name;
      }
    }
    for (const pid of this.prev.keys()) if (!seen.has(pid)) this.prev.delete(pid);

    if (busy) {
      this.idleCount = 0;
      if (!this.thinking) {
        this.thinking = true;
        this.current = who;
        this.emit("agent", { state: "thinking", name: who });
      }
      return;
    }

    if (!this.thinking) return;
    if (++this.idleCount < IDLE_POLLS) return; // just a pause, not an answer
    this.thinking = false;
    this.idleCount = 0;
    this.emit("agent", { state: "done", name: this.current });
  }

  // Linux: read /proc directly. No process spawn, so this can poll at 1Hz
  // without itself becoming the CPU load it is trying to measure.
  scanProc() {
    const out = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue; // process exited between readdir and read — expected
      }
      // comm is parenthesised and may itself contain spaces/parens
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < 0) continue;
      const comm = stat.slice(open + 1, close);
      const hit = this.matches(comm);
      if (!hit) continue;
      const fields = stat.slice(close + 2).split(" ");
      // after comm: state is [0]; utime is [11], stime is [12]
      const utime = Number(fields[11]) || 0;
      const stime = Number(fields[12]) || 0;
      out.push({ pid: Number(entry), name: hit, cpu: utime + stime });
    }
    return out;
  }

  // macOS / other: ps reports cumulative CPU time, which deltas the same way.
  scanPs() {
    return new Promise((resolve, reject) => {
      execFile("ps", ["-Ao", "pid=,time=,comm="], { timeout: 4000 }, (err, stdout) => {
        if (err) return reject(err);
        const out = [];
        for (const line of stdout.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          const hit = this.matches(m[3]);
          if (!hit) continue;
          // TIME is [[dd-]hh:]mm:ss — convert to centiseconds for parity with jiffies
          const parts = m[2].split(/[:-]/).map(Number).reverse();
          const secs =
            (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600 + (parts[3] || 0) * 86400;
          out.push({ pid: Number(m[1]), name: hit, cpu: secs * 100 });
        }
        resolve(out);
      });
    });
  }
}

module.exports = { AgentWatcher, DEFAULT_AGENTS };
