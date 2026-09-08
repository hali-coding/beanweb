/*
 * Mushroom Command -- a BeanWeb package.
 *
 * Missile Command played over a mushroom bed. Spores fall out of the night
 * onto six patches you are defending; the counter-spores you fire bloom into
 * mushroom caps, and a cap kills whatever it touches. The arcade original's
 * explosions were already mushroom clouds -- this only takes the joke at its
 * word.
 *
 * Plain ES2020 in one file with no build step: a package is whatever is in
 * the zip, and the browser runs this as it stands. Everything it can reach
 * goes through `window.bw`; docs/packages.md is the whole API.
 *
 * Two things this frame cannot do, both on purpose:
 *
 *   - `alert()`, `confirm()` and `prompt()` are blocked. The iframe is
 *     sandboxed with `allow-scripts` and nothing else, so there is no
 *     `allow-modals`. The title card, the wave tally and the game-over screen
 *     are therefore drawn on the canvas rather than asked for -- which is
 *     what a game wants anyway.
 *   - `fetch()` never leaves. The document carries `connect-src 'none'`, so
 *     there is no leaderboard here and there cannot be one.
 *
 * The only thing it persists is the high score, one small text file in its
 * own folder. That is the whole of what the `fs` permission is asked for.
 */

/** Inside /boot/home/packages/<id>/, the only place we may write. */
const STORE = 'scores.txt'

/* --- the field ----------------------------------------------------------
 *
 * One fixed logical field, scaled to whatever the window is. Everything below
 * is in these coordinates and nothing in the game knows the window's size --
 * the only place pixels and field units meet is `layout()`.
 */

const W = 480
const H = 300
const GROUND_Y = 268

const PATCH_X = [75, 120, 165, 315, 360, 405]
const BATTERY_X = [40, 240, 440]
const AMMO = 12

const SHOT_SPEED = 330
const BLOOM_GROW = 46
/*
 * A cap fades slower than it grows, which is most of what makes the game
 * forgiving: a shot fired a little early is still open when the spore
 * arrives. Widening the cap and slowing the fade is a gentler dial than
 * slowing the spores, because it rewards aim rather than hiding the miss.
 */
const BLOOM_FADE = 26
const BLOOM_MAX = 30

/*
 * A game is a play surface, not chrome: like Tetris and Bean Challenge in
 * BeanWeb proper, it keeps a palette of its own instead of the R5 panel ramp.
 * The bar above it does not -- that part is chrome and is grey.
 */
const C = {
  sky: '#0b1020',
  star: '#3d4468',
  ground: '#243318',
  groundLip: '#3c5327',
  cap: '#d4382f',
  capDark: '#96231d',
  spot: '#f2ede0',
  stalk: '#e8dfc6',
  rubble: '#4a4034',
  spore: '#e07be0',
  sporeTrail: '#7a3a7a',
  shot: '#8ef2c0',
  shotTrail: '#2f6b52',
  enemyCap: '#e8a33c',
  enemySpot: '#4a2c10',
  aim: '#8ef2c0',
  text: '#d8dce8',
  dim: '#8890a8',
}

const rand = (a, b) => a + Math.random() * (b - a)
const randInt = (n) => Math.floor(Math.random() * n)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/* --- markup and style ---------------------------------------------------
 *
 * The frame is a bare document with none of BeanWeb's CSS in it, so a package
 * draws its own chrome. These greys are the R5 panel ramp; the real ones and
 * the tint_color() arithmetic behind them are in src/styles/tokens.css.
 */

document.body.innerHTML = [
  '<div class="bar">',
  '  <button id="new">New Game</button>',
  '  <button id="pause">Pause</button>',
  '  <span class="stat">Score <b id="score">0</b></span>',
  '  <span class="stat">Wave <b id="wave">1</b></span>',
  '  <span class="stat high">Best <b id="high">0</b></span>',
  '</div>',
  '<div class="stage" id="stage"><canvas id="field" tabindex="0"></canvas></div>',
].join('')

