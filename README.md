# Pixelcat

A pixel cat that lives on your desktop. It reacts to your mouse, keyboard and
scrolling, reminds you to stretch and drink water, and runs a Pomodoro timer.
Its colour and pattern are yours to pick.

Runs on macOS, Windows and Linux.

```bash
npm install
npm start          # run it
npm run dev        # run it with the settings window open
npm run preview    # render a contact sheet of every palette x pattern
npm run build      # package installers into dist/
```

---

## How it works

### The cat is stored as palette slots, not colours

`src/renderer/pet/sprites.js` holds the cat as a 32x32 grid of *slot* letters.
A pixel knows it is `B` (fur), `M` (marking), `L` (light) or `N` (pink) — it
never knows it is `#2b2b2b`.

That's the whole reason "customise its colour and pattern" is cheap: a palette
is a four-entry map and a pattern is a mask that repaints fur. 8 palettes x 5
patterns = 40 cats out of one hand-drawn grid, and adding a ninth colour is four
hex values, not another sprite sheet.

Two rules keep it safe:

- **Masks recolour, they never create.** A mask can turn fur into marking, but
  it cannot add a pixel, so no pattern can deform the silhouette or leak past
  the outline.
- **Outlines are generated, not drawn.** The renderer dilates the alpha mask by
  1px. Hand-authored outlines would need redrawing for every pose; generated
  ones are consistent for free. (Comnyang's own site does the same thing in SVG
  with `feMorphology`.)

Eyes are drawn procedurally on top rather than baked in, because eye-follow
needs per-frame control of the pupil — and once eyes are procedural, blink,
half-lid and sleep are three lines each instead of three more grids.

### Global input, and why Wayland needs a third path

This is the part that decides whether a desktop pet works on someone's machine,
and the naive design does not survive contact with Wayland.

**What actually happens on Wayland** (measured on KDE, not assumed):

- `screen.getCursorScreenPoint()` returned the *identical coordinate 60 times
  out of 60 samples* while the mouse moved over a Wayland window. Wayland does
  not tell an unfocused app where the pointer is; Electron reports the last
  position the cursor was over an XWayland surface, and holds it until the
  cursor crosses one again — at which point it leaps the whole way in a single
  sample.
- `uiohook-napi` fails outright with `XkbGetKeyboard failed to locate a valid
  keyboard`, then delivers nothing.

So there are three sources, and the pointer is assembled from all of them:

| Source | Where it works | Gives |
| --- | --- | --- |
| `getCursorScreenPoint()` | Windows, macOS, Linux/X11 | exact cursor |
| `uiohook-napi` | Windows, macOS (needs Accessibility), Linux/X11 | keys, scroll |
| `/dev/input` (evdev) | Linux incl. Wayland, needs `input` group | keys, scroll, raw mouse deltas |

There is no "which source", because the honest answer on a real Wayland desktop
is *all of them, some of the time*. Electron runs as an **XWayland** client, and
XWayland's pointer is neither working nor frozen: `getCursorScreenPoint()` is
exact while the cursor is over an X surface — including the cat's own window —
and frozen the instant it crosses onto a native Wayland one.

That third regime is what broke this repeatedly. The old code picked one source
and latched: the first evdev delta flipped it to "estimated" and nothing could
flip it back, so a native point that was telling the truth several times a
second was discarded for the rest of the session, and the cat had no idea where
the pointer was unless it was physically over its window.

So there is **one estimate**, and everything that can say something true about
it gets to correct it — the native point whenever it changes, DOM pointer events
over our own window, raw evdev deltas integrated in between, and the screen
edges, which the real cursor stops at and so does ours (shoving the mouse into a
corner resyncs an axis exactly, and users do that constantly without being asked
to).

The estimate carries a **confidence**: how far wrong it expects to be. Dead
reckoning drifts because the compositor applies pointer acceleration we cannot
observe — so it is measured instead. Any tick where the native point *and* a raw
delta both moved is a reading of that acceleration, and confidence decays with
distance travelled times how badly that constant is still known. A fresh session
loses faith quickly; a calibrated one holds it across a screen.

Consumers then clear a bar instead of being handed a boolean, and that is the
part that matters:

- **Eye-follow** needs a direction, and a direction survives being somewhat
  wrong. It takes a rough fix happily, which is why the cat now watches you
  anywhere on the desktop.
- **Petting, hovering and hearts** need a pixel, and take nothing but an exact
  position — a DOM event, or a native point that genuinely moved.

