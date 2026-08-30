import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MenuBar } from '@/widgets/Menu'
import type { MenuDef, MenuItem } from '@/widgets/Menu'
import { Button } from '@/widgets/controls'
import { BeanChallengeIcon } from '@/lib/icons'
import { useDesktop } from '@/store/desktop'
import {
  BOOT_KINDS,
  TICK_MS,
  Tile,
  drawEntity,
  drawTile,
  hintFor,
  packOrDefault,
  resumeIndex,
  markComplete,
  readProgress,
  setCurrent,
  startLevel,
  step,
  furthestUnlocked,
  VOID,
  type Dir,
  type Game,
  type Status,
} from '@/lib/beanchallenge'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './beanchallenge.css'

/**
 * Bean Challenge: a tile puzzle in the spirit of Chip's Challenge.
 *
 * The rules are in `lib/beanchallenge/engine.ts` and are pure -- this file is
 * the clock and the picture. `step` is synchronous and the view paces it, the
 * same division `shell/Shutdown.tsx` uses; the interval below is the only timer
 * in the game.
 *
 * React never re-renders per tick. The live `Game` lives in a ref, the interval
 * advances it, and a `requestAnimationFrame` loop blits when `version` moves.
 * Only the handful of values the panel shows are mirrored into state, and only
 * when one of them actually changes. Same rule as the window drag, the Claude
 * token stream and the BASIC screen.
 */

/** Tiles across the visible window, and the pixel size each is drawn at. */
const VIEW = 9
const TILE = 32
const CANVAS = VIEW * TILE

/** The inventory strip: four keys over four boots. */
const SLOT = 26
const SLOT_COLS = 4

const KEY_TILES = [Tile.KeyRed, Tile.KeyGreen, Tile.KeyYellow, Tile.KeyCyan]
const BOOT_TILES = [Tile.Flippers, Tile.FireBoots, Tile.Skates, Tile.Suction]

const KEY_BY_CODE: Record<string, Dir> = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
}

const OVER: Record<Status, string> = {
  playing: '',
  complete: 'Level complete',
  drowned: 'You drowned',
  burned: 'You burned up',
  caught: 'Something caught you',
  exploded: 'The bomb got you',
  timeout: 'Out of time',
}

/** The values the panel shows. Everything else about the game stays in the ref. */
interface Hud {
  index: number
  beansLeft: number
  beansTotal: number
  time: number
  status: Status
  hint: string | null
  keys: number[]
  boots: boolean[]
}

const hudOf = (g: Game, index: number): Hud => ({
  index,
  beansLeft: g.beansLeft,
  beansTotal: g.beansTotal,
  time: g.timeLeft,
  status: g.status,
  hint: hintFor(g),
  keys: [...g.keys],
  boots: BOOT_KINDS.map((kind) => g.boots[kind]),
})

const sameHud = (a: Hud, b: Hud): boolean =>
  a.index === b.index &&
  a.beansLeft === b.beansLeft &&
  a.time === b.time &&
  a.status === b.status &&
  a.hint === b.hint &&
  a.keys.every((n, i) => n === b.keys[i]) &&
  a.boots.every((n, i) => n === b.boots[i])

/** Top-left of the visible window, centring a level smaller than the viewport. */
const camera = (at: number, size: number): number => {
  if (size <= VIEW) return Math.floor((size - VIEW) / 2)
  return Math.max(0, Math.min(at - Math.floor(VIEW / 2), size - VIEW))
}

