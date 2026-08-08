/*
 * watching.js — is the user watching something right now?
 *
 * Peek mode wants to know "a video is playing, get out of the way". There is no
 * API for that, and asking the window manager which window is fullscreen is both
 * compositor-specific and useless anyway — a maximised video and a fullscreen
 * one look the same to the person watching.
 *
 * The signal that actually tracks playback is power-management INHIBITION.
 * Anything playing video tells the session "do not blank the screen" — that is
 * how a film stops your monitor sleeping mid-scene — and browsers, mpv and VLC
 * all do it.
 *
 * WHY THE BOOLEAN IS NOT ENOUGH
 * `org.freedesktop.PowerManagement.Inhibit.HasInhibit` answers "is anything
 * inhibiting", and on a real desktop the answer is permanently yes for reasons
 * that have nothing to do with video: measured on this KDE session it was true
 * at rest because the battery applet holds a standing "suppress sleep and screen
 * locking" inhibition. Trusting it would park the cat off-screen forever.
 *
 * So where the session will say WHO is inhibiting, that is used instead and the
 * desktop's own housekeeping is filtered out. KDE exposes exactly that through
 * the PolicyAgent. The boolean remains as a last resort for sessions with
 * nothing richer, where it is better than no peek mode at all.
 *
 * WHY A SUBPROCESS
 * Talking D-Bus from Node means a native module or the wire protocol by hand,
 * and this app has two runtime dependencies and should keep them. Hence a poll
 * at 0.2Hz rather than the 1Hz the agent watcher uses: that one reads /proc and
 * costs nothing, this one forks. Five seconds is quicker than anyone notices a
 * cat moving.
 */
const { execFile } = require("child_process");

const POLL_MS = 5000;

/*
 * Inhibitions that are a standing user or system preference rather than
 * something playing: the battery applet's "suppress sleep", presentation mode,
 * the power daemon's own bookkeeping. Matched as substrings of the app id.
 */
const NOT_MEDIA = ["plasmashell", "powerdevil", "ksmserver", "kded", "gnome-settings"];

const KDE_ARGS = [
  "org.kde.Solid.PowerManagement.PolicyAgent",
  "/org/kde/Solid/PowerManagement/PolicyAgent",
  "org.freedesktop.DBus.Properties.Get",
  "org.kde.Solid.PowerManagement.PolicyAgent",
  "ActiveInhibitions",
];

// Each entry answers true/false/null(unavailable).
const PROBES = [
  {
    // KDE, via glib. Prints ('type', 'app.id', 'reason', 'block', uint32 n).
    bin: "gdbus",
    args: [
      "call", "--session",
      "--dest", "org.kde.Solid.PowerManagement.PolicyAgent",
      "--object-path", "/org/kde/Solid/PowerManagement/PolicyAgent",
      "--method", "org.freedesktop.DBus.Properties.Get",
      "org.kde.Solid.PowerManagement.PolicyAgent", "ActiveInhibitions",
    ],
    parse: (out) => appsFrom(out, /\('[^']*',\s*'([^']*)'/g),
  },
  {
    // Same property through Qt's tool, which quotes with " instead of '.
    bin: "qdbus",
    args: ["--literal", ...KDE_ARGS],
    parse: (out) => appsFrom(out, /\(ssssu\)\s*"[^"]*",\s*"([^"]*)"/g),
  },
  {
    bin: "qdbus-qt6",
    args: ["--literal", ...KDE_ARGS],
    parse: (out) => appsFrom(out, /\(ssssu\)\s*"[^"]*",\s*"([^"]*)"/g),
  },
  {
    // Last resort: the coarse boolean. Documented above as unreliable on a
    // desktop that holds standing inhibitions, but better than nothing.
    bin: "qdbus",
    args: [
      "org.freedesktop.PowerManagement",
      "/org/freedesktop/PowerManagement/Inhibit",
      "HasInhibit",
    ],
    parse: (out) => (/true|false/.test(out.toLowerCase()) ? out.toLowerCase().includes("true") : null),
  },
];

// true if any inhibitor is something other than the desktop's own housekeeping.
function appsFrom(out, re) {
  const apps = [];
  let m;
  while ((m = re.exec(out))) apps.push(m[1].toLowerCase());
  // No tuples at all is a legitimate answer — nothing is inhibiting — but only
  // if the call actually returned a list rather than an error we misread.
  if (!/\(|\[/.test(out)) return null;
  return apps.some((a) => a && !NOT_MEDIA.some((ig) => a.includes(ig)));
}

class WatchDetector {
  constructor(onChange) {
    this.onChange = onChange;
    this.timer = null;
    this.watching = false;
    this.probe = null; // the first probe that answered; null until one does
    this.supported = process.platform === "linux";
    this.busy = false;
  }

  start() {
    this.stop();
    if (!this.supported) return; // no equivalent wired up on macOS/Windows yet
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // A slow session must never stack probes up behind each other.
  tick() {
    if (this.busy) return;
    this.busy = true;
    this.query((value) => {
      this.busy = false;
      if (value === null) return; // nothing could answer; leave the state alone
      if (value === this.watching) return;
      this.watching = value;
      this.onChange(value);
    });
  }

  query(done) {
    const list = this.probe ? [this.probe] : PROBES;
    let i = 0;
    const next = () => {
      if (i >= list.length) return done(null);
      const p = list[i++];
      execFile(p.bin, p.args, { timeout: 4000 }, (err, stdout) => {
        if (err) return next(); // not installed, or the service is absent
        const value = p.parse(String(stdout));
        if (value === null) return next();
        this.probe = p; // stick with whatever answered first
        done(value);
      });
    };
    next();
  }
}

module.exports = { WatchDetector, NOT_MEDIA };