const style = document.createElement('style')
style.textContent = `
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; overflow: hidden;
       font: 12px/15px system-ui, sans-serif; color: #000; background: #d8d8d8; }
.bar { display: flex; align-items: center; gap: 8px; padding: 5px 8px;
       border-bottom: 1px solid #979797; flex: none; }
.stat { color: #565656; white-space: nowrap; }
.stat b { color: #000; font-weight: bold; font-variant-numeric: tabular-nums; }
.high { margin-left: auto; }
button { font: inherit; padding: 2px 12px; background: #d8d8d8; color: #000;
         border: 1px solid #979797; border-radius: 3px;
         box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #b0b0b0; }
button:active { box-shadow: inset 1px 1px 0 #b0b0b0; }
button:focus-visible { outline: 2px solid #0000e5; outline-offset: 1px; }
.stage { flex: 1; min-height: 0; background: ${C.sky}; touch-action: none; }
canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
canvas:focus { outline: none; }
canvas:focus-visible { outline: 2px solid #0000e5; outline-offset: -2px; }
`
document.head.appendChild(style)

const el = (id) => document.getElementById(id)
const stage = el('stage')
const canvas = el('field')
const ctx = canvas.getContext('2d')

/* --- the canvas -----------------------------------------------------------
 *
 * The field is letterboxed in JavaScript rather than with `aspect-ratio`, for
 * the reason BeanWeb's own BASIC screen does it: CSS cannot letterbox against
 * both axes without the used width collapsing, and flex then quietly shrinks
 * the frame back. Measure the stage and do the arithmetic.
 */

const view = { scale: 1, offX: 0, offY: 0 }

function layout() {
  const dpr = window.devicePixelRatio || 1
  const cssW = stage.clientWidth
  const cssH = stage.clientHeight
  if (!cssW || !cssH) return
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  view.scale = Math.min(cssW / W, cssH / H)
  view.offX = (cssW - W * view.scale) / 2
  view.offY = (cssH - H * view.scale) / 2
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** A pointer position in field units. The scroll offset is already in `rect`. */
function toField(ev) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: clamp((ev.clientX - rect.left - view.offX) / view.scale, 0, W),
    y: clamp((ev.clientY - rect.top - view.offY) / view.scale, 0, GROUND_Y - 4),
  }
}

/* --- the game -------------------------------------------------------------
 *
 * One plain object rebuilt by `newGame`, mutated by `step`, read by `render`.
 * No state lives anywhere else, so restarting is one assignment and there is
 * nothing to leak between games.
 */

let game = newGame()
let high = 0

function newGame() {
  const g = {
    state: 'title', // 'title' | 'playing' | 'between' | 'over'
    best: false, // beat the stored high score; the game-over card reads it
    paused: false,
    score: 0,
    wave: 0,
    mult: 1,
    patches: PATCH_X.map((x) => ({ x, alive: true })),
    batteries: BATTERY_X.map((x) => ({ x, ammo: AMMO, alive: true })),
    spores: [],
    shots: [],
    blooms: [],
    sparks: [],
    pending: 0,
    dropIn: 0,
    speed: 18,
    splits: 0,
    bonusAt: 5000,
    carrot: null,
    carrotIn: rand(6, 14),
    tally: [],
    aim: { x: W / 2, y: 150 },
    stars: Array.from({ length: 60 }, () => ({
      x: rand(0, W),
      y: rand(0, GROUND_Y - 30),
      r: rand(0.3, 0.9),
    })),
  }
  return g
}

/** Everything a spore is willing to fall on. */
function targets() {
  const live = game.patches.filter((p) => p.alive).map((p) => p.x)
  const guns = game.batteries.filter((b) => b.alive).map((b) => b.x)
  return live.concat(guns)
}

function startWave(n) {
  game.wave = n
  game.mult = Math.min(6, 1 + Math.floor((n - 1) / 2))
  game.pending = Math.min(24, 7 + Math.round(n * 1.6))
  game.dropIn = 0.6
  game.speed = Math.min(52, 18 + n * 2.5)
  game.splits = n >= 4 ? 1 : 0
  for (const b of game.batteries) {
    b.ammo = AMMO
    b.alive = true
  }
  game.spores.length = 0
  game.shots.length = 0
  game.blooms.length = 0
  game.sparks.length = 0
  game.state = 'playing'
}

