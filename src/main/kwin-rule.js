/*
 * kwin-rule.js — keep the windows out of the KDE taskbar.
 *
 * Pixelcat is a tray app: a cat on the desktop, an icon in the tray. It has no
 * business holding a taskbar slot as well, and it cannot decline one on its own
 * — `skipTaskbar` was marked unsupported on Linux in Electron 19 and removed in
 * 20, because X11's _NET_WM_STATE_SKIP_TASKBAR has no Wayland equivalent and
 * the workarounds cost more than the feature. Declaring the window a toolbar
 * type does work, and takes the decorations with it: the settings pane ends up
 * with no close button.
 *
 * So the window manager is asked instead, which is where the decision actually
 * lives. KDE only.
 *
 * WHY THIS IS A BUTTON AND NOT SOMETHING THE APP JUST DOES
 * This writes to a config file the user owns and shares with every other window
 * rule they have ever made. An app that edits that on first launch, uninvited,
 * has overstepped — so it is offered, and it is reversible from the same place.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Fixed rather than random: this is what makes installing twice replace the
// rule instead of stacking up another copy of it every time.
const RULE_ID = "b6f1c3d2-5a47-4e19-9c8b-3d2e1f0a7c64";

const rulesPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "kwinrulesrc");

function isKDE() {
  return (
    process.platform === "linux" &&
    (process.env.KDE_FULL_SESSION === "true" ||
      /kde/i.test(process.env.XDG_CURRENT_DESKTOP || ""))
  );
}

/*
 * kwinrulesrc is INI, and it is SHARED. Every window rule the user has ever
 * written lives in it, so this parses what is there, touches only our own
 * section and writes the rest back untouched. Rewriting the file wholesale
 * would silently delete work that took someone an afternoon to get right.
 */
function parseIni(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) {
      current = { name: header[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function read() {
  const file = rulesPath();
  return fs.existsSync(file) ? parseIni(fs.readFileSync(file, "utf8")) : [];
}

function isInstalled() {
  return read().some((s) => s.name === RULE_ID);
}

// KWin reads rules at startup, so a running one has to be told. Best effort:
// without this the rule still applies, just not until the next login.
function reconfigure() {
  for (const [bin, args] of [
    ["qdbus", ["org.kde.KWin", "/KWin", "reconfigure"]],
    ["qdbus6", ["org.kde.KWin", "/KWin", "reconfigure"]],
    ["dbus-send", ["--session", "--dest=org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure"]],
  ]) {
    try {
      execFile(bin, args, () => {});
      return;
    } catch {}
  }
}

function write(enabled) {
  const kept = read().filter((s) => s.name !== RULE_ID && s.name !== "General");

  if (enabled) {
    kept.push({
      name: RULE_ID,
      lines: [
        "Description=Pixelcat — tray only, no taskbar entry",
        // Matching the class alone, rather than the instance+class pair, is
        // what lets one rule cover both the cat and its settings pane.
        "wmclass=pixelcat",
        "wmclasscomplete=false",
        "wmclassmatch=1",
        // 2 is "Force": the rule wins over whatever the app asks for, which
        // matters because the app asks for the opposite on every platform.
        "skiptaskbar=true",
        "skiptaskbarrule=2",
        "",
      ],
    });
  }

  const ids = kept.filter((s) => s.name !== "$Version").map((s) => s.name);
  const out = `${[
    "[General]",
    `count=${ids.length}`,
    `rules=${ids.join(",")}`,
    "",
    ...kept.flatMap((s) => [`[${s.name}]`, ...s.lines]),
  ].join("\n")}\n`;

  const file = rulesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  reconfigure();
}

// { supported, installed } — `supported` is false anywhere the rule would mean
// nothing, so the UI can leave the option out entirely rather than offer a
// button that cannot work.
function status() {
  return { supported: isKDE(), installed: isKDE() && isInstalled() };
}

function set(enabled) {
  if (!isKDE()) {
    return { ok: false, message: "This needs a KDE session — nothing to change here." };
  }
  try {
    write(enabled);
  } catch (err) {
    return { ok: false, message: `Could not write the rule: ${err.message}` };
  }
  return {
    ok: true,
    // The rule is applied when a window is mapped, so windows already open keep
    // whatever they had. Saying so beats the user concluding it did not work.
    message: enabled
      ? "Done. Restart Pixelcat and the taskbar entry is gone."
      : "Removed. Restart Pixelcat and the taskbar entry comes back.",
  };
}

module.exports = { status, set, isKDE, RULE_ID, rulesPath };
