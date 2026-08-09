# AGENTS.md

Engineering context for Pixelcat. Read this before changing anything in `src/main/`
— most of the non-obvious code is non-obvious for a documented reason, and this
file is where the reasons live.

User-facing docs are in [README.md](README.md). This file is the *why*.

---

## Orientation

Electron app, two windows: the pet (transparent, always-on-top, click-through) and
settings. Two runtime dependencies. No network access anywhere in the codebase —
keep it that way.

```bash
npm start          # run it
npm run dev        # run it with the settings window open
npm test           # all simulators — REQUIRED before believing a change
npm run preview    # contact sheet of every palette × pattern
npm run icons      # regenerate app + tray icons from the sprite
npm run desktop    # Linux desktop entry + KWin rule (from a checkout only)
npm run build      # package installers into dist/
```

### Layout

```
src/
  main/
    index.js            app lifecycle, pet window, click-through hit test
    input.js            cursor estimate, uiohook, scroll notching, macOS permission
    evdev-linux.js      /dev/input reader: keys, wheel, touchpad reconstruction
    agent-sessions.js   AI agent transcript readers (exact signal)
    agents.js           AI agent process/CPU watcher (fallback signal)
    win-proc.js         Windows process snapshots over one long-lived PowerShell
    watching.js         peek mode: is a video playing? (three signals, one shape)
    reminders.js        stretch / water / messages / pomodoro
    store.js            atomic JSON settings
    kwin-rule.js        KDE taskbar rule
    preload.js          allow-listed IPC bridge
  renderer/
    pet/                sprites.js (grids), cat.js (renderer), pet.js (behaviours)
    settings/           controls + live preview using the same renderer
tools/
  lib.mjs               build-time rasteriser + zero-dep PNG encoder
  preview.mjs           palette × pattern contact sheet
  make-icons.mjs        app + tray icons, generated from the sprite itself
  cursor-sim.js         the Linux session regimes, simulated
  touch-scroll-sim.js   scripted touchpad fingers
  wheel-sim.js          Windows/macOS scroll notching
  ps-sim.js             Apple `ps` output through the real parser
  win-proc-sim.js       WMI snapshots through the real parser and watcher
  pmset-sim.js          macOS power assertions through the real parser
  smtc-sim.js           Windows media sessions, and the pipe they arrive down
  agent-probe.js        live: what the cat can actually see, once a second
  watch-probe.js        live: why peek mode is or isn't firing
  scroll-probe.js       live: why a real touchpad isn't producing scroll
  cursor-probe.js       live: what the cursor sources report
.github/workflows/
  release.yml           one build job per OS — see the file for why it must be
```

`tools/` renders the cat in Node using the same sprite data the app uses, so the
icon can never drift from the cat it depicts.

---

## Invariants

Things that look redundant, wrong, or removable, and are none of those. Breaking
any of these has broken the app before.

1. **Never collapse the cursor estimate back into a boolean "is it exact".**
   Direction consumers (eye-follow) and pixel consumers (petting, hearts) clear
   different bars. Conflating them is what made every previous fix break the other
   half of the feature.
