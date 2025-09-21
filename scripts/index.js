const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const GV = window.GameValues;
let hudColor = '#eee';
let catcherColor = '#fff';

// Player (folder)
let catcher = { x: 230, y: 560, w: 60, h: 25, speed: GV.player.baseSpeed };

// Falling objects
let objects = [];
let score = 0;
let highScore = parseInt(localStorage.getItem('vatAttackHighScore') || '0', 10);
let lives = 3;
let keys = {};
let gameRunning = true;
let spawnTimerId = null;
let rafId = null;
let currentTheme = localStorage.getItem('vatAttackTheme') || 'light';
let gameState = 'start'; // start | playing | paused | over

// Difficulty state
const baseCatcherSpeed = GV.player.baseSpeed;
const baseSpawnInterval = GV.spawn.baseInterval;
let currentDifficultyLevel = 0;
let currentSpawnInterval = baseSpawnInterval;


// VATIT letter collection (V, A, T, I, T)
const vatitOrder = ['v','a','t','i','t'];
let nextVatitIndex = 0; // which letter to spawn next
let collectedVatitCount = 0; // how many letters collected towards combo (0..5)

// Quick canvas flash effect (on special pickups)
const FLASH_DURATION_MS = GV.flash.durationMs;
let flashEndAt = 0;
/** Start a short screen flash overlay */
function startFlash() {
  flashEndAt = performance.now() + FLASH_DURATION_MS;
}

// Bonus text flicker when completing VATIT
const BONUS_FLASH_MS = GV.bonus.durationMs;
let bonusEndAt = 0;
/** Trigger the center "BONUS!" flicker */
function triggerBonusFlash() {
  bonusEndAt = performance.now() + BONUS_FLASH_MS;
}

// Final score counting animation for Game Over popup
const FINAL_COUNT_MS = GV.final.countMs;
let finalCountRafId = null;
/** Stop any active final score animation */
function cancelFinalCountAnim() {
  if (finalCountRafId) { cancelAnimationFrame(finalCountRafId); finalCountRafId = null; }
}
/** Animate the Game Over "Final VAT Reclaimed" value up to target */
function animateFinalCount(toValue) {
  cancelFinalCountAnim();
  const finalEl = document.getElementById('overlay-final');
  if (!finalEl) return;
  const startTimeRef = { t: 0 };
  const step = (ts) => {
    if (!startTimeRef.t) startTimeRef.t = ts;
    const e = Math.min(1, (ts - startTimeRef.t) / FINAL_COUNT_MS);
    const val = Math.floor(e * toValue);
    finalEl.textContent = 'Final VAT Reclaimed: €' + val;
    if (e < 1) finalCountRafId = requestAnimationFrame(step);
    else finalCountRafId = null;
  };
  finalEl.textContent = 'Final VAT Reclaimed: €0';
  finalCountRafId = requestAnimationFrame(step);
}

// In-game HUD score count-up (1s) when score increases
const SCORE_ANIM_MS = GV.hud.scoreAnimMs;
let scoreAnimStart = 0;
let scoreAnimFrom = 0;
let scoreAnimTo = 0;
/** Interpolated HUD score value for smooth count-up */
function getDisplayedScore(nowTs) {
  if (scoreAnimStart === 0 || scoreAnimTo <= scoreAnimFrom) return score;
  const e = (nowTs - scoreAnimStart) / SCORE_ANIM_MS;
  if (e >= 1) { scoreAnimStart = 0; scoreAnimFrom = scoreAnimTo; return scoreAnimTo; }
  return Math.floor(scoreAnimFrom + e * (scoreAnimTo - scoreAnimFrom));
}
/** Add to score and start/extend the HUD animation */
function addScore(delta) {
  const now = performance.now();
  const currentDisplayed = getDisplayedScore(now);
  score += delta;
  scoreAnimFrom = currentDisplayed;
  scoreAnimTo = score;
  scoreAnimStart = now;
}

