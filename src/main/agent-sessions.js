/*
 * agent-sessions.js — read what the agent wrote down, instead of guessing.
 *
 * The CPU heuristic this replaces was wrong in both directions, and for one
 * reason: CPU is not what an agent spends its turn doing.
 *
 *   - A turn waiting on the model burns nothing. Thirty seconds of hard thinking
 *     is indistinguishable from thirty seconds of an empty terminal, so the cat
 *     announced "finished!" in the middle of an answer — repeatedly, because the
 *     next token restarted the whole cycle.
 *   - A terminal UI burns CPU whenever anything redraws: a spinner, a keystroke,
 *     a resize. An idle session the user is merely typing into looked like work.
 *
 * But every one of these CLIs already writes down exactly what it is doing. They
 * all persist a transcript so `--resume` and `/rewind` can work, that file is
 * appended to as the turn happens, and its last entry states plainly whether the
 * model is mid-turn or the turn has ended. Reading it is exact, costs nothing,
 * needs no configuration, and needs no cooperation from the agent.
 *
 * WHY NOT HOOKS
 * Claude Code, Codex and Gemini CLI can all call out on lifecycle events, which
 * is more precise still. It also means editing the user's agent config to point
 * at pixelcat. Reading a file they already write is the same answer without
 * touching anything of theirs, so that is the default; hooks stay available as
 * an opt-in for the one thing transcripts cannot see (a permission prompt
 * waiting for an answer).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not try to answer "is a tool running right now" during a long silent
 * Bash call — the transcript is quiet for the whole of it. It reports that the
 * session has gone silent and lets the caller fall back to CPU for that gap,
 * which is the one job CPU is actually good at.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

// Reading a session's last entry only needs the end of the file. Individual
// entries carry whole tool results, so this is sized for "the last few entries",
// not "the last few lines".
const TAIL_BYTES = 128 * 1024;

// Appends arrive in bursts while a reply streams; coalesce them.
const DEBOUNCE_MS = 250;

// How often the set of directories worth watching is recomputed. Catches new
// projects, and new day-folders for agents that shard sessions by date.
const RESCAN_MS = 30000;

// On startup there are no file events to learn from, so sessions are seeded by
// mtime. Anything older than this was not open when pixelcat started.
const LOOKBACK_MS = 30 * 60 * 1000;

// Sessions nobody has touched in this long stop being tracked at all.
const FORGET_MS = 60 * 60 * 1000;

// inotify watches are cheap but not free, and ~/.claude/projects grows one
// directory per project forever. Watch the most recently used ones.
const MAX_WATCHED_DIRS = 192;

const home = os.homedir();

/*
 * Claude Code — ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl
 *
 * One JSON object per line. A single assistant message is split across several
 * lines (one for the thinking block, one for the text, one per tool_use), and
 * every one of those lines carries that message's `stop_reason`. That is the
 * whole state machine:
 *
 *   assistant, stop_reason "tool_use"  -> a tool is about to run: still working
 *   assistant, any other stop_reason   -> the turn ended: done
 *   user                               -> a prompt, or a tool result going back
 *                                         to the model: working
 *
 * Reading the *blocks* instead would be wrong. A text block mid-turn ("Let me
 * check the config") is written as its own line and looks exactly like the final
 * answer; only stop_reason separates them.
 */
function claudeState(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    // Subagent transcripts are interleaved into the same file. A subagent
    // finishing is not the turn finishing, and while one runs the main chain is
    // already parked on a `tool_use`, so they are simply not evidence.
    if (!e || e.isSidechain) continue;
    const msg = e.message;
    if (!msg) continue; // mode / attachment / system / ai-title: bookkeeping

    if (e.type === "assistant") {
      if (msg.stop_reason === "tool_use") return "busy";
      if (msg.stop_reason) return "idle"; // end_turn, max_tokens, stop_sequence
      return null; // written mid-stream; keep whatever we last believed
    }
    if (e.type === "user") {
      // Pressing escape writes a user entry like any prompt, and without this it
      // would read as "a turn just started" and pin the cat to thinking until
      // the staleness timeout rescued it.
      return interrupted(msg.content) ? "idle" : "busy";
    }
  }
  return null;
}

function interrupted(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("")
        : "";
  return /\[Request interrupted/i.test(text);
}

/*
 * Codex CLI — ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl
 *
 * Codex states turn boundaries outright rather than leaving them to be inferred:
 * `event_msg` payloads include task_started and task_complete. Everything else
 * in the file (response_item lines, token_count events) is turn *content*, so
 * only the event_msg lines are read and the rest is skipped over.
 */
function codexState(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || e.type !== "event_msg" || !e.payload) continue;
    const t = e.payload.type;
    if (t === "task_started") return "busy";
    if (t === "task_complete" || t === "turn_aborted" || t === "error") return "idle";
  }
  return null;
}

function parse(line) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null; // a line still being written, or one clipped by the tail read
  }
}

