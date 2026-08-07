/*
 * settings.js — controls, plus a live preview driven by the same renderer the
 * cat itself uses. Picking a colour shows you the actual cat, not a swatch that
 * approximates it.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let S = null;
  let catalog = null;

  const preview = $("preview");
  const pctx = preview.getContext("2d");
  const cat = new CatRenderer();
  let previewEye = { x: 0, y: 0 };

  const BEHAVIOURS = [
    ["eyeFollow", "Eye follow"],
    ["mouseHunt", "Mouse hunt"],
    ["petting", "Purring pets"],
    ["kneading", "Keyboard kneading"],
    ["overheat", "Overheat mode"],
    ["scrollUnroll", "Paper unroll"],
    ["agentReactions", "AI agent reactions"],
  ];

  // Writes are debounced per-key so dragging a slider or typing a name doesn't
  // hammer the disk once per keystroke.
  const pending = new Map();
  function save(patch, key = JSON.stringify(Object.keys(patch))) {
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(async () => {
        S = await window.pet.invoke("set-settings", patch);
        drawPreview();
      }, 120)
    );
  }

  function drawPreview() {
    if (!S) return;
    cat.setLook(S.palette, S.pattern);
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.imageSmoothingEnabled = false;
    cat.render(pctx, { x: 0, y: 0, scale: 4, eye: previewEye, lids: 0, mouth: "neutral" });
  }

  // The preview cat watches the cursor around the settings window — the same
  // behaviour it has on the desktop, so you can try it before enabling it.
  window.addEventListener("mousemove", (e) => {
    const r = preview.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const n = Math.max(1, Math.hypot(dx, dy));
    previewEye = {
      x: Math.max(-1, Math.min(1, (dx / n) * 1.6)),
      y: Math.max(-1, Math.min(1, (dy / n) * 1.6)),
    };
    drawPreview();
  });

  function buildPalettes() {
    const wrap = $("palettes");
    wrap.innerHTML = "";
    for (const p of catalog.palettes) {
      const b = document.createElement("button");
      b.className = "swatch";
      b.type = "button";
      b.title = p.label;
      b.setAttribute("aria-label", p.label);
      b.style.setProperty("--b", p.B);
      b.style.setProperty("--m", p.M);
      b.setAttribute("aria-pressed", String(S.palette === p.id));
      b.addEventListener("click", () => {
        S.palette = p.id;
        buildPalettes();
        drawPreview();
        save({ palette: p.id });
      });
      wrap.appendChild(b);
    }
  }

  function buildPatterns() {
    const wrap = $("patterns");
    wrap.innerHTML = "";
    for (const p of catalog.patterns) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.textContent = p.label;
      b.setAttribute("aria-pressed", String(S.pattern === p.id));
      b.addEventListener("click", () => {
        S.pattern = p.id;
        buildPatterns();
        drawPreview();
        save({ pattern: p.id });
      });
      wrap.appendChild(b);
    }
  }

  function buildBehaviours() {
    const wrap = $("behaviours");
    wrap.innerHTML = "";
    for (const [key, label] of BEHAVIOURS) {
      const l = document.createElement("label");
      l.className = "check";
      const i = document.createElement("input");
      i.type = "checkbox";
      i.checked = !!S.behaviours[key];
      i.addEventListener("change", () => save({ behaviours: { [key]: i.checked } }, key));
      const s = document.createElement("span");
      s.textContent = label;
      l.append(i, s);
      wrap.appendChild(l);
    }
  }

  function buildMessages() {
    const wrap = $("messages");
    wrap.innerHTML = "";
    if (!S.messages || !S.messages.length) {
      wrap.innerHTML = '<p class="empty">No scheduled messages yet.</p>';
      return;
    }
    for (const m of S.messages) {
      const row = document.createElement("div");
      row.className = "msg";

      const on = document.createElement("input");
      on.type = "checkbox";
      on.checked = m.enabled !== false;
      on.addEventListener("change", () => {
        m.enabled = on.checked;
        save({ messages: S.messages }, "messages");
      });

      const when = document.createElement("span");
      when.className = "when";
      when.textContent = m.time;

      const what = document.createElement("span");
      what.className = "what";
      what.textContent = m.text;

      const del = document.createElement("button");
      del.className = "btn danger";
      del.type = "button";
      del.textContent = "DELETE";
      del.addEventListener("click", () => {
        S.messages = S.messages.filter((x) => x.id !== m.id);
        buildMessages();
        save({ messages: S.messages }, "messages");
      });

      row.append(on, when, what, del);
      wrap.appendChild(row);
    }
  }

  // Report what each input source is ACTUALLY doing. A pet whose reactions
  // silently do nothing is far more confusing than one that says why.
  function showInputStatus(st) {
    const el = $("inputStatus");
    if (!st) return;

    const typing =
      st.keyboard === "ok"
        ? "Typing: detected"
        : st.keyboard === "evdev"
          ? "Typing: detected via /dev/input"
          : "Typing: unavailable";
    const cursor = st.cursor === "evdev" ? "Cursor: estimated" : "Cursor: tracked";

    el.textContent = `${typing} · ${cursor}${st.detail ? ` — ${st.detail}` : ""}`;
    el.className =
      st.keyboard === "ok" || st.keyboard === "evdev" ? "note" : "note warn";

    const estimating = st.cursor === "evdev";
    $("gainRow").hidden = !estimating;
    $("gainNote").hidden = !estimating;

    // Offer the one-click fix only when it is actually the missing piece.
    $("grantInput").hidden = !(
      window.pet.platform === "linux" &&
      st.keyboard !== "ok" &&
      st.keyboard !== "evdev"
    );
  }

  // --- position ------------------------------------------------------------
  function currentDisplay() {
    const list = S.displays || [];
    const sel = $("posDisplay");
    const chosen = list.find((d) => String(d.id) === sel.value);
    return chosen || list.find((d) => d.primary) || list[0];
  }

  function buildDisplays() {
    const sel = $("posDisplay");
    const list = S.displays || [];
    sel.hidden = list.length < 2; // a selector for one screen is just noise
    if (sel.hidden) return;
    const keep = sel.value;
    sel.innerHTML = "";
    for (const d of list) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = d.label + (d.primary ? " (primary)" : "");
      sel.appendChild(o);
    }
    if (keep) sel.value = keep;
  }

  function buildSnap() {
    const wrap = $("snap");
    wrap.innerHTML = "";
    const rows = ["top", "middle", "bottom"];
    const cols = ["left", "center", "right"];
    for (const v of rows)
      for (const h of cols) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = `${v} ${h}`;
        b.setAttribute("aria-label", `Snap to ${v} ${h}`);
        b.addEventListener("click", () => snapTo(v, h));
        wrap.appendChild(b);
      }
  }

  function snapTo(v, h) {
    const d = currentDisplay();
    if (!d || !S.layout) return;
    const wa = d.workArea;
    const m = 24;
    const W = S.layout.width;
    const H = S.layout.height;
    const x =
      h === "left" ? wa.x + m
      : h === "center" ? Math.round(wa.x + (wa.width - W) / 2)
      : wa.x + wa.width - W - m;
    const y =
      v === "top" ? wa.y + m
      : v === "middle" ? Math.round(wa.y + (wa.height - H) / 2)
      : wa.y + wa.height - H - m;
    $("posX").value = x;
    $("posY").value = y;
    save({ position: { x, y } }, "position");
  }

  function fill() {
    $("scale").value = S.scale;
    $("scaleOut").textContent = `${S.scale}x`;
    if (S.position) {
      $("posX").value = S.position.x;
      $("posY").value = S.position.y;
    }
    $("gain").value = S.pointerGain ?? 1;
    $("gainOut").textContent = `${Number(S.pointerGain ?? 1).toFixed(1)}x`;
    $("stretchOn").checked = S.reminders.stretch.enabled;
    $("stretchMin").value = S.reminders.stretch.everyMin;
    $("waterOn").checked = S.reminders.water.enabled;
    $("waterMin").value = S.reminders.water.everyMin;
    $("focusMin").value = S.pomodoro.focusMin;
    $("breakMin").value = S.pomodoro.breakMin;
    $("rounds").value = S.pomodoro.rounds;
    $("name").value = S.name || "";
    $("pinned").value = S.pinnedMessage || "";
    $("agentNames").value = S.agentNames || "";
    $("alwaysOnTop").checked = S.alwaysOnTop;
    $("launchAtLogin").checked = S.launchAtLogin;
    $("tagline").textContent = S.name
      ? `${S.name}'s cat is on the desktop.`
      : "A pixel cat that lives in your computer.";
  }

  function wire() {
    $("scale").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      $("scaleOut").textContent = `${v}x`;
      save({ scale: v }, "scale");
    });

    const num = (id, path, key) =>
      $(id).addEventListener("change", (e) => {
        const v = Math.max(1, Number(e.target.value) || 1);
        e.target.value = v;
        save(path(v), key);
      });

    num("stretchMin", (v) => ({ reminders: { stretch: { everyMin: v } } }), "stretchMin");
    num("waterMin", (v) => ({ reminders: { water: { everyMin: v } } }), "waterMin");
    num("focusMin", (v) => ({ pomodoro: { focusMin: v } }), "focusMin");
    num("breakMin", (v) => ({ pomodoro: { breakMin: v } }), "breakMin");
    num("rounds", (v) => ({ pomodoro: { rounds: v } }), "rounds");

    $("stretchOn").addEventListener("change", (e) =>
      save({ reminders: { stretch: { enabled: e.target.checked } } }, "stretchOn")
    );
    $("waterOn").addEventListener("change", (e) =>
      save({ reminders: { water: { enabled: e.target.checked } } }, "waterOn")
    );

    $("name").addEventListener("input", (e) => {
      $("tagline").textContent = e.target.value
        ? `${e.target.value}'s cat is on the desktop.`
        : "A pixel cat that lives in your computer.";
      save({ name: e.target.value.trim() }, "name");
    });
    $("pinned").addEventListener("input", (e) =>
      save({ pinnedMessage: e.target.value }, "pinned")
    );

    $("alwaysOnTop").addEventListener("change", (e) =>
      save({ alwaysOnTop: e.target.checked }, "aot")
    );
    $("launchAtLogin").addEventListener("change", (e) =>
      save({ launchAtLogin: e.target.checked }, "login")
    );

    const readPos = () => ({
      x: Math.round(Number($("posX").value) || 0),
      y: Math.round(Number($("posY").value) || 0),
    });
    $("posX").addEventListener("change", () => save({ position: readPos() }, "position"));
    $("posY").addEventListener("change", () => save({ position: readPos() }, "position"));

    $("gain").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      $("gainOut").textContent = `${v.toFixed(1)}x`;
      save({ pointerGain: v }, "gain");
    });

    $("agentNames").addEventListener("input", (e) =>
      save({ agentNames: e.target.value }, "agentNames")
    );

    $("grantInput").addEventListener("click", async () => {
      const btn = $("grantInput");
      const out = $("grantResult");
      btn.disabled = true;
      btn.textContent = "WAITING FOR AUTHORISATION…";
      const r = await window.pet.invoke("grant-input-access");
      out.hidden = false;
      out.textContent = r.message;
      out.className = r.ok ? "note" : "note warn";
      btn.disabled = false;
      btn.textContent = "ENABLE FULL INPUT TRACKING";
    });

    $("pomoToggle").addEventListener("click", () =>
      window.pet.send("action", { type: "pomodoro-toggle" })
    );

    $("msgAdd").addEventListener("click", () => {
      const time = $("msgTime").value;
      const text = $("msgText").value.trim();
      if (!time || !text) return;
      S.messages = [
        ...(S.messages || []),
        { id: `m${Date.now().toString(36)}`, time, text, enabled: true },
      ];
      $("msgText").value = "";
      buildMessages();
      save({ messages: S.messages }, "messages");
    });
  }

  // The pet window can change settings too (tray menu), so stay in sync — but
  // every save echoes back, and re-filling a control the user is currently
  // holding snaps it out from under them mid-drag. Leave the focused one alone.
  window.pet.on("settings", (s) => {
    S = s;
    const busy = document.activeElement;
    const editing = busy && busy !== document.body && busy.tagName === "INPUT";
    if (!editing) fill();
    if (catalog) {
      buildPalettes();
      buildPatterns();
    }
    buildDisplays();
    drawPreview();
  });

  (async function init() {
    [S, catalog] = await Promise.all([
      window.pet.invoke("get-settings"),
      window.pet.invoke("get-catalog"),
    ]);
    buildPalettes();
    buildPatterns();
    buildBehaviours();
    buildMessages();
    buildDisplays();
    buildSnap();
    fill();
    wire();
    drawPreview();

    // The active input source is decided at runtime (and can change), so poll
    // it rather than reporting whatever was true at launch.
    const refresh = async () => showInputStatus(await window.pet.invoke("get-input-status"));
    await refresh();
    setInterval(refresh, 2000);
  })();
})();