Conflating those two is what made every previous fix break the other half of the
feature: making the cat trust the estimate made it purr at nobody, and making it
distrust the estimate made it go blind.

The cat is also its **own calibration target**. The renderer hands every DOM
pointer position back to main, so each time the cursor approaches the window the
estimate is re-anchored to a true position — precision matters most just before
you touch the cat, and that is exactly the moment the truth is available.

`node tools/cursor-sim.js` drives all of this through every session type — X11,
X11 with evdev, frozen Wayland, XWayland — with a scripted pointer and a fake
clock, and checks what it concluded against what was actually true. Every
regression this has ever had was in a regime the machine doing the testing could
not be in, so run it before believing a change.

**Enabling full tracking on Linux/Wayland** — one command, then log out and in:

```bash
sudo usermod -aG input $USER
```

Without it the app still works, but only reacts while the pointer is over the
cat (see below). It says so in settings rather than silently doing nothing.

**Privacy:** the evdev reader can see every keystroke on the machine, so it
deliberately sees as little as possible — key events are reduced to "a key went
down" and **the key code is discarded immediately**. Nothing is buffered,
logged, or written to disk. The cat only needs to know *that* you're typing.

### The window is click-through except where the cat is

The pet window is bigger than the cat — the padding is the stage it acts on
(bubbles above, timer beside, room to pounce). A window that size would eat
every click in the corner of your screen, so it is click-through by default and
`setIgnoreMouseEvents` is flipped off only while the cursor is over an opaque
pixel.

That hit test runs off the **cursor poll in main**, not renderer `mousemove`,
because a click-through window receives no `mousemove` at all — the renderer
would never learn the cursor had arrived. The renderer publishes the cat's
opaque bounding box; main compares it against the polled cursor.

Whether it may do that at all is a separate, deliberately **slow** decision. It
is settled from accumulated evidence — how much of the pointer's real travel the
native point managed to witness — reconsidered at most once a second, and it can
only ever be taken away, never granted. The asymmetry is the point: losing it
costs a window that absorbs clicks in its padding, which is irritating and
survivable. Granting it wrongly costs the cat, because the window starts
hit-testing against a point that is about to freeze somewhere else, and every
click then falls straight through the cat forever. Gating this on whether the
*current sample* happened to be exact is what made the window flip interactive
and back several times a second on XWayland, so the cat could go untouchable
mid-stroke.

Where hit-testing is refused, the window simply stays interactive and the
renderer drives touch from its own DOM pointer events, which are exact whenever
the cursor is over the window. Local events take precedence over the global feed
for 400ms after they arrive; the global feed fills the gaps. The trade-off is
the window's rectangle, not just the cat, absorbing clicks — which is why the
`input` group is worth the one command.

### Behaviours are overlapping drives, not exclusive states

`src/renderer/pet/pet.js` keeps continuous values — `heat`, `petMeter`,
`hoverAmt`, `sleepiness` — that rise and decay independently. A state machine
with one active state at a time reads like a vending machine; overlapping drives
are why the cat can be half-asleep, blink, and still track your cursor.

Squash-and-stretch pivots on the feet rather than the centre, so a squashed cat
presses into the desk instead of floating.

### AI agent reactions, without integrating with any agent

The cat thinks along while Claude Code, Codex, Cursor, opencode, aider, goose
and friends are working, and hops when they finish.

This used to be inferred from CPU alone, and CPU is bad at this job in both
directions. **An agent waiting on the model burns nothing**, so "thinking" read
as "finished" and the cat celebrated mid-answer — then again at the next pause,
and the next. Meanwhile a terminal that is merely being *typed into* redraws and
burns CPU, so an idle session read as work. No amount of debouncing fixes a
signal that is measuring the wrong thing; it only makes both failures slower.

The fix is that the agents already write down what they are doing. They all
persist a transcript so `--resume` works, it is appended to as the turn happens,
and its last entry says outright whether the model is mid-turn or the turn ended.
`src/main/agent-sessions.js` reads it — exact, instant, no configuration, and no
cooperation from the agent.

- **Claude Code** (`~/.claude/projects/*/*.jsonl`) — one assistant message is
  split across several lines (thinking, text, one per tool call) and every line
  carries that message's `stop_reason`. `tool_use` means still working; anything
  else means the turn ended. Reading the content *blocks* instead would be wrong:
  a mid-turn "Let me check the config" is its own line and looks exactly like a
  final answer. Only `stop_reason` separates them.
