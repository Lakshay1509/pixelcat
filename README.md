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
  out of 60 samples* while the mouse moved. Wayland does not tell an
  unfocused app where the pointer is; Electron reports the last position the
  cursor was over an XWayland surface, forever.
- `uiohook-napi` fails outright with `XkbGetKeyboard failed to locate a valid
  keyboard`, then delivers nothing.

So there are three sources, chosen at runtime:

| Source | Where it works | Gives |
| --- | --- | --- |
| `getCursorScreenPoint()` | Windows, macOS, Linux/X11 | exact cursor |
| `uiohook-napi` | Windows, macOS (needs Accessibility), Linux/X11 | keys, scroll |
| `/dev/input` (evdev) | Linux incl. Wayland, needs `input` group | keys, scroll, raw mouse deltas |

The cursor is a **hybrid**: poll the native point, and whenever it actually
changes, trust it. If it stops changing while raw device deltas keep arriving,
dead-reckon from those instead. That self-selects correctly with no platform
branching — on X11/Windows/macOS the native point moves and always wins; on
Wayland it never moves so evdev drives.

Dead reckoning drifts, because the compositor applies pointer acceleration we
cannot observe. The saving grace: the real cursor stops at the screen edges and
so does ours, so shoving the mouse into a corner **resyncs both exactly**. Users
do this constantly without being told to. `Pointer speed` in settings tunes the
rest.

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

### Falling back when there is no global cursor at all

If the pointer can't be tracked globally, the window cannot hit-test it — and a
click-through window that can't hit-test is a cat you can never touch: no drag,
no petting, no right-click.

So in that mode the window stays interactive and the **renderer** tracks the
pointer from its own DOM `mousemove` events, which are exact whenever the cursor
is over the window. Local events always take precedence over the global feed for
400ms after they arrive; the global feed fills the gaps.

Trade-off: while in this mode the window's rectangle (not just the cat) absorbs
clicks. That is why the `input` group is worth the one command — with it, the
precise per-pixel click-through comes back.

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

### Behaviours are overlapping drives, not exclusive states

`src/renderer/pet/pet.js` keeps continuous values — `heat`, `petMeter`,
`huntAmt`, `sleepiness` — that rise and decay independently. A state machine
with one active state at a time reads like a vending machine; overlapping drives
are why the cat can be half-asleep, blink, and still track your cursor.

Squash-and-stretch pivots on the feet rather than the centre, so a squashed cat
presses into the desk instead of floating.

### AI agent reactions, without integrating with any agent

The cat thinks along while Claude Code, Codex, Cursor, opencode, aider, goose
and friends are working, and hops when they finish.

There is no API for "is this agent thinking right now", so `src/main/agents.js`
infers it from CPU: a matched agent process burning CPU is working; when it goes
quiet, it has answered. One signal, no per-agent integration, and adding a new
agent is one string in settings.

Two details that decide whether this feels alive or broken:

- **CPU time deltas, not instantaneous %CPU.** An agent streaming a reply uses
  CPU in bursts, so a sampled percentage flickers between 0 and 40 constantly
  and the cat twitches. Accumulated jiffies over the interval are smooth.
- **Going idle is debounced (~3s).** Agents pause mid-answer waiting on the
  network. Firing "done!" on every pause would be worse than not having it.

On Linux it reads `/proc` directly — no process spawn, so polling at 1Hz doesn't
become the CPU load it's trying to measure. Elsewhere it deltas `ps` CPU time.

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
