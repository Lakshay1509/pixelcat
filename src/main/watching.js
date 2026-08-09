/*
 * watching.js — is the user watching something right now?
 *
 * Peek mode wants to know "a video is playing, get out of the way". There is no
 * API for that on any of the three platforms, and asking the window manager
 * which window is fullscreen is both compositor-specific and useless anyway — a
 * maximised video and a fullscreen one look the same to the person watching.
 *
 * So each platform is asked the nearest question it can actually answer, and
 * every one of them answers it as a LIST OF OWNERS rather than a boolean. That
 * is the shape the whole file is built around: the boolean form of each of these
 * signals is true for reasons that have nothing to do with video, so the useful
 * answer is always "who", filtered against the things that are known not to be
 * someone watching something.
 *
 * LINUX — power-management inhibition, over D-Bus
 * Anything playing video tells the session "do not blank the screen" — that is
 * how a film stops your monitor sleeping mid-scene — and browsers, mpv and VLC
 * all do it.
 *
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
 * MACOS — power assertions, from `pmset -g assertions`
 * The same idea with a better interface. `pmset -g assertions` prints a "Listed
 * by owning process" section giving pid, process name and the assertion held,
 * needs no privilege and no TCC grant, and — unlike KDE — an idle Mac genuinely
 * holds no display-sleep assertion at all, so the signal starts clean.
 *
 * Only the DISPLAY assertions count. `PreventUserIdleSystemSleep` is what a
 * download or a backup takes, and coreaudiod takes one for every audio context
 * on the machine; reading those as "watching" would hide the cat for music, a
 * Zoom call and a long `npm install` alike. The display-sleep ones are the ones
 * a video player takes, which is the question being asked.
 *
 * WINDOWS — the media session list, NOT the power requests
 * The obvious analogue is `SetThreadExecutionState` with ES_DISPLAY_REQUIRED,
 * and the only way to enumerate who holds one is `powercfg /requests`, which is
 * a wrapper over NtPowerInformation(GetPowerRequestList) and REQUIRES
 * ADMINISTRATOR RIGHTS. A tray app that cannot ask for elevation has no
 * unelevated way in, so that whole route is closed — and the coarse fallback the
 * Linux path keeps does not exist here either.
 *
 * What is available unelevated is the System Media Transport Controls session
 * list — `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`,
 * the thing behind the media flyout on the volume popup. It reports every app
 * that has registered playback, its play/pause state, and the app it belongs to.
 * Win32 desktop processes may call it: the `globalMediaControl` capability in
 * the docs is a packaged-app declaration, and the API is refused only to
 * non-interactive sessions (a service, or SYSTEM), which the cat never is.
 *
 * WHY PlaybackType IS NOT USED TO FIND VIDEO
 * A session carries a PlaybackType of Music, Video or Image, which looks exactly
 * like the "is this actually video" discriminator this feature wants. It is not
 * one. Both browser engines hardcode Music: Chromium's SMTC bridge calls
 * `put_Type(MediaPlaybackType_Music)` once at Initialize and then fills in
 * MusicProperties, and Firefox's WindowsSMTCProvider does the same. A YouTube
 * video in Chrome, Edge or Firefox therefore reports Music, and filtering on
 * Video would leave peek mode dead in the browser — which is where nearly all
 * watching happens. So the type is ignored and Windows is filtered the same way
 * as the other two: by who owns the session.
 *
 * WHY A SUBPROCESS, AND WHY ONE OF THEM IS RESIDENT
 * Talking D-Bus or WinRT from Node means a native module or the wire protocol by
 * hand, and this app has two runtime dependencies and should keep them. Hence a
 * poll at 0.2Hz rather than the 1Hz the agent watcher uses: that one reads /proc
 * and costs nothing, these fork. Five seconds is quicker than anyone notices a
 * cat moving.
 *
 * `gdbus` and `pmset` are small programs and forking one every five seconds is
 * fine. PowerShell is not: starting it costs several times more than the query
 * does, and paying that every five seconds forever would make the cat the
 * heaviest thing on the desktop. So Windows starts ONE PowerShell that keeps the
 * loop itself and prints a line per poll, exactly as win-proc.js does for the
 * process list.
 *
 * `node tools/pmset-sim.js` and `node tools/smtc-sim.js` run real captured
 * output through the real parsers, which is the only part of either port that
 * can be tested from a Linux box. `node tools/watch-probe.js` shows what the
 * detector sees on the machine it is actually running on.
 */
