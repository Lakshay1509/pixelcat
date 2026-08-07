/*
 * preload.js — the only bridge between main and the renderers.
 *
 * contextIsolation stays on and nodeIntegration stays off; the renderer gets an
 * explicit allow-listed surface and nothing else. Channels are enumerated
 * rather than pattern-matched so adding one is a deliberate act.
 */
const { contextBridge, ipcRenderer } = require("electron");

const FROM_MAIN = [
  "settings",
  "cursor",
  "key",
  "wheel",
  "say",
  "pomodoro",
  "input-status",
  "drag",
];

const TO_MAIN = [
  "hit-rect",
  "drag-start",
  "drag-end",
  "open-settings",
  "close-settings",
  "quit",
  "action",
];

const INVOKE = ["get-settings", "set-settings", "get-input-status", "get-catalog"];

contextBridge.exposeInMainWorld("pet", {
  on(channel, listener) {
    if (!FROM_MAIN.includes(channel)) throw new Error(`blocked channel: ${channel}`);
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  send(channel, payload) {
    if (!TO_MAIN.includes(channel)) throw new Error(`blocked channel: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  invoke(channel, payload) {
    if (!INVOKE.includes(channel)) throw new Error(`blocked channel: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  platform: process.platform,
});