function launchSpore(x0, y0, splits) {
  const list = targets()
  if (!list.length) return
  const tx = clamp(list[randInt(list.length)] + rand(-7, 7), 4, W - 4)
  const ty = GROUND_Y
  const d = Math.hypot(tx - x0, ty - y0) || 1
  const sp = game.speed * rand(0.85, 1.15)
  game.spores.push({
    x: x0,
    y: y0,
    sx: x0,
    sy: y0,
    vx: ((tx - x0) / d) * sp,
    vy: ((ty - y0) / d) * sp,
    ty,
    splits,
    splitY: splits > 0 ? rand(50, 130) : -1,
  })
}

/**
 * Fire from the battery nearest the target that still has ammo, or from the
 * one named by the 1/2/3 keys. Returns false when nothing could fire, which
 * is what the "no ammo" flash is drawn from.
 */
function fire(tx, ty, forced) {
  let pick = null
  if (forced != null) {
    const b = game.batteries[forced]
    if (b && b.alive && b.ammo > 0) pick = b
  } else {
    for (const b of game.batteries) {
      if (!b.alive || b.ammo <= 0) continue
      if (!pick || Math.abs(b.x - tx) < Math.abs(pick.x - tx)) pick = b
    }
  }
  if (!pick) return false

  pick.ammo--
  const x0 = pick.x
  const y0 = GROUND_Y - 8
  const d = Math.hypot(tx - x0, ty - y0) || 1
  game.shots.push({
    x: x0,
    y: y0,
    sx: x0,
    sy: y0,
    tx,
    ty,
    vx: ((tx - x0) / d) * SHOT_SPEED,
    vy: ((ty - y0) / d) * SHOT_SPEED,
    left: d / SHOT_SPEED,
  })
  return true
}

/*
 * A carrot crosses the sky now and then, and that is the whole of it: nothing
 * shoots it, it shoots nothing, and no rule in the game reads it. It is here
 * because a night sky with only ordnance in it is a poorer sky, and because
 * something moving that you do not have to deal with is restful. Deliberately
 * outside the wave-clear test below -- a decoration that could hold a wave
 * open would stop being a decoration.
 */
function spawnCarrot() {
  const dir = Math.random() < 0.5 ? 1 : -1
  game.carrot = {
    x: dir > 0 ? -20 : W + 20,
    y: rand(28, 140),
    dir,
    speed: rand(34, 58),
    bob: rand(0, Math.PI * 2),
    tilt: rand(-0.12, 0.12),
  }
}

function stepCarrot(dt) {
  const c = game.carrot
  if (!c) {
    if (game.state !== 'playing') return
    game.carrotIn -= dt
    if (game.carrotIn <= 0) spawnCarrot()
    return
  }
  c.x += c.speed * c.dir * dt
  c.bob += dt * 2
  if (c.x < -30 || c.x > W + 30) {
    game.carrot = null
    game.carrotIn = rand(12, 26)
  }
}

function drawCarrot(c) {
  ctx.save()
  ctx.translate(c.x, c.y + Math.sin(c.bob) * 3)
  ctx.scale(c.dir, 1)
  ctx.rotate(c.tilt)

  ctx.fillStyle = '#3f8f36'
  for (const a of [-0.55, -0.05, 0.45]) {
    ctx.save()
    ctx.rotate(a)
    ctx.beginPath()
    ctx.moveTo(-6, 0)
    ctx.quadraticCurveTo(-11, -1.6, -15, 0)
    ctx.quadraticCurveTo(-11, 1.6, -6, 0)
    ctx.fill()
    ctx.restore()
  }

  ctx.fillStyle = '#e0812c'
  ctx.beginPath()
  ctx.moveTo(-6, -4)
  ctx.quadraticCurveTo(4, -3, 11, 0)
  ctx.quadraticCurveTo(4, 3, -6, 4)
  ctx.quadraticCurveTo(-8, 0, -6, -4)
  ctx.fill()

  ctx.strokeStyle = '#a8551a'
  ctx.lineWidth = 0.7
  for (const x of [-2.5, 1, 4.5]) {
    ctx.beginPath()
    ctx.moveTo(x, -2.6)
    ctx.lineTo(x + 1.2, 2.6)
    ctx.stroke()
  }
  ctx.restore()
}

