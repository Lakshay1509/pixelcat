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
const input = require("./input");
const { Reminders } = require("./reminders");
const { AgentWatcher } = require("./agents");
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
let drag = false; // a drag gesture is in progress
let dragSeen = 0; // last time we heard from it, for the stuck-drag watchdog
let agents = null;
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
function placeCat(catPos) {
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
  catOffset = { x: Math.round(wantX - wx), y: Math.round(wantY - wy) };
  store.set({ position: { x: cx, y: cy } });
  return { x: cx, y: cy };
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
  if (petWin && !petWin.isDestroyed()) position = currentCatPos();
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

  // 'moved' fires continuously while dragging, so the write and the settings
  // echo are both debounced to the end of the gesture.
  let movedTimer = null;
  petWin.on("moved", () => {
    if (!petWin || petWin.isDestroyed()) return;
    clearTimeout(movedTimer);
    movedTimer = setTimeout(() => {
      if (!petWin || petWin.isDestroyed()) return;
      store.set({ position: currentCatPos() });
      // Keep the X/Y fields in settings truthful when the cat is dragged.
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
    backgroundColor: "#141418",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "../renderer/settings/index.html"));
  settingsWin.webContents.on("did-finish-load", sendSettings);
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

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings…", click: openSettings },
      {
        label: reminders && reminders.pomo.phase !== "idle" ? "Stop Pomodoro" : "Start Pomodoro",
        click: () => {
          reminders.togglePomodoro();
          refreshTrayMenu();
        },
      },
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
  input.setGain(store.get().pointerGain);
  input.startGlobal({
    onKey: () => send("key", { t: Date.now() }),
    onWheel: (e) => send("wheel", { rotation: e.rotation || 0 }),
  });

  input.startCursor((p, dx, dy) => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;

    // Watchdog: a lost drag-end used to leave `drag` set forever, and the old
    // code re-pinned the window to the cursor on every poll — which silently
    // overrode setPosition, so the snap presets appeared to do nothing.
    // Dragging no longer touches position here at all, but a stuck flag would
    // still keep the window permanently interactive, so it self-clears.
    if (drag && Date.now() - dragSeen > 2500) drag = false;

    const [wx, wy] = petWin.getPosition();
    const lx = p.x - wx;
    const ly = p.y - wy;

    // Smooth the speed a little; raw per-frame deltas are far too jumpy to
    // drive a "the cursor is moving fast, go hunt it" threshold.
    const raw = Math.hypot(dx, dy);
    lastSpeed = lastSpeed * 0.8 + raw * 0.2;

    // No global cursor source (Wayland without /dev/input access): we cannot
    // hit-test a pointer we cannot see, and leaving the window click-through
    // would make the cat completely untouchable — no drag, no petting, no
    // right-click. Stay interactive instead and let the renderer track the
    // pointer from its own events.
    const stale = input.status.cursor === "frozen";
    if (stale) {
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
      const shouldIgnore = !(over || drag);
      if (shouldIgnore !== ignoring) {
        ignoring = shouldIgnore;
        petWin.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      }
    }

    // wy lets the renderer know when the window is hard against (or past) the
    // top of the screen, so it can flip speech bubbles below the cat instead
    // of drawing them off-screen.
    send("cursor", { gx: p.x, gy: p.y, lx, ly, wy, speed: lastSpeed, dragging: !!drag, stale });
  });

}

// --- ipc --------------------------------------------------------------------
function wireIpc() {
  ipcMain.on("hit-rect", (_e, rect) => {
    hitRect = rect;
  });

  ipcMain.on("drag-start", () => {
    drag = true;
    dragSeen = Date.now();
    send("drag", { active: true });
  });

  // Dragging moves the window by RELATIVE deltas from the renderer's pointer
  // events, never by absolute cursor position. Wayland refuses to report the
  // global cursor, so the old absolute scheme dragged the cat to a fixed point
  // and pinned it there; movementX/Y is reported correctly everywhere.
  ipcMain.on("drag-move", (_e, { dx, dy }) => {
    dragSeen = Date.now();
    if (!drag || !petWin || petWin.isDestroyed()) return;
    const [x, y] = petWin.getPosition();
    petWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  ipcMain.on("drag-end", () => {
    drag = false;
    send("drag", { active: false });
    if (!petWin || petWin.isDestroyed()) return;
    // Normalise: re-derive the cat's screen position and re-place it, which
    // recomputes catOffset if the drag ended against a screen edge.
    placeCat(currentCatPos());
    sendSettings();
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
          {
            label: reminders.pomo.phase !== "idle" ? "Stop Pomodoro" : "Start Pomodoro",
            click: () => reminders.togglePomodoro(),
          },
          { type: "separator" },
          { label: "Hide cat", click: () => petWin && petWin.hide() },
          { label: "Quit", click: () => app.quit() },
        ]).popup({ window: petWin });
        break;
      case "pomodoro-toggle":
        reminders.togglePomodoro();
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
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    if (patch.pointerGain !== undefined) input.setGain(patch.pointerGain);
    if (patch.position && petWin && !petWin.isDestroyed()) placeCat(patch.position);
    if (patch.reminders) reminders.resetCadence();
    if (patch.agentNames !== undefined || patch.behaviours) applyAgentSettings();

    sendSettings();
    refreshTrayMenu();
    return settingsPayload();
  });

  ipcMain.handle("get-input-status", () => input.status);

  // Linux only: adding the user to the `input` group is what makes global
  // typing detection possible under Wayland. It needs privilege, so it is an
  // explicit button that raises the system's own auth prompt — never silent.
  ipcMain.handle("grant-input-access", () => {
    if (process.platform !== "linux") {
      return { ok: false, message: "Only needed on Linux." };
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

    reminders = new Reminders((channel, payload) => send(channel, payload));
    reminders.start();

    agents = new AgentWatcher((channel, payload) => send(channel, payload));
    applyAgentSettings();
    agents.start();

    wireIpc();

    // Compositors on Linux occasionally hand back an opaque window if it is
    // created the instant the app reports ready; a frame's grace fixes it.
    const boot = () => {
      createPet();
      buildTray();
      wireInput();
      app.setLoginItemSettings({ openAtLogin: store.get().launchAtLogin });
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
  });
}
