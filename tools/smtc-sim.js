/*
 * smtc-sim.js — drive the Windows half of peek mode without Windows.
 *
 *   node tools/smtc-sim.js
 *
 * WHY THIS EXISTS
 * Windows is the platform where peek mode had no obvious implementation at all,
 * so it is the one running on the most assumptions, and none of them can be
 * checked from here.
 *
 * The route it does NOT take is the one every search recommends: the analogue of
 * a power inhibition is `SetThreadExecutionState(ES_DISPLAY_REQUIRED)`, and the
 * only way to enumerate who holds one is `powercfg /requests`, which needs
 * administrator rights. A tray app cannot ask for them, so the cat asks the
 * system media session list instead — the thing behind the media flyout on the
 * volume popup — which is readable by any ordinary interactive process.
 *
 * That trade brings one trap, and it is the reason this file exists:
 *
 *   A media session carries a PlaybackType of Music, Video or Image, which looks
 *   exactly like the discriminator this feature wants. Both browser engines
 *   HARDCODE Music. Chromium's SMTC bridge calls put_Type(MediaPlaybackType_Music)
 *   once during Initialize and then writes MusicProperties; Firefox's
 *   WindowsSMTCProvider does the same. A YouTube video in Chrome, Edge or Firefox
 *   is therefore announced to Windows as music, and the "obvious" filter — only
 *   peek for PlaybackType == Video — leaves the feature dead in the browser,
 *   which is where nearly all watching happens.
 *
 * So the type is ignored and the owner is filtered instead, exactly as on Linux
 * and macOS. The cases below are the ids those apps actually report, and the
 * transport underneath them: lines arriving in pieces down a pipe from a
 * PowerShell that may crash, and the retraction that has to happen if it does.
 */
const assert = require("assert");
const {
  playingFrom,
  smtcScript,
  SmtcSource,
  WatchDetector,
  WATCH_TAG,
  MAX_STARTS,
} = require("../src/main/watching.js");

// One poll's worth of output: the tag, then the app user model id of every
// session that is playing. Desktop apps report their executable; packaged ones
// report a full AUMID.
const line = (...ids) => [WATCH_TAG, ...ids].join("\t");

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// --- the answer -------------------------------------------------------------

check("nothing playing is a real answer, not a missing one", () => {
  assert.strictEqual(playingFrom(line()), false);
});

check("a video in a browser counts, whatever it calls itself", () => {
  assert.strictEqual(playingFrom(line("chrome.exe")), true);
  assert.strictEqual(playingFrom(line("msedge.exe")), true);
  assert.strictEqual(playingFrom(line("firefox.exe")), true);
});

check("desktop players count", () => {
  assert.strictEqual(playingFrom(line("vlc.exe")), true);
  assert.strictEqual(playingFrom(line("mpc-hc64.exe")), true);
  assert.strictEqual(playingFrom(line("mpv.exe")), true);
});

/*
 * Windows 11's Media Player is the app that used to be Groove, and its id still
 * says Music. It plays films. Adding it to the filter is the tempting mistake
 * this case exists to fail on.
 */
check("Windows Media Player is not filtered out for being called ZuneMusic", () => {
  assert.strictEqual(
    playingFrom(line("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic")),
    true
  );
});

// --- music is not watching --------------------------------------------------

check("a music player alone does not move the cat", () => {
  assert.strictEqual(playingFrom(line("Spotify.exe")), false);
  assert.strictEqual(playingFrom(line("iTunes.exe")), false);
  assert.strictEqual(playingFrom(line("foobar2000.exe")), false);
});

check("the packaged form of the same app is filtered too", () => {
  // Matched as a substring precisely so that one entry covers both installs.
  assert.strictEqual(
    playingFrom(line("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")),
    false
  );
});

check("music alongside a video still means a video is playing", () => {
  assert.strictEqual(playingFrom(line("Spotify.exe", "chrome.exe")), true);
});

check("a paused browser is not in the list at all, so it does not count", () => {
  // The helper only ever emits sessions whose PlaybackStatus is Playing. This is
  // what that looks like from here: Spotify playing, Chrome paused and absent.
  assert.strictEqual(playingFrom(line("Spotify.exe")), false);
});

// --- unavailable is not "no" ------------------------------------------------

check("a line without the tag answers null, not false", () => {
  // PowerShell banners, warnings, and anything else that reaches stdout.
  assert.strictEqual(playingFrom(""), null);
  assert.strictEqual(playingFrom("At line:1 char:1"), null);
  assert.strictEqual(playingFrom("chrome.exe"), null);
  assert.strictEqual(playingFrom(undefined), null);
});

// --- the pipe ---------------------------------------------------------------

check("lines split across chunks are still one line", () => {
  const seen = [];
  const s = new SmtcSource((v) => seen.push(v));
  s.feed(`${WATCH_TAG}\tchr`);
  assert.deepStrictEqual(seen, [], "half a line was answered");
  s.feed("ome.exe\n");
  assert.deepStrictEqual(seen, [true]);
});

