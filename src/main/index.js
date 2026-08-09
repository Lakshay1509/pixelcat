/*
 * index.js — app lifecycle, the pet window, and the input plumbing.
 *
 * The interesting problem here is the window itself. A desktop pet needs a
 * window that is always on top and covers a decent area (room for the cat to
 * hop, for speech bubbles, for the pomodoro timer) while NOT stealing clicks
 * from whatever the user is actually working in. So the window is click-through
 * by default and we flip `setIgnoreMouseEvents` off only while the cursor is
 * genuinely over an opaque pixel of the cat.
 *
 * That hit test runs off the cursor poll in main, not off renderer mousemove,
 * because a click-through window receives no mousemove at all — the renderer
 * would never learn the cursor had arrived.
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

const store = require("./store");
const kwinRule = require("./kwin-rule");
const input = require("./input");
const { Reminders } = require("./reminders");
const { AgentWatcher } = require("./agents");
const { WatchDetector } = require("./watching");
const CatSprites = require("../renderer/pet/sprites.js");

// Linux compositors need to be told we actually mean it about transparency.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
}

let petWin = null;
let settingsWin = null;
let tray = null;
let reminders = null;

// Cursor-over-cat state
let hitRect = null; // { x, y, w, h } in window-local px, published by the renderer
let ignoring = null; // last value passed to setIgnoreMouseEvents; null = unset
// The cat is positioned by coordinate only; there is no drag gesture. See the
// note in renderer/pet/pet.js for why steering the window by pointer deltas
// could not reach the screen edges.
let agents = null;
let watcher = null;
// Peek mode: where the cat was before it went to hide, so it can come back.
let peeking = false;
let prePeek = null;
// How far the sprite is slid inside its window so the cat can reach a screen
// edge the window itself is not allowed to cross. Usually {0,0}.
let catOffset = { x: 0, y: 0 };

// --- geometry ---------------------------------------------------------------
// Window is deliberately larger than the cat: the padding is the stage it acts
// on (bubbles above, pomodoro timer beside, room to pounce).
const PAD = { x: 60, top: 70, bottom: 20 };

function layout(scale) {
  const size = CatSprites.W * scale;
  return {
    size,
    scale,
    catX: PAD.x,
    catY: PAD.top,
    width: size + PAD.x * 2,
    height: size + PAD.top + PAD.bottom,
  };
}

// Returns the CAT's screen position, matching what `settings.position` means.
function defaultPosition(l) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - l.size - 12),
    y: Math.round(workArea.y + workArea.height - l.size - 12),
  };
}

function send(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

function applyAgentSettings() {
  if (!agents) return;
  const s = store.get();
  agents.enabled = s.behaviours.agentReactions !== false;
  agents.setAgents(
    String(s.agentNames || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .concat(require("./agents").DEFAULT_AGENTS)
  );
}

/*
 * Peek mode is the one behaviour whose cost is a PROCESS, not a branch: a probe
 * forked every five seconds on Linux and macOS, and a resident PowerShell on
 * Windows. Turning it off in settings used to leave all of that running and only
 * ignore the answer at the point of use, which is a bill for a feature nobody
 * asked to keep — so the detector is started and stopped with the setting.
 *
 * Stopping it also has to bring the cat back. `setPeek` is edge-triggered, so a
 * detector switched off mid-video would otherwise never send the falling edge,
 * and the cat would stay parked past the screen edge until something else moved
 * it.
 */
function applyPeekSettings() {
  if (!watcher || !petWin || petWin.isDestroyed()) return;
  if (store.get().behaviours.peekMode !== false) return watcher.start();
  watcher.stop();
  setPeek(false);
}

function displayInfo() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds, // full screen, for clamping
    workArea: d.workArea, // panel-aware, for snapping
    primary: d.id === primaryId,
  }));
}

