/*
 * pet.js — what makes it feel alive.
 *
 * Behaviour is modelled as continuous drives (heat, pet-meter, hunt, sleepiness)
 * rather than exclusive states. A cat that can only be doing one thing at a time
 * reads like a vending machine; overlapping drives are why it can be
 * half-asleep, blink, and still track your cursor.
 */
(function () {
  "use strict";

  const cvs = document.getElementById("stage");
  const ctx = cvs.getContext("2d");
  const bubbleEl = document.getElementById("bubble");
  const timerEl = document.getElementById("timer");
  const pinEl = document.getElementById("pin");
  const cat = new CatRenderer();
  const A = CatSprites.ANCHORS;

  let S = null;
  let L = null;

  const cursor = { lx: -9999, ly: -9999, speed: 0, dragging: false };
  let particles = [];
  let lastRect = null; // cat bounds from the previous frame, for hit testing
  let staleMode = false; // true when main has no usable global cursor

  // drives
  let heat = 0; // 0..1 overheat blush
  let petMeter = 0; // 0..1 purring
  let huntAmt = 0; // 0..1 pounce lean
  let sleepiness = 0; // 0..1

  let lastKey = 0;
  let keyTimes = [];
  let lastActivity = Date.now();
  let blinkNext = performance.now() + 2000;
  let blinkUntil = 0;
  let dragging = false;
  let dragVel = { x: 0, y: 0 };
  let lastCursor = { lx: 0, ly: 0 };
  let wobble = 0;
  let stretchUntil = 0;
  let jumpUntil = 0;
  let bubbleTimer = null;
  let lastHit = "";

  const now = () => performance.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // --- setup ---------------------------------------------------------------
  function applySettings(s) {
    S = s;
    L = s.layout;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = Math.round(L.width * dpr);
    cvs.height = Math.round(L.height * dpr);
    cvs.style.width = `${L.width}px`;
    cvs.style.height = `${L.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    cat.setLook(s.palette, s.pattern);
    pinEl.textContent = s.pinnedMessage || "";
    pinEl.classList.toggle("show", !!s.pinnedMessage);
  }

  window.pet.on("settings", applySettings);
  window.pet.invoke("get-settings").then(applySettings);

  /*
   * Two pointer sources, and local events always win.
   *
   * Main polls a global cursor, which is exact on Windows/macOS/X11 and either
   * estimated or entirely blind on Wayland. But whenever the pointer is over
   * this window we get real DOM mousemove events with exact coordinates — so
   * those take precedence for a moment after they arrive, and the global feed
   * fills the gaps. On a Wayland box with no /dev/input access this is the only
   * working source, and it's why the cat still reacts when you approach it.
   */
  let localAt = -1e9;
  let localPrev = null;

  window.pet.on("cursor", (c) => {
    cursor.dragging = c.dragging;
    staleMode = !!c.stale;
    if (c.stale) return; // position is meaningless; local events are all we have
    if (now() - localAt < 400) return; // a real pointer event is more accurate
    cursor.lx = c.lx;
    cursor.ly = c.ly;
    cursor.speed = c.speed;
    if (c.speed > 2) lastActivity = Date.now();
  });

  window.addEventListener("mousemove", (e) => {
    const t = now();
    const lx = e.clientX;
    const ly = e.clientY;
    if (localPrev) {
      const dt = Math.max(8, t - localPrev.t);
      // normalise to per-16ms so it shares a scale with main's polled speed
      cursor.speed = (Math.hypot(lx - localPrev.x, ly - localPrev.y) / dt) * 16;
    }
    localPrev = { x: lx, y: ly, t };
    cursor.lx = lx;
    cursor.ly = ly;
    localAt = t;
    lastActivity = Date.now();
  });

  window.pet.on("key", () => {
    const t = now();
    lastKey = t;
    keyTimes.push(t);
    lastActivity = Date.now();
  });

  window.pet.on("wheel", () => {
    if (!S || !S.behaviours.scrollUnroll) return;
    lastActivity = Date.now();
    spawnPaper();
  });

  window.pet.on("drag", ({ active }) => {
    dragging = active;
    if (!active) wobble = 1;
  });

  window.pet.on("say", ({ text, kind, ms }) => {
    say(text, kind, ms);
    if (kind === "stretch") stretchUntil = now() + 1400;
    if (kind === "pomodoro") jumpUntil = now() + 700;
  });

  window.pet.on("pomodoro", (p) => {
    if (!p || p.phase === "idle") {
      timerEl.classList.remove("show");
      return;
    }
    const secs = Math.max(0, Math.round(p.remainingMs / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    timerEl.textContent = `${p.phase === "focus" ? "FOCUS" : "BREAK"} ${mm}:${ss}`;
    timerEl.dataset.phase = p.phase;
    timerEl.classList.add("show");
  });

  function say(text, kind, ms = 8000) {
    bubbleEl.textContent = text;
    bubbleEl.dataset.kind = kind || "";
    bubbleEl.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.remove("show"), ms);
  }

  // --- pointer -------------------------------------------------------------
  // These only fire while the window is NOT click-through, i.e. while the cursor
  // is genuinely over the cat — main flips that for us.
  cvs.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    window.pet.send("drag-start", { ox: e.clientX, oy: e.clientY });
  });
  window.addEventListener("mouseup", () => window.pet.send("drag-end"));
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.pet.send("action", { type: "menu" });
  });
  timerEl.addEventListener("click", () => window.pet.send("action", { type: "pomodoro-toggle" }));
  cvs.addEventListener("dblclick", () => window.pet.send("open-settings"));

  // --- particles -----------------------------------------------------------
  function spawn(kind, x, y, opts = {}) {
    particles.push({
      kind,
      x,
      y,
      vx: opts.vx ?? (Math.random() - 0.5) * 20,
      vy: opts.vy ?? -30 - Math.random() * 20,
      life: opts.life ?? 1.2,
      max: opts.life ?? 1.2,
      colour: opts.colour ?? "#ffffff",
      scale: opts.scale ?? Math.max(1, (L ? L.scale : 4) * 0.5),
    });
  }

  function headPoint() {
    return {
      x: L.catX + A.headTop.x * L.scale,
      y: L.catY + A.headTop.y * L.scale,
    };
  }

  function spawnPaper() {
    const h = headPoint();
    spawn("paper", h.x + (Math.random() - 0.5) * 30, h.y + 40, {
      colour: "#f4efe6",
      vy: 20 + Math.random() * 20,
      vx: (Math.random() - 0.5) * 40,
      life: 1.0,
    });
  }

  // --- loop ----------------------------------------------------------------
  let last = now();

  function frame() {
    requestAnimationFrame(frame);
    if (!S || !L) return;

    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;

    ctx.clearRect(0, 0, L.width, L.height);

    // --- drives ---
    keyTimes = keyTimes.filter((k) => t - k < 8000);
    const typing = t - lastKey < 700;
    // ~5 chars per word; 8s window scaled to a minute.
    const wpm = (keyTimes.length / 5) * (60 / 8);
    if (S.behaviours.overheat) {
      heat = clamp(heat + (wpm > 65 ? dt * 0.55 : -dt * 0.5), 0, 1);
    } else heat = 0;

    const idleMs = Date.now() - lastActivity;
    sleepiness = clamp((idleMs - 120_000) / 180_000, 0, 1);

    // cat centre in window coords
    const cx = L.catX + A.head.x * L.scale;
    const cy = L.catY + A.head.y * L.scale;
    const dx = cursor.lx - cx;
    const dy = cursor.ly - cy;
    const dist = Math.hypot(dx, dy);

    // Is the pointer over the cat? Computed here from the rect we drew last
    // frame rather than trusted from main, because main's copy is wrong on
    // Wayland and one frame of staleness is invisible.
    const inside =
      lastRect &&
      cursor.lx >= lastRect.x &&
      cursor.lx <= lastRect.x + lastRect.w &&
      cursor.ly >= lastRect.y &&
      cursor.ly <= lastRect.y + lastRect.h;

    // petting: cursor over the head, moving
    const overHead = inside && dist < 11 * L.scale;
    if (S.behaviours.petting && overHead && cursor.speed > 1.2 && !dragging) {
      petMeter = clamp(petMeter + dt * 1.4, 0, 1);
      lastActivity = Date.now();
    } else {
      petMeter = clamp(petMeter - dt * 0.6, 0, 1);
    }
    const purring = petMeter > 0.45;
    if (purring && Math.random() < dt * 6) {
      const h = headPoint();
      spawn("heart", h.x + (Math.random() - 0.5) * 26, h.y, { colour: "#f2708a", life: 1.1 });
    }

    // hunting
    const wantHunt = S.behaviours.mouseHunt && cursor.speed > 9 && !dragging;
    huntAmt = clamp(huntAmt + (wantHunt ? dt * 3 : -dt * 1.6), 0, 1);

    // overheat steam
    if (heat > 0.5 && Math.random() < dt * 8) {
      const h = headPoint();
      spawn("steam", h.x + (Math.random() - 0.5) * 30, h.y - 6, {
        colour: "#d8d8e0",
        life: 0.9,
        vy: -45,
      });
    }

    // sleep zzz
    if (sleepiness > 0.6 && Math.random() < dt * 1.6) {
      const h = headPoint();
      spawn("z", h.x + 16, h.y - 4, { colour: "#b9b9c6", life: 2.0, vy: -18, vx: 10 });
    }

    // blink
    let lids = 0;
    if (t > blinkNext) {
      blinkUntil = t + 110;
      blinkNext = t + 2200 + Math.random() * 4200;
    }
    if (t < blinkUntil) lids = 1;
    if (sleepiness > 0.75) lids = 1;
    else if (purring || sleepiness > 0.4) lids = Math.max(lids, 0.5);

    // --- pose ---
    // eye follow: normalise direction, keep pupils inside the sclera.
    // When local events are the only source, the last known position goes
    // stale the moment the pointer leaves the window — so let the gaze relax
    // to neutral instead of staring at a spot the cursor left long ago.
    const pointerFresh = !staleMode || t - localAt < 1800;
    let eye = { x: 0, y: 0 };
    if (S.behaviours.eyeFollow && pointerFresh && dist > 4 && lids < 1) {
      const n = Math.max(1, dist);
      eye = { x: clamp((dx / n) * 1.6, -1, 1), y: clamp((dy / n) * 1.6, -1, 1) };
    }

    // drag velocity -> mochi squash
    const vx = cursor.lx - lastCursor.lx;
    const vy = cursor.ly - lastCursor.ly;
    lastCursor = { lx: cursor.lx, ly: cursor.ly };
    if (dragging) dragVel = { x: lerp(dragVel.x, vx, 0.3), y: lerp(dragVel.y, vy, 0.3) };
    else dragVel = { x: lerp(dragVel.x, 0, 0.15), y: lerp(dragVel.y, 0, 0.15) };

    let squashX = 1;
    let squashY = 1;

    if (dragging) {
      // hanging from the scruff: stretched tall, swaying with horizontal speed
      const pull = clamp(Math.abs(dragVel.y) / 26, 0, 0.35);
      squashY = 1 + 0.22 + pull;
      squashX = 1 - 0.14 - pull * 0.6;
    }
    if (wobble > 0) {
      wobble = Math.max(0, wobble - dt * 2.2);
      const w = Math.sin(wobble * Math.PI * 6) * wobble * 0.28;
      squashX += w;
      squashY -= w;
    }
    if (t < stretchUntil) {
      const p = 1 - (stretchUntil - t) / 1400;
      const e = Math.sin(p * Math.PI); // ease in and back out
      squashY += e * 0.42;
      squashX -= e * 0.16;
    }
    // breathing, but only when otherwise still
    const calm = 1 - Math.max(huntAmt, petMeter, dragging ? 1 : 0);
    squashY += Math.sin(t / 620) * 0.018 * calm;

    // position offsets
    let ox = 0;
    let oy = 0;
    if (huntAmt > 0) {
      const n = Math.max(1, dist);
      ox += (dx / n) * huntAmt * 26;
      oy += (dy / n) * huntAmt * 14;
      oy -= Math.abs(Math.sin(t / 90)) * huntAmt * 8; // scampering bob
    }
    if (t < jumpUntil) {
      const p = 1 - (jumpUntil - t) / 700;
      oy -= Math.abs(Math.sin(p * Math.PI * 2)) * 26;
    }
    if (typing && S.behaviours.kneading) oy += Math.sin(t / 70) * 1.5;

    const mouth = huntAmt > 0.4 || heat > 0.6 ? "open" : purring ? "smile" : "neutral";

    const hit = cat.render(ctx, {
      x: L.catX + ox,
      y: L.catY + oy,
      scale: L.scale,
      eye,
      lids,
      mouth,
      tint: heat,
      squashX,
      squashY,
      knead: typing && S.behaviours.kneading ? (t % 320) / 320 : null,
    });

    // --- particles ---
    particles = particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) return false;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 26 * dt;
      cat.drawParticle(ctx, p.kind, p.x, p.y, p.scale, p.colour, clamp(p.life / p.max, 0, 1));
      return true;
    });

    // --- publish hit rect ---
    // Padded a little: asking a user to hit an exact 4px tail is not a game.
    const pad = 6;
    const rect = {
      x: hit.x - pad,
      y: hit.y - pad,
      w: hit.w + pad * 2,
      h: hit.h + pad * 2,
    };
    lastRect = rect;
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (key !== lastHit) {
      lastHit = key;
      window.pet.send("hit-rect", rect);
    }

    // keep the bubble pinned above the cat's head
    bubbleEl.style.left = `${L.catX + (CatSprites.W * L.scale) / 2 + ox}px`;
    bubbleEl.style.top = `${L.catY + oy - 6}px`;
  }

  requestAnimationFrame(frame);
})();
