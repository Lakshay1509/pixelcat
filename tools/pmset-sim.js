/*
 * pmset-sim.js — drive the macOS half of peek mode with real `pmset -g
 * assertions` output, deterministically, without a Mac.
 *
 *   node tools/pmset-sim.js
 *
 * WHY THIS EXISTS
 * Peek mode fails silently in both directions and neither failure is visible
 * from a Linux box. Too strict and the cat never moves; too loose and it parks
 * itself off the edge of the screen and stays there, which is the exact failure
 * the Linux implementation already had to be rescued from once.
 *
 * Four things about this output decide which way it goes, and every one of them
 * is a detail of Apple's formatting rather than of the idea:
 *
 *   - the ASSERTION TYPE is not the only place the type appears. Almost every
 *     assertion is named after itself in lowercase, so `coreaudiod` holding
 *     PreventUserIdle*System*Sleep prints the string "preventuseridlesleep" in
 *     its name and, on other devices, "preventuseridledisplaysleep" — under a
 *     line-wide search for the display type, a machine playing nothing but a
 *     notification chime reads as a machine playing a film.
 *   - an entry WRAPS. `named:` frequently lands on the following line, and
 *     `Created for PID:` and `Timeout will fire in ...` lines follow it, so
 *     "one assertion is one line" is not true.
 *   - process names contain spaces. "Google Chrome" is the single most important
 *     owner this can ever see.
 *   - the display assertion has two spellings. `NoDisplaySleepAssertion` is the
 *     old name, still printed and still used, and dropping it would lose IINA
 *     and anything else built before the rename.
 *
 * So real output is scripted here and run through the real parser. The layout
 * below is Apple's, indentation and wrapping included, because the layout is
 * what is being tested.
 */
const assert = require("assert");
const { assertionsFrom, WatchDetector } = require("../src/main/watching.js");

// A Mac doing nothing: no display assertion anywhere, and hidd's UserIsActive —
// which is a keypress, not a film — sitting right where a naive parser would
// find it.
const IDLE = `2026-08-09 16:15:57 +0530
Assertion status system-wide:
   BackgroundTask                 0
   ApplePushServiceTask           0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    0
   PreventUserIdleSystemSleep     1
   ExternalMedia                  0
   PreventSystemSleep             0
   NetworkClientActive            0
Listed by owning process:
   pid 237(coreaudiod): [0x000472fb00018753] 00:09:40 PreventUserIdleSystemSleep
   named: "com.apple.audio.AppleHDAEngineOutput:1B,0,1,1:0.context.preventuseridlesleep"
   Created for PID: 54000.
   pid 127(hidd): [0x00045a9800098430] 01:53:42 UserIsActive
   named: "com.apple.iohideventsystem.queue.tickle.4295002300.3"
   Timeout will fire in 599 secs Action=TimeoutActionRelease
Kernel Assertions: 0x100=MAGICWAKE
   id=507  level=255 0x100=MAGICWAKE mod=8/9/26, 2:47 PM description=en0 owner=en0
Idle sleep preventers: IODisplayWrangler`;

// The one that matters: a video in a browser tab. Two owners, and only one of
// them is the reason the screen is being held awake.
const CHROME = `2026-08-09 16:20:03 +0530
Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 372(Google Chrome): [0x0000f7b800026d0c] 00:16:31 PreventUserIdleDisplaySleep named: "com.google.Chrome.Playing Audio"
   pid 237(coreaudiod): [0x000472fb00018753] 00:16:30 PreventUserIdleSystemSleep
   named: "com.apple.audio.AppleHDAEngineOutput:1B,0,1,1:0.context.preventuseridlesleep"
   Created for PID: 372.
Idle sleep preventers: IODisplayWrangler`;

// Music out of a monitor's own speakers. coreaudiod takes a DISPLAY assertion
// for DisplayPort audio, so this is the case where the screen is genuinely being
// held awake and nobody is watching anything.
const HDMI_AUDIO = `2026-08-09 16:31:11 +0530
Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 223(coreaudiod): [0x00004e9e00058dc2] 00:03:18 PreventUserIdleDisplaySleep named: "com.apple.audio.AppleGFXHDAEngineOutputDP:10001:0:{B31A-08C6-00000000}.context.preventuseridledisplaysleep"
Idle sleep preventers: IODisplayWrangler`;

// A user who has told the machine to never sleep. Standing preference, not
// playback — and it would otherwise pin the cat off-screen for days.
const CAFFEINATED = `2026-08-09 17:02:44 +0530
Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 8812(caffeinate): [0x0000abc100011111] 04:12:09 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
   pid 108(powerd): [0x000e9eef0001a32e] 08:50:02 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
Idle sleep preventers: IODisplayWrangler`;

// The old spelling, from a player that predates the rename.
const IINA = `2026-08-09 18:00:00 +0530
Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 6001(IINA): [0x0000aa1200022222] 00:41:12 NoDisplaySleepAssertion named: "IINA is playing video"
Idle sleep preventers: IODisplayWrangler`;

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// --- the answer -------------------------------------------------------------