function unionBounds() {
  const b = displayInfo().reduce(
    (acc, d) => ({
      x0: Math.min(acc.x0, d.bounds.x),
      y0: Math.min(acc.y0, d.bounds.y),
      x1: Math.max(acc.x1, d.bounds.x + d.bounds.width),
      y1: Math.max(acc.y1, d.bounds.y + d.bounds.height),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  );
  return Number.isFinite(b.x0) ? b : { x0: 0, y0: 0, x1: 1920, y1: 1080 };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/*
 * placeCat — put the CAT at a screen coordinate, not the window.
 *
 * `settings.position` is the cat's own top-left on screen. The window is
 * deliberately larger than the sprite (the padding is the stage for speech
 * bubbles and pouncing), so if the window were simply aligned to the requested
 * point, the cat would always sit ~60px in from any screen edge.
 *
 * Placing the window off-screen to compensate does not work either: KWin (and
 * most window managers) refuse a negative position and quietly clamp it back,
 * which is exactly what left the cat stranded away from the edge.
 *
 * So the window always stays fully on-screen, and any shortfall is handed to
 * the renderer as `catOffset` — the sprite slides *within* its window to reach
 * the true edge. Same trick makes the corners reachable on every platform
 * without relying on off-screen window placement being permitted.
 */
function placeCat(catPos, persist = true) {
  if (!petWin || petWin.isDestroyed()) return catPos;
  const l = layout(store.get().scale);
  const b = unionBounds();

  const cx = clamp(Math.round(catPos.x), b.x0, b.x1 - l.size);
  const cy = clamp(Math.round(catPos.y), b.y0, b.y1 - l.size);

  const wantX = cx - l.catX;
  const wantY = cy - l.catY;
  const wx = clamp(wantX, b.x0, b.x1 - l.width);
  const wy = clamp(wantY, b.y0, b.y1 - l.height);

  petWin.setPosition(Math.round(wx), Math.round(wy));
  // Force the click-through state to be re-applied on the next input tick.
  // setIgnoreMouseEvents installs an input region on the window, and `ignoring`
  // exists to avoid re-sending a value the window already has — but that cache
  // assumes the region survives everything, and a compositor is free to rebuild
  // it when the window moves. If it does, the cat goes quietly untouchable at
  // its new position with nothing in our state to say so. Re-asserting costs one
  // call per move.
  ignoring = null;
  catOffset = { x: Math.round(wantX - wx), y: Math.round(wantY - wy) };
  // Peek mode moves the cat somewhere it does not LIVE. Persisting that would
  // overwrite the position the user chose with the edge it hid against, and a
  // crash or quit mid-video would make the move permanent.
  if (persist) store.set({ position: { x: cx, y: cy } });
  return { x: cx, y: cy };
}

/*
 * setAutoLaunch — start with the session.
 *
 * `app.setLoginItemSettings` is implemented on macOS and Windows only. On Linux
 * it does not fail, it simply does nothing: verified on Electron 33 by calling
 * it and then reading `getLoginItemSettings()` back as `openAtLogin: false`,
 * with no file written anywhere. So the checkbox saved a preference that had no
 * effect whatsoever.
 *
 * The XDG convention it should have used is a .desktop file in
 * ~/.config/autostart, which every desktop environment reads.
 */
function setAutoLaunch(enabled) {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }

  const file = path.join(os.homedir(), ".config", "autostart", "pixelcat.desktop");
  if (!enabled) {
    try {
      fs.unlinkSync(file);
    } catch {} // already absent is the desired state
    return;
  }

  // Packaged, execPath IS the app. Running from a checkout it is the Electron
  // binary, which needs the project path as its argument or it opens the
  // default "no app loaded" window instead of the cat.
  const quote = (s) => (/[\s"']/.test(s) ? `"${s.replace(/(["`$\\])/g, "\\$1")}"` : s);
  const exec = app.isPackaged
    ? quote(process.execPath)
    : `${quote(process.execPath)} ${quote(app.getAppPath())}`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Pixelcat",
        "Comment=A pixel cat that lives on your desktop",
        `Exec=${exec}`,
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n")
    );
  } catch (err) {
    console.error("[autostart] could not write the entry:", err.message);
  }
}

/*
 * Peek mode — get out of the way while something is playing.
 *
 * The cat walks to whichever screen edge it is already closest to, then slides
 * most of its body past it. It cannot actually leave the screen: the window is
 * clamped on-screen and the canvas clips anything drawn outside, so "sliding
 * past the edge" IS the sprite being drawn off the end of its own canvas. The
 * clipping is the effect, not a bug worked around.
 *
 * The horizontal edges are preferred over the vertical ones: a cat poking in
 * from the side of a video is out of the way, and one clinging to the bottom of
 * the screen is sitting on the subtitles.
 */
const PEEK_FRACTION = 0.62; // how much of the cat hides past the edge

function peekTarget() {
  const l = layout(store.get().scale);
  const b = unionBounds();
  const cat = currentCatPos();
  const centreX = cat.x + l.size / 2;
  const centreY = cat.y + l.size / 2;

  const dist = {
    left: centreX - b.x0,
    right: b.x1 - centreX,
    top: centreY - b.y0,
    bottom: b.y1 - centreY,
  };
  // Bias towards a side edge unless the cat is markedly nearer a horizontal one.
  const side = dist.left <= dist.right ? "left" : "right";
  const vert = dist.top <= dist.bottom ? "top" : "bottom";
  const edge = dist[side] <= dist[vert] * 1.6 ? side : vert;

  const shift = Math.round(l.size * PEEK_FRACTION);
  switch (edge) {
    case "left":
      return { pos: { x: b.x0, y: cat.y }, shift: { x: -shift, y: 0 } };
    case "right":
      return { pos: { x: b.x1 - l.size, y: cat.y }, shift: { x: shift, y: 0 } };
    case "top":
      return { pos: { x: cat.x, y: b.y0 }, shift: { x: 0, y: -shift } };
    default:
      return { pos: { x: cat.x, y: b.y1 - l.size }, shift: { x: 0, y: shift } };
  }
}

function setPeek(active) {
  if (!petWin || petWin.isDestroyed()) return;
  if (active === peeking) return;

  if (active) {
    if (store.get().behaviours.peekMode === false) return;
    prePeek = currentCatPos();
    const { pos, shift } = peekTarget();
    peeking = true;
    placeCat(pos, false);
    send("peek", { active: true, shift });
  } else {
    peeking = false;
    if (prePeek) placeCat(prePeek);
    prePeek = null;
    send("peek", { active: false, shift: { x: 0, y: 0 } });
  }
  sendSettings();
}

// Where the cat currently is on screen, derived from the live window position.
function currentCatPos() {
  const l = layout(store.get().scale);
  const [wx, wy] = petWin.getPosition();
  return { x: wx + l.catX + catOffset.x, y: wy + l.catY + catOffset.y };
}

// ONE builder for every settings reply. get-settings, set-settings and the
// broadcast must all return the same shape: set-settings used to omit
// `displays`, so the renderer's copy lost it after the first save and the snap
// presets silently stopped working until the app was relaunched.
function settingsPayload() {
  const s = store.get();
  // Report where the cat actually IS, not where settings last recorded it —
  // on first run `position` is still null and the window is placed by default.
  let position = s.position;
  if (peeking && prePeek) position = prePeek;
  else if (petWin && !petWin.isDestroyed()) position = currentCatPos();
  return { ...s, position, catOffset, layout: layout(s.scale), displays: displayInfo() };
}

function sendSettings() {
  const payload = settingsPayload();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("settings", payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("settings", payload);
}

// --- windows ----------------------------------------------------------------
function createPet() {
  const s = store.get();
  const l = layout(s.scale);
  const wanted = s.position || defaultPosition(l);

  petWin = new BrowserWindow({
    width: l.width,
    height: l.height,
    x: Math.round(wanted.x - l.catX),
    y: Math.round(wanted.y - l.catY),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    // 'screen-saver' keeps the cat above full-screen apps, which is the whole
    // point — a pet that vanishes when you open a video is not living with you.
    alwaysOnTop: s.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // otherwise the cat freezes when unfocused
    },
  });

  if (s.alwaysOnTop) petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.loadFile(path.join(__dirname, "../renderer/pet/index.html"));

  // The window can still be moved by the window manager itself (KWin's
  // Meta+drag, a "move to screen" action), which placeCat never hears about.
  // Debounced because a WM move emits this continuously, and because our own
  // setPosition triggers it too — settling first keeps the readback truthful.
  let movedTimer = null;
  petWin.on("moved", () => {
    if (!petWin || petWin.isDestroyed()) return;
    clearTimeout(movedTimer);
    movedTimer = setTimeout(() => {
      if (!petWin || petWin.isDestroyed()) return;
      if (peeking) return; // hiding is not a new home
      store.set({ position: currentCatPos() });
      // Keep the X/Y fields in settings truthful however the cat got moved.
      if (settingsWin && !settingsWin.isDestroyed()) sendSettings();
    }, 180);
  });

  petWin.webContents.on("did-finish-load", () => {
    // Re-place once the window exists so a stored position that no longer fits
    // (screen resized, monitor unplugged) is corrected, and so catOffset is
    // computed for positions flush against a screen edge.
    placeCat(wanted);
    sendSettings();
    send("input-status", input.status);
  });

  petWin.on("closed", () => {
    petWin = null;
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 560,
    title: "Pixelcat",
    /*
     * No taskbar button, matching the cat's own window and the dock icon macOS
     * is already told to suppress (LSUIElement). This is a tray app: the whole
     * of it is a cat sitting on the desktop, and a desktop pet that also claims
     * a slot in the taskbar has taken up residence twice.
     *
     * Nothing becomes unreachable. The tray icon opens this window, so does
     * double-clicking the cat, and so does launching the app a second time —
     * `second-instance` calls openSettings rather than starting a rival copy.
     */
    /*
     * macOS and Windows ONLY. Electron marked skipTaskbar unsupported on Linux
     * in 19 and removed it in 20: X11 has _NET_WM_STATE_SKIP_TASKBAR, Wayland
     * has no equivalent, and the workarounds cost more than the feature does.
     * So on Linux BOTH windows sit in the taskbar, this changes nothing, and
     * no other option here would either — it is a window-manager setting now.
     *
     * Declaring the window a toolbar TYPE does get it out of the taskbar, and
     * is not worth the price: KWin then strips the decorations too, leaving the
     * settings pane with no close button. Tried, measured, reverted.
     */
    skipTaskbar: true,
    // Independently useful: the title bar's icon, alt-tab's, and the one
    // Windows groups by. An unpackaged run without it advertises itself as a
    // generic Electron app.
    icon: path.join(__dirname, "../../assets/icon.png"),
    backgroundColor: "#141418",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  /*
   * Windows drops skipTaskbar when an existing window is show()n again
   * (electron#3869), and openSettings() does exactly that every time the tray
   * is clicked while this window is sitting minimised. Re-asserting costs
   * nothing, and on Linux it is the same no-op the option already is.
   */
  settingsWin.on("show", () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setSkipTaskbar(true);
  });

  settingsWin.loadFile(path.join(__dirname, "../renderer/settings/index.html"));
  settingsWin.webContents.on("did-finish-load", () => {
    sendSettings();
    // Opened mid-round, the window would otherwise show "not running" until the
    // next tick — and show it wrongly for up to a second on every open.
    if (reminders) settingsWin.webContents.send("pomodoro", reminders.pomoState());
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function buildTray() {
  const iconPath = path.join(__dirname, "../../assets/tray.png");
  if (!fs.existsSync(iconPath)) {
    console.warn("[tray] assets/tray.png missing — run `npm run icons`; skipping tray");
    return;
  }
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(process.platform === "darwin" ? img.resize({ width: 16, height: 16 }) : img);
  tray.setToolTip("Pixelcat");
  refreshTrayMenu();
  tray.on("click", () => openSettings());
}

/*
 * Both menus get these from one place. They used to be written out twice with
 * only the tray copy kept in sync, so the cat's own right-click menu could offer
 * "Start Pomodoro" during a round.
 */
function pomodoroMenuItems() {
  if (!reminders) return [];
  const p = reminders.pomoState();
  if (p.phase === "idle") {
    return [{ label: "Start Pomodoro", click: () => { reminders.startPomodoro(); refreshTrayMenu(); } }];
  }
  /*
   * Minutes, not mm:ss. A tray menu is a STATIC menu — setContextMenu paints it
   * once — so a seconds countdown in it would simply freeze at whatever it read
   * when the menu was last rebuilt, which is worse than being coarse. Rounded up
   * so it says "1 min left" until it is actually over. The settings window has
   * the second-by-second clock.
   */
  const mins = Math.ceil(p.remainingMs / 60000);
  return [
    { label: `${p.phase === "focus" ? "Focus" : "Break"} — ${mins} min left`, enabled: false },
    { label: "Reset this round", click: () => { reminders.resetPomodoro(); refreshTrayMenu(); } },
    { label: "Stop Pomodoro", click: () => { reminders.stopPomodoro(); refreshTrayMenu(); } },
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings…", click: openSettings },
      ...pomodoroMenuItems(),
      { type: "separator" },
      {
        label: "Always on top",
        type: "checkbox",
        checked: s.alwaysOnTop,
        click: (item) => {
          store.set({ alwaysOnTop: item.checked });
          if (petWin) petWin.setAlwaysOnTop(item.checked, "screen-saver");
        },
      },
      {
        label: "Hide cat",
        click: () => petWin && (petWin.isVisible() ? petWin.hide() : petWin.show()),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

// --- input ------------------------------------------------------------------
function wireInput() {
  let lastSpeed = 0;

  // Global sources first: on Wayland the cursor poll consumes the raw deltas
  // this produces, so it has to be accumulating before polling starts.
  input.startGlobal({
    onKey: () => send("key", { t: Date.now() }),
    onWheel: (e) => send("wheel", { rotation: e.rotation || 0 }),
  });

  input.startCursor((s) => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;

    const [wx, wy] = petWin.getPosition();
    const lx = s.x - wx;
    const ly = s.y - wy;

    // Smooth the speed a little; raw per-frame deltas are far too jumpy to
    // drive a "the cursor is moving fast, go hunt it" threshold.
    const raw = Math.hypot(s.dx, s.dy);
    lastSpeed = lastSpeed * 0.8 + raw * 0.2;

    /*
     * Click-through is gated on `hitTest`, which is a settled verdict about the
     * SESSION, not on `exact`, which is a fact about this one sample. They are
     * different questions and the difference is the whole bug.
     *
     * On XWayland the native point is exact several times a second — whenever
     * the pointer crosses an X surface — and frozen in between. Gating on the
     * per-sample flag therefore flipped the window interactive and back
     * repeatedly while the pointer merely moved across the desk, which meant
     * the cat could go untouchable in the middle of being stroked. `hitTest`
     * changes at most once a second and only on accumulated evidence, so this
     * branch is stable for as long as the session is.
     *
     * When it is false the window simply stays interactive and the renderer
     * drives touch from its own DOM pointer events, which are exact whenever
     * the pointer is over the window. Trade-off is the documented one: the
     * window's rect, not just the cat, absorbs clicks.
     */
    if (!s.hitTest) {
      if (ignoring !== false) {
        ignoring = false;
        petWin.setIgnoreMouseEvents(false);
      }
    } else {
      const over =
        !!hitRect &&
        lx >= hitRect.x &&
        lx <= hitRect.x + hitRect.w &&
        ly >= hitRect.y &&
        ly <= hitRect.y + hitRect.h;
      const shouldIgnore = !over;
      if (shouldIgnore !== ignoring) {
        ignoring = shouldIgnore;
        petWin.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      }
    }

    // wy lets the renderer know when the window is hard against (or past) the
    // top of the screen, so it can flip speech bubbles below the cat instead
    // of drawing them off-screen.
    send("cursor", {
      gx: s.x,
      gy: s.y,
      lx,
      ly,
      wy,
      speed: lastSpeed,
      exact: s.exact,
      conf: s.conf,
      hitTest: s.hitTest,
    });
  });

  /*
   * A subsystem this easy to get wrong has to be observable on the machine that
   * is getting it wrong, because the failure is always "the cat ignores me" and
   * that one sentence covers every possible cause. `tools/cursor-sim.js` proves
   * the logic; this says which regime a real session actually landed in.
   *
   *   PIXELCAT_DEBUG_INPUT=1 npm start
   */
  if (process.env.PIXELCAT_DEBUG_INPUT) {
    const timer = setInterval(() => {
      const s = input.status;
      console.log(
        `[input] cursor=${s.cursor} hitTest=${s.hitTest} conf=${s.conf} ` +
          `gain=${s.gain}±${s.gainErr} keyboard=${s.keyboard}`
      );
    }, 1000);
    if (timer.unref) timer.unref();
  }

}

// --- ipc --------------------------------------------------------------------
function wireIpc() {
  ipcMain.on("hit-rect", (_e, rect) => {
    hitRect = rect;
  });

  /*
   * The renderer handing back a pointer position it saw for real.
   *
   * DOM pointer events over the pet window are exact on every platform, Wayland
   * included, so they are ground truth — and they arrive precisely when the
   * estimate is about to be asked its hardest question, because the pointer is
   * approaching the cat. Feeding them back makes the cat its own calibration
   * target: every visit re-anchors the global estimate and resets its drift.
   */
  ipcMain.on("pointer-sync", (_e, p) => {
    if (!petWin || petWin.isDestroyed() || !p) return;
    if (!Number.isFinite(p.lx) || !Number.isFinite(p.ly)) return;
    const [wx, wy] = petWin.getPosition();
    input.syncCursor({ x: wx + p.lx, y: wy + p.ly });
  });

  ipcMain.on("open-settings", openSettings);
  ipcMain.on("close-settings", () => settingsWin && settingsWin.close());
  ipcMain.on("quit", () => app.quit());

  ipcMain.on("action", (_e, action) => {
    if (!action) return;
    switch (action.type) {
      case "menu":
        Menu.buildFromTemplate([
          { label: "Settings…", click: openSettings },
          ...pomodoroMenuItems(),
          { type: "separator" },
          { label: "Hide cat", click: () => petWin && petWin.hide() },
          { label: "Quit", click: () => app.quit() },
        ]).popup({ window: petWin });
        break;
      case "pomodoro-toggle":
        reminders.togglePomodoro();
        refreshTrayMenu();
        break;
      case "pomodoro-reset":
        reminders.resetPomodoro();
        refreshTrayMenu();
        break;
    }
  });

  ipcMain.handle("get-settings", () => settingsPayload());

  ipcMain.handle("set-settings", (_e, patch) => {
    const before = store.get();
    const after = store.set(patch);

    // Resizing the stage means rebuilding the window bounds around the cat,
    // then re-placing so the cat keeps its screen position rather than drifting.
    if (patch.scale && patch.scale !== before.scale && petWin && !petWin.isDestroyed()) {
      const l = layout(after.scale);
      const keep = currentCatPos();
      const [x, y] = petWin.getPosition();
      petWin.setBounds({ x, y, width: l.width, height: l.height });
      placeCat(keep);
    }
    if (patch.alwaysOnTop !== undefined && petWin && !petWin.isDestroyed()) {
      petWin.setAlwaysOnTop(patch.alwaysOnTop, "screen-saver");
    }
    if (patch.launchAtLogin !== undefined) {
      setAutoLaunch(patch.launchAtLogin);
    }
    if (patch.position && petWin && !petWin.isDestroyed()) placeCat(patch.position);
    if (patch.reminders) reminders.resetCadence();
    if (patch.agentNames !== undefined || patch.behaviours) applyAgentSettings();
    if (patch.behaviours) applyPeekSettings();

    sendSettings();
    refreshTrayMenu();
    return settingsPayload();
  });

  ipcMain.handle("get-input-status", () => input.status);

  // Offered rather than done: this writes to a config file the user owns and
  // shares with every other window rule they have. See kwin-rule.js.
  ipcMain.handle("get-taskbar-rule", () => kwinRule.status());
  ipcMain.handle("set-taskbar-rule", (_e, enabled) => kwinRule.set(!!enabled));

  // Linux only: adding the user to the `input` group is what makes global
  // typing detection possible under Wayland. It needs privilege, so it is an
  // explicit button that raises the system's own auth prompt — never silent.
  ipcMain.handle("grant-input-access", async () => {
    /*
     * macOS will not take this permission from a program under any
     * circumstances — Accessibility is granted by a person, in Settings, and
     * that is the point of it. What can be removed is the part where they have
     * to go and find the pane. input.js is already watching for the grant, so
     * nothing here has to report success: the cat starts reacting on its own.
     */
    if (process.platform === "darwin") {
      try {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
      } catch {
        return {
          ok: false,
          message:
            "Could not open System Settings. Go to Privacy & Security > Accessibility and switch Pixelcat on.",
        };
      }
      return {
        ok: true,
        message:
          "Switch Pixelcat on in the Accessibility list. The cat starts reacting a second or two later — no relaunch.",
      };
    }
    if (process.platform !== "linux") {
      return { ok: false, message: "Only needed on Linux and macOS." };
    }
    const user = os.userInfo().username;
    return new Promise((resolve) => {
      execFile("pkexec", ["usermod", "-aG", "input", user], { timeout: 120000 }, (err, _o, stderr) => {
        if (err) {
          const cancelled = err.code === 126 || err.code === 127;
          return resolve({
            ok: false,
            message: cancelled
              ? "Cancelled, or pkexec is unavailable. You can run it yourself: sudo usermod -aG input $USER"
              : String(stderr || err.message).trim(),
          });
        }
        resolve({
          ok: true,
          message: `Added ${user} to the input group. Log out and back in to finish.`,
        });
      });
    });
  });

  ipcMain.handle("get-catalog", () => ({
    palettes: Object.entries(CatSprites.PALETTES).map(([id, p]) => ({
      id,
      label: p.label,
      B: p.B,
      M: p.M,
    })),
    patterns: Object.entries(CatSprites.PATTERNS).map(([id, p]) => ({ id, label: p.label })),
  }));
}

// --- boot -------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (petWin) petWin.show();
    openSettings();
  });

  app.whenReady().then(() => {
    if (process.platform === "darwin" && app.dock) app.dock.hide();

    /*
     * Pomodoro state goes to the settings window as well as the pet. The pet
     * used to carry a FOCUS/00:00 banner and was the only thing that knew the
     * time; now it just wears a headband, so the clock and the controls live in
     * settings and it needs the live feed rather than a snapshot from whenever
     * it happened to open.
     */
    let trayShows = ""; // what the tray's static menu currently claims
    reminders = new Reminders((channel, payload) => {
      send(channel, payload);
      if (channel !== "pomodoro") return;
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send(channel, payload);
      }
      // Rebuild the tray only when its minute-resolution label would actually
      // change. Doing it on every one-second tick would repaint the menu sixty
      // times an hour for nothing, and on Linux tray implementations rebuilding
      // an open menu is not always harmless.
      const shows = `${payload.phase}:${Math.ceil(payload.remainingMs / 60000)}`;
      if (shows === trayShows) return;
      trayShows = shows;
      refreshTrayMenu();
    });
    reminders.start();

    agents = new AgentWatcher((channel, payload) => send(channel, payload));
    applyAgentSettings();
    agents.start();

    // Peek mode watches for anything playing video and moves the cat aside.
    // Started in boot() below, not here: setPeek needs a window to move, and a
    // video already playing at launch would otherwise be reported once, dropped
    // for want of a pet window, and never mentioned again. What each platform
    // actually watches, and why none of them watch the same thing, is in
    // watching.js.
    watcher = new WatchDetector((active) => setPeek(active));

    wireIpc();

    // Compositors on Linux occasionally hand back an opaque window if it is
    // created the instant the app reports ready; a frame's grace fixes it.
    const boot = () => {
      createPet();
      applyPeekSettings();
      buildTray();
      wireInput();
      // Re-assert on every start: the entry points at a path, and a checkout
      // that moved would otherwise autostart nothing from a stale Exec line.
      setAutoLaunch(store.get().launchAtLogin);
      // No dock icon and a tray that some Linux shells hide entirely means a
      // first run can leave you with a cat and no way to configure it.
      if (process.argv.includes("--settings") || !tray) openSettings();
    };
    if (process.platform === "linux") setTimeout(boot, 120);
    else boot();

    app.on("activate", () => {
      if (!petWin) createPet();
    });
  });

  // A desktop pet has no windows to speak of — closing settings must not quit.
  app.on("window-all-closed", (e) => e.preventDefault());

  app.on("before-quit", () => {
    input.stopCursor();
    input.stopGlobal();
    if (reminders) reminders.stop();
    if (agents) agents.stop();
    if (watcher) watcher.stop();
  });
}