- **Codex** (`~/.codex/sessions/**/rollout-*.jsonl`) — states it outright, as
  `event_msg` payloads `task_started` / `task_complete`.

`src/main/agents.js` keeps CPU, demoted to covering the one gap transcripts have:
a long tool call writes nothing for as long as it runs, and during exactly that
gap the process tree is busy. So the two compose — transcripts drive, CPU covers
while a session is silent — and agents that keep no readable transcript (aider,
goose, amp) still work on CPU alone.

Details that decide whether this feels alive or broken:

- **Two speeds of "done".** A transcript-confirmed turn ending is a fact, so it
  is announced in ~2s. A CPU lull is a guess and still has to persist ~8s and
  follow enough work to have been a task at all.
- **The whole process tree, not just the agent.** Most of what a turn costs is
  spent in children — the test run, the build — while the parent sits at zero, so
  measuring the parent alone missed the busiest parts of a turn. Reaped children
  count too (`cutime`), which is how a finished test run still registers.
- **`comm` is not enough.** An agent installed as an npm package runs as
  `node .../claude-code/cli.js` and shows up as "node". Interpreter processes get
  their arguments read; shells deliberately do not, since a `bash -c` command line
  contains whatever the agent happened to run and would match itself constantly.
- **A transcript outlives the process that wrote it.** A session closed mid-turn
  says "working" forever, so a session only counts while its CLI is still running,
  and a "working" session that has gone silent for minutes hands the decision back
  to CPU — which can tell a long tool call from an abandoned terminal.
- **CPU time deltas, not instantaneous %CPU.** An agent streaming a reply uses
  CPU in bursts, so a sampled percentage flickers between 0 and 40 constantly and
  the cat twitches. Accumulated jiffies over the interval are smooth. (macOS is
  the exception: `ps` reports cumulative CPU only to the second, too coarse for a
  1Hz poll, so its `%CPU` estimate is read alongside.)

On Linux it reads `/proc` directly — no process spawn, so polling at 1Hz doesn't
become the CPU load it's trying to measure. Elsewhere it deltas `ps` CPU time.

`node tools/agent-probe.js` prints both signals once a second — which transcripts
are live and what they say, which process trees matched and what they burned — so
a miss can be told apart from a mismatch.

### The yarn ball, and why it is drawn on top of the cat

Scrolling bats a ball of yarn along the desk. A thread unspools back to the cat's
paws and reels it in again when you stop, so it always ends up back at the flank.

It replaced a paper sprite that was spawned per wheel tick and thrown downward
under gravity. A long scroll buried the desk in rectangles that all fell out of
frame: nothing to watch on the way, nothing left afterwards, and a mess in
between. One ball on a spring gives the scroll somewhere to go *and* somewhere to
come back to — and the return trip is not decoration, it is what keeps the effect
on a canvas that only has 60px of padding either side of the cat.

Three things that were wrong on the first attempt:

- **The ball is drawn in front of the cat**, which sounds wrong and is not. It
  sits on the paw line, not at head height, so the only thing it ever crosses is
  the cat's front feet — which is where a ball on a desk is. Drawing it *behind*
  was tried first: the cat is 128px of opaque sprite, so rolling inward made the
  ball vanish for most of its journey. Half the effect, invisible.
- **It rests at the flank, not at the paws.** Resting in front of the paws looks
  tidier standing still, but the ball is 21px against a 128px cat and it covers
  the belly markings the whole time it is out.
- **The physics was tuned against the real canvas, not by feel.** Travel and
  settling time pull against each other, and the spring constant matters far less
  than the impulse cap and the drag — sweeping all three found the trio that gets
  the ball right across the cat and back to rest 2.5s after the last scroll, just
  as it starts to fade.

The ball is its own sprite rather than a particle, because particles are one flat
colour and a ball whose wrap you cannot see turning does not read as rolling — it
reads as a dot sliding sideways. Four frames step the wrap one pixel along; the
cycle runs backwards when it rolls the other way. Its silhouette is a real circle
rather than a square with the corners knocked off, which at 7px is the whole
difference between a ball and a die.

### The pomodoro is worn, not displayed

A focus round used to put a `FOCUS 24:51` banner beside the cat. It was the only
thing on screen that looked like a piece of UI rather than a pet, and it spent
that space telling you something a clock already tells you.