2. **Never latch onto one cursor source.** All three can be right some of the time
   in the same session. See [Cursor](#cursor-one-estimate-many-correctors).
3. **Click-through hit-testing permission can only ever be revoked, never granted
   mid-session**, and is reconsidered at most once a second. Fast re-granting made
   the cat untouchable mid-stroke on XWayland.
4. **A missing process list is not an empty one.** Where a process list can't be
   produced, checks that need it are *skipped*, not failed. Treating "cannot see
   any processes" as "no agent is running" kept Windows dead for a full release.
5. **An empty WMI snapshot is never published.** Windows cannot have zero
   processes; empty means broken, and broken publishes nothing.
6. **Masks recolour, they never create.** A pattern cannot add a pixel, so it can't
   deform the silhouette or leak past the outline. The pomodoro headband knot is
   the single deliberate exception.
7. **Outlines are generated, never hand-drawn.** The renderer dilates the alpha
   mask by 1px.
8. **`settings.position` is the CAT's top-left, not the window's.** See
   [Positioning](#positioning-position-means-the-cat-not-its-window).
9. **Dragging uses relative deltas, never the global cursor.**
10. **Reminders are wall-clock based**, compared against `Date.now()`, never
    accumulated `setInterval` ticks.
11. **Key codes are discarded immediately.** The evdev reader reduces every key
    event to "a key went down". Nothing is buffered, logged, or persisted. This is
    a privacy promise in the README — do not weaken it.
12. **Run `npm test` before believing a change.** Every regression this project has
    had was in a regime the developing machine could not physically be in.

---

## Cursor: one estimate, many correctors

This is the part that decides whether a desktop pet works on someone's machine,
and the naive design does not survive contact with Wayland.

**What actually happens on Wayland** (measured on KDE, not assumed):

- `screen.getCursorScreenPoint()` returned the *identical coordinate 60 times out
  of 60 samples* while the mouse moved over a Wayland window. Wayland does not tell
  an unfocused app where the pointer is; Electron reports the last position the
  cursor was over an XWayland surface and holds it until the cursor crosses one
  again — at which point it leaps the whole way in a single sample.
- `uiohook-napi` fails outright with `XkbGetKeyboard failed to locate a valid
  keyboard`, then delivers nothing.

So there are three sources, and the pointer is assembled from all of them:

| Source | Where it works | Gives |
| --- | --- | --- |
| `getCursorScreenPoint()` | Windows, macOS, Linux/X11 | exact cursor |
| `uiohook-napi` | Windows, macOS (needs Accessibility), Linux/X11 | keys, scroll (notched on the way in) |
| `/dev/input` (evdev) | Linux incl. Wayland, needs `input` group | keys, scroll (wheel *and* fingers), raw mouse deltas |

There is no "which source", because the honest answer on a real Wayland desktop is
*all of them, some of the time*. Electron runs as an **XWayland** client, and
XWayland's pointer is neither working nor frozen: `getCursorScreenPoint()` is exact
while the cursor is over an X surface — including the cat's own window — and frozen
the instant it crosses onto a native Wayland one.

That third regime is what broke this repeatedly. The old code picked one source and
latched: the first evdev delta flipped it to "estimated" and nothing could flip it
back, so a native point that was telling the truth several times a second was
discarded for the rest of the session, and the cat had no idea where the pointer
was unless it was physically over its window.

So there is **one estimate**, and everything that can say something true about it
gets to correct it — the native point whenever it changes, DOM pointer events over
our own window, raw evdev deltas integrated in between, and the screen edges, which
the real cursor stops at and so does ours (shoving the mouse into a corner resyncs
an axis exactly, and users do that constantly without being asked to).

The estimate carries a **confidence**: how far wrong it expects to be. Dead
reckoning drifts because the compositor applies pointer acceleration we cannot
observe — so it is measured instead. Any tick where the native point *and* a raw
delta both moved is a reading of that acceleration, and confidence decays with
distance travelled times how badly that constant is still known. A fresh session
loses faith quickly; a calibrated one holds it across a screen.

Consumers then clear a bar instead of being handed a boolean, and that is the part
that matters:

- **Eye-follow** needs a direction, and a direction survives being somewhat wrong.
  It takes a rough fix happily, which is why the cat watches you anywhere on the
  desktop.
- **Petting, hovering and hearts** need a pixel, and take nothing but an exact
  position — a DOM event, or a native point that genuinely moved.

The cat is also its **own calibration target**. The renderer hands every DOM pointer
position back to main, so each time the cursor approaches the window the estimate is
re-anchored to a true position — precision matters most just before you touch the
cat, and that is exactly the moment the truth is available.

> `node tools/cursor-sim.js` drives all of this through every session type — X11,
> X11 with evdev, frozen Wayland, XWayland — with a scripted pointer and a fake
> clock, and checks what it concluded against what was actually true.

---

## Click-through: the window is transparent to clicks except where the cat is

The pet window is bigger than the cat — the padding is the stage it acts on
(bubbles above, timer beside, room to pounce). A window that size would eat every
click in the corner of your screen, so it is click-through by default and
`setIgnoreMouseEvents` is flipped off only while the cursor is over an opaque pixel.

That hit test runs off the **cursor poll in main**, not renderer `mousemove`,
because a click-through window receives no `mousemove` at all — the renderer would
never learn the cursor had arrived. The renderer publishes the cat's opaque bounding
box; main compares it against the polled cursor.

Whether it may do that at all is a separate, deliberately **slow** decision. It is
settled from accumulated evidence — how much of the pointer's real travel the native
point managed to witness — reconsidered at most once a second, and it can only ever
be taken away, never granted. The asymmetry is the point: losing it costs a window
that absorbs clicks in its padding, which is irritating and survivable. Granting it
wrongly costs the cat, because the window starts hit-testing against a point that is
about to freeze somewhere else, and every click then falls straight through the cat
forever. Gating this on whether the *current sample* happened to be exact is what
made the window flip interactive and back several times a second on XWayland, so the
cat could go untouchable mid-stroke.

Where hit-testing is refused, the window stays interactive and the renderer drives
touch from its own DOM pointer events, which are exact whenever the cursor is over
the window. Local events take precedence over the global feed for 400ms after they
arrive; the global feed fills the gaps. The trade-off is the window's rectangle, not
just the cat, absorbing clicks — which is why the `input` group is worth the one
command.

---

## macOS Accessibility: asking is not the hard part, noticing is

libuiohook calls `AXIsProcessTrustedWithOptions` with the prompt flag set, so
starting the hook is what puts macOS's "Pixelcat would like to control this
computer" dialog on screen. Without the grant, `uIOhook.start()` throws
`UIOHOOK_ERROR_AXAPI_DISABLED`.

That used to be caught, written into the status as "denied", and that was the end of
it — a dead end the app could enter and never leave. The user went to System
Settings, granted the permission the app had *just asked them for*, came back, and
nothing had changed. Nothing would change until they quit and relaunched, and
nothing told them to.

macOS applies an Accessibility grant to a process that is already running, so there
was never anything to relaunch for. `input.js` polls
`systemPreferences.isTrustedAccessibilityClient(false)` every 2s after a denial and
starts the hook the moment the grant lands. **The `false` matters**: it means *check,
don't ask*. libuiohook has already shown the dialog, macOS shows it once per launch,
and prompting on a two-second timer would either do nothing or stack dialogs forever.

Two smaller rules fell out of it:

- Only `UIOHOOK_ERROR_AXAPI_DISABLED` is reported as "denied". A run loop that could
  not be acquired is a different problem, and sending someone to grant a permission
  they already granted is worse than saying nothing.
- The settings button that opens the Accessibility pane appears on macOS as well as
  Linux.

---

## Scroll: touchpads have to be reconstructed, not received

Scrolling with a wheel is a hardware event: the mouse emits `REL_WHEEL` and there is
nothing to work out. Scrolling on a laptop touchpad is **not an event at all** — it
is an interpretation. The kernel reports only where each finger is (`EV_ABS`
multitouch), and libinput decides in userspace that two of them moving together
means scroll.

Reading `/dev/input` bypasses libinput, which is the whole point on Wayland — so we
inherit that job too. Without it the yarn ball answers only to a plugged-in mouse
and the trackpad does nothing, which is exactly how this read: the touchpad here
reports `EV=10001b`, with no `EV_REL` bit anywhere in it.

So `evdev-linux.js` does what libinput does. It tracks live fingers by their
multitouch slots, and while there are exactly **two**, averages their vertical travel
per frame — averages rather than sums, because two fingers moving together are one
scroll, and because it makes a pinch cancel out, which is right.

Two details do most of the work:

- **The threshold is a fraction of the pad, not a number of units.** Device units
  have no fixed size — pads differ by roughly 5× in how many they report per
  millimetre, and the range cannot be read without an ioctl Node has no way to
  issue. So the pad's height is learned from the finger positions themselves, which
  costs nothing and converges within a swipe or two. A guess is used until then, and
  being 2× out merely makes the first swipe eager or lazy.
- **It is notched, at most one report per 50ms.** A finger is continuous and would
  otherwise report at the pad's full ~125Hz. Travel keeps accumulating in between,
  so scrolling slowly makes the ticks sparse rather than absent — this is what makes
  a touchpad feel like a wheel instead of a firehose.

Devices that report a wheel of their own are left alone, so an Apple trackpad —
whose driver hands over both touch data *and* a `REL_WHEEL` it derived from that
same data — cannot be counted twice.

> `node tools/touch-scroll-sim.js` scripts the fingers — a pinch that must cancel, a
> re-grip that must not fire, a pad half the size of this one.
> `node tools/scroll-probe.js` does the same job on real hardware and separates the
> three ways this fails: devices that won't open, devices that open but say nothing,
> and fingers that arrive but aren't read as a scroll.

### Windows sends the same firehose and does not admit it

Windows *does* deliver touchpad scroll as wheel messages, so none of the above is
needed there — which is why it took a bug report to notice the yarn ball did nothing
on a Windows laptop while working perfectly with a mouse.

A Windows Precision Touchpad is an **ultra-high-resolution** device, and Microsoft
documents the consequence plainly: the default delta for one is **1**, not the 120 a
wheel click sends. libuiohook computes its `rotation` by accumulating deltas and
dividing by 120, keeping the remainder — so a two-finger drag arrives as a message
per unit at the pad's full report rate, of which **119 out of every 120 carry
`rotation: 0`**.

Both halves of that broke the ball, and only together:

- The renderer bats it once per report. At a hundred reports a second it went
  straight to maximum speed, hit the edge of the canvas, and stayed pinned there for
  the whole gesture — re-kicked before it could ever hop. There was an animation; it
  just had nowhere to go and nothing to watch.
- `rotation: 0` says nothing about direction, so the side it rolled to was a guess
  that fed back into itself and never corrected.

So `input.js` notches the uiohook stream into the shape a wheel already has, at the
same 50ms cadence `evdev-linux.js` gives a Linux touchpad, carrying the last
direction that was actually *observed*. **A real rotation still goes straight through
the instant it arrives** — a wheel click must not wait 50ms to be answered, and it is
the only thing that ever teaches direction.

macOS gets the same treatment for free, and wants it: libuiohook reads
`kCGScrollWheelEventDeltaAxis1` there, which is a **line** delta, so a slow trackpad
drag scrolling less than one line at a time reports `rotation: 0` the same way. A
line-granularity scroll passes straight through untouched, so there's nothing to lose
either way.

**Known wrongness, not a rounding error:** because libuiohook discards the sign of a
sub-notch step before handing anything over, a touchpad scroll that *reverses* carries
the previous direction for its first 120 units and the ball sets off the wrong way
before correcting. Remembering the last observed direction still beats remembering
nothing — scrolling the same way twice is far more common than turning around.

> `node tools/wheel-sim.js` replays both Windows streams through it on a fake clock,
> generated by transcribing libuiohook's own arithmetic rather than guessing at its
> output, and checks the two properties that matter: a touchpad cannot report faster
> than a wheel notches, and a wheel click is never delayed.

---

## AI agent detection, without integrating with any agent

The cat thinks along while Claude Code, Codex, Cursor, opencode, aider, goose and
friends are working, and hops when they finish.

This used to be inferred from CPU alone, and **CPU is bad at this job in both
directions**. An agent waiting on the model burns nothing, so "thinking" read as
"finished" and the cat celebrated mid-answer — then again at the next pause, and the
next. Meanwhile a terminal that is merely being *typed into* redraws and burns CPU,
so an idle session read as work. No amount of debouncing fixes a signal that is
measuring the wrong thing; it only makes both failures slower.

The fix is that the agents already write down what they're doing. They persist a
transcript so `--resume` works, it is appended to as the turn happens, and its last
entry says outright whether the model is mid-turn or the turn ended.
`agent-sessions.js` reads it — exact, instant, no configuration, no cooperation from
the agent.

- **Claude Code** (`~/.claude/projects/*/*.jsonl`) — one assistant message is split
  across several lines (thinking, text, one per tool call) and every line carries
  that message's `stop_reason`. `tool_use` means still working; anything else means
  the turn ended. Reading the content *blocks* instead would be wrong: a mid-turn
  "Let me check the config" is its own line and looks exactly like a final answer.
  Only `stop_reason` separates them.
- **Codex** (`~/.codex/sessions/**/rollout-*.jsonl`) — states it outright, as
  `event_msg` payloads `task_started` / `task_complete`.

`agents.js` keeps CPU, demoted to covering the one gap transcripts have: a long tool
call writes nothing for as long as it runs, and during exactly that gap the process
tree is busy. So the two compose — **transcripts drive, CPU covers while a session is
silent** — and agents that keep no readable transcript (aider, goose, amp) still work
on CPU alone.

Details that decide whether this feels alive or broken:

- **Two speeds of "done".** A transcript-confirmed turn ending is a fact, so it is
  announced in ~2s. A CPU lull is a guess and still has to persist ~8s and follow
  enough work to have been a task at all.
- **The whole process tree, not just the agent.** Most of what a turn costs is spent
  in children — the test run, the build — while the parent sits at zero. Reaped
  children count too (`cutime`), which is how a finished test run still registers.
- **`comm` is not enough.** An agent installed as an npm package runs as
  `node .../claude-code/cli.js` and shows up as "node". Interpreter processes get
  their arguments read; **shells deliberately do not**, since a `bash -c` command line
  contains whatever the agent happened to run and would match itself constantly.
- **A transcript outlives the process that wrote it.** A session closed mid-turn says
  "working" forever, so a session only counts while its CLI is still running, and a
  "working" session that has gone silent for minutes hands the decision back to CPU —
  which can tell a long tool call from an abandoned terminal.
- **…but a missing process list is not an empty one.** That "still running" check
  needs a process list, and where one cannot be produced it is *skipped* rather than
  failed. Treating "we cannot see any processes" as "no agent is running" is what kept
  Windows dead even for Claude Code, whose transcript was on disk being right the
  whole time. The staleness timeout still covers the abandoned-terminal case, in
  minutes instead of instantly — a much cheaper failure than detecting nothing at all.
- **CPU time deltas, not instantaneous %CPU.** An agent streaming a reply uses CPU in
  bursts, so a sampled percentage flickers between 0 and 40 and the cat twitches.
  Accumulated jiffies over the interval are smooth.

### Linux

Reads `/proc` directly — no process spawn, so polling at 1Hz doesn't become the CPU
load it's trying to measure.

### macOS: three details of BSD `ps` decide whether this works at all

- **`ps -o pid=,ppid=,time=` prints one column or three, depending.** In BSD, an `=`
  takes the *whole rest of the argument* as that column's header — so this would be
  asking for a single PID column headed `,ppid=,time=,args=`. Apple's `ps` disables
  that (`#ifndef __APPLE__` in `keyword.c`) and splits on commas like everyone else.
  It is one `#ifdef` away from having silently asked for nothing.
- **TIME is `MMM:SS.hh`, not `hh:mm:ss`.** The minutes are *total* minutes and never
  carry into an hours field, so `120:00.00` is two hours. Read left to right it is
  five days.
- **TIME carries hundredths**, and the code used to claim it didn't. The old comment
  said macOS resolved CPU "only to the second, too coarse for a 1Hz poll" and reached
  for `%cpu` to compensate — but Apple's `cputime()` formats `"%3ld:%02ld.%02ld"`, so
  the resolution is a centisecond, exactly a Linux jiffy. Worse, the fallback it
  justified was actively harmful: BSD `%cpu` is a **decaying average** over roughly
  the last minute, summed across the whole process tree, so a turn that had just
  finished went on reading as busy until it decayed. For the agents with no transcript
  — aider, goose, amp, opencode — "finished!" arrived tens of seconds late or never.
  It is gone; a cumulative counter stops moving the moment the work does.

`ps` is also invoked with `-ww` and with `$COLUMNS` stripped from its environment.
Apple's `ps` already goes to unlimited width when stdout is not a terminal, which it
never is here, but that decision sits downstream of a `$COLUMNS` lookup and this
process inherits whatever shell launched it. A width inherited from someone's
80-column terminal would cut the tail off
`node …/node_modules/@anthropic-ai/claude-code/cli.js` — the only part of that line
that identifies an agent.

> `node tools/ps-sim.js` runs real `ps` output, in Apple's exact column layout,
> through the real parser and matcher.

### Windows has neither `/proc` nor `ps`

The old code asked it for `ps` anyway, got `ENOENT`, and swallowed it once a second
forever — which is why agent detection did nothing at all there. `wmic` is the answer
every search returns and it is the wrong one now: disabled by default since Windows 11
23H2, removed outright at 25H2.

So `win-proc.js` starts **one** PowerShell that keeps the loop itself and prints a
`Win32_Process` snapshot down a pipe; Node pays for a string split. Three consequences:

- **It samples every 2s, not every 1s.** A WMI enumeration is not cheap and CPU is
  only the fallback signal. So the busy threshold is expressed as a *rate* and scaled
  by the interval actually observed, and a snapshot that has not refreshed yet is not
  re-deltaed into looking like a lull.
- **An empty snapshot is never published.** A failed WMI query leaves the result empty
  rather than stopping, and an empty snapshot terminated normally would read as "this
  machine is running no processes" — vetoing every transcript and putting Windows back
  where it started. Windows cannot have zero processes, so empty means broken, and
  broken publishes nothing.
- `claude.exe`, `claude.cmd` and `node.exe …\claude-code\cli.js` are the same agent.
  Executable suffixes are stripped, and the command line is split **quote-aware**, or
  `C:\Program Files\nodejs\node.exe` becomes two arguments and the script path — the
  only thing identifying an agent under an interpreter — comes out as `"C:\Program`.

> `node tools/win-proc-sim.js` scripts a snapshot through the real parser and the real
> watcher — a command line containing a tab, a snapshot arriving a byte at a time, a
> machine with no WMI at all — because the PowerShell is the small half and everything
> that can actually be wrong is on this side of the pipe.
>
> `node tools/agent-probe.js` prints both signals once a second — which transcripts
> are live and what they say, which process trees matched and what they burned — so a
> miss can be told apart from a mismatch. On Windows it prints `procs: unavailable`
> when WMI cannot be reached, which is a **working** state: transcripts alone still
> cover Claude Code and Codex.

---

## Sprites: palette slots, not colours

`src/renderer/pet/sprites.js` holds the cat as a 32×32 grid of *slot* letters. A pixel
knows it is `B` (fur), `M` (marking), `L` (light) or `N` (pink) — it never knows it is
`#2b2b2b`.

That's the whole reason "customise its colour and pattern" is cheap: a palette is a
four-entry map and a pattern is a mask that repaints fur. 8 palettes × 5 patterns = 40
cats out of one hand-drawn grid, and adding a ninth colour is four hex values, not
another sprite sheet.

Two rules keep it safe:

- **Masks recolour, they never create.** A mask can turn fur into marking, but it
  cannot add a pixel, so no pattern can deform the silhouette or leak past the outline.
- **Outlines are generated, not drawn.** The renderer dilates the alpha mask by 1px.
  Hand-authored outlines would need redrawing for every pose; generated ones are
  consistent for free. 

Eyes are drawn procedurally on top rather than baked in, because eye-follow needs
per-frame control of the pupil — and once eyes are procedural, blink, half-lid and
sleep are three lines each instead of three more grids.

---

## Behaviours are overlapping drives, not exclusive states

`src/renderer/pet/pet.js` keeps continuous values — `heat`, `petMeter`, `hoverAmt`,
`sleepiness` — that rise and decay independently. A state machine with one active
state at a time reads like a vending machine; overlapping drives are why the cat can
be half-asleep, blink, and still track your cursor.

Squash-and-stretch pivots on the feet rather than the centre, so a squashed cat presses
into the desk instead of floating.

### The yarn ball, and why it is drawn on top of the cat

Scrolling bats a ball of yarn along the desk. A thread unspools back to the cat's paws
and reels it in again when you stop.

It replaced a paper sprite spawned per wheel tick and thrown downward under gravity. A
long scroll buried the desk in rectangles that all fell out of frame: nothing to watch
on the way, nothing left afterwards, and a mess in between. One ball on a spring gives
the scroll somewhere to go *and* somewhere to come back to — and the return trip is not
decoration, it is what keeps the effect on a canvas with only 60px of padding either
side of the cat.

Three things that were wrong on the first attempt:

- **The ball is drawn in front of the cat**, which sounds wrong and is not. It sits on
  the paw line, not at head height, so the only thing it crosses is the cat's front
  feet — which is where a ball on a desk is. Drawing it *behind* was tried first: the
  cat is 128px of opaque sprite, so rolling inward made the ball vanish for most of its
  journey.
- **It rests at the flank, not at the paws.** Resting in front of the paws looks tidier
  standing still, but the ball is 21px against a 128px cat and would cover the belly
  markings the whole time it is out.
- **The physics was tuned against the real canvas, not by feel.** Travel and settling
  time pull against each other, and the spring constant matters far less than the
  impulse cap and the drag — sweeping all three found the trio that gets the ball across
  the cat and back to rest 2.5s after the last scroll, just as it starts to fade.

The ball is its own sprite rather than a particle, because particles are one flat colour
and a ball whose wrap you cannot see turning reads as a dot sliding sideways. Four frames
step the wrap one pixel along; the cycle runs backwards when it rolls the other way. Its
silhouette is a real circle rather than a square with the corners knocked off, which at
7px is the whole difference between a ball and a die.

### The pomodoro is worn, not displayed

A focus round used to put a `FOCUS 24:51` banner beside the cat. It was the only thing on
screen that looked like UI rather than a pet, and it spent that space telling you
something a clock already tells you.

Now the cat puts a **headband** on for a focus round and takes it off for the break. It
comes with the same narrowed eyes the cat uses when an agent is working, applied through
`max()` so the cat still blinks: never blinking for 25 minutes is a stare, not
concentration.

The band is painted over fur slots only, **never the generated outline** — filling whole
rows would eat the rim the sprite needs to stay legible against an arbitrary desktop. Its
knot is the one place anything adds pixels *outside* the silhouette, which patterns are
forbidden from doing, because an accessory that stops at the skull is just a stripe.

Removing the banner meant removing a control, so the clock and controls moved somewhere a
clock belongs:

- **Settings** shows `Focus — 12:34 left · round 2 of 4` on the same one-second feed the
  cat gets, with `STOP POMODORO` and `RESET ROUND`.
- **Reset restarts the phase you are in**, not the whole cycle. The reason to reach for it
  is an interruption partway through a round, and throwing away banked rounds would be a
  strange punishment for being interrupted.
- **The tray menu counts in minutes, not `mm:ss`.** A tray menu is a *static* menu —
  `setContextMenu` paints it once — so a seconds countdown would freeze at whatever it read
  when the menu was last built. It is rebuilt only when the minute actually changes.
- **Both menus draw their pomodoro entries from one function.** They were written out twice
  before, with only the tray copy kept in sync, so the cat's own right-click menu could
  offer "Start Pomodoro" in the middle of a round.

---

## Positioning: position means the CAT, not its window

`settings.position` is the sprite's own top-left on screen. The window is larger than the
cat (padding is the stage for bubbles and pouncing), so aligning the *window* to a
requested point parks the cat ~60px in from every screen edge — you can never reach the
corner.

Placing the window off-screen to compensate does not work: KWin, like most window managers,
refuses a negative position and silently clamps it back (verified — asking for `-60,-70`
produced a window at `0,0`).

So the window always stays fully on-screen and any shortfall is handed to the renderer as
`catOffset`: the sprite slides *within* its own window to reach the true edge. Snapping to
a corner lands the cat flush against it.

One consequence: at the top edge, "above the cat" is off-screen, so speech bubbles flip to
below the cat automatically.

### Dragging uses relative deltas, never the global cursor

Drag is driven by pointer capture and `movementX/Y` from the renderer, and main moves the
window by those deltas. Absolute positioning against the global cursor looks simpler and
breaks badly: on Wayland that cursor is frozen, so the cat teleports to one point, and a
lost mouse-up leaves the drag latched — which silently overrides `setPosition`, making the
position presets look broken. Pointer capture also guarantees move/up events keep arriving
once the pointer leaves the window. A watchdog clears a stuck drag flag regardless.

---

## Peek mode: inferring "a video is playing"

There is no API for it on any platform, and asking the window manager which window is
fullscreen is both compositor-specific and useless anyway — a maximised video and a
fullscreen one look the same to the person watching.

So each platform is asked the nearest question it *can* answer. They are three different
questions with three different answers, and the one thing they have in common is the shape
of the answer: **a list of owners, never a boolean**. Every one of these signals has a
boolean form, and every boolean form is true for reasons that have nothing to do with
video. `NOT_MEDIA`, `NOT_MEDIA_DARWIN` and `NOT_MEDIA_WIN32` are the same idea three times.

### Linux — power-management inhibition, over D-Bus

Anything playing video tells the session "do not blank the screen", and browsers, mpv and
VLC all do it.

`org.freedesktop.PowerManagement.Inhibit.HasInhibit` answers "is anything inhibiting", and
on a real desktop that is permanently yes for reasons unrelated to video — measured on this
KDE session it was true at rest because the battery applet holds a standing inhibition.
Trusting the boolean would park the cat off-screen forever. So where the session will say
*who* is inhibiting, that is used instead and the desktop's own housekeeping is filtered
out by app id. KDE exposes exactly that through the PolicyAgent; the boolean remains as a
last resort.

### macOS — power assertions, from `pmset -g assertions`

The same idea with a better interface, and the port was as cheap as this file used to
predict: one more entry in `PROBES`, no new dependency, no change to `WatchDetector`.
`pmset` needs no privilege and no TCC grant, names the owning process, and — unlike KDE —
an idle Mac holds no display-sleep assertion at all, so the signal starts clean.

Two things about the output decide whether it works, and neither is about the idea:

- **Only the DISPLAY assertions count.** `PreventUserIdleSystemSleep` is what a download or
  a backup takes and what `coreaudiod` takes for every audio context on the machine.
  `PreventUserIdleDisplaySleep` (and its legacy spelling `NoDisplaySleepAssertion`) is what
  a video player takes.
- **The type must be read by position, not by search.** Almost every assertion is named
  after itself in lowercase, so a system-sleep assertion routinely prints the string
  `preventuseridledisplaysleep` inside its own name. A line-wide match reads a notification
  chime as a film. `PMSET_ENTRY` takes the word after the assertion id and the elapsed
  time, and nothing else.

`coreaudiod` is in the filter list because it takes a *display* assertion for audio going
out over HDMI or DisplayPort — it is this list's `plasmashell`. Nothing is lost: a video
player holds an assertion of its own alongside it.

### Windows — the media session list, and why not the obvious thing

The direct analogue is `SetThreadExecutionState(ES_DISPLAY_REQUIRED)`, and the only way to
enumerate who holds one is `powercfg /requests` — a wrapper over
`NtPowerInformation(GetPowerRequestList)`, which **requires administrator rights**. A tray
app cannot ask for elevation, so that route is closed outright, and unlike Linux there is
no coarse boolean to fall back to either.

What *is* readable unelevated is the System Media Transport Controls session list —
`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`, the thing behind
the media flyout on the volume popup. It reports every app that registered playback, its
play state, and which app it belongs to: the same owner-list shape as the other two. The
`globalMediaControl` capability in Microsoft's docs is a *packaged-app* declaration; the
API is refused only to non-interactive sessions (a service, or SYSTEM), which the cat never
is.

**Do not filter on `PlaybackType`.** A session declares Music, Video or Image, which looks
exactly like the discriminator this feature wants, and it is a trap. Both browser engines
hardcode Music: Chromium's SMTC bridge calls `put_Type(MediaPlaybackType_Music)` once in
`Initialize()` and then writes `MusicProperties`, and Firefox's `WindowsSMTCProvider` does
the same. A YouTube video in Chrome, Edge or Firefox announces itself to Windows as music.
Filtering on `Video` would leave peek mode dead in the browser, which is where nearly all
watching happens — so the type is ignored and the owner is filtered instead.

Two consequences of the trade, both in the README: it only sees apps that register with the
media controls, and it needs Windows 10 1809.

### The costs, and the one resident process

Talking D-Bus or WinRT from Node means a native module or the wire protocol by hand, and
this app has two runtime dependencies and should keep them. So all three fork, and all
three poll at 0.2Hz — five seconds is quicker than anyone notices a cat moving.

`gdbus` and `pmset` are small programs and forking one every five seconds is fine.
**PowerShell is not.** Starting it costs several times more than the query does, so Windows
starts one and keeps it, printing a line per poll down a pipe — the same bargain, and the
same reasoning, as `win-proc.js`. That resident process is also why `applyPeekSettings()`
in `index.js` stops the detector when the behaviour is switched off rather than leaving it
running and ignoring the answer.

### A dead Windows helper must retract, not go quiet

Everywhere else, "nothing could answer" leaves the cat exactly where it is — an unknown
answer is not a reason to move a cat. Windows is the exception: the source is a resident
process, and if it dies one poll after saying *a video is playing*, silence means the cat
stays parked past the screen edge until the app is restarted. So `SmtcSource` reports the
loss and the detector publishes `false`. It does that **only if the helper ever worked** —
on a machine where the API was never reachable, nothing was ever claimed and there is
nothing to take back.

### Testing it

`setPeek`, `peekTarget` and the position-restore path in `index.js` are platform-agnostic
and were never the hard part. The parsers are, and neither of the new ones can be run here,
so both are driven by captured output: `node tools/pmset-sim.js` and
`node tools/smtc-sim.js`. `tools/watch-probe.js` is the live counterpart — it prints the raw
answer your machine gives next to the verdict, which is the only way to tell "the filter is
wrong" apart from "the player produces no signal at all".

---

## Reminders live in main

Scheduling is wall-clock based (compared against `Date.now()`), not accumulated
`setInterval` ticks — so a laptop that sleeps for two hours fires **once** on wake rather
than 120 times or never. They live in the main process because that is the one that
survives: a renderer reload must not reset your Pomodoro round.

Settings are written through `store.js` with a temp-file + rename, atomic on every platform
we ship to, and merged so that unknown keys from an older or newer build are kept rather
than dropped — downgrading must not silently wipe a user's config.

---

## Packaging notes

- `npmRebuild: false` is deliberate. `uiohook-napi` is an N-API addon and N-API is
  ABI-stable across both Node and Electron, so its prebuilt binary already works.
  Rebuilding only introduces a hard dependency on X11 dev headers
  (`libX11`/`libXtst`/`libxkbcommon-x11`) that fails the build on any machine without them,
  for no benefit.
- `asarUnpack` for `uiohook-napi` is required — prebuilt `.node` binaries must stay outside
  the asar archive or the loader can't `dlopen` them at runtime.
- macOS sets `LSUIElement: 1`: agent app, no dock tile, no menu bar. A desktop pet is not a
  document app.
- On Linux the app cannot keep itself out of the taskbar — `skipTaskbar` was marked
  unsupported in Electron 19 and removed in 20, because X11's `_NET_WM_STATE_SKIP_TASKBAR`
  has no Wayland equivalent. `npm run desktop` installs a KWin rule that does it on KDE.
  (Declaring the window a toolbar type also works and is a trap: KWin takes the decorations
  with it, leaving the settings pane no close button.)
- `.github/workflows/release.yml` runs one build job per OS — see the file for why it must.

---

## Manual test checklist

`npm test` covers the simulators. These are the things only a human at a desk can confirm.
Tick them off after any change to the areas involved.

### Check these first (they broke before)

- [ ] Move the cat, then pet it — petting still works at the new spot
- [ ] Move the cat, then right-click it — menu still opens
- [ ] Pet the head, then hold still — purring fades instead of going forever
- [ ] Move the pointer off the cat — eyes go back to neutral, they don't dart to the corner

### Placing it

- [ ] Type an X and Y in settings — cat moves there
- [ ] All 9 snap buttons put it where they say
- [ ] It reaches all four corners, flush against the edge, no gap
- [ ] Position survives a restart

### Touching it

- [ ] Hover — it sits up and gives one sparkle
- [ ] Stroke the top half — purrs, hearts come out
- [ ] Stroke the belly — no hearts (only the head counts)
- [ ] Right-click — menu with Settings / Pomodoro / Hide / Quit
- [ ] Double-click — settings window opens
- [ ] Right-click / double-click the empty space beside it — nothing happens

### On its own

- [ ] Eyes follow the mouse pointer
- [ ] Type fast (60+ wpm) — it blushes and steams; its paws knead
- [ ] Scroll a mouse wheel — the yarn ball rolls out and is batted along
- [ ] Two-finger scroll on a touchpad — same, in the direction you swipe
- [ ] Leave it 2 minutes — sleepy, half-lids, zzz

### At the top of the screen

- [ ] Speech bubbles and thinking dots appear *below* it, not cut off above
- [ ] Hearts and steam stay visible

### AI agent reactions

- [ ] Start Claude Code / Codex — three dots appear while it works
- [ ] When the agent answers — one hop, "finished!", **only once per answer**
- [ ] Nothing fires from a brief flicker of CPU
- [ ] With the cat at the right edge, the whole bubble is readable
- [ ] Turn off "AI agent reactions" — no dots, no hops

### Peek mode

Every platform now has a signal, and each one is a different signal — run this
list on each, and run `node tools/watch-probe.js` first if any of it surprises you.

- [ ] Play a video — after ~5s the cat slides to the nearest edge, only a sliver showing
- [ ] While peeking: no yarn, and an agent finishing does NOT make it hop
- [ ] A stretch or water reminder still gets through
- [ ] Stop the video — it walks back to exactly where it was
- [ ] Its saved X/Y never changes to the hiding spot
- [ ] Turn "Peek while watching" off — it stays put
- [ ] Turn it off *while it is hiding* — it comes back immediately
- [ ] Play music instead of a video — Spotify and friends must NOT hide it
- [ ] macOS: `pmset -g assertions` names your player under "Listed by owning process"
- [ ] Windows: your player appears in the media flyout on the volume popup —
      if it isn't there, the cat cannot see it either
- [ ] Windows: no console window flashes, and no `powershell.exe` survives quitting

### Reminders and Pomodoro

- [ ] Stretch and water reminders fire on their intervals
- [ ] Change an interval — the countdown restarts from now
- [ ] Start Pomodoro from the tray — headband goes on; settings shows the clock
- [ ] Focus ends, break starts, it says so
- [ ] Reset restarts the current phase, keeping banked rounds
- [ ] Add a scheduled message for a minute from now — it says it, once
- [ ] Set a pinned message — it stays above its head

### Looks

- [ ] All 8 colours and all 5 patterns apply
- [ ] Size slider 2×–10× — it resizes and stays where it was
- [ ] Settings preview matches the real cat

### System

- [ ] Stays on top of other windows, including fullscreen video
- [ ] Tray: Settings, Start/Stop Pomodoro, Always on top, Hide cat, Quit
- [ ] Hide, then show again from the tray
- [ ] Launch at login works
- [ ] Closing settings doesn't quit the app

### macOS only

Nothing below has ever been run on real macOS. Start with the permission dance, since
everything else depends on it.

- [ ] First launch — macOS asks for Accessibility permission
- [ ] **Without quitting the app**, grant it in System Settings › Privacy & Security ›
      Accessibility. Within ~2s the cat reacts to typing and scroll. **No relaunch.**
- [ ] Settings shows an OPEN ACCESSIBILITY SETTINGS button while denied, and it opens the
      right pane
- [ ] Once granted, the button disappears and status reads "Typing: detected"
- [ ] Trackpad two-finger scroll — the yarn ball rolls out and is batted along
- [ ] Start Claude Code — dots appear for **both** install shapes: native installer
      (`~/.local/bin/claude`) and npm/Homebrew (`node …`)
- [ ] Start aider or goose (no transcript, CPU is the only signal) — dots appear while it
      works **and clear within ~8s of it finishing**, not 30s+. A late clear means the
      decaying-average problem is back.
- [ ] `node tools/agent-probe.js` shows a matched tree with a rising CPU number

### Windows only

- [ ] Two-finger scroll on a **precision touchpad** — the ball rolls and is batted, same as
      a wheel. Before the fix it shot to the edge of the canvas and sat there.
- [ ] Keep scrolling for several seconds — the ball keeps moving and hopping, not pinned
- [ ] Mouse wheel — still one bat per click, no lag
- [ ] Start Claude Code — dots appear for **both** install shapes: `claude.exe` and
      `node.exe …\claude-code\cli.js`
- [ ] `agent-probe` shows `procs:` with a matched tree, not `unavailable`
- [ ] No black console window appears at launch or afterwards
- [ ] Quit the cat, then check Task Manager — **no `powershell.exe` left behind**

### Known / not bugs

- A thin white line near the cat is your terminal's own UI showing through the transparent
  window. Move the cat onto empty desktop to confirm — the line stays with the terminal.
- On Linux/Wayland the cat's *window*, not just the cat, absorbs clicks. That is the cost of
  Wayland not reporting the mouse position to unfocused apps.
- There is no drag. The cat is placed by coordinates and snap buttons, on purpose — dragging
  could never reach the screen edges.
- There is no mouse hunt (the cat chasing a fast cursor). Removed on request.