check("CRLF and a byte order mark do not cost the first poll", () => {
  const seen = [];
  const s = new SmtcSource((v) => seen.push(v));
  s.feed(`﻿${WATCH_TAG}\tchrome.exe\r\n${WATCH_TAG}\r\n`);
  assert.deepStrictEqual(seen, [true, false]);
});

check("noise between polls is skipped without disturbing the state", () => {
  const seen = [];
  const s = new SmtcSource((v) => seen.push(v));
  s.feed(`${WATCH_TAG}\tvlc.exe\nWARNING: something\n${WATCH_TAG}\n`);
  assert.deepStrictEqual(seen, [true, false]);
});

// --- losing the helper ------------------------------------------------------

/*
 * The failure that would be worst to ship. On Linux and macOS a probe that stops
 * answering leaves the cat where it is, which is right there: the answer is
 * unknown, and unknown is not a reason to move a cat. On Windows the source is a
 * resident process, and if it dies one poll after saying "a video is playing"
 * then leaving the cat where it is means leaving it hidden past the edge of the
 * screen until the app is restarted.
 */
check("a helper that dies while peeking brings the cat home", () => {
  const seen = [];
  const d = new WatchDetector((v) => seen.push(v), { platform: "win32" });
  d.win.feed(`${line("chrome.exe")}\n`);
  assert.deepStrictEqual(seen, [true]);

  d.win.stopped = false;
  d.win.starts = MAX_STARTS; // the restart budget, spent
  d.win.schedule();
  assert.deepStrictEqual(seen, [true, false], "the cat was left off-screen");
});

check("a helper that never worked retracts nothing", () => {
  // Nothing was ever claimed, so there is nothing to take back — and publishing
  // a false here would be asserting "nothing is playing" on a machine where the
  // question was never successfully asked.
  const seen = [];
  const d = new WatchDetector((v) => seen.push(v), { platform: "win32" });
  d.win.stopped = false;
  d.win.starts = MAX_STARTS;
  d.win.schedule();
  assert.deepStrictEqual(seen, []);
});

check("the detector only reports changes", () => {
  const seen = [];
  const d = new WatchDetector((v) => seen.push(v), { platform: "win32" });
  for (const l of [line(), line("chrome.exe"), line("chrome.exe"), line("Spotify.exe"), line()]) {
    d.win.feed(`${l}\n`);
  }
  assert.deepStrictEqual(seen, [true, false]);
});

check("Windows is wired up at all — the platform gate is the whole port", () => {
  const d = new WatchDetector(() => {}, { platform: "win32" });
  assert.strictEqual(d.supported, true);
  assert.ok(d.win, "no media session source on win32");
  // And it is pushed to, not polled: a poll would be a PowerShell every five
  // seconds forever.
  assert.strictEqual(d.probes, null);
});

// --- the script itself ------------------------------------------------------

/*
 * The helper is a string of PowerShell that nothing here can run, so the parts
 * of it that are load-bearing AND look like formatting are asserted instead.
 * Every one of these has a plausible tidy-up that silently breaks the feature.
 */
check("the WinRT type literal has no spaces in it", () => {
  const src = smtcScript(4242, 5000);
  assert.ok(
    src.includes(
      "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager," +
        "Windows.Media.Control,ContentType=WindowsRuntime]"
    ),
    "the type literal was reformatted; WinRT will not resolve it"
  );
});

check("playback state is compared by name, not by number", () => {
  // Playing is 4 and Paused is 5. Anyone writing the number from memory writes
  // the wrong one, and the cat hides for paused videos and not for playing ones.
  const src = smtcScript(4242, 5000);
  assert.ok(src.includes("PlaybackStatus -eq 'Playing'"), "compared numerically");
});

check("the script stops itself when the cat is gone", () => {
  // Killing an Electron main process does not kill its children on Windows.
  const src = smtcScript(4242, 5000);
  assert.ok(src.includes("$parent = 4242"), "no parent pid");
  assert.ok(src.includes("Get-Process -Id $parent"), "no exit condition");
});

check("the manager is requested once, outside the loop", () => {
  // RequestAsync is the expensive call; GetSessions re-reads live state. Moving
  // the request inside the loop is the change that makes this cost real money.
  const src = smtcScript(4242, 5000);
  const before = src.indexOf("RequestAsync");
  const loop = src.indexOf("while ($true)");
  assert.ok(before >= 0 && loop > before, "RequestAsync is inside the loop");
  assert.strictEqual(src.split("RequestAsync").length - 1, 1);
});

check("a poll that throws does not take the helper down", () => {
  const src = smtcScript(4242, 5000);
  assert.ok(/try \{[\s\S]*\} catch \{ \}/.test(src), "the enumeration is unguarded");
  assert.ok(src.includes("$ErrorActionPreference = 'Stop'"), "setup failures are silent");
});

check("the interval reaches the loop", () => {
  assert.ok(smtcScript(1, 5000).includes("Start-Sleep -Milliseconds 5000"));
  assert.ok(smtcScript(1, 250).includes("Start-Sleep -Milliseconds 250"));
});

// --- report -----------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    let why = "";
    try {
      await fn();
    } catch (err) {
      why = err.message;
      failed++;
    }
    console.log(`${why ? "  FAIL" : "  ok  "}  ${name}${why ? `\n          ${why}` : ""}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