Now the cat puts a **headband** on for a focus round and takes it off for the
break. That is the entire readout, and it says the one thing worth saying —
heads down — in the cat's own vocabulary. It comes with the same narrowed eyes
the cat uses when an agent is working, applied through `max()` so the cat still
blinks: never blinking for 25 minutes is a stare, not concentration.

The band is painted over fur slots only, never the generated outline — filling
whole rows would eat the rim the sprite needs to stay legible against an
arbitrary desktop. Its knot is the one place anything adds pixels *outside* the
silhouette, which patterns are forbidden from doing, because an accessory that
stops at the skull is just a stripe.

Removing the banner meant removing a control, though: clicking it was the only
way to stop a running round, and the settings window's button said
`START POMODORO` whether or not one was running, because nothing ever told it
otherwise. So the clock and the controls moved somewhere a clock belongs:

- **Settings** shows `Focus — 12:34 left · round 2 of 4` on the same one-second
  feed the cat gets, with `STOP POMODORO` and `RESET ROUND`.
- **Reset restarts the phase you are in**, not the whole cycle. The reason to
  reach for it is an interruption partway through a round, and throwing away the
  rounds already banked would be a strange punishment for being interrupted.
- **The tray menu counts in minutes, not `mm:ss`.** A tray menu is a *static*
  menu — `setContextMenu` paints it once — so a seconds countdown would freeze at
  whatever it read when the menu was last built. It is rebuilt only when the
  minute actually changes, rather than sixty times an hour for nothing.

Both menus draw their pomodoro entries from one function. They were written out
twice before, with only the tray copy kept in sync, so the cat's own right-click
menu could offer "Start Pomodoro" in the middle of a round.

### Position means the CAT, not its window

`settings.position` is the sprite's own top-left on screen. The window is larger
than the cat (padding is the stage for bubbles and pouncing), so aligning the
*window* to a requested point parks the cat ~60px in from every screen edge —
you can never reach the corner.

Placing the window off-screen to compensate does not work: KWin, like most
window managers, refuses a negative position and silently clamps it back
(verified — asking for `-60,-70` produced a window at `0,0`).

So the window always stays fully on-screen and any shortfall is handed to the
renderer as `catOffset`: the sprite slides *within* its own window to reach the
true edge. Snapping to a corner now lands the cat flush against it.

One consequence: at the top edge, "above the cat" is off-screen, so speech
bubbles flip to below the cat automatically.

### Dragging uses relative deltas, never the global cursor

Drag is driven by pointer capture and `movementX/Y` from the renderer, and main
moves the window by those deltas. Absolute positioning against the global cursor
looks simpler and breaks badly: on Wayland that cursor is frozen, so the cat
teleports to one point, and a lost mouse-up leaves the drag latched — which
silently overrides `setPosition`, making the position presets look broken.
Pointer capture also guarantees move/up events keep arriving once the pointer
leaves the window. A watchdog clears a stuck drag flag regardless.

### Reminders live in main

Scheduling is wall-clock based (compared against `Date.now()`), not accumulated
`setInterval` ticks — so a laptop that sleeps for two hours fires **once** on
wake rather than 120 times or never. They live in the main process because that
is the one that survives: a renderer reload must not reset your Pomodoro round.

---

## Layout

```
src/
  main/
    index.js       app lifecycle, pet window, click-through hit test
    input.js       two-tier input with honest degradation
    reminders.js   stretch / water / messages / pomodoro
    store.js       atomic JSON settings
    preload.js     allow-listed IPC bridge
  renderer/
    pet/           sprites.js, cat.js (renderer), pet.js (behaviours)
    settings/      controls + live preview using the same renderer
tools/
  lib.mjs          build-time rasteriser + zero-dep PNG encoder
  preview.mjs      palette x pattern contact sheet
  make-icons.mjs   app + tray icons, generated from the sprite itself
```

`tools/` renders the cat in Node using the same sprite data the app uses, so the
icon can never drift from the cat it depicts.

## Editing the cat

Edit the grids in `src/renderer/pet/sprites.js`, then:

```bash
npm run preview && npm run icons
```

`preview` validates that every row is exactly 32 characters before rendering —
a miscounted row is the single easiest mistake to make here, and it fails loudly
instead of drawing a subtly lopsided cat.

## Known limits

- Global typing detection does not work in native Wayland apps (see table
  above). Cursor reactions are unaffected.
- macOS needs Accessibility permission granted manually for typing reactions.
- Unsigned builds: macOS and Windows will warn on first launch until the
  binaries are code-signed.
