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

const store = require("./store");
const input = require("./input");
const { Reminders } = require("./reminders");
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
let drag = null; // { ox, oy } cursor offset inside the window while dragging

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

function defaultPosition(l) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - l.width - 24),
    y: Math.round(workArea.y + workArea.height - l.height - 24),
  };
}

function send(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

function displayInfo() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    workArea: d.workArea,
    primary: d.id === primaryId,
  }));
}

function sendSettings() {
  const s = store.get();
  const l = layout(s.scale);
  // Report where the cat actually IS, not where settings last recorded it —
  // on first run `position` is still null and the window is placed by default.
  let position = s.position;
  if (petWin && !petWin.isDestroyed()) {
    const [x, y] = petWin.getPosition();
    position = { x, y };
  }
  const payload = { ...s, position, layout: l, displays: displayInfo() };
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("settings", payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("settings", payload);
}

// --- windows ----------------------------------------------------------------
function createPet() {
  const s = store.get();
  const l = layout(s.scale);
  const pos = s.position || defaultPosition(l);

  petWin = new BrowserWindow({
    width: l.width,
    height: l.height,
    x: pos.x,
    y: pos.y,
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
      const [x, y] = petWin.getPosition();
      store.set({ position: { x, y } });
      // Keep the X/Y fields in settings truthful when the cat is dragged.
      if (settingsWin && !settingsWin.isDestroyed()) sendSettings();
    }, 180);
  });

  petWin.webContents.on("did-finish-load", () => {
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

    // Dragging wins over everything: reposition the window under the grab point.
    if (drag) {
      petWin.setPosition(Math.round(p.x - drag.ox), Math.round(p.y - drag.oy));
    }

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

    send("cursor", { gx: p.x, gy: p.y, lx, ly, speed: lastSpeed, dragging: !!drag, stale });
  });

}

// --- ipc --------------------------------------------------------------------
function wireIpc() {
  ipcMain.on("hit-rect", (_e, rect) => {
    hitRect = rect;
  });

  ipcMain.on("drag-start", (_e, { ox, oy }) => {
    drag = { ox, oy };
    send("drag", { active: true });
  });

  ipcMain.on("drag-end", () => {
    drag = null;
    send("drag", { active: false });
    if (petWin && !petWin.isDestroyed()) {
      const [x, y] = petWin.getPosition();
      store.set({ position: { x, y } });
    }
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

  ipcMain.handle("get-settings", () => {
    const s = store.get();
    let position = s.position;
    if (petWin && !petWin.isDestroyed()) {
      const [x, y] = petWin.getPosition();
      position = { x, y };
    }
    return { ...s, position, layout: layout(s.scale), displays: displayInfo() };
  });

  ipcMain.handle("set-settings", (_e, patch) => {
    const before = store.get();
    const after = store.set(patch);

    // Resizing the stage means rebuilding the window bounds around the cat.
    if (patch.scale && patch.scale !== before.scale && petWin && !petWin.isDestroyed()) {
      const l = layout(after.scale);
      const [x, y] = petWin.getPosition();
      petWin.setBounds({ x, y, width: l.width, height: l.height });
    }
    if (patch.alwaysOnTop !== undefined && petWin && !petWin.isDestroyed()) {
      petWin.setAlwaysOnTop(patch.alwaysOnTop, "screen-saver");
    }
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    if (patch.pointerGain !== undefined) input.setGain(patch.pointerGain);
    if (patch.position && petWin && !petWin.isDestroyed()) {
      // Clamp into the desktop so a fat-fingered coordinate can't strand the
      // cat off-screen with no way to get it back.
      const l = layout(after.scale);
      const b = displayInfo().reduce(
        (acc, d) => ({
          x0: Math.min(acc.x0, d.workArea.x),
          y0: Math.min(acc.y0, d.workArea.y),
          x1: Math.max(acc.x1, d.workArea.x + d.workArea.width),
          y1: Math.max(acc.y1, d.workArea.y + d.workArea.height),
        }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      );
      const x = Math.round(Math.max(b.x0, Math.min(b.x1 - l.width, patch.position.x)));
      const y = Math.round(Math.max(b.y0, Math.min(b.y1 - l.height, patch.position.y)));
      petWin.setPosition(x, y);
      store.set({ position: { x, y } });
    }
    if (patch.reminders) reminders.resetCadence();

    sendSettings();
    refreshTrayMenu();
    return { ...after, layout: layout(after.scale) };
  });

  ipcMain.handle("get-input-status", () => input.status);

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
  });
}
