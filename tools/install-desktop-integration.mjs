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
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const remove = process.argv.includes("--remove");

if (process.platform !== "linux") {
  console.log("Desktop entries and window rules are a Linux thing — nothing to do here.");
  process.exit(0);
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const entryPath = join(dataHome, "applications", "pixelcat.desktop");

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
// Delegated to src/main/kwin-rule.js rather than reimplemented here, so the
// button in the settings window and this script cannot drift apart. tools/ is
// excluded from the packaged app; src/ is not, which is why the shared copy
// lives there and not the other way round.
const { status, set } = createRequire(import.meta.url)("../src/main/kwin-rule.js");

function kwinRule() {
  if (!status().supported) {
    console.log("not a KDE session — skipping the window rule");
    return;
  }
  const r = set(!remove);
  console.log(r.ok ? `${remove ? "removed" : "wrote"} the KWin rule` : r.message);
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