const { execFile, spawn } = require("child_process");

const POLL_MS = 5000;

/*
 * Inhibitions that are a standing user or system preference rather than
 * something playing: the battery applet's "suppress sleep", presentation mode,
 * the power daemon's own bookkeeping. Matched as substrings of the app id.
 */
const NOT_MEDIA = ["plasmashell", "powerdevil", "ksmserver", "kded", "gnome-settings"];

/*
 * The macOS equivalent, matched as substrings of the owning process name.
 *
 * `powerd` files its own bookkeeping assertions. `coreaudiod` takes a
 * display-sleep assertion for audio going out over HDMI or DisplayPort, so
 * trusting it would hide the cat for every song played through a monitor's
 * speakers — it is this list's `plasmashell`. Nothing is lost by dropping it:
 * an app playing a video holds an assertion of its own alongside coreaudiod's.
 *
 * `caffeinate` and the stay-awake utilities are the clearest case of all. They
 * are a user saying "never sleep", indefinitely, on purpose — a standing
 * preference, not something being watched.
 */
const NOT_MEDIA_DARWIN = [
  "powerd",
  "coreaudiod",
  "windowserver",
  "hidd",
  "caffeinate",
  "amphetamine",
  "keepingyouawake",
];

/*
 * Assertion types that mean "keep the SCREEN on". `PreventUserIdleDisplaySleep`
 * is the current name and `NoDisplaySleepAssertion` the legacy one still printed
 * by older systems and still used by some apps; both are the same promise.
 * Compared lowercased against the type field only — never against the whole
 * line, because an assertion's *name* often contains the type spelled in
 * lowercase ("...context.preventuseridledisplaysleep") and matching that would
 * read a system-sleep assertion as a display one.
 */
const DISPLAY_ASSERTIONS = ["preventuseridledisplaysleep", "nodisplaysleepassertion"];

/*
 * Windows: apps whose media session is known to be music and only music,
 * matched as substrings of the app user model id (`Spotify.exe` for a desktop
 * app, `SpotifyAB.SpotifyMusic_...!Spotify` for a packaged one).
 *
 * This list exists because PlaybackType cannot be trusted — see the header.
 * Being on it is a claim that the app CANNOT play video, so Windows Media Player
 * is deliberately absent: `Microsoft.ZuneMusic` is the id for the Windows 11
 * player that replaced Groove, and it plays films as happily as albums.
 */
const NOT_MEDIA_WIN32 = [
  "spotify",
  "itunes",
  "applemusic",
  "apple.music",
  "foobar2000",
  "aimp",
  "musicbee",
  "winamp",
  "deezer",
  "tidal",
  "amazonmusic",
];

const KDE_ARGS = [
  "org.kde.Solid.PowerManagement.PolicyAgent",
  "/org/kde/Solid/PowerManagement/PolicyAgent",
  "org.freedesktop.DBus.Properties.Get",
  "org.kde.Solid.PowerManagement.PolicyAgent",
  "ActiveInhibitions",
];

// Each entry answers true/false/null(unavailable), per platform.
const PROBES = {
  linux: [
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
  ],
  darwin: [
    {
      // There is only one probe here on purpose. pmset ships with the OS, needs
      // no privilege, and names the owner — everything the KDE chain has to try
      // four programs to get at.
      bin: "pmset",
      args: ["-g", "assertions"],
      parse: (out) => assertionsFrom(out),
    },
  ],
};

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

