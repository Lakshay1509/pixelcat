<div align="center">

<img src="assets/icon.png" width="104" alt="Pixelcat" />

# Pixelcat

**A pixel cat that lives on your desktop — and knows when your AI agent is thinking.**

It follows your cursor, purrs when you pet it, bats a ball of yarn when you scroll,
nags you to drink water, wears a headband for your Pomodoro, and thinks along
while Claude Code works.

[![Release](https://github.com/Lakshay1509/pixelcat/actions/workflows/release.yml/badge.svg)](https://github.com/Lakshay1509/pixelcat/actions/workflows/release.yml)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com/Lakshay1509/pixelcat/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![Network](https://img.shields.io/badge/network%20calls-0-brightgreen)](#privacy)

[**Download**](#download) · [Features](#features) · [From source](#from-source) · [How it works](AGENTS.md)

</div>

---

## Why

Desktop pets are a solved problem from 1997. This one is built for the way people
work now: a second presence next to the terminal that reacts to your machine, not
just to itself. When your coding agent starts a turn, the cat starts thinking.
When the turn lands, it hops and tells you. You stop tab-checking a job that takes
ninety seconds.

Everything else it does — the stretching, the water, the Pomodoro — is the same
idea. Signals you already generate, rendered as something alive in the corner of
the screen instead of another notification you dismiss.

## Features

| | |
| --- | --- |
| **Reacts to you** | Eyes follow the cursor anywhere on screen. Pet it and it purrs. Type fast and it blushes and steams. Scroll and it bats a ball of yarn along the desk. Leave it alone and it dozes off. |
| **Knows your AI agent** | Thinking dots while Claude Code, Codex, Cursor, opencode, aider, goose or amp are working; a hop and a "finished!" when the turn ends. No integration, no config, no API key. |
| **Pomodoro you can feel** | The cat puts a headband on for a focus round and takes it off for the break. That's the whole readout. Clock and controls live in settings and the tray. |
| **Reminders** | Stretch and water on wall-clock intervals, plus scheduled messages and a pinned note above its head. |
| **Stays out of the way** | Click-through everywhere except the cat itself. Start a video and it slides to the screen edge until you're done *(Linux)*. |
| **40 cats** | 8 palettes × 5 patterns, 2×–10× size, all from one hand-drawn 32×32 grid. |
| **Costs nothing** | Two runtime dependencies. Zero network calls. Reads `/proc` rather than spawning processes to watch CPU. |

## Download

Grab a build from the [**releases page**](https://github.com/Lakshay1509/pixelcat/releases/latest) —
one per platform, each built on that platform.

| Platform | File |
| --- | --- |
| **Windows** | `Pixelcat.Setup.*.exe` (installer) or `Pixelcat.*.exe` (portable, no install) |
| **macOS** | `*-arm64.dmg` for Apple Silicon, `*.dmg` for Intel |
| **Linux** | `*.AppImage` — `chmod +x` and run. Or the `.deb` if you'd rather your package manager knew about it. |

### The builds are not code-signed

There is no Apple or Windows signing certificate behind these, so both systems
treat them as software from nobody in particular. Nothing is wrong with the
download; this is what unsigned looks like.

- **macOS** refuses them outright, and the wording is misleading — it usually says
  the app is *damaged*, which sounds like a corrupt file and isn't. Right-click the
  app and choose **Open**, or clear the quarantine flag:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Pixelcat.app
  ```

- **Windows** shows a SmartScreen panel. **More info** → **Run anyway**.

## Platform support

| | macOS | Windows | Linux / X11 | Linux / Wayland |
| --- | :---: | :---: | :---: | :---: |
| Cursor tracking | ✅ | ✅ | ✅ | ✅ *(needs `input` group)* |
| Typing & scroll reactions | ✅ *(needs Accessibility)* | ✅ | ✅ | ✅ *(needs `input` group)* |
| AI agent reactions | ✅ | ✅ | ✅ | ✅ |
| Peek while watching video | — | — | ✅ | ✅ |
| Kept out of the taskbar | ✅ | ✅ | KDE only | KDE only |

**Linux/Wayland** — one command, then log out and back in:

```bash
sudo usermod -aG input $USER
```

Wayland doesn't tell an unfocused app where your pointer is, so Pixelcat reads
`/dev/input` directly. Without the group it still runs, but only reacts while the
pointer is over the cat — and it says so in settings rather than silently doing
nothing.

**macOS** — the first launch asks for Accessibility. That grant is what lets any
app see keystrokes it didn't receive itself; declining costs you only the typing
and scroll reactions. Grant it in System Settings and the cat picks it up within
a couple of seconds — no relaunch.

## Privacy

The cat talks to no network, at all. There is no telemetry, no update check, no
analytics.

Watching for keystrokes means the input reader can see every key on the machine,
so it is built to see as little as possible: a key event is reduced to *"a key
went down"* and **the key code is discarded immediately**. Nothing is buffered,
logged, or written to disk. The cat only needs to know *that* you're typing.

Agent detection reads transcript files your agent already writes to your own home
directory, and the local process list. Neither leaves the machine.

## From source

```bash
npm install
npm start          # run it
npm run dev        # run it with the settings window open
npm test           # the simulators — run these before believing a change
npm run build      # package installers into dist/
```

<details>
<summary>Other scripts</summary>

```bash
npm run preview    # contact sheet of every palette × pattern
npm run icons      # regenerate app + tray icons from the sprite itself
npm run desktop    # Linux desktop integration (see below)
```
</details>

### Linux: `npm run desktop`

Two things a Linux desktop has to be told, neither of which the app can say for
itself. Undo both with `npm run desktop -- --remove`. **Packaged builds need none
of this** — it's only for running from a checkout.

- **A desktop entry**, so the taskbar knows what the window is. Linux task managers
  ignore a window's own icon and use the desktop entry matched against its
  `WM_CLASS`; with nothing to match, the cat advertises itself as the X.Org logo.
- **A KWin rule**, so the taskbar stops listing it at all. Pixelcat is a tray app
  and has no business holding a taskbar slot. Electron can't arrange this —
  `skipTaskbar` was removed on Linux in Electron 20 — so the window manager is
  asked directly. KDE only.

### Editing the cat

Edit the grids in `src/renderer/pet/sprites.js`, then:

```bash
npm run preview && npm run icons
```

`preview` validates that every row is exactly 32 characters before rendering, so
a miscounted row fails loudly instead of drawing a subtly lopsided cat.

## How it works

The cat is stored as **palette slots, not colours** — a pixel knows it is fur or
marking or light, never `#2b2b2b` — which is why 40 cats fall out of one grid and
a ninth colour costs four hex values. Outlines are generated by dilating the alpha
mask, so they can never drift from the sprite. Behaviours are overlapping drives
rather than exclusive states, which is why the cat can be half-asleep, blink, and
still track your cursor.

The hard parts are the ones that touch the OS: assembling one cursor estimate from
three unreliable sources on Wayland, reconstructing touchpad scroll that the kernel
never reports as scroll, and detecting agent turns from transcripts rather than the
CPU signal that lies in both directions.

📖 **[AGENTS.md](AGENTS.md)** documents all of it — the architecture, the
invariants that must not be broken, and the measurements behind each decision.

## Known limits

- **The macOS build has never been launched by anyone.** CI proves it packages; it
  cannot prove it runs. Its platform-specific paths were derived from Apple's `ps`
  and libuiohook's sources and are covered by simulators, but nobody has confirmed
  them on real hardware.
- **Windows has been run**, and both things it reported — touchpad scroll and agent
  detection — are fixed and simulator-covered, but the fixes themselves haven't been
  witnessed on a real Windows machine.
- Global typing detection doesn't reach native Wayland apps. Cursor reactions are
  unaffected.
- Agent detection on Windows sees Windows processes only — an agent running **inside
  WSL** is invisible to it.
- Peek mode is Linux only. It infers playback from power-management inhibitions,
  and there's no equivalent wired up for macOS or Windows yet.
- There is no drag. The cat is placed by coordinates and snap buttons, on purpose —
  dragging could never reach the screen edges.

Run `node tools/agent-probe.js` to see exactly what the cat can and can't see on
your machine.

## Contributing

Issues and PRs welcome. Two things worth knowing before you open one:

1. **Run `npm test` first.** The simulators script every platform regime — X11,
   frozen Wayland, XWayland, Windows precision touchpads, Apple `ps` output — on a
   fake clock. Every regression this project has ever had was in a regime the
   machine doing the testing could not physically be in.
2. **Read [AGENTS.md](AGENTS.md).** Most of the non-obvious code is non-obvious for
   a documented reason, and the invariants section lists the things that look
   redundant and are not.

## License

MIT © Lakshay Gupta