function bloom(x, y, max, kind) {
  game.blooms.push({ x, y, r: 1, max, grow: true, kind })
}

function spark(x, y, colour, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2)
    const s = rand(20, 70)
    game.sparks.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 20,
      life: rand(0.3, 0.8),
      colour,
    })
  }
}

/** A spore has landed: bloom, and flatten whatever stood under it. */
function impact(x) {
  bloom(x, GROUND_Y, 24, 'enemy')
  spark(x, GROUND_Y, C.enemyCap, 10)
  for (const p of game.patches) {
    if (p.alive && Math.abs(p.x - x) < 18) p.alive = false
  }
  for (const b of game.batteries) {
    if (b.alive && Math.abs(b.x - x) < 18) {
      b.alive = false
      b.ammo = 0
    }
  }
}

function step(dt) {
  if (game.paused) return

  const playing = game.state === 'playing'

  if (playing && game.pending > 0) {
    game.dropIn -= dt
    if (game.dropIn <= 0) {
      launchSpore(rand(10, W - 10), 0, game.splits)
      game.pending--
      game.dropIn = rand(0.6, 1.7) * Math.max(0.45, 1 - game.wave * 0.04)
    }
  }

  for (let i = game.spores.length - 1; i >= 0; i--) {
    const s = game.spores[i]
    s.x += s.vx * dt
    s.y += s.vy * dt

    // MIRV: one spore becomes several, from the point it split at.
    if (s.splits > 0 && s.y >= s.splitY) {
      s.splits = 0
      for (let k = 0; k < 1 + randInt(2); k++) launchSpore(s.x, s.y, 0)
    }

    if (s.y >= s.ty) {
      impact(s.x)
      game.spores.splice(i, 1)
    }
  }

  for (let i = game.shots.length - 1; i >= 0; i--) {
    const s = game.shots[i]
    s.left -= dt
    if (s.left <= 0) {
      bloom(s.tx, s.ty, BLOOM_MAX, 'player')
      game.shots.splice(i, 1)
    } else {
      s.x += s.vx * dt
      s.y += s.vy * dt
    }
  }

  for (let i = game.blooms.length - 1; i >= 0; i--) {
    const b = game.blooms[i]
    b.r += (b.grow ? BLOOM_GROW : -BLOOM_FADE) * dt
    if (b.grow && b.r >= b.max) b.grow = false
    if (!b.grow && b.r <= 0) {
      game.blooms.splice(i, 1)
      continue
    }
    // A cap kills what it touches, and what it kills blooms in turn -- the
    // chain reaction is most of what makes a good wave feel good.
    for (let k = game.spores.length - 1; k >= 0; k--) {
      const s = game.spores[k]
      if (Math.hypot(s.x - b.x, s.y - b.y) > b.r) continue
      game.spores.splice(k, 1)
      if (playing) score(25 * game.mult)
      spark(s.x, s.y, C.spore, 6)
      bloom(s.x, s.y, 20, 'chain')
    }
  }

  stepCarrot(dt)

  for (let i = game.sparks.length - 1; i >= 0; i--) {
    const p = game.sparks[i]
    p.life -= dt
    if (p.life <= 0) {
      game.sparks.splice(i, 1)
      continue
    }
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vy += 120 * dt
  }

  if (playing && !game.pending && !game.spores.length && !game.shots.length && !game.blooms.length) {
    endWave()
  }
}

function score(n) {
  game.score += n
  el('score').textContent = String(game.score)
}