/*
 * One entry of the "Listed by owning process" section:
 *
 *   pid 372(Google Chrome): [0x0000f7b800026d0c] 00:16:31 PreventUserIdleDisplaySleep
 *
 * The type is taken from its POSITION — the word after the assertion id and the
 * elapsed time — rather than by searching the line, because the quoted name that
 * usually follows contains the type again in lowercase and often disagrees with
 * it. An entry frequently wraps before `named:`, and carries `Created for PID:`
 * and `Timeout will fire in` continuation lines after it; none of those match
 * this, which is why matching only the `pid` line is enough to walk the section
 * without tracking where the section ends.
 *
 * Process names contain spaces ("Google Chrome") and parentheses do not appear
 * inside them, so the name is everything up to the closing bracket.
 */
const PMSET_ENTRY = /^\s*pid\s+(\d+)\(([^)]*)\):.*?\]\s+[\d:]+\s+([A-Za-z]+)/;

/*
 * true if some process other than the housekeeping set is holding the screen
 * awake. Null if this does not look like pmset output at all — a Mac with
 * nothing playing still prints the section header, so its absence means the
 * call failed rather than that the answer is no.
 */
function assertionsFrom(out) {
  if (!/Listed by owning process/i.test(out)) return null;
  const holders = [];
  for (const line of String(out).split("\n")) {
    const m = PMSET_ENTRY.exec(line);
    if (!m) continue;
    if (!DISPLAY_ASSERTIONS.includes(m[3].toLowerCase())) continue;
    holders.push(m[2].toLowerCase());
  }
  return holders.some((p) => p && !NOT_MEDIA_DARWIN.some((ig) => p.includes(ig)));
}

// Marks a Windows poll. It cannot collide with an app id: ids never contain a
// tab, and this is the whole first field of the line.
const WATCH_TAG = "--pixelcat-watch--";

/*
 * One line from the Windows helper: the tag, then the app user model id of every
 * session that is PLAYING right now, tab separated.
 *
 * The tag alone is a complete and meaningful line — it means the query worked
 * and nothing is playing. That is the difference between this and the process
 * list in win-proc.js, where an empty answer can only mean the query broke: a
 * machine really can have no media sessions, and the tag is what proves the
 * emptiness was measured rather than inferred from silence.
 */
function playingFrom(line) {
  if (typeof line !== "string" || !line.startsWith(WATCH_TAG)) return null;
  const ids = line
    .split("\t")
    .slice(1)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ids.some((id) => !NOT_MEDIA_WIN32.some((ig) => id.includes(ig)));
}

/*
 * The loop runs inside PowerShell, so the only per-poll cost on this side is
 * reading a pipe.
 *
 * The manager is requested ONCE, before the loop. RequestAsync is the expensive
 * call and the object it returns stays live — GetSessions re-reads the current
 * state on every call.
 *
 * Every WinRT line here is Windows PowerShell 5.1 syntax and it must stay that
 * way. The `[Type, Assembly, ContentType = WindowsRuntime]` literal and the
 * System.Runtime.WindowsRuntime AsTask shim are .NET Framework features that
 * PowerShell 7 dropped, so "modernising" this to `pwsh` would break it — which
 * is also why the spawn below names powershell.exe explicitly rather than
 * whatever is on PATH.
 */
