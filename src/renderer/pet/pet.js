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
  // Where the sprite is drawn inside the window. Normally the layout padding,
  // but main slides it when the cat is flush against a screen edge the window
  // itself is not allowed to cross.
  let catX = 0;
  let catY = 0;

  const cursor = { lx: -9999, ly: -9999, speed: 0 };
  let particles = [];
  let lastRect = null; // cat bounds from the previous frame, for hit testing
  let staleMode = false; // true when main has no usable global cursor
  let winY = 100; // window's screen y, for deciding which side bubbles go

  // drives
  let heat = 0; // 0..1 overheat blush
  let petMeter = 0; // 0..1 purring
  let sleepiness = 0; // 0..1
  let hoverAmt = 0; // 0..1 "I noticed you" perk-up
  let wasInside = false;
  let thinking = false; // an AI agent is working
  // Peek mode. `peekTo` is where main wants the sprite slid to; `peekAmt` eases
  // towards it so the cat walks off the edge rather than teleporting.
  let peekTo = { x: 0, y: 0 };
  let peekAmt = 0;
  let peekWanted = 0;

  let lastKey = 0;
  let keyTimes = [];
  let lastActivity = Date.now();
  let blinkNext = performance.now() + 2000;
  let blinkUntil = 0;
  let stretchUntil = 0;
  let jumpUntil = 0;
  let bubbleTimer = null;
  let lastHit = "";

  const now = () => performance.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // --- setup ---------------------------------------------------------------
  function applySettings(s) {
    S = s;
    L = s.layout;
    catX = L.catX + ((s.catOffset && s.catOffset.x) || 0);
    catY = L.catY + ((s.catOffset && s.catOffset.y) || 0);
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
  // When cursor.speed was last set by ANY source. Pointer events stop arriving
  // the moment a hand stops moving, so without this the last speed stands
  // forever: a hand resting on the cat's head would pet it indefinitely, and a
  // fast flick that ended over the cat would leave it pouncing for good.
  let speedAt = -1e9;

  window.pet.on("cursor", (c) => {
    // `exact` means the display server reported a real point. A dead-reckoned
    // one (Wayland + /dev/input) is close enough to know the mouse is MOVING and
    // nowhere near close enough to say which pixel it is on — so it is treated
    // like no position at all rather than trusted a few hundred px off, which
    // made the cat stop registering a hand resting on it 400ms after the last
    // local event and drop the pet meter mid-stroke.
    staleMode = !c.exact;
    if (typeof c.wy === "number") winY = c.wy;
    // Global movement still counts as being awake even when we cannot place it.
    if (c.speed > 2) lastActivity = Date.now();
    if (!c.exact) return; // position is an estimate; local events are all we trust
    if (now() - localAt < 400) return; // a real pointer event is more accurate
    cursor.lx = c.lx;
    cursor.ly = c.ly;
    cursor.speed = c.speed;
    speedAt = now();
  });

  window.addEventListener("mousemove", (e) => {
    const t = now();
    const lx = e.clientX;
    const ly = e.clientY;
    if (localPrev) {
      const dt = Math.max(8, t - localPrev.t);
      // normalise to per-16ms so it shares a scale with main's polled speed
      cursor.speed = (Math.hypot(lx - localPrev.x, ly - localPrev.y) / dt) * 16;
      speedAt = t;
    }
    localPrev = { x: lx, y: ly, t };
    cursor.lx = lx;
    cursor.ly = ly;
    localAt = t;
    lastActivity = Date.now();
  });

  // Without a trustworthy global cursor the last local point is all we have, and
  // it does not expire on its own: walk the pointer off the cat and the stale
  // coordinate is still sitting on it, so the cat stays perked up and purring at
  // nobody. Leaving the window means "the pointer is elsewhere", so say so.
  document.addEventListener("mouseleave", () => {
    cursor.lx = -9999;
    cursor.ly = -9999;
    cursor.speed = 0;
    localPrev = null;
    // Expire the local sample too. Parking it far off-screen without this left
    // the gaze treating (-9999,-9999) as a real target, so the cat rolled its
    // eyes hard to the top-left for the 1.8s the sample stayed "fresh".
    localAt = -1e9;
  });

  window.pet.on("key", () => {
    const t = now();
    lastKey = t;
    keyTimes.push(t);
    lastActivity = Date.now();
  });

  window.pet.on("wheel", (e) => {
    if (!S || !S.behaviours.scrollUnroll) return;
    if (peekAmt > 0.5) return; // nothing rolling across someone's video
    lastActivity = Date.now();
    // Scroll direction picks the side it rolls to. A wheel that reports no
    // rotation at all still gets a bat — whichever way it is already going.
    const rot = (e && e.rotation) || 0;
    batYarn(rot ? Math.sign(rot) : yarn.vx >= 0 ? 1 : -1);
  });

  window.pet.on("peek", ({ active, shift }) => {
    peekWanted = active ? 1 : 0;
    if (active && shift) peekTo = shift;
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

  window.pet.on("agent", ({ state, name, quiet }) => {
    if (!S || S.behaviours.agentReactions === false) return;
    // Peeking means staying out of the way of whatever is playing. Reminders
    // are the exception — they are the reason you asked for a pet — but an
    // agent finishing is not worth hopping across a film for.
    if (peekAmt > 0.5 && state !== "thinking") {
      thinking = false;
      return;
    }
    if (state === "thinking") {
      thinking = true;
      return;
    }
    thinking = false;
    // A gap main is not confident was the end of the turn: stop squinting, but
    // do not celebrate. Otherwise one answer is announced once per tool call.
    if (quiet) return;
    jumpUntil = now() + 900; // the happy hop
    say(`${name || "agent"} finished!`, "agent", 6000);
    const h = headPoint();
    for (let i = 0; i < 6; i++)
      spawn("spark", h.x + (Math.random() - 0.5) * 40, h.y, {
        colour: "#ffe9a8",
        life: 0.9,
        vy: -50 - Math.random() * 30,
      });
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
  /*
   * The cat is NOT draggable, by design — it is placed by coordinate.
   *
   * Dragging steered the window by relative pointer deltas, and near a screen
   * edge that fought the two constraints below it: the compositor clamps a window
   * that would leave the screen, and the sprite's offset inside its own window
   * (`catOffset`, what lets it reach a true edge at all) is only recomputed when
   * a position is committed. So past an invisible line the window stopped moving
   * while the cat kept a stale offset, and it visibly came unstuck from the
   * pointer. Setting X/Y goes through placeCat, which solves both together.
   */
  /*
   * Both of these ask "is the pointer on the CAT", not "is it in the window".
   *
   * The canvas fills the whole window, and the window is deliberately larger
   * than the sprite. Wherever the window has to stay interactive (any session
   * without an exact global cursor) that padding is live too, so binding these
   * to the window meant a right-click or double-click in the empty space beside
   * the cat opened its menu or its settings — from a spot that looks like
   * desktop. lastRect is the sprite's own bounds from the last frame.
   */
  const overCat = (e) =>
    !!lastRect &&
    e.clientX >= lastRect.x &&
    e.clientX <= lastRect.x + lastRect.w &&
    e.clientY >= lastRect.y &&
    e.clientY <= lastRect.y + lastRect.h;

  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (overCat(e)) window.pet.send("action", { type: "menu" });
  });
  timerEl.addEventListener("click", () => window.pet.send("action", { type: "pomodoro-toggle" }));
  cvs.addEventListener("dblclick", (e) => {
    if (overCat(e)) window.pet.send("open-settings");
  });

  // --- particles -----------------------------------------------------------
  function spawn(kind, x, y, opts = {}) {
    let vy = opts.vy ?? -30 - Math.random() * 20;
    /*
     * Almost everything the cat emits — hearts, steam, zzz, the notice-you spark
     * — spawns at its head and floats up. Sat flush against the top of the
     * screen there is no canvas above its head, so all of it rose straight out
     * of view: you could pet the cat and get no hearts, no purring cue, nothing,
     * which is indistinguishable from petting being broken. Keep the origin
     * on-canvas and send it the other way instead.
     */
    if (y < 12) {
      y = Math.max(2, y);
      if (vy < 0) vy = -vy;
    }
    particles.push({
      kind,
      x,
      y,
      vx: opts.vx ?? (Math.random() - 0.5) * 20,
      vy,
      life: opts.life ?? 1.2,
      max: opts.life ?? 1.2,
      colour: opts.colour ?? "#ffffff",
      scale: opts.scale ?? Math.max(1, (L ? L.scale : 4) * 0.5),
    });
  }

  function headPoint() {
    return {
      x: catX + A.headTop.x * L.scale,
      y: catY + A.headTop.y * L.scale,
    };
  }

  /*
   * --- the yarn ball -------------------------------------------------------
   *
   * Scrolling bats a ball of yarn along the desk. A thread unspools back to the
   * cat's paws, and when you stop scrolling the thread reels it in and it
   * settles again beside the cat.
   *
   * It is ONE ball on a spring, not a stream of particles, and that is the whole
   * idea. What this replaces spawned a paper rectangle per wheel tick and threw
   * it downward under gravity, so a long scroll buried the desk in rectangles
   * that all fell out of frame: nothing to look at on the way, nothing left
   * afterwards, and a mess in between. A single ball that comes back gives the
   * scroll somewhere to go and something to watch it do.
   *
   * The spring is also what keeps the effect on-canvas. There is only 60px of
   * padding either side of the cat, so anything launched freely is off the edge
   * within a few frames — the return trip is not decoration, it is what makes
   * the ball stay somewhere it can be seen.
   */
  const yarn = {
    on: false,
    x: 0, // canvas px, centre of the ball
    vx: 0,
    hop: 0, // height above the ground line, never negative
    hopV: 0,
    roll: 0, // accumulated rotation, in frames
    life: 0,
    fade: 0, // eases in on the first bat so it does not just appear
  };

  /*
   * Tuned against the real canvas, not by feel. Travel and settling time pull
   * against each other — a spring soft enough to let the ball run is a spring
   * too slow to reel it back before the ball fades out — and the spring constant
   * turns out to matter far less than the impulse cap and the drag. This trio
   * gets the ball right across the cat (~120px of a 248px canvas) and back to
   * rest 2.5s after the last scroll, just as it starts fading.
   */
  const YARN_LIFE = 2.6; // seconds of stillness before it is put away
  const YARN_SPRING = 4.5; // thread tension pulling it home
  const YARN_FRICTION = 3.2; // desk drag, and what stops it oscillating forever
  const YARN_BODY = "#e07a8c";
  const YARN_WRAP = "#ffd3dc";

  // Sized off the cat so the ball looks the same at every scale.
  const yarnScale = () => Math.max(2, Math.round(L.scale * 0.85));
  const yarnRadius = () => (7 * yarnScale()) / 2;

  /*
   * Where it rests: tucked against the cat's flank by the tail, clear of the
   * sprite. Parking it in front of the paws instead was tried and covers the
   * belly markings the whole time it is out — the ball is 21px and the cat only
   * 128px, so sitting on the body is not a small intrusion.
   *
   * That leaves the two directions lopsided: it is a short bump into the wall
   * one way and a long run across the cat the other. That is fine, and better
   * than the alternative — both directions being short.
   */
  const yarnHome = (cx) => cx + (CatSprites.W + 1) * L.scale;
  // The floor the ball rolls on: the cat's feet, not its paws anchor. That
  // anchor is where kneading is drawn, a good bit up the body, and a ball
  // resting there sits on the belly markings instead of on the desk.
  const yarnGround = (cy) => cy + (A.paws.y + 1.5) * L.scale;

  function batYarn(dir) {
    if (!yarn.on) {
      yarn.on = true;
      yarn.x = yarnHome(catX);
      yarn.vx = 0;
      yarn.hop = 0;
      yarn.hopV = 0;
      yarn.roll = 0;
      yarn.fade = 0;
    }
    yarn.life = YARN_LIFE;
    yarn.vx = clamp(yarn.vx + dir * 26 * L.scale, -90 * L.scale, 90 * L.scale);
    // A little hop on each bat, but only off the ground — kicking a ball that is
    // already in the air reads as it being yanked, not batted.
    if (yarn.hop <= 0.5) yarn.hopV = 40 * L.scale;
  }

  function updateYarn(dt, cx) {
    yarn.life -= dt;
    // Quick enough to read as "it was already there", slow enough not to pop.
    // A slower fade looks like the ball is arriving from somewhere, which is a
    // strange thing for an object on a desk to do.
    yarn.fade = Math.min(1, yarn.fade + dt * 12);
    if (yarn.life <= -0.5) {
      yarn.on = false;
      return;
    }

    const home = yarnHome(cx);
    yarn.vx += (home - yarn.x) * YARN_SPRING * dt;
    yarn.vx *= Math.max(0, 1 - YARN_FRICTION * dt);
    yarn.x += yarn.vx * dt;

    // The canvas edge is a wall it bounces off, rather than somewhere it can
    // vanish to. Losing the ball off the side would be the same failure as
    // throwing paper off the bottom.
    const r = yarnRadius();
    if (yarn.x < r) {
      yarn.x = r;
      yarn.vx = Math.abs(yarn.vx) * 0.45;
    } else if (yarn.x > L.width - r) {
      yarn.x = L.width - r;
      yarn.vx = -Math.abs(yarn.vx) * 0.45;
    }

    yarn.hop += yarn.hopV * dt;
    yarn.hopV -= 230 * L.scale * dt;
    if (yarn.hop <= 0) {
      yarn.hop = 0;
      // Bounce, until the bounce is too small to be worth drawing.
      yarn.hopV = yarn.hopV < -22 * L.scale ? -yarn.hopV * 0.42 : 0;
    }

    // Rotation follows distance travelled, not time, so it stops turning exactly
    // when it stops moving. Dividing by the sprite scale keeps the wrap sliding
    // at the same apparent speed however big the cat is.
    yarn.roll += (yarn.vx * dt) / (yarnScale() * 3);
  }

  function drawYarn(t, cx, cy) {
    const s = yarnScale();
    const ground = yarnGround(cy);
    const by = ground - yarnRadius() - yarn.hop;
    const alpha = yarn.fade * clamp(yarn.life / 0.5 + 1, 0, 1);

    /*
     * The thread. Drawn as a run of lattice-snapped squares rather than a
     * stroked line, because a 1px antialiased diagonal is the one thing on this
     * canvas that would look like it came from a different program.
     *
     * It sags when the ball is close and pulls straight as it gets further out,
     * which is what sells it as a thread rather than a stick.
     */
    const px = cx + A.paws.x * L.scale;
    const py = ground - L.scale;
    const dist = Math.hypot(yarn.x - px, by - py);
    const slack = 1 - clamp(dist / (L.width * 0.45), 0, 1);
    const sag = (1 + slack * 3) * L.scale;
    const wob = Math.min(3, Math.abs(yarn.vx) / (14 * L.scale)) * L.scale;
    const dot = Math.max(1, Math.round(L.scale * 0.5));

    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = YARN_BODY;
    const steps = 20;
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      const arc = Math.sin(Math.PI * u); // zero at both ends: it stays attached
      const x = px + (yarn.x - px) * u;
      const y = py + (by - py) * u + arc * (sag + Math.sin(u * 7 - t / 90) * wob);
      ctx.fillRect(Math.round(x / dot) * dot, Math.round(y / dot) * dot, dot, dot);
    }
    ctx.globalAlpha = 1;

    cat.drawYarn(ctx, yarn.x, by, s, yarn.roll, YARN_BODY, YARN_WRAP, alpha);
  }

  // --- loop ----------------------------------------------------------------
  let last = now();

  function frame() {
    requestAnimationFrame(frame);
    if (!S || !L) return;

    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;

    // A pointer that has stopped reporting has stopped moving. On a platform
    // with a real global cursor this never fires — main resends at 60Hz — so it
    // only covers the case where local events are the only source.
    if (t - speedAt > 90) cursor.speed = 0;

    // Ease into and out of hiding. The sprite is simply drawn past the end of
    // its own canvas; the clipping is what makes it look like it has slipped
    // off the screen edge.
    peekAmt += (peekWanted - peekAmt) * Math.min(1, dt * 3.5);
    if (Math.abs(peekWanted - peekAmt) < 0.002) peekAmt = peekWanted;
    const peekX = peekTo.x * peekAmt;
    const peekY = peekTo.y * peekAmt;
    const hiding = peekAmt > 0.5;

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
    const cx = catX + peekX + A.head.x * L.scale;
    const cy = catY + peekY + A.head.y * L.scale;
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

    // Hover: simply being noticed is its own reaction. Without this the cat
    // ignores you until you wiggle the mouse on exactly the right pixels,
    // which reads as broken rather than aloof.
    hoverAmt = clamp(hoverAmt + (inside ? dt * 5 : -dt * 3), 0, 1);
    if (inside && !wasInside) {
      const h = headPoint();
      spawn("spark", h.x + 18, h.y - 2, { colour: "#ffe9a8", life: 0.7, vy: -28 });
      lastActivity = Date.now();
    }
    wasInside = inside;

    // Petting: anywhere on the upper half counts as the head, and the movement
    // threshold is low — a slow deliberate stroke should register, and it did
    // not when the bar was set at a brisk flick.
    const overHead = inside && cursor.ly < catY + peekY + 18 * L.scale;
    if (S.behaviours.petting && overHead && cursor.speed > 0.5) {
      petMeter = clamp(petMeter + dt * 1.8, 0, 1);
      lastActivity = Date.now();
    } else {
      petMeter = clamp(petMeter - dt * 0.5, 0, 1);
    }
    const purring = petMeter > 0.45;
    if (purring && Math.random() < dt * 6) {
      const h = headPoint();
      spawn("heart", h.x + (Math.random() - 0.5) * 26, h.y, { colour: "#f2708a", life: 1.1 });
    }

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
    if (thinking) lids = Math.max(lids, 0.5); // squinting at the problem
    // Being hovered wakes it up: a cat you are actively touching should not
    // keep its sleepy half-lids.
    if (hoverAmt > 0.4 && t >= blinkUntil && !purring) lids = 0;

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

    let squashX = 1;
    let squashY = 1;

    if (t < stretchUntil) {
      const p = 1 - (stretchUntil - t) / 1400;
      const e = Math.sin(p * Math.PI); // ease in and back out
      squashY += e * 0.42;
      squashX -= e * 0.16;
    }
    // hover: sit up a little straighter when noticed
    squashY += hoverAmt * 0.05;
    squashX -= hoverAmt * 0.02;

    // breathing, but only when otherwise still
    const calm = 1 - Math.max(petMeter, hoverAmt);
    squashY += Math.sin(t / 620) * 0.018 * calm;

    // position offsets
    let ox = 0;
    let oy = 0;
    if (t < jumpUntil) {
      const p = 1 - (jumpUntil - t) / 700;
      oy -= Math.abs(Math.sin(p * Math.PI * 2)) * 26;
    }
    if (typing && S.behaviours.kneading) oy += Math.sin(t / 70) * 1.5;
    oy -= hoverAmt * 3;

    const mouth = heat > 0.6 ? "open" : purring || hoverAmt > 0.5 ? "smile" : "neutral";

    /*
     * --- yarn ball ---
     * Stepped before the cat is drawn, because the cat leans after it and that
     * lean has to be in the render call. The ball itself is drawn afterwards —
     * see below for why.
     */
    const yarnCx = catX + ox + peekX;
    if (yarn.on) {
      if (hiding) {
        yarn.on = false; // put it away rather than leave it rolling alone
      } else {
        updateYarn(dt, yarnCx);
        // The cat leans after it. Small on purpose: this is a glance, not a pounce.
        ox += clamp((yarn.x - yarnHome(yarnCx)) * 0.05, -2.5, 2.5);
      }
    }

    const hit = cat.render(ctx, {
      x: catX + ox + peekX,
      y: catY + oy + peekY,
      scale: L.scale,
      eye,
      lids,
      mouth,
      tint: heat,
      squashX,
      squashY,
      knead: typing && S.behaviours.kneading ? (t % 320) / 320 : null,
    });

    /*
     * The ball goes ON TOP of the cat, which sounds wrong and is not. It sits on
     * the paw line, not at head height, so the only thing it ever crosses is the
     * cat's front feet — and a ball in front of the feet is exactly where a ball
     * on a desk is.
     *
     * Drawing it behind was tried first and is much worse. The cat is 128px of
     * opaque sprite and the canvas only has 60px of padding either side, so
     * rolling inward put the ball behind the body and it simply disappeared for
     * most of the roll: half the effect, invisible.
     */
    if (yarn.on && !hiding) drawYarn(t, yarnCx, catY + oy + peekY);

    // --- thinking indicator ---
    // Three dots cycling above the head while an agent works. Drawn with a
    // dark plate behind each dot so it stays legible on a light desktop as
    // well as a dark one — the cat can be sitting on anything.
    if (thinking) {
      const h = headPoint();
      const s = Math.max(3, Math.round(L.scale * 1.4));
      const step = Math.floor(t / 260) % 4;
      // Same problem the speech bubble has: flush against the top of the screen,
      // "above the head" is off-screen. Drop them under the cat instead.
      const above = Math.round(h.y - s * 6);
      const below = Math.round(catY + peekY + CatSprites.H * L.scale + s);
      for (let i = 0; i < 3; i++) {
        const x = Math.round(h.x - s * 4 + i * s * 3) + ox;
        const y = (above >= 0 ? above : below) + oy;
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#14141a";
        ctx.fillRect(x - 1, y - 1, s + 2, s + 2);
        ctx.globalAlpha = step === i ? 1 : 0.35;
        ctx.fillStyle = "#f4efe6";
        ctx.fillRect(x, y, s, s);
      }
      ctx.globalAlpha = 1;
    }

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

    // Pin the bubble above the cat's head — unless the window is against the
    // top of the screen, in which case "above" is off-screen and the bubble
    // would simply never be seen. Snapping the cat flush to the top edge makes
    // that a normal position, not an edge case.
    const flip = winY < 12;
    bubbleEl.classList.toggle("below", flip);
    // Centred on the cat, but nudged back inside when the cat is flush against a
    // screen edge — out there half the bubble hangs outside its own window and
    // is simply clipped away, which ate the right-hand half of every message.
    const half = (bubbleEl.offsetWidth || 0) / 2;
    bubbleEl.style.left = `${clamp(catX + peekX + (CatSprites.W * L.scale) / 2 + ox, half + 2, L.width - half - 2)}px`;
    bubbleEl.style.top = flip
      ? `${catY + peekY + CatSprites.H * L.scale + oy - 4}px`
      : `${catY + peekY + oy - 6}px`;
  }

  requestAnimationFrame(frame);
})();