function endWave() {
  const ammo = game.batteries.reduce((n, b) => n + (b.alive ? b.ammo : 0), 0)
  const alive = game.patches.filter((p) => p.alive).length
  const lines = [
    ['Unused spores', ammo, 5 * game.mult],
    ['Patches standing', alive, 100 * game.mult],
  ]
  for (const [, count, each] of lines) score(count * each)

  // A patch grows back every 5000 points, if there is a gap for it. Classic
  // Missile Command's bonus city, and the only way back from a bad wave.
  let regrown = false
  if (game.score >= game.bonusAt) {
    game.bonusAt += 5000
    const gone = game.patches.find((p) => !p.alive)
    if (gone) {
      gone.alive = true
      regrown = true
    }
  }

  game.tally = lines.map(([label, count, each]) => `${label}  ${count} x ${each} = ${count * each}`)
  if (regrown) game.tally.push('A patch has grown back.')

  if (!alive) {
    game.state = 'over'
    finish()
  } else {
    game.state = 'between'
  }
}

function advance() {
  if (game.state === 'title') {
    startWave(1)
  } else if (game.state === 'between') {
    startWave(game.wave + 1)
  } else if (game.state === 'over') {
    restart()
    return
  }
  paintBar()
}

/* --- rendering ----------------------------------------------------------- */