function smtcScript(parentPid, intervalMs) {
  return [
    // Loud during setup: a machine too old for the API, or without the WinRT
    // projection, must die here with something on stderr rather than quietly
    // loop forever printing nothing.
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$out = [Console]::Out",
    "$tab = [char]9",
    `$parent = ${parentPid}`,
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    // WinRT's IAsyncOperation is not a Task and PowerShell cannot await it.
    // This is the one AsTask overload that takes a bare IAsyncOperation`1.
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | " +
      "Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and " +
      "$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    // No spaces inside the type literal: the WinRT form is parsed as one token
    // and a helpful reformat is enough to make it stop resolving.
    "$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager," +
      "Windows.Media.Control,ContentType=WindowsRuntime]",
    "$task = $asTask.MakeGenericMethod($mgrType).Invoke($null, @($mgrType::RequestAsync()))",
    "$task.Wait(-1) | Out-Null",
    "$mgr = $task.Result",
    "while ($true) {",
    // How this exits. Killing an Electron main process does not kill its
    // children on Windows, and a PowerShell left polling forever after the cat
    // was closed would be a genuinely bad thing to ship.
    "  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }",
    /*
     * Sessions come and go between the enumeration and the read — closing a tab
     * mid-loop is enough — and under 'Stop' that would take the whole helper
     * down. A poll that throws prints nothing at all, which the reader treats as
     * "no answer this time" and leaves the cat where it is.
     */
    "  try {",
    "    $ids = @()",
    "    foreach ($s in $mgr.GetSessions()) {",
    // Compared against the enum name rather than its number: Playing is 4 and
    // Paused is 5, which is exactly the pair that would be silently swapped by
    // anyone who assumed the obvious ordering.
    "      if ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {",
    // An id containing a tab would turn one field into two. Nothing is known to
    // do it; the line is cheap and the failure would be baffling.
    "        $ids += (([string]$s.SourceAppUserModelId) -replace '\\s', ' ')",
    "      }",
    "    }",
    `    $out.WriteLine(((@('${WATCH_TAG}') + $ids) -join $tab))`,
    "    $out.Flush()",
    "  } catch { }",
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    "}",
  ].join("\n");
}

// A crashed child is worth another go; a machine where the API does not exist is
// not. Each attempt costs a process spawn.
const MAX_STARTS = 4;
const RESTART_MS = 5000;

/*
 * The resident PowerShell behind the Windows answer.
 *
 * `onValue` is called with true/false per poll, and with NULL when the helper is
 * gone for good. Null is not "leave it alone" here, the way an unanswered probe
 * is on the other platforms: the last thing this source said may have been
 * "something is playing", and a source that then dies would leave the cat parked
 * off the edge of the screen for the rest of the session. So losing the helper
 * has to be reported, and the detector brings the cat home.
 */
class SmtcSource {
  constructor(onValue, { intervalMs = POLL_MS } = {}) {
    this.onValue = onValue;
    this.intervalMs = intervalMs;
    this.child = null;
    this.buf = "";
    this.starts = 0;
    this.stopped = true;
    this.retry = null;
    this.error = "";
    this.answered = false;
  }

  start() {
    this.stopped = false;
    this.spawn();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.buf = "";
  }

