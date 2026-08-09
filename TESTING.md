# Pixelcat — things to test

Tick these off after any change. Plain manual checks, no tools needed.

## Check these first (they broke before)

- [ ] Move the cat, then pet it — petting still works at the new spot
- [ ] Move the cat, then right-click it — menu still opens
- [ ] Pet the head, then hold your hand still — purring fades instead of going forever
- [ ] Move the pointer off the cat — eyes go back to neutral, they don't dart to the corner

## Placing it

- [ ] Type an X and Y in settings — cat moves there
- [ ] All 9 snap buttons put it where they say
- [ ] It reaches all four corners, flush against the edge, no gap
- [ ] It cannot be dragged (removed on purpose — position is coordinates only)
- [ ] Position survives a restart

## Touching it

- [ ] Hover over it — it sits up and gives one sparkle
- [ ] Stroke the top half — it purrs and hearts come out
- [ ] Stroke the belly — no hearts (only the head counts)
- [ ] Right-click it — menu with Settings / Pomodoro / Hide / Quit
- [ ] Double-click it — settings window opens
- [ ] Right-click the empty space beside it — nothing happens
- [ ] Double-click the empty space beside it — nothing happens

## On its own

- [ ] Eyes follow the mouse pointer
- [ ] Type fast (60+ wpm) — it blushes and steams
- [ ] Type — its paws knead
- [ ] Scroll a mouse wheel — a ball of yarn rolls out and is batted along
- [ ] Scroll with two fingers on a touchpad — same, and in the direction you swipe
- [ ] Leave it alone 2 minutes — it gets sleepy, half-lids, zzz

## At the top of the screen

Put it at the very top, then check:

- [ ] Speech bubbles appear below it, not cut off above
- [ ] Thinking dots appear below it
- [ ] Hearts and steam stay visible (don't vanish straight upward)

## AI agent reactions

- [ ] Start Claude Code / Codex — three dots appear over its head while it works
- [ ] When the agent answers — it hops once and says "finished!"
- [ ] **Only once per answer** — not repeatedly during one reply
- [ ] Nothing fires from a brief flicker of CPU
- [ ] With the cat at the right edge, the whole bubble is readable, not cut off
- [ ] Turn off "AI agent reactions" in settings — no dots, no hops

## Peek mode (stay out of the way)

- [ ] Play a video in a browser or a player — after ~5s the cat slides to the
      nearest screen edge and only a sliver of it shows
- [ ] While it's peeking, no paper falls out
- [ ] While it's peeking, an agent finishing does NOT make it hop
- [ ] A stretch or water reminder still gets through
- [ ] Stop the video — it walks back to exactly where it was
- [ ] Its saved X/Y in settings never changes to the hiding spot
- [ ] Turn "Peek while watching" off — it stays put during a video

## Reminders and Pomodoro

- [ ] Stretch reminder fires on its interval
- [ ] Water reminder fires on its interval
- [ ] Change an interval — the countdown restarts from now
- [ ] Start Pomodoro from the tray — timer appears beside the cat
- [ ] Click the timer — it stops
- [ ] Focus ends, break starts, it says so
- [ ] Add a scheduled message for a minute from now — it says it, once
- [ ] Set a pinned message — it stays above its head

## Looks

- [ ] All 8 colours apply
- [ ] All 5 patterns apply
- [ ] Size slider 2x–10x — it resizes and stays where it was
- [ ] Settings preview matches the real cat

## System

- [ ] Stays on top of other windows, including fullscreen video
- [ ] Tray: Settings, Start/Stop Pomodoro, Always on top, Hide cat, Quit
- [ ] Hide, then show again from the tray
- [ ] Launch at login works
- [ ] Closing settings doesn't quit the app
- [ ] Clicking straight through the empty area beside the cat still reaches the
      window behind it, or if not, that's the known trade-off below

## Known / not bugs

- A thin white line near the cat is your terminal's own UI showing through the
  transparent window. Move the cat onto empty desktop to confirm — the line
  stays with the terminal.
- On Linux/Wayland the cat's window (not just the cat) absorbs clicks. That is
  the cost of Wayland not reporting the mouse position to unfocused apps.
- Global typing detection needs the `input` group:
  `sudo usermod -aG input $USER`, then log out and back in.
- There is no drag. The cat is placed by coordinates and snap buttons, on
  purpose — dragging could never reach the screen edges.
- There is no mouse hunt (the cat chasing a fast cursor). Removed on request.
- Peek mode is Linux only for now. It works out that something is playing by
  asking the desktop who is holding a "don't blank the screen" lock, and
  ignores the ones your battery applet holds all the time.