// Temporary invulnerability after missing an invoice (scales with difficulty)
const BASE_INVUL_MS = GV.player.invulMs;
let invulEndAt = 0;
/** Begin temporary invulnerability; duration shrinks with difficulty */
function startInvul() {
  const dur = Math.max(500, Math.round(BASE_INVUL_MS / difficultyMultiplier()));
  invulEndAt = performance.now() + dur;
}
function isInvul() { return performance.now() < invulEndAt; }

// --------------------
// Utils
// --------------------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function chance(p) { return Math.random() < p; }

/** Difficulty multiplier based on score (10% per 2000 points) */
function difficultyMultiplier() {
  return 1 + GV.difficulty.stepPerLevel * currentDifficultyLevel;
}

/** Apply current difficulty to player speed and spawn interval */
function applyDifficulty() {
  const mult = difficultyMultiplier();
  catcher.speed = baseCatcherSpeed * mult;
  const desired = Math.max(GV.spawn.minInterval, Math.round(baseSpawnInterval / mult));
  if (desired !== currentSpawnInterval) {
    currentSpawnInterval = desired;
    if (spawnTimerId) { clearInterval(spawnTimerId); spawnTimerId = null; }
    spawnTimerId = setInterval(spawnObject, currentSpawnInterval);
  }
}

/** Step difficulty when crossing each 2000-point threshold */
function recomputeDifficulty() {
  const newLevel = Math.floor(score / GV.difficulty.pointsPerLevel);
  if (newLevel !== currentDifficultyLevel) {
    currentDifficultyLevel = newLevel;
    applyDifficulty();
  }
}

// Sprite images — single base SVG per sprite (tinted at draw time)
let assets = {};
function createSpriteSet(theme) {
  // We load the light variant as the single base; we tint to theme color when drawing.
  const make = (name) => { const img = new Image(); img.src = `sprites/${name}.svg`; return img; };
  return {
    invoice: make('invoice'),
    fraud: make('fraud'),
    audit: make('audit'),
    deadlineFuel: make('deadlineFuel'),
    catcher: make('catcher'),
    controls: make('controls'),
    // Letter sprites
    v: make('v'),
    a: make('a'),
    t: make('t'),
    i: make('i'),
  };
}