  spawn() {
    if (this.stopped || this.child) return;
    if (this.starts >= MAX_STARTS) return this.giveUp();
    this.starts++;

    const src = smtcScript(process.pid, this.intervalMs);
    let child;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-NoLogo",
          // powershell.exe already defaults to STA, but WinRT activation is the
          // one thing here that depends on it, so it is asked for rather than
          // assumed.
          "-Sta",
          // Not strictly needed — an encoded command is not a script file, so
          // execution policy does not apply — but a locked-down machine is
          // exactly where this has to work, and it costs nothing.
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(src, "utf16le").toString("base64"),
        ],
        // windowsHide is what passes CREATE_NO_WINDOW. Without it a GUI app
        // spawning a console app gets a black console window on screen — and it
        // would be on top of the cat.
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (err) {
      this.error = err.message;
      return this.giveUp();
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.feed(chunk));
    // Read stderr rather than ignoring it: a stalled pipe would eventually block
    // the child, and the first line of it is the only explanation anyone will
    // ever get for why peek mode does nothing on their machine.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (!this.error) this.error = String(chunk).trim().split("\n")[0] || "";
    });
    child.on("error", (err) => {
      this.error = err.code === "ENOENT" ? "powershell.exe not found" : err.message;
      this.child = null;
      this.schedule();
    });
    child.on("exit", () => {
      this.child = null;
      this.schedule();
    });
  }

  schedule() {
    if (this.stopped || this.retry) return;
    if (this.starts >= MAX_STARTS) return this.giveUp();
    this.retry = setTimeout(() => {
      this.retry = null;
      this.spawn();
    }, RESTART_MS);
  }

  giveUp() {
    if (!this.answered) return; // never worked; it was never holding the cat
    this.answered = false;
    this.onValue(null);
  }

  feed(chunk) {
    // A stray byte order mark would otherwise be glued to the tag and cost the
    // first poll. Cheaper to drop than to explain.
    this.buf += String(chunk).replace(/^﻿/, "");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      const value = playingFrom(line);
      if (value === null) continue;
      // A line arriving is the only proof the API works, so this is where the
      // restart budget is refunded.
      this.starts = 1;
      this.error = "";
      this.answered = true;
      this.onValue(value);
    }
  }

  // For tools/watch-probe.js and anyone reading a bug report.
  state() {
    if (this.answered) return { ok: true, detail: "media session list" };
    if (this.starts >= MAX_STARTS) return { ok: false, detail: this.error || "gave up" };
    return { ok: false, detail: this.error || "starting" };
  }
}

class WatchDetector {
  /*
   * `platform` is settable for the same reason agents.js lets its watcher be
   * told which OS it is on: the two ports this file gained cannot be exercised
   * from the machine they were written on, and a simulator that had to fake
   * `process.platform` would be testing its own fake.
   */
  constructor(onChange, { intervalMs = POLL_MS, platform = process.platform } = {}) {
    this.onChange = onChange;
    this.timer = null;
    this.watching = false;
    this.intervalMs = intervalMs;
    this.platform = platform;
    this.probe = null; // the first probe that answered; null until one does
    this.probes = PROBES[platform] || null;
    /*
     * Windows is pushed to rather than polled, and the null it can send means
     * something different from an unanswered probe: the helper is gone, so
     * whatever it last claimed has to be retracted or the cat stays hidden. See
     * SmtcSource.
     */
    this.win =
      platform === "win32"
        ? new SmtcSource((v) => this.publish(v === null ? false : v), { intervalMs })
        : null;
    this.supported = Boolean(this.probes || this.win);
    this.running = false;
    this.busy = false;
  }

  start() {
    if (this.running) return;
    if (!this.supported) return;
    this.running = true;
    if (this.win) return this.win.start();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.win) this.win.stop();
  }

  // A slow session must never stack probes up behind each other.
  tick() {
    if (this.busy) return;
    this.busy = true;
    this.query((value) => {
      this.busy = false;
      this.publish(value);
    });
  }

  publish(value) {
    if (value === null) return; // nothing could answer; leave the state alone
    if (value === this.watching) return;
    this.watching = value;
    this.onChange(value);
  }

  query(done) {
    if (!this.probes) return done(null);
    const list = this.probe ? [this.probe] : this.probes;
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

  // For tools/watch-probe.js and anyone reading a bug report.
  state() {
    if (!this.supported) return { ok: false, detail: `no source on ${this.platform}` };
    if (this.win) return this.win.state();
    if (this.probe) return { ok: true, detail: this.probe.bin };
    return { ok: false, detail: this.running ? "no probe has answered yet" : "not started" };
  }
}

module.exports = {
  WatchDetector,
  SmtcSource,
  PROBES,
  NOT_MEDIA,
  NOT_MEDIA_DARWIN,
  NOT_MEDIA_WIN32,
  assertionsFrom,
  playingFrom,
  smtcScript,
  WATCH_TAG,
  POLL_MS,
  MAX_STARTS,
};