function drawMushroom(x, y, r, cap, spot, stalk) {
  ctx.fillStyle = stalk
  ctx.fillRect(x - r * 0.2, y - r * 0.15, r * 0.4, r * 0.8)
  ctx.fillStyle = cap
  ctx.beginPath()
  ctx.ellipse(x, y, r, r * 0.8, 0, Math.PI, 0)
  ctx.fill()
  ctx.fillStyle = spot
  const spots = [
    [-0.45, -0.28, 0.16],
    [0.12, -0.46, 0.19],
    [0.5, -0.16, 0.13],
  ]
  for (const [dx, dy, dr] of spots) {
    ctx.beginPath()
    ctx.arc(x + dx * r, y + dy * r, dr * r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Every missile draws the line it has flown, which is the arcade's own look. */
function trail(m, colour) {
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(m.sx, m.sy)
  ctx.lineTo(m.x, m.y)
  ctx.stroke()
}

function banner(title, lines) {
  ctx.fillStyle = 'rgba(6, 9, 20, 0.78)'
  ctx.fillRect(0, 0, W, GROUND_Y)
  ctx.textAlign = 'center'
  ctx.fillStyle = C.cap
  ctx.font = 'bold 22px ui-monospace, monospace'
  ctx.fillText(title, W / 2, 96)
  ctx.font = '11px ui-monospace, monospace'
  lines.forEach((line, i) => {
    ctx.fillStyle = i === lines.length - 1 ? C.aim : C.text
    ctx.fillText(line, W / 2, 128 + i * 17)
  })
  ctx.textAlign = 'left'
}

function render() {
  const cssW = stage.clientWidth
  const cssH = stage.clientHeight
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cssW, cssH)
  ctx.translate(view.offX, view.offY)
  ctx.scale(view.scale, view.scale)
  ctx.beginPath()
  ctx.rect(0, 0, W, H)
  ctx.clip()

  ctx.fillStyle = C.sky
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = C.star
  for (const s of game.stars) {
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }

  if (game.carrot) drawCarrot(game.carrot)

  ctx.fillStyle = C.ground
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y)
  ctx.fillStyle = C.groundLip
  ctx.fillRect(0, GROUND_Y, W, 2)

  for (const p of game.patches) {
    if (p.alive) {
      drawMushroom(p.x, GROUND_Y - 4, 11, C.cap, C.spot, C.stalk)
      drawMushroom(p.x - 9, GROUND_Y - 2, 6, C.capDark, C.spot, C.stalk)
    } else {
      ctx.fillStyle = C.rubble
      ctx.fillRect(p.x - 11, GROUND_Y - 3, 22, 3)
      ctx.fillRect(p.x - 5, GROUND_Y - 6, 7, 3)
    }
  }

  game.batteries.forEach((b) => {
    ctx.fillStyle = b.alive ? C.groundLip : C.rubble
    ctx.beginPath()
    ctx.moveTo(b.x - 16, GROUND_Y)
    ctx.lineTo(b.x - 10, GROUND_Y - 9)
    ctx.lineTo(b.x + 10, GROUND_Y - 9)
    ctx.lineTo(b.x + 16, GROUND_Y)
    ctx.closePath()
    ctx.fill()
    if (!b.alive) return
    // Ammunition, one pip per counter-spore, in two rows of five.
    for (let i = 0; i < b.ammo; i++) {
      const col = i % 5
      const row = Math.floor(i / 5)
      ctx.fillStyle = C.shot
      ctx.beginPath()
      ctx.arc(b.x - 8 + col * 4, GROUND_Y - 13 - row * 4, 1.4, 0, Math.PI * 2)
      ctx.fill()
    }
  })

  for (const s of game.spores) {
    trail(s, C.sporeTrail)
    ctx.fillStyle = C.spore
    ctx.beginPath()
    ctx.arc(s.x, s.y, 2, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const s of game.shots) {
    trail(s, C.shotTrail)
    ctx.fillStyle = C.shot
    ctx.beginPath()
    ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = C.shot
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(s.tx - 3, s.ty)
    ctx.lineTo(s.tx + 3, s.ty)
    ctx.moveTo(s.tx, s.ty - 3)
    ctx.lineTo(s.tx, s.ty + 3)
    ctx.stroke()
  }

  for (const b of game.blooms) {
    const enemy = b.kind === 'enemy'
    ctx.globalAlpha = b.grow ? 1 : Math.max(0.2, b.r / b.max)
    drawMushroom(
      b.x,
      b.y,
      Math.max(1, b.r),
      enemy ? C.enemyCap : C.cap,
      enemy ? C.enemySpot : C.spot,
      enemy ? C.enemySpot : C.stalk,
    )
    ctx.globalAlpha = 1
  }

  for (const p of game.sparks) {
    ctx.globalAlpha = clamp(p.life * 2, 0, 1)
    ctx.fillStyle = p.colour
    ctx.fillRect(p.x - 0.7, p.y - 0.7, 1.4, 1.4)
  }
  ctx.globalAlpha = 1

  if (game.state === 'playing' && !game.paused) {
    const a = game.aim
    ctx.strokeStyle = C.aim
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(a.x, a.y, 5, 0, Math.PI * 2)
    ctx.moveTo(a.x - 9, a.y)
    ctx.lineTo(a.x - 2, a.y)
    ctx.moveTo(a.x + 2, a.y)
    ctx.lineTo(a.x + 9, a.y)
    ctx.moveTo(a.x, a.y - 9)
    ctx.lineTo(a.x, a.y - 2)
    ctx.moveTo(a.x, a.y + 2)
    ctx.lineTo(a.x, a.y + 9)
    ctx.stroke()
  }

  if (game.state === 'title') {
    banner('MUSHROOM COMMAND', [
      'Spores are falling on the patch.',
      'Click to bloom a cap where you click; anything',
      'it touches is done for. Keys 1 2 3 pick a gun,',
      'arrows and space aim by hand, P pauses.',
      '',
      'Click or press space to start',
    ])
  } else if (game.state === 'between') {
    banner(`WAVE ${game.wave} CLEARED`, game.tally.concat(['', 'Click or press space for the next wave']))
  } else if (game.state === 'over') {
    banner('THE PATCH IS FLAT', [
      `Score ${game.score}`,
      game.best ? 'A new best.' : `Best ${high}`,
      '',
      'Click or press space to play again',
    ])
  } else if (game.paused) {
    banner('PAUSED', ['Click or press P to carry on'])
  }

  ctx.restore()
}

/* --- input --------------------------------------------------------------- */

function shootAt(pt) {
  game.aim.x = pt.x
  game.aim.y = pt.y
  if (game.state !== 'playing' || game.paused) return
  if (!fire(pt.x, pt.y, null)) spark(pt.x, pt.y, C.dim, 4)
}

canvas.addEventListener('pointermove', (ev) => {
  const pt = toField(ev)
  game.aim.x = pt.x
  game.aim.y = pt.y
})

canvas.addEventListener('pointerdown', (ev) => {
  /*
   * Click-to-focus, the same shape BeanWeb's own Terminal needs: `.focus()`
   * from a pointerdown is undone by the browser's default action, so it takes
   * the preventDefault as well. Getting this wrong is quiet -- the mouse keeps
   * firing and every key silently stops working, because a click that focuses
   * nothing inside the frame leaves the *frame itself* unfocused and the
   * keydown goes to the desktop instead. Which is why the canvas is
   * `tabindex="0"` and this runs before anything else.
   */
  ev.preventDefault()
  canvas.focus()
  if (game.state !== 'playing') {
    advance()
    return
  }
  if (game.paused) {
    setPaused(false)
    return
  }
  shootAt(toField(ev))
})

window.addEventListener('keydown', (ev) => {
  const k = ev.key
  // R5 used Alt where other systems use Ctrl, and BeanWeb keeps that.
  if (ev.altKey && k.toLowerCase() === 'n') {
    ev.preventDefault()
    restart()
    return
  }
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return

  const nudge = ev.shiftKey ? 16 : 6
  if (k === 'ArrowLeft') game.aim.x = clamp(game.aim.x - nudge, 0, W)
  else if (k === 'ArrowRight') game.aim.x = clamp(game.aim.x + nudge, 0, W)
  else if (k === 'ArrowUp') game.aim.y = clamp(game.aim.y - nudge, 0, GROUND_Y - 4)
  else if (k === 'ArrowDown') game.aim.y = clamp(game.aim.y + nudge, 0, GROUND_Y - 4)
  else if (k === ' ' || k === 'Enter') {
    if (game.state !== 'playing') advance()
    else if (game.paused) setPaused(false)
    else shootAt(game.aim)
  } else if (k === '1' || k === '2' || k === '3') {
    if (game.state === 'playing' && !game.paused) fire(game.aim.x, game.aim.y, Number(k) - 1)
  } else if (k.toLowerCase() === 'p' || k === 'Escape') {
    setPaused(!game.paused)
  } else {
    return
  }
  ev.preventDefault()
})

el('new').addEventListener('click', restart)
el('pause').addEventListener('click', () => setPaused(!game.paused))

function setPaused(on) {
  if (game.state !== 'playing') return
  game.paused = on
  paintBar()
}

function restart() {
  game = newGame()
  startWave(1)
  score(0)
  paintBar()
}

function paintBar() {
  el('score').textContent = String(game.score)
  el('wave').textContent = String(Math.max(1, game.wave))
  el('high').textContent = String(high)
  el('pause').disabled = game.state !== 'playing'
  el('pause').textContent = game.paused ? 'Resume' : 'Pause'
}

/* --- the high score -------------------------------------------------------
 *
 * A relative path is resolved inside the package folder and refused if it
 * lands anywhere else, so `../` buys nothing here. It is written as text
 * rather than JSON so the file reads as itself in StyledEdit.
 */

async function loadHigh() {
  try {
    const text = await bw.fs.read(STORE)
    const found = text && /high\s+(\d+)/.exec(text)
    if (found) high = Number(found[1])
  } catch (err) {
    // A missing file reads as null; anything else is worth saying once, but
    // never at the cost of the game starting.
    high = 0
  }
  paintBar()
}

async function finish() {
  if (game.score <= high) return
  high = game.score
  game.best = true
  paintBar()
  try {
    await bw.fs.write(STORE, `Mushroom Command\nhigh ${high}\nwave ${game.wave}\n`)
  } catch (err) {
    await bw.alert(`Could not save the high score.\n\n${(err && err.message) || err}`, 'stop')
  }
}

/* --- boot ---------------------------------------------------------------- */

let last = 0
function frame(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  step(dt)
  render()
  requestAnimationFrame(frame)
}

async function boot() {
  /*
   * `ready` is the first call every package makes. It names the package, the
   * folder it may write to, and the document it was opened on -- null here,
   * since this one claims no file type.
   */
  await bw.ready()
  await bw.setTitle('Mushroom Command')

  layout()
  canvas.focus()
  if (window.ResizeObserver) new ResizeObserver(layout).observe(stage)
  window.addEventListener('resize', layout)

  await loadHigh()
  paintBar()
  requestAnimationFrame(frame)
}

boot().catch((err) => {
  document.body.textContent = String((err && err.message) || err)
})