// Offscreen tint helper: uses image alpha as mask and fills with color
function drawTintedSprite(ctx, img, x, y, w, h, color) {
  const off = drawTintedSprite._off || (drawTintedSprite._off = document.createElement('canvas'));
  const offCtx = drawTintedSprite._offCtx || (drawTintedSprite._offCtx = off.getContext('2d'));
  off.width = w; off.height = h;
  offCtx.clearRect(0, 0, w, h);
  offCtx.drawImage(img, 0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-in';
  offCtx.fillStyle = color;
  offCtx.fillRect(0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(off, x, y);
}

/** Tint sprite using theme: gradient in light, solid hudColor in dark */
function drawTintedSpriteThemed(ctx, img, x, y, w, h) {
  const off = drawTintedSprite._off || (drawTintedSprite._off = document.createElement('canvas'));
  const offCtx = drawTintedSprite._offCtx || (drawTintedSprite._offCtx = off.getContext('2d'));
  off.width = w; off.height = h;
  offCtx.clearRect(0, 0, w, h);
  offCtx.drawImage(img, 0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-in';
  if (currentTheme === 'light' && window.GameValues && window.GameValues.colors) {
    const g = offCtx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, window.GameValues.colors.accentStart);
    g.addColorStop(1, window.GameValues.colors.accentEnd);
    offCtx.fillStyle = g;
  } else {
    offCtx.fillStyle = hudColor;
  }
  offCtx.fillRect(0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(off, x, y);
}

// Theme helpers
function refreshThemeColors() {
  const styles = getComputedStyle(document.body);
  hudColor = styles.getPropertyValue('--fg').trim() || '#fff';
  catcherColor = hudColor;
}
function applyTheme(theme) {
  currentTheme = theme;
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('vatAttackTheme', theme);
  refreshThemeColors();
  assets = createSpriteSet(theme);
}

// Redraw overlay icon (Game Over) to reflect current theme color
function redrawOverlayIcon() {
  const overlay = document.getElementById('overlay');
  if (!overlay) return;
  const mode = overlay.getAttribute('data-mode');
  if (mode !== 'over') return;
  const msgEl = document.getElementById('overlay-message');
  const iconCanvas = document.getElementById('overlay-icon');
  if (!msgEl || !iconCanvas) return;
  const message = msgEl.textContent || '';
  const iconCtx = iconCanvas.getContext('2d');
  iconCtx.clearRect(0, 0, iconCanvas.width, iconCanvas.height);
  iconCanvas.classList.add('hidden');
  iconCanvas.style.display = 'none';
  let iconImg = null;
  if (/Fraudulent Claim/i.test(message)) iconImg = assets.fraud;
  else if (/Missed an Audit Notice/i.test(message)) iconImg = assets.audit;
  else if (/Too Many Missed Claims/i.test(message)) iconImg = assets.invoice;
  if (!iconImg) return;
  const draw = () => {
    if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
      drawTintedSpriteThemed(iconCtx, iconImg, 0, 0, iconCanvas.width, iconCanvas.height);
      iconCanvas.classList.remove('hidden');
      iconCanvas.style.display = 'block';
    }
  };
  if (iconImg.complete && iconImg.naturalWidth > 0) draw();
  else iconImg.addEventListener('load', draw, { once: true });
}

// Build the START overlay message with actual icons per line
function renderStartMessage() {
  const msgEl = document.getElementById('overlay-message');
  if (!msgEl) return;
  // Clear existing content
  msgEl.innerHTML = '';

  const fg = hudColor;

  const lines = [
    { img: () => assets.invoice, text: 'Gotta cath all \'em Invoices!' },
    { img: () => assets.fraud, text: 'Avoid fraudulent claims' },
    { img: () => assets.audit, text: 'Don\'t miss audit notices' },
    { img: () => assets.deadlineFuel, text: 'Dealine Fuel saves lives' },
  ];

  const makeLine = (getImg, text, parent = msgEl) => {
    const row = document.createElement('div');
    row.className = 'start-line';
    const can = document.createElement('canvas');
    can.width = 24; can.height = 24;
    can.className = 'icon-canvas';
    row.appendChild(can);
    const label = document.createElement('span');
    label.textContent = text;
    row.appendChild(label);
    parent.appendChild(row);

    const img = getImg();
    const draw = () => {
      const c2 = can.getContext('2d');
      c2.clearRect(0, 0, can.width, can.height);
      if (img && img.complete && img.naturalWidth > 0) {
            drawTintedSpriteThemed(c2, img, 0, 0, can.width, can.height);
      }
    };
    if (img) {
      if (img.complete && img.naturalWidth > 0) draw();
      else img.addEventListener('load', draw, { once: true });
    }
  };

  // Controls block first
  const controlsWrap = document.createElement('div');
  controlsWrap.className = 'start-block';
  msgEl.appendChild(controlsWrap);
  makeLine(() => assets.controls, 'Use A ← → D to move', controlsWrap);
  makeLine(() => assets.controls, 'Use [SPACE] to pause', controlsWrap);

  // Separator, then rules lines
  const sep = document.createElement('div');
  sep.className = 'start-sep';
  msgEl.appendChild(sep);
  lines.forEach(l => makeLine(l.img, l.text));
}

// Keyboard
document.addEventListener("keydown", e => { keys[e.code] = true; });
document.addEventListener("keyup", e => keys[e.code] = false);

function spawnObject() {
  if (!gameRunning) return;
  // Determine how many to spawn this tick based on difficulty multiplier
  const mult = difficultyMultiplier();
  // Expected count ~= 1 * mult. Spawn base + probabilistic extra for fractional part.
  let expected = mult;
  let count = 1 + Math.floor(expected);
  if (Math.random() < (expected - Math.floor(expected))) count += 1;

  // Helper to check if an audit is already present
  const auditOnScreen = () => objects.some(o => o.type === 'audit');

  // Compute dynamic probabilities for each drop
  const computeSpawnProbabilities = () => {
    // Base probabilities
    const pFuel = 0.10;
    const pVatit = 0.05;
    const baseAudit = 0.10;
    const baseFraud = 0.10;
    // Scale audit and fraud up by +5% per difficulty level (relative to base)
    const level = currentDifficultyLevel;
    const pAudit = Math.min(GV.probabilities.auditFraudCap, baseAudit * (1 + GV.probabilities.auditFraudScalePerLevel * level));
    const pFraud = Math.min(GV.probabilities.auditFraudCap, baseFraud * (1 + GV.probabilities.auditFraudScalePerLevel * level));
    // Invoice absorbs remaining probability
    let pInvoice = 1 - (pFuel + pVatit + pAudit + pFraud);
    pInvoice = Math.max(GV.probabilities.invoiceMin, pInvoice);
    // Normalize in case of clamping pushing sum > 1
    const sum = pInvoice + pFuel + pAudit + pFraud + pVatit;
    return {
      invoice: pInvoice / sum,
      deadlineFuel: pFuel / sum,
      audit: pAudit / sum,
      fraud: pFraud / sum,
      vatit: pVatit / sum
    };
  };

  const chooseType = () => {
    const { invoice: nInvoice, deadlineFuel: nFuel, audit: nAudit, fraud: nFraud, vatit: nVatit } = computeSpawnProbabilities();
    const r = Math.random();
    const t1 = nInvoice;
    const t2 = t1 + nFuel;
    const t3 = t2 + nAudit;
    const t4 = t3 + nFraud;
    if (r < t1) return 'invoice';
    if (r < t2) return 'deadlineFuel';
    if (r < t3) return 'audit';
    if (r < t4) return 'fraud';
    return 'vatit';
  };

  const spawnOne = () => {
    let type = chooseType();
    // Enforce max 1 audit on screen at a time
    if (type === 'audit' && auditOnScreen()) {
      type = 'invoice';
    }
    const obj = {
      x: Math.random() * GV.spawnArea.width,
      y: -20,
      w: 40, h: 40,
      speed: GV.spawn.fallSpeedMin + Math.random() * GV.spawn.fallSpeedRange,
      type
    };
    // Zig-zag chance scales with difficulty
    const zigChance = Math.min(GV.spawn.zigzagCap, GV.spawn.zigzagBase + GV.spawn.zigzagPerLevel * currentDifficultyLevel);
    if (chance(zigChance)) {
      obj.zigzag = true;
      obj.zdir = Math.random() < 0.5 ? -1 : 1;
      obj.zspeed = 1 + Math.random() * 1.5;
    }
    if (type === 'vatit') {
      obj.letter = vatitOrder[nextVatitIndex];
      nextVatitIndex = (nextVatitIndex + 1) % vatitOrder.length;
    }
    objects.push(obj);
  };

  for (let i = 0; i < count; i++) spawnOne();
}

// Update game state
/** Main game loop: move, collide, draw, schedule next frame */
function update() {
  if (!gameRunning) return;

  // Move catcher
  if (keys["ArrowLeft"] || keys["KeyA"]) catcher.x -= catcher.speed;
  if (keys["ArrowRight"] || keys["KeyD"]) catcher.x += catcher.speed;
  catcher.x = Math.max(0, Math.min(canvas.width - catcher.w, catcher.x));

  // Move objects
  objects.forEach(o => {
    if (o.zigzag) {
      o.x += o.zspeed * o.zdir;
      if (o.x <= 0) { o.x = 0; o.zdir = 1; }
      else if (o.x >= canvas.width - o.w) { o.x = canvas.width - o.w; o.zdir = -1; }
    }
    o.y += o.speed;
  });

  // Collision detection
  let gameOverReason = null; // 'audit' | 'fraud' | null
  objects = objects.filter(o => {
    // Out of bounds
    if (o.y > canvas.height) {
      if (o.type === "invoice") {
        if (!isInvul()) {
          lives--;
          if (lives > 0) startInvul();
        }
      }
      if (o.type === "audit") {
        if (!isInvul()) {
          lives -= 3;
          if (lives <= 0) gameOverReason = 'audit';
        }
      }
      // deadlineFuel falling off-screen has no penalty
      return false;
    }
    // Catch check
    if (o.x < catcher.x+catcher.w && o.x+o.w > catcher.x &&
        o.y < catcher.y+catcher.h && o.y+o.h > catcher.y) {
      if (o.type === "invoice") addScore(100);
      else if (o.type === "fraud") {
        if (!isInvul()) {
          lives -= 3;
          if (lives <= 0) gameOverReason = 'fraud';
        }
      }
      else if (o.type === "audit") addScore(500);
      else if (o.type === "deadlineFuel") {
        lives += 1; // restore one life when collected
        // no flash for deadline fuel pickups
      } else if (o.type === 'vatit') {
        // Collect VATIT letter (progress combo regardless of pickup order)
        collectedVatitCount = Math.min(5, collectedVatitCount + 1);
        lives += 1; // gain a life from VATIT pickup
        addScore(1000);
        if (collectedVatitCount >= 5) {
          addScore(10000); // bonus for completing VATIT
          collectedVatitCount = 0;
          triggerBonusFlash();
        }
        startFlash();
      }
      return false;
    }
    return true;
  });

  // Lives check
  if (lives <= 0) {
    if (gameOverReason === 'audit') endGame("Missed an Audit Notice!");
    else if (gameOverReason === 'fraud') endGame("Filed a Fraudulent Claim!");
    else endGame("Too Many Missed Claims!");
  }

  // Ramp difficulty as score crosses thresholds
  if (gameRunning) recomputeDifficulty();

  // If the game ended during this update, stop drawing the normal scene
  if (!gameRunning) return;

  // Draw
  ctx.clearRect(0,0,canvas.width,canvas.height);

  drawCatcher();

  // Objects
  objects.forEach(o => {
    const img = (o.type === 'vatit') ? assets[o.letter] : assets[o.type];
    if (img && img.complete && img.naturalWidth > 0) {
      drawTintedSpriteThemed(ctx, img, o.x, o.y, o.w, o.h);
    } else {
      // minimal fallback: draw a box until image loads
      ctx.strokeStyle = hudColor;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }
  });

  drawHUD();

  drawFlashOverlay();
  drawBonusOverlay();

  // Draw collected VATIT letters (top-right), always in VATIT order
  if (collectedVatitCount > 0) {
    const size = 20;
    const gap = 4;
    const totalW = collectedVatitCount * (size + gap) - gap;
    let x = canvas.width - 10 - totalW;
    const y = 10;
    for (let i = 0; i < collectedVatitCount; i++) {
      const letterKey = vatitOrder[i];
      const img = assets[letterKey];
      if (img && img.complete && img.naturalWidth > 0) {
        drawTintedSpriteThemed(ctx, img, x, y, size, size);
      } else {
        ctx.strokeStyle = hudColor;
        ctx.strokeRect(x, y, size, size);
      }
      x += size + gap;
    }
  }

  rafId = requestAnimationFrame(update);
}

// --------------------
// Drawing helpers
// --------------------
function drawCatcher() {
  // Catcher (draw tinted sprite) with invulnerability flicker
  const invulActive = isInvul();
  const showCatcher = !invulActive || ((Math.floor(performance.now() / 100) % 2) === 0);
  if (!showCatcher) return;
  if (assets.catcher && assets.catcher.complete && assets.catcher.naturalWidth > 0) {
    drawTintedSpriteThemed(ctx, assets.catcher, catcher.x, catcher.y, catcher.w, catcher.h);
  } else {
    // fallback if image not loaded yet
    ctx.fillStyle = catcherColor;
    ctx.fillRect(catcher.x, catcher.y, catcher.w, catcher.h);
  }
}

function hudGradient() {
  const g = ctx.createLinearGradient(0, 0, canvas.width, 0);
  g.addColorStop(0, window.GameValues.colors.accentStart);
  g.addColorStop(1, window.GameValues.colors.accentEnd);
  return g;
}

function drawHUD() {
  ctx.fillStyle = (currentTheme === 'light') ? hudGradient() : hudColor;
  ctx.font = window.GameValues.hud.font;
  const dispScore = getDisplayedScore(performance.now());
  ctx.fillText("VAT Reclaimed: €" + dispScore, 10, 20);
  ctx.fillText("Lives: " + lives, 10, 40);
}

function drawFlashOverlay() {
  if (flashEndAt <= 0) return;
  const now = performance.now();
  const remaining = flashEndAt - now;
  if (remaining > 0) {
    const ratio = Math.max(0, Math.min(1, remaining / FLASH_DURATION_MS));
    const alpha = window.GameValues.flash.maxAlpha * ratio;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = hudColor; // opposite of bg
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  } else {
    flashEndAt = 0;
  }
}

function drawBonusOverlay() {
  if (bonusEndAt <= 0) return;
  const now = performance.now();
  const remaining = bonusEndAt - now;
  if (remaining > 0) {
    const on = (Math.floor(now / window.GameValues.bonus.flickerMs) % 2) === 0;
    if (!on) return;
    ctx.save();
    ctx.fillStyle = (currentTheme === 'light') ? hudGradient() : hudColor;
    ctx.font = window.GameValues.bonus.font;
    const text = window.GameValues.bonus.text;
    const w = ctx.measureText(text).width;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height / 2);
    ctx.fillText(text, x, y);
    ctx.restore();
  } else {
    bonusEndAt = 0;
  }
}

// End game
function endGame(message) {
  gameRunning = false;
  // Ensure HUD reflects final lives immediately
  lives = Math.max(0, lives);
  ctx.clearRect(0, 0, 230, 50);
  ctx.fillStyle = (currentTheme === 'light') ? hudGradient() : hudColor;
  ctx.font = window.GameValues.hud.font;
  ctx.fillText("VAT Reclaimed: €" + score, 10, 20);
  ctx.fillText("Lives: " + lives, 10, 40);

  // Show centered DOM overlay popup
  const overlay = document.getElementById("overlay");
  const msgEl = document.getElementById("overlay-message");
  const finalEl = document.getElementById("overlay-final");
  const highEl = document.getElementById("overlay-high");
  const titleEl = overlay.querySelector('.title');
  const modalEl = overlay.querySelector('.modal');
  const startBtn = document.getElementById('start-game');
  const againBtn = document.getElementById('play-again');
  const resumeBtn = document.getElementById('resume-game');
  const iconCanvas = document.getElementById('overlay-icon');
  msgEl.textContent = message;
  // Animate final VAT reclaimed count-up
  animateFinalCount(score);
  // Hide the start-only separator above final on non-start overlays
  const finalSepHide = document.getElementById('final-sep');
  if (finalSepHide) finalSepHide.style.display = 'none';
  const sepAfterTitleHide = document.getElementById('sep-after-title');
  if (sepAfterTitleHide) sepAfterTitleHide.style.display = 'none';
  const sepAfterHighHide = document.getElementById('sep-after-high');
  if (sepAfterHighHide) sepAfterHighHide.style.display = 'none';
  // Show relevant icon for Game Over reason
  if (iconCanvas) {
    const iconCtx = iconCanvas.getContext('2d');
    iconCtx.clearRect(0, 0, iconCanvas.width, iconCanvas.height);
    iconCanvas.classList.add('hidden');
    iconCanvas.style.display = 'none';
    let iconImg = null;
    if (/Fraudulent Claim/i.test(message)) iconImg = assets.fraud;
    else if (/Missed an Audit Notice/i.test(message)) iconImg = assets.audit;
    else if (/Too Many Missed Claims/i.test(message)) iconImg = assets.invoice;
    if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
      drawTintedSpriteThemed(iconCtx, iconImg, 0, 0, iconCanvas.width, iconCanvas.height);
      iconCanvas.classList.remove('hidden');
      iconCanvas.style.display = 'block';
    }
  }
  // Update and persist high score
  const isNewHigh = score > highScore;
  if (isNewHigh) {
    highScore = score;
    localStorage.setItem('vatAttackHighScore', String(highScore));
  }
  if (highEl) highEl.textContent = isNewHigh ? ('New High Score: €' + highScore) : ('High Score: €' + highScore);
  if (highEl) highEl.classList.toggle('new-high', isNewHigh);
  overlay.style.display = "flex";
  gameState = 'over';
  overlay.setAttribute('data-mode','over');
  // Configure for GAME OVER state
  titleEl.textContent = 'GAME OVER';
  titleEl.style.color = 'var(--fg)';
  startBtn.classList.add('hidden');
  againBtn.classList.remove('hidden');
  if (resumeBtn) resumeBtn.classList.add('hidden');

  // Stop timers/loops to avoid stale updates
  if (spawnTimerId) { clearInterval(spawnTimerId); spawnTimerId = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  // Clear bottom status so nothing shows beneath the canvas
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.innerText = "";
}

// Reset and restart the game
function resetGame() {
  // Reset state
  score = 0;
  lives = 3;
  objects = [];
  catcher.x = (canvas.width - catcher.w) / 2;
  keys = {};
  // Reset VATIT combo state
  collectedVatitCount = 0;
  nextVatitIndex = 0;
  bonusEndAt = 0;
  flashEndAt = 0;
  cancelFinalCountAnim();
  // Reset HUD score animation
  scoreAnimStart = 0; scoreAnimFrom = 0; scoreAnimTo = 0;

  // Hide overlay and restart loop
  document.getElementById("overlay").style.display = "none";
  startGame();
}

// Wire up Play Again button
// Boot UI, apply theme, and wire event handlers
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-game');
  const againBtn = document.getElementById('play-again');
  const resumeBtn = document.getElementById('resume-game');
  const overlay = document.getElementById('overlay');
  const titleEl = overlay.querySelector('.title');
  const modalEl = overlay.querySelector('.modal');
  const msgEl = document.getElementById('overlay-message');
  const finalEl = document.getElementById('overlay-final');
  const highEl = document.getElementById('overlay-high');
  const themeToggle = document.getElementById('theme-toggle');
  const iconCanvas = document.getElementById('overlay-icon');

  applyTheme(currentTheme);
  ctx.imageSmoothingEnabled = false;

  overlay.style.display = 'flex';
  overlay.setAttribute('data-mode','start');
  titleEl.textContent = 'VAT ATTACK!';
  titleEl.style.color = 'var(--fg)';
  // Insert separator after title, then move high score under it
  let sepAfterTitle = document.getElementById('sep-after-title');
  if (!sepAfterTitle) {
    sepAfterTitle = document.createElement('div');
    sepAfterTitle.id = 'sep-after-title';
    sepAfterTitle.className = 'start-sep';
    modalEl.insertBefore(sepAfterTitle, document.getElementById('overlay-message'));
  }
  sepAfterTitle.style.display = 'block';

  // Move High Score just beneath the title separator
  if (highEl) {
    modalEl.insertBefore(highEl, document.getElementById('overlay-message'));
    highEl.textContent = 'High Score: €' + highScore;
    highEl.classList.remove('new-high');
  }

  // Separator between High Score and the controls/rules block
  let sepAfterHigh = document.getElementById('sep-after-high');
  if (!sepAfterHigh) {
    sepAfterHigh = document.createElement('div');
    sepAfterHigh.id = 'sep-after-high';
    sepAfterHigh.className = 'start-sep';
    modalEl.insertBefore(sepAfterHigh, document.getElementById('overlay-message'));
  }
  sepAfterHigh.style.display = 'block';

  // Populate message with controls then rules
  renderStartMessage();
  finalEl.textContent = 'Press Start or Space to begin';
  // Add a separator above the final line (start screen)
  let finalSep = document.getElementById('final-sep');
  if (!finalSep) {
    finalSep = document.createElement('div');
    finalSep.id = 'final-sep';
    finalSep.className = 'start-sep';
    if (finalEl && finalEl.parentNode) finalEl.parentNode.insertBefore(finalSep, finalEl);
  }
  if (finalSep) finalSep.style.display = 'block';
  startBtn.classList.remove('hidden');
  againBtn.classList.add('hidden');
  resumeBtn.classList.add('hidden');
  if (modalEl) modalEl.classList.remove('new-high');
  if (iconCanvas) { iconCanvas.classList.add('hidden'); iconCanvas.style.display = 'none'; }

  // Buttons: start, play again, resume, toggle theme
  if (startBtn) startBtn.addEventListener('click', resetGame);
  if (againBtn) againBtn.addEventListener('click', resetGame);
  if (resumeBtn) resumeBtn.addEventListener('click', () => resumeGame());
  if (themeToggle) themeToggle.addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    const mode = overlay.getAttribute('data-mode');
    if (mode === 'start') renderStartMessage();
    else if (mode === 'over') redrawOverlayIcon();
  });

  // Overlay key handling: start/resume/restart via Space/Enter
  document.addEventListener('keydown', (e) => {
    const overlayShown = overlay.style.display === 'flex';
    const mode = overlay.getAttribute('data-mode');
    if (!overlayShown) return;
    if (mode === 'start' && e.code === 'Space') {
      e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      resetGame();
    } else if (mode === 'over' && (e.code === 'Enter' || e.code === 'Space')) {
      resetGame();
    } else if (mode === 'paused' && e.code === 'Space') {
      e.preventDefault();
      // Prevent the global Space key handler from firing after we hide the overlay
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      resumeGame();
    }
  });

  // Click on backdrop to start
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target.id !== 'overlay') return;
    const mode = overlay.getAttribute('data-mode');
    if (mode === 'start') resetGame();
  });

  // Global Space toggles pause when overlay hidden
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const overlayShown = overlay.style.display === 'flex';
    if (overlayShown) return;
    e.preventDefault();
    if (gameRunning) pauseGame();
  });
});