export function BeanChallenge({ windowId, args }: AppProps) {
  const pack = useMemo(() => packOrDefault(args?.pack), [args?.pack])

  const [index, setIndex] = useState(() => {
    const progress = readProgress()
    const wanted = args?.level ? pack.levels.findIndex((l) => l.id === args.level) : -1
    return wanted >= 0 ? wanted : resumeIndex(pack, progress)
  })
  const level = pack.levels[index] ?? pack.levels[0]

  const gameRef = useRef<Game>(startLevel(level))
  const [hud, setHud] = useState<Hud>(() => hudOf(gameRef.current, index))
  const [paused, setPaused] = useState(false)
  const [unlocked, setUnlocked] = useState(() => furthestUnlocked(pack, readProgress()))

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  /** The direction being asked for: a fresh tap wins over a held key. */
  const heldRef = useRef<Dir | null>(null)
  const tapRef = useRef<Dir | null>(null)

  const requestClose = useDesktop((s) => s.requestClose)
  const isActive = useDesktop((s) => s.activeId === windowId)

  /* ------------------------------------------------------------ level moves */

  /**
   * Where the player is, written straight to the DOM node rather than held in
   * state -- walking changes nothing the panel shows, so putting it in state
   * would cost a reconciliation five times a second for no visible reason. It
   * is also the only way a test can see the board: jsdom has no canvas, so the
   * picture itself cannot be read back.
   */
  const markPosition = useCallback((g: Game) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.dataset.x = String(g.player.x)
    canvas.dataset.y = String(g.player.y)
  }, [])

  const load = useCallback(
    (next: number) => {
      const target = pack.levels[next]
      if (!target) return
      gameRef.current = startLevel(target)
      heldRef.current = null
      tapRef.current = null
      setIndex(next)
      setPaused(false)
      setHud(hudOf(gameRef.current, next))
      setCurrent(pack.id, target.id)
      // Restarting the level already open leaves `index` unchanged, so the
      // effect that publishes the square would not run. Publish it here.
      markPosition(gameRef.current)
    },
    [markPosition, pack],
  )

  const restart = useCallback(() => load(index), [index, load])

  useEffect(() => {
    setCurrent(pack.id, level.id)
  }, [level.id, pack.id])

  /* ------------------------------------------------------------------ clock */

  useEffect(() => {
    markPosition(gameRef.current)
  }, [index, markPosition])

  useEffect(() => {
    if (paused || hud.status !== 'playing') return
    const id = setInterval(() => {
      const before = gameRef.current
      const input = tapRef.current ?? heldRef.current
      const after = step(before, input)
      gameRef.current = after
      // The player moves on odd ticks; a tap is spent as soon as one lands.
      if (after.ticks % 2 === 1) tapRef.current = null
      markPosition(after)

      const next = hudOf(after, index)
      setHud((current) => (sameHud(current, next) ? current : next))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [paused, hud.status, index, markPosition])

  // Finishing unlocks the next level, and does it once.
  useEffect(() => {
    if (hud.status !== 'complete') return
    const progress = markComplete(pack.id, level.id)
    setUnlocked(furthestUnlocked(pack, progress))
  }, [hud.status, level.id, pack])

  /* --------------------------------------------------------------- painting */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // jsdom has no canvas. Bailing out here is what lets the rest of the
    // component -- menus, panel, keys -- be tested at all.
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = CANVAS
    canvas.height = CANVAS

    let raf = 0
    let painted = -1

    const fit = () => {
      const frame = frameRef.current
      const stage = frame?.parentElement
      if (!frame || !stage) return
      // clientWidth counts the stage's own padding, so measuring with it
      // oversizes the frame and flex quietly shrinks it back -- squashing the
      // board by however much padding there was. Same trap as BasicScreen.
      const pad = getComputedStyle(stage)
      const availW = stage.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
      const availH = stage.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
      const side = Math.floor(Math.max(0, Math.min(availW, availH)))
      if (side <= 0) return
      frame.style.width = `${side}px`
      frame.style.height = `${side}px`
    }

    const paint = () => {
      raf = requestAnimationFrame(paint)
      const g = gameRef.current
      if (g.version === painted) return
      painted = g.version

      const camX = camera(g.player.x, g.w)
      const camY = camera(g.player.y, g.h)

      ctx.fillStyle = VOID
      ctx.fillRect(0, 0, CANVAS, CANVAS)

      for (let vy = 0; vy < VIEW; vy += 1) {
        for (let vx = 0; vx < VIEW; vx += 1) {
          const x = camX + vx
          const y = camY + vy
          if (x < 0 || x >= g.w || y < 0 || y >= g.h) continue
          drawTile(ctx, g.terrain[y * g.w + x], vx * TILE, vy * TILE, TILE)
        }
      }

      const place = (x: number, y: number) => [(x - camX) * TILE, (y - camY) * TILE] as const
      const onScreen = (x: number, y: number) =>
        x >= camX && x < camX + VIEW && y >= camY && y < camY + VIEW

      for (const block of g.blocks) {
        if (!onScreen(block.x, block.y)) continue
        const [px, py] = place(block.x, block.y)
        drawEntity(ctx, 'block', px, py, TILE)
      }
      for (const monster of g.monsters) {
        if (!onScreen(monster.x, monster.y)) continue
        const [px, py] = place(monster.x, monster.y)
        drawEntity(ctx, monster.kind, px, py, TILE, monster.dir)
      }
      if (onScreen(g.player.x, g.player.y)) {
        const [px, py] = place(g.player.x, g.player.y)
        drawEntity(ctx, 'player', px, py, TILE, g.player.dir)
      }
    }

    // Resizing the window is not a repaint, so it needs its own signal.
    const stage = frameRef.current?.parentElement
    const observer = stage ? new ResizeObserver(fit) : null
    if (stage && observer) observer.observe(stage)
    fit()

    raf = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [])

  /* ------------------------------------------------------- inventory strip */

  const stripRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = stripRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = SLOT * SLOT_COLS
    canvas.height = SLOT * 2
    ctx.fillStyle = VOID
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Empty slots are drawn as slots, so the strip reads as somewhere things go
    // rather than as a black rectangle.
    ctx.fillStyle = '#242a33'
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < SLOT_COLS; col += 1) {
        ctx.fillRect(col * SLOT + 2, row * SLOT + 2, SLOT - 4, SLOT - 4)
      }
    }

    KEY_TILES.forEach((tile, i) => {
      if (hud.keys[i] > 0) drawTile(ctx, tile, i * SLOT, 0, SLOT)
    })
    BOOT_TILES.forEach((tile, i) => {
      if (hud.boots[i]) drawTile(ctx, tile, i * SLOT, SLOT, SLOT)
    })
  }, [hud.keys, hud.boots])

  /* --------------------------------------------------------------- keyboard */

  const advance = useCallback(() => {
    if (hud.status === 'complete') {
      load(index + 1 < pack.levels.length ? index + 1 : index)
    } else if (hud.status !== 'playing') {
      restart()
    }
  }, [hud.status, index, load, pack.levels.length, restart])

  // Claimed only while this window is in front, and never with a modifier down,
  // so Alt+W still closes and a background Terminal keeps its own arrows.
  useEffect(() => {
    if (!isActive) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const dir = KEY_BY_CODE[e.key]
      if (dir !== undefined) {
        heldRef.current = dir
        tapRef.current = dir
      } else {
        switch (e.key) {
          case 'r':
          case 'R':
            if (!e.repeat) restart()
            break
          case 'p':
          case 'P':
            if (!e.repeat) setPaused((was) => !was)
            break
          case 'Enter':
          case ' ':
            if (!e.repeat) advance()
            break
          default:
            return
        }
      }
      // Stop the page scrolling out from under the board.
      e.preventDefault()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEY_BY_CODE[e.key]
      if (dir !== undefined && heldRef.current === dir) heldRef.current = null
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [advance, isActive, restart])

  // A window losing focus mid-stride would otherwise keep walking.
  useEffect(() => {
    if (!isActive) heldRef.current = null
  }, [isActive])

  /* ------------------------------------------------------------------- menus */

  const menus: MenuDef[] = useMemo(() => {
    const levelItems: MenuItem[] = pack.levels.map((entry, i) => ({
      label: `${i + 1}. ${entry.name}`,
      checked: i === index,
      disabled: i > unlocked,
      onSelect: () => load(i),
    }))

    return [
      {
        title: 'Game',
        items: [
          { label: 'Restart level', shortcut: 'R', onSelect: restart },
          {
            label: paused ? 'Resume' : 'Pause',
            shortcut: 'P',
            disabled: hud.status !== 'playing',
            onSelect: () => setPaused((was) => !was),
          },
          { separator: true },
          { label: 'Close', shortcut: 'Alt+W', onSelect: () => void requestClose(windowId) },
        ],
      },
      { title: 'Level', items: levelItems },
    ]
  }, [hud.status, index, load, pack.levels, paused, requestClose, restart, unlocked, windowId])

  /* ------------------------------------------------------------------- view */

  const overlay = paused && hud.status === 'playing' ? 'Paused' : OVER[hud.status]
  const wonLast = hud.status === 'complete' && index + 1 >= pack.levels.length
  const time = hud.time === Infinity ? '--' : String(Math.max(0, hud.time))

  const move = (dir: Dir) => () => {
    tapRef.current = dir
  }

  return (
    <div className="bean">
      <MenuBar menus={menus} />

      <div className="bean-body">
        <div className="bean-stage">
          {/* Sized in pixels by the effect above: the board is square whatever
              shape the window is, and CSS cannot letterbox both axes. */}
          <div className="bean-frame" ref={frameRef}>
            <canvas
              ref={canvasRef}
              className="bean-canvas"
              role="img"
              aria-label={`${level.name}, ${hud.beansLeft} beans left`}
            />
          </div>
          {overlay ? (
            <div className="bean-overlay">
              <div className="bean-plaque">
                <span className="bean-plaque-text">{overlay}</span>
                {hud.status !== 'playing' ? (
                  <Button isDefault onClick={advance}>
                    {hud.status === 'complete' ? (wonLast ? 'Play again' : 'Next level') : 'Try again'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="bean-side">
          <div className="b-box bean-box">
            <span className="b-box-label">Level</span>
            <div className="bean-level">
              <strong>{index + 1}</strong>
              <span>{level.name}</span>
            </div>
          </div>

          <dl className="bean-stats">
            <dt>Beans</dt>
            <dd>{hud.beansLeft}</dd>
            <dt>Time</dt>
            <dd>{time}</dd>
          </dl>

          <div className="b-box bean-box">
            <span className="b-box-label">Carrying</span>
            <canvas
              ref={stripRef}
              className="bean-strip"
              role="img"
              aria-label="Keys and boots collected"
            />
          </div>

          <div className="bean-buttons">
            <Button onClick={restart}>Restart</Button>
            <Button disabled={hud.status !== 'playing'} onClick={() => setPaused((was) => !was)}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
        </div>
      </div>

      {/* Touch pad: only shown where there is no keyboard. */}
      <div className="bean-pad">
        <Button onClick={move(3)} aria-label="Move left">←</Button>
        <Button onClick={move(0)} aria-label="Move up">↑</Button>
        <Button onClick={move(2)} aria-label="Move down">↓</Button>
        <Button onClick={move(1)} aria-label="Move right">→</Button>
      </div>

      <div className="bean-status b-fixed">
        {hud.hint ?? 'Arrows move · R restart · P pause'}
      </div>
    </div>
  )
}

registerApp({
  id: 'beanchallenge',
  name: 'Bean Challenge',
  component: BeanChallenge,
  icon: BeanChallengeIcon,
  defaultW: 468,
  defaultH: 460,
  minW: 320,
  minH: 380,
  singleton: true,
})
