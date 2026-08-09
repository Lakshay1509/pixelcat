/*
 * install-desktop-entry.mjs — teach the desktop shell what this app IS, when
 * running it from source.
 *
 *   node tools/install-desktop-entry.mjs            install
 *   node tools/install-desktop-entry.mjs --remove   undo
 *
 * WHY THIS EXISTS
 * A window carries an icon, and every Linux task manager ignores it. What they
 * show instead is the icon of the DESKTOP ENTRY the window belongs to, found by
 * matching the window's WM_CLASS against the entries installed on the system.
 * Run from a checkout there is no entry to find, so the shell falls back to
 * something generic — under KDE, the X.Org logo, which is how a pixel cat ends
 * up advertising itself in the taskbar as XWayland.
 *
 * Packaged builds never hit this: electron-builder writes an entry into the deb
 * and the AppImage. It is only ever a from-source problem, which is exactly why
 * it survives so long unnoticed — it is invisible to everyone except the people
 * working on the app.
 *
 * The entry is written under the user's own data directory. It is one file, it
 * is listed below when written, and --remove deletes it.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

if (process.platform !== "linux") {
  console.log("Desktop entries are a Linux thing — nothing to do on this platform.");
  process.exit(0);
}

const dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "applications");
const target = join(dir, "pixelcat.desktop");

if (process.argv.includes("--remove")) {
  if (existsSync(target)) {
    unlinkSync(target);
    console.log(`removed ${target}`);
  } else {
    console.log(`nothing to remove at ${target}`);
  }
  refresh();
  process.exit(0);
}

const electron = join(root, "node_modules/.bin/electron");
if (!existsSync(electron)) {
  console.error("node_modules/.bin/electron is missing — run `npm install` first.");
  process.exit(1);
}

/*
 * StartupWMClass is the whole point of the file: it is the string the shell
 * matches a live window against. Electron takes it from package.json's `name`,
 * and it is NOT the productName — "pixelcat", not "Pixelcat". Getting the case
 * wrong fails silently, so verify with:  xprop WM_CLASS
 */
const entry = `[Desktop Entry]
Type=Application
Name=Pixelcat
GenericName=Desktop Pet
Comment=A pixel cat that lives on your desktop
Exec="${electron}" "${root}"
Icon=${join(root, "assets/icon.png")}
Terminal=false
Categories=Utility;
StartupWMClass=pixelcat
`;

mkdirSync(dir, { recursive: true });
writeFileSync(target, entry);
console.log(`wrote ${target}`);
console.log("remove it again with: npm run desktop -- --remove");
refresh();

// Best effort. Both of these are absent on plenty of systems and the entry
// still works once the shell rescans on its own, so a failure is not an error.
function refresh() {
  for (const [bin, args] of [
    ["update-desktop-database", [dir]],
    ["kbuildsycoca6", ["--noincremental"]],
  ]) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
    } catch {}
  }
}