check("an idle Mac is not watching anything", () => {
  assert.strictEqual(assertionsFrom(IDLE), false);
});

check("a video in Chrome is", () => {
  assert.strictEqual(assertionsFrom(CHROME), true);
});

check("mpv holding the screen awake is", () => {
  const out = `Listed by owning process:
   pid 9100(mpv): [0x0000dd4400033333] 00:02:00 PreventUserIdleDisplaySleep named: "io.mpv.video_playing_back"`;
  assert.strictEqual(assertionsFrom(out), true);
});

check("the legacy NoDisplaySleepAssertion spelling counts too", () => {
  assert.strictEqual(assertionsFrom(IINA), true);
});

// --- the ways it would be wrong ---------------------------------------------

/*
 * The single most valuable line in this file. Read the whole entry looking for
 * "preventuseridledisplaysleep" and this is true, because the NAME says it even
 * though the TYPE does not.
 */
check("a system-sleep assertion named after the display one is still not video", () => {
  const out = `Listed by owning process:
   pid 237(coreaudiod): [0x000472fb00018753] 00:09:40 PreventUserIdleSystemSleep
   named: "com.apple.audio.AppleHDAEngineOutput.context.preventuseridledisplaysleep"`;
  assert.strictEqual(assertionsFrom(out), false);
});

check("audio over DisplayPort is coreaudiod's business, not a film", () => {
  assert.strictEqual(assertionsFrom(HDMI_AUDIO), false);
});

check("caffeinate is a preference, not playback", () => {
  assert.strictEqual(assertionsFrom(CAFFEINATED), false);
});

check("UserIsActive is a keypress and never means watching", () => {
  const out = `Listed by owning process:
   pid 127(hidd): [0x00045a9800098430] 01:53:42 UserIsActive named: "com.apple.iohideventsystem.queue.tickle"`;
  assert.strictEqual(assertionsFrom(out), false);
});

// --- the formatting ---------------------------------------------------------

check("a process name with a space in it survives", () => {
  const out = `Listed by owning process:
   pid 372(Google Chrome): [0x0000f7b800026d0c] 00:16:31 PreventUserIdleDisplaySleep named: "x"`;
  assert.strictEqual(assertionsFrom(out), true);
});

check("continuation lines are not entries", () => {
  // If `Created for PID: 372.` were read as an entry it would carry no type and
  // no owner, and the tolerant parse this file wants would have to guess.
  const out = `Listed by owning process:
   pid 372(Google Chrome): [0x0000f7b800026d0c] 00:16:31 PreventUserIdleDisplaySleep
   named: "com.google.Chrome.Playing Audio"
   Created for PID: 372.
   Timeout will fire in 599 secs Action=TimeoutActionRelease`;
  assert.strictEqual(assertionsFrom(out), true);
});

check("an elapsed time with hours parses like any other", () => {
  const out = `Listed by owning process:
   pid 500(VLC): [0x0000bb2200044444] 12:03:44 PreventUserIdleDisplaySleep named: "VLC media playback"`;
  assert.strictEqual(assertionsFrom(out), true);
});

// --- unavailable is not "no" ------------------------------------------------

/*
 * A Mac with nothing playing still prints the section header. Its absence means
 * the call did not do what was asked, and the difference matters: false moves a
 * peeking cat back, null leaves it exactly where it is.
 */
check("output that is not pmset output answers null, not false", () => {
  assert.strictEqual(assertionsFrom(""), null);
  assert.strictEqual(assertionsFrom("pmset: command not found"), null);
  assert.strictEqual(assertionsFrom("Assertion status system-wide:\n   UserIsActive 1"), null);
});

check("an empty section is a real 'nothing is playing'", () => {
  assert.strictEqual(assertionsFrom("Listed by owning process:\n"), false);
});

// --- the detector on top of it ----------------------------------------------

check("the detector only reports changes, and never reports a null", async () => {
  const seen = [];
  const d = new WatchDetector((v) => seen.push(v), { platform: "darwin" });

  const answers = [false, true, true, null, null, false, false];
  let i = 0;
  d.query = (done) => done(answers[i++]);
  for (let n = 0; n < answers.length; n++) d.tick();

  assert.deepStrictEqual(seen, [true, false], `got ${JSON.stringify(seen)}`);
});

check("macOS has a probe at all — the platform gate is the whole port", () => {
  const d = new WatchDetector(() => {}, { platform: "darwin" });
  assert.strictEqual(d.supported, true);
  assert.ok(
    d.probes.some((p) => p.bin === "pmset"),
    "no pmset probe on darwin"
  );
  // And the gate still closes on something genuinely unsupported.
  assert.strictEqual(new WatchDetector(() => {}, { platform: "aix" }).supported, false);
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