/** Initialize timers and start the main loop */
function startGame() {
  if (spawnTimerId) { clearInterval(spawnTimerId); spawnTimerId = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  gameRunning = true;
  gameState = 'playing';

  // Set difficulty from current score (e.g., after reset score=0)
  currentDifficultyLevel = Math.floor(score / 2000);
  currentSpawnInterval = baseSpawnInterval;
  applyDifficulty();
  if (!spawnTimerId) spawnTimerId = setInterval(spawnObject, currentSpawnInterval);
  update();
}

/** Show pause overlay and stop timers */
function pauseGame() {
  if (!gameRunning) return;
  gameRunning = false;
  gameState = 'paused';
  if (spawnTimerId) { clearInterval(spawnTimerId); spawnTimerId = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  const overlay = document.getElementById('overlay');
  const titleEl = overlay.querySelector('.title');
  const modalEl = overlay.querySelector('.modal');
  const msgEl = document.getElementById('overlay-message');
  const finalEl = document.getElementById('overlay-final');
  const highEl = document.getElementById('overlay-high');
  const startBtn = document.getElementById('start-game');
  const againBtn = document.getElementById('play-again');
  const resumeBtn = document.getElementById('resume-game');

  overlay.style.display = 'flex';
  overlay.setAttribute('data-mode','paused');
  titleEl.textContent = 'Paused';
  titleEl.style.color = 'var(--fg)';
  msgEl.textContent = '';
  finalEl.textContent = 'Press Space to resume';
  const finalSepHide2 = document.getElementById('final-sep');
  if (finalSepHide2) finalSepHide2.style.display = 'none';
  const sepAfterTitleHide2 = document.getElementById('sep-after-title');
  if (sepAfterTitleHide2) sepAfterTitleHide2.style.display = 'none';
  const sepAfterHighHide2 = document.getElementById('sep-after-high');
  if (sepAfterHighHide2) sepAfterHighHide2.style.display = 'none';
  if (highEl) highEl.textContent = 'High Score: €' + highScore;
  startBtn.classList.add('hidden');
  againBtn.classList.add('hidden');
  resumeBtn.classList.remove('hidden');
  if (highEl) highEl.classList.remove('new-high');
  const iconCanvas = document.getElementById('overlay-icon');
  if (iconCanvas) { iconCanvas.classList.add('hidden'); iconCanvas.style.display = 'none'; }
}

/** Hide overlay and resume gameplay */
function resumeGame() {
  const overlay = document.getElementById('overlay');
  overlay.style.display = 'none';
  cancelFinalCountAnim();
  startGame();
}
