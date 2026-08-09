/*
 * install-desktop-integration.mjs — the two things a Linux desktop needs told
 * about this app, neither of which the app can tell it itself.
 *
 *   node tools/install-desktop-integration.mjs            install
 *   node tools/install-desktop-integration.mjs --remove   undo
 *
 * 1. A DESKTOP ENTRY, so the taskbar knows what the window is.
 *    A window carries an icon and every Linux task manager ignores it, showing
 *    instead the icon of the desktop entry it matches the window's WM_CLASS
 *    against. Run from a checkout there is nothing to match, so the shell falls
 *    back to something generic — under KDE, the X.Org logo, which is how a pixel
 *    cat ends up advertising itself in the taskbar as XWayland. Packaged builds
 *    ship their own entry; this is only for running from source.
 *
 * 2. A KWIN RULE, so the taskbar stops listing it at all.
 *    Pixelcat is a tray app: a cat on the desktop and an icon in the tray. It
 *    has no business holding a taskbar slot as well. Electron cannot arrange
 *    that — skipTaskbar was marked unsupported on Linux in Electron 19 and
 *    removed in 20, because X11's _NET_WM_STATE_SKIP_TASKBAR has no Wayland
 *    equivalent and the workarounds cost more than the feature. Declaring the
 *    window a toolbar type does work and takes the window decorations with it,
 *    which leaves the settings pane with no close button.
 *
 *    So the window manager is asked instead, which is where the decision now
 *    lives. This is KDE-specific and skipped entirely on other desktops.
 *
 * Everything written here is under the user's own config, listed on the way
 * past, and removed by --remove.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const remove = process.argv.includes("--remove");

if (process.platform !== "linux") {
  console.log("Desktop entries and window rules are a Linux thing — nothing to do here.");
  process.exit(0);
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const entryPath = join(dataHome, "applications", "pixelcat.desktop");
const rulesPath = join(configHome, "kwinrulesrc");

// Fixed rather than random, which is what makes re-running this replace the
// rule instead of stacking up a new copy of it every time.
const RULE_ID = "b6f1c3d2-5a47-4e19-9c8b-3d2e1f0a7c64";

// --- 1. desktop entry -------------------------------------------------------
function desktopEntry() {
  if (remove) {
    if (existsSync(entryPath)) {
      unlinkSync(entryPath);
      console.log(`removed ${entryPath}`);
    }
    return;
  }

  const electron = join(root, "node_modules/.bin/electron");
  if (!existsSync(electron)) {
    console.error("node_modules/.bin/electron is missing — run `npm install` first.");
    process.exit(1);
  }

  /*
   * StartupWMClass is the whole point of the file: it is the string the shell
   * matches a live window against. Electron takes it from package.json's `name`
   * and it is NOT the productName — "pixelcat", not "Pixelcat". Getting the
   * case wrong fails silently, so verify with:  xprop WM_CLASS
   */
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(
    entryPath,
    `[Desktop Entry]
Type=Application
Name=Pixelcat
GenericName=Desktop Pet
Comment=A pixel cat that lives on your desktop
Exec="${electron}" "${root}"
Icon=${join(root, "assets/icon.png")}
Terminal=false
Categories=Utility;
StartupWMClass=pixelcat
`
  );
  console.log(`wrote ${entryPath}`);
}

// --- 2. kwin rule -----------------------------------------------------------
const isKDE = () =>
  process.env.KDE_FULL_SESSION === "true" ||
  /kde/i.test(process.env.XDG_CURRENT_DESKTOP || "");

/*
 * kwinrulesrc is INI, and it is SHARED — every window rule the user has ever
 * made lives in it. So this parses what is there, replaces only our own
 * section, and writes the rest back untouched. Rewriting the file wholesale
 * would silently delete rules that took someone an afternoon to get right.
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

function kwinRule() {
  if (!isKDE()) {
    console.log(`not a KDE session — skipping the window rule (${rulesPath} untouched)`);
    return;
  }

  const sections = existsSync(rulesPath) ? parseIni(readFileSync(rulesPath, "utf8")) : [];
  const kept = sections.filter((s) => s.name !== RULE_ID && s.name !== "General");

  if (!remove) {
    kept.push({
      name: RULE_ID,
      lines: [
        "Description=Pixelcat — tray only, no taskbar entry",
        // wmclassmatch=1 is "exact", and matching the class alone (rather than
        // the instance+class pair) is what makes one rule cover both the cat's
        // window and its settings pane.
        "wmclass=pixelcat",
        "wmclasscomplete=false",
        "wmclassmatch=1",
        // 2 is "Force" — the rule wins over whatever the app asks for, which
        // matters because the app asks for the opposite on every platform.
        "skiptaskbar=true",
        "skiptaskbarrule=2",
        "",
      ],
    });
  }

  const ruleIds = kept.filter((s) => s.name !== "$Version").map((s) => s.name);
  const out = [
    "[General]",
    `count=${ruleIds.length}`,
    `rules=${ruleIds.join(",")}`,
    "",
    ...kept.flatMap((s) => [`[${s.name}]`, ...s.lines]),
  ].join("\n");

  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, out.endsWith("\n") ? out : `${out}\n`);
  console.log(`${remove ? "removed rule from" : "wrote rule to"} ${rulesPath}`);

  // Rules are read at startup, so a running KWin has to be told. Best effort:
  // without this the rule still applies, just not until the next login.
  for (const [bin, args] of [
    ["qdbus", ["org.kde.KWin", "/KWin", "reconfigure"]],
    ["qdbus6", ["org.kde.KWin", "/KWin", "reconfigure"]],
    ["dbus-send", ["--session", "--dest=org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure"]],
  ]) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
      break;
    } catch {}
  }
}

desktopEntry();
kwinRule();

if (!remove) {
  console.log("\nRestart Pixelcat for the rule to take: the window is matched when it opens.");
  console.log("Undo both with: npm run desktop -- --remove");
}

// Best effort, and absent on plenty of systems — the entry still works once the
// shell rescans on its own, so a failure here is not an error.
if (!remove) {
  try {
    execFileSync("update-desktop-database", [dirname(entryPath)], { stdio: "ignore" });
  } catch {}
}