const ADAPTERS = [
  {
    agent: "claude",
    root: path.join(home, ".claude", "projects"),
    depth: 1, // sessions sit one level down, in a per-project directory
    match: (f) => f.endsWith(".jsonl"),
    read: claudeState,
  },
  {
    agent: "codex",
    root: path.join(home, ".codex", "sessions"),
    depth: 3, // YYYY/MM/DD
    match: (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"),
    read: codexState,
  },
];

class SessionWatcher {
  // `roots` overrides where an agent's transcripts live, keyed by agent name.
  // Only tests pass it; it is what lets a whole turn be replayed against a
  // scratch directory instead of the user's real session history.
  constructor(roots) {
    this.adapters = ADAPTERS.map((a) =>
      roots && roots[a.agent] ? { ...a, root: roots[a.agent] } : a
    );
    this.sessions = new Map(); // file -> { agent, state, at }
    this.watchers = new Map(); // dir -> { w: FSWatcher, adapter }
    this.pending = new Map(); // file -> debounce timer
    this.rescanTimer = null;
  }

  start() {
    this.stop();
    this.rescan();
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS);
  }

  stop() {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    for (const { w } of this.watchers.values()) {
      try {
        w.close();
      } catch {}
    }
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.sessions.clear();
  }

  /*
   * What the caller gets: one entry per session that has been alive recently.
   * `at` is when the transcript was last appended to, which is what tells a
   * caller whether "busy" is still trustworthy or the session has gone quiet
   * inside a long tool call.
   */
  snapshot() {
    const out = [];
    for (const [file, s] of this.sessions) out.push({ file, ...s });
    return out;
  }

  rootExists(a) {
    try {
      return fs.statSync(a.root).isDirectory();
    } catch {
      return false;
    }
  }

  rescan() {
    const now = Date.now();
    const wanted = new Map(); // dir -> adapter

    for (const a of this.adapters) {
      if (!this.rootExists(a)) continue;
      // Rank by mtime so a machine with three years of Codex day-folders watches
      // this week rather than an arbitrary slice of 2024.
      const leaves = rank(descend(a.root, a.depth), MAX_WATCHED_DIRS);
      wanted.set(a.root, a); // the root itself, to notice new projects/days
      for (const d of leaves) wanted.set(d, a);
    }

    for (const [dir, entry] of this.watchers) {
      if (wanted.has(dir)) continue;
      try {
        entry.w.close();
      } catch {}
      this.watchers.delete(dir);
    }
    // Seeding is only for directories that were not already being watched: once
    // a watch is live every append arrives as an event, so re-reading the whole
    // history on a timer would be hundreds of stats a second to learn nothing.
    for (const [dir, a] of wanted) {
      if (this.watchers.has(dir)) continue;
      this.watch(dir, a);
      this.seed(dir, a, now);
    }

    for (const [file, s] of this.sessions) {
      if (now - s.at > FORGET_MS) this.sessions.delete(file);
    }
  }

  watch(dir, adapter) {
    if (this.watchers.has(dir)) return;
    let w;
    try {
      w = fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        // A new project directory appears as an event on the root; it gets
        // watched on the next rescan, and its first append is caught then.
        if (!adapter.match(String(filename))) return;
        this.schedule(path.join(dir, String(filename)), adapter);
      });
    } catch {
      return; // deleted between the scan and here, or out of inotify watches
    }
    w.on("error", () => {
      try {
        w.close();
      } catch {}
      this.watchers.delete(dir);
    });
    this.watchers.set(dir, { w, adapter });
  }

  // Startup has no file events to learn from, so recently-written transcripts
  // are read once up front. Without this the cat ignores a turn that was already
  // in flight when it launched.
  seed(dir, adapter, now) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!adapter.match(name)) continue;
      const file = path.join(dir, name);
      if (this.sessions.has(file)) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || now - st.mtimeMs > LOOKBACK_MS) continue;
      this.read(file, adapter, st.mtimeMs);
    }
  }

  schedule(file, adapter) {
    if (this.pending.has(file)) return;
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        this.read(file, adapter, Date.now());
      }, DEBOUNCE_MS)
    );
  }

  read(file, adapter, at) {
    const lines = tail(file);
    if (!lines) return this.sessions.delete(file); // rotated or removed
    const state = adapter.read(lines);
    const prev = this.sessions.get(file);
    // A null reading means "this append said nothing about the turn" — a token
    // counter, a partial write. Keeping the previous verdict is right; treating
    // it as idle would end the turn on a bookkeeping line.
    this.sessions.set(file, {
      agent: adapter.agent,
      state: state || (prev && prev.state) || "busy",
      at,
    });
  }
}

// Directories exactly `depth` levels below root, skipping anything unreadable.
function descend(root, depth) {
  let level = [root];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory()) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  return level;
}

function rank(dirs, limit) {
  if (dirs.length <= limit) return dirs;
  return dirs
    .map((d) => {
      try {
        return { d, m: fs.statSync(d).mtimeMs };
      } catch {
        return { d, m: 0 };
      }
    })
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.d);
}

// The last TAIL_BYTES of a file, as whole lines. The first line of the window is
// dropped when the window does not start at the file's beginning, because it is
// almost certainly cut in half.
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.allocUnsafe(Math.min(TAIL_BYTES, size));
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return text.split("\n");
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

module.exports = { SessionWatcher, claudeState, codexState };
