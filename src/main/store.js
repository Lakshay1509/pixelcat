/*
 * store.js — settings persistence.
 *
 * Deliberately a plain JSON file rather than electron-store: the whole app has
 * two runtime dependencies and I'd rather keep it that way. Writes are atomic
 * (tmp + rename) so a crash mid-write can't leave an unparseable settings file
 * that bricks startup.
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  palette: "void",
  pattern: "tabby",
  scale: 4, // screen px per sprite px
  name: "",
  position: null, // null => bottom-right of the primary display on first run
  alwaysOnTop: true,
  launchAtLogin: false,
  behaviours: {
    eyeFollow: true,
    petting: true,
    kneading: true,
    overheat: true,
    scrollUnroll: true, // the yarn ball; the key predates it and is kept so
    //                     upgrading does not silently re-enable it
    agentReactions: true,
    peekMode: true,
  },
  // Extra process names to treat as AI agents, comma separated. Empty means
  // just the built-in list (claude, codex, cursor-agent, opencode, aider, ...).
  agentNames: "",
  reminders: {
    stretch: { enabled: true, everyMin: 45 },
    water: { enabled: true, everyMin: 60 },
  },
  pomodoro: { enabled: false, focusMin: 25, breakMin: 5, rounds: 4 },
  pinnedMessage: "",
  messages: [], // { id, time: "14:30", text, enabled }
};

let cache = null;

function file() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Merge that keeps unknown keys from an older/newer build instead of dropping
// them, so downgrading doesn't silently wipe a user's config.
function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object"
        ? merge(base[k], v)
        : v;
  }
  return out;
}

function get() {
  if (cache) return cache;
  try {
    cache = merge(DEFAULTS, JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function set(patch) {
  cache = merge(get(), patch);
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, target); // atomic on every platform we ship to
  } catch (err) {
    console.error("[store] failed to persist settings:", err.message);
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
  return cache;
}

module.exports = { get, set, DEFAULTS };
