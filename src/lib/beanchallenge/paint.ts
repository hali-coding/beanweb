/**
 * Tile artwork.
 *
 * The one module here that touches a canvas; everything it reads is pure data,
 * so the rest of the folder stays testable under jsdom. Shapes are laid out on a
 * 32-unit grid and scaled to whatever `size` asks for -- the same grid
 * `lib/icons.tsx` draws on, so a tile and an app icon are the same visual
 * language.
 *
 * `drawTile` is standalone and size-parameterised because it already has two
 * callers, the board and the HUD inventory strip, and a level editor's palette
 * will be the third. Colours are the game's own and are deliberately not themed:
 * this is a play surface, like Tetris's well, not desktop chrome.
 */

import { Tile } from './tiles'
import type { Dir } from './level'
import type { EntityKind } from './tiles'

export const VOID = '#161a20'

const FLOOR = '#5d6d80'
const FLOOR_DARK = '#546375'
const FLOOR_LINE = '#4b5868'

const WALL = '#39424f'
const WALL_LIT = '#525e6e'
const WALL_SHADE = '#232a34'

const KEY_COLOURS = ['#d8453c', '#4caf50', '#e8c33a', '#3fc7d8']
const DOOR_COLOURS = ['#a32b24', '#2f7d35', '#b08c1c', '#238e9c']

export function drawTile(
  ctx: CanvasRenderingContext2D,
  tile: number,
  px: number,
  py: number,
  size: number,
) {
  const u = size / 32
  /** Rectangle in grid units. */
  const r = (x: number, y: number, w: number, h: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.fillRect(px + x * u, py + y * u, w * u, h * u)
  }
  const dot = (x: number, y: number, rad: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(px + x * u, py + y * u, rad * u, 0, Math.PI * 2)
    ctx.fill()
  }
  const poly = (points: number[][], fill: string) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    points.forEach(([x, y], i) => {
      const cx = px + x * u
      const cy = py + y * u
      if (i === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    })
    ctx.closePath()
    ctx.fill()
  }

  const floor = () => {
    r(0, 0, 32, 32, FLOOR)
    r(0, 0, 32, 1, FLOOR_LINE)
    r(0, 0, 1, 32, FLOOR_LINE)
    r(16, 16, 16, 16, FLOOR_DARK)
    r(0, 0, 16, 16, FLOOR_DARK)
  }

  switch (tile) {
    case Tile.Wall:
      r(0, 0, 32, 32, WALL)
      r(0, 0, 32, 3, WALL_LIT)
      r(0, 0, 3, 32, WALL_LIT)
      r(0, 29, 32, 3, WALL_SHADE)
      r(29, 0, 3, 32, WALL_SHADE)
      r(3, 15, 26, 2, WALL_SHADE)
      break

    case Tile.Gravel:
      floor()
      for (const [x, y] of [[6, 8], [13, 5], [22, 9], [9, 19], [18, 22], [26, 17], [14, 14]]) {
        dot(x, y, 2, '#7d8a99')
        dot(x - 0.6, y - 0.6, 1, '#98a4b1')
      }
      break

    case Tile.Hint:
      floor()
      r(6, 6, 20, 20, '#3c4a5c')
      r(7, 7, 18, 18, '#46566a')
      ctx.fillStyle = '#e8dfa8'
      ctx.font = `bold ${20 * u}px ${'"Bitstream Vera Sans", sans-serif'}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('?', px + 16 * u, py + 17 * u)
      break

    case Tile.Bean:
      floor()
      /*
       * A kidney bean, lit from the top-left like every icon in the set, and
       * deliberately small: it is a thing lying on the floor, and the player is
       * a bean too. At full size the two were the same green blob until this
       * one was shrunk and that one grew a face.
       */
      poly([[12, 10], [20, 9], [22, 14], [21, 20], [15, 22], [11, 20], [10, 14]], '#4a7018')
      poly([[12.8, 10.8], [19, 10], [21, 14], [20, 19], [15, 21], [12, 19], [11, 14]], '#8fbf4a')
      poly([[14, 12], [18, 11.4], [19, 13.5], [16.5, 14.2], [14.6, 14]], '#bce07d')
      break

    case Tile.Socket:
      r(0, 0, 32, 32, '#2b313b')
      r(2, 2, 28, 28, '#3a4250')
      for (let i = 0; i < 4; i += 1) {
        r(4 + i * 7, 4, 4, 4, '#d8b23a')
        r(4 + i * 7, 24, 4, 4, '#d8b23a')
        r(4, 4 + i * 7, 4, 4, '#d8b23a')
        r(24, 4 + i * 7, 4, 4, '#d8b23a')
      }
      r(10, 10, 12, 12, '#1d222a')
      break

    case Tile.Exit:
      r(0, 0, 32, 32, '#2b313b')
      r(3, 3, 26, 26, '#ffc900')
      r(7, 7, 18, 18, '#2b313b')
      r(11, 11, 10, 10, '#ffe066')
      break

    case Tile.Water:
      r(0, 0, 32, 32, '#2f6fbf')
      r(0, 0, 32, 6, '#3b82d6')
      for (const y of [9, 17, 25]) {
        r(4, y, 8, 2, '#6fa8e8')
        r(18, y + 3, 9, 2, '#6fa8e8')
      }
      break

    case Tile.Fire:
      r(0, 0, 32, 32, '#7d1f0c')
      poly([[6, 30], [10, 16], [14, 22], [17, 6], [22, 17], [26, 12], [27, 30]], '#d0421b')
      poly([[12, 30], [15, 18], [18, 23], [20, 14], [23, 30]], '#f2a03c')
      poly([[16, 30], [18, 22], [20, 30]], '#ffe08a')
      break

    case Tile.Bomb:
      floor()
      dot(16, 19, 10, '#1b1f26')
      dot(13, 16, 3.5, '#5a6472')
      r(17, 6, 2, 5, '#8a6a3a')
      dot(19, 5, 2.5, '#f2a03c')
      break

    case Tile.Teleport:
      r(0, 0, 32, 32, '#141c2c')
      for (const [rad, colour] of [[13, '#1f3a6e'], [9, '#2f6fbf'], [5, '#63d6f0'], [2, '#ffffff']] as const) {
        dot(16, 16, rad, colour)
      }
      break

    case Tile.KeyRed:
    case Tile.KeyGreen:
    case Tile.KeyYellow:
    case Tile.KeyCyan: {
      floor()
      const colour = KEY_COLOURS[tile - Tile.KeyRed]
      dot(12, 11, 6, colour)
      dot(12, 11, 2.5, '#1d222a')
      r(14, 13, 3, 15, colour)
      r(17, 20, 5, 3, colour)
      r(17, 25, 4, 3, colour)
      break
    }

    case Tile.DoorRed:
    case Tile.DoorGreen:
    case Tile.DoorYellow:
    case Tile.DoorCyan: {
      const i = tile - Tile.DoorRed
      r(0, 0, 32, 32, DOOR_COLOURS[i])
      r(0, 0, 32, 3, KEY_COLOURS[i])
      r(0, 0, 3, 32, KEY_COLOURS[i])
      r(6, 6, 20, 20, DOOR_COLOURS[i])
      dot(16, 15, 4, '#1d222a')
      r(15, 15, 2, 8, '#1d222a')
      break
    }

    case Tile.Flippers:
      floor()
      poly([[8, 8], [14, 8], [15, 24], [6, 24]], '#2fa8bf')
      poly([[18, 8], [24, 8], [26, 24], [17, 24]], '#3fc7d8')
      break

    case Tile.FireBoots:
      floor()
      poly([[10, 6], [18, 6], [18, 20], [25, 20], [25, 26], [10, 26]], '#b8402a')
      poly([[12, 8], [16, 8], [16, 22], [23, 22], [23, 24], [12, 24]], '#e8663f')
      break

    case Tile.Skates:
      floor()
      poly([[9, 7], [17, 7], [17, 18], [23, 18], [23, 23], [9, 23]], '#c8d4e0')
      r(7, 24, 18, 2, '#8b98a8')
      r(7, 26, 18, 2, '#e8f0f8')
      break

    case Tile.Suction:
      floor()
      poly([[10, 6], [18, 6], [18, 20], [25, 20], [25, 26], [10, 26]], '#6a3f9c')
      dot(14, 12, 3, '#b98fe0')
      dot(21, 23, 2.5, '#b98fe0')
      break

    case Tile.Ice:
      r(0, 0, 32, 32, '#bcdcea')
      r(0, 0, 32, 4, '#dcf0f8')
      r(4, 8, 14, 2, '#ffffff')
      r(14, 20, 14, 2, '#ffffff')
      break

    case Tile.IceNE:
    case Tile.IceNW:
    case Tile.IceSW:
    case Tile.IceSE: {
      r(0, 0, 32, 32, '#bcdcea')
      r(0, 0, 32, 4, '#dcf0f8')
      // The two walled sides, drawn as the rails they behave like.
      const rail = '#6f98ad'
      if (tile === Tile.IceNE || tile === Tile.IceNW) r(0, 0, 32, 5, rail)
      if (tile === Tile.IceSE || tile === Tile.IceSW) r(0, 27, 32, 5, rail)
      if (tile === Tile.IceNE || tile === Tile.IceSE) r(27, 0, 5, 32, rail)
      if (tile === Tile.IceNW || tile === Tile.IceSW) r(0, 0, 5, 32, rail)
      break
    }

    case Tile.ForceUp:
    case Tile.ForceDown:
    case Tile.ForceLeft:
    case Tile.ForceRight:
    case Tile.ForceRandom: {
      r(0, 0, 32, 32, '#5a4a80')
      r(0, 0, 32, 3, '#6f5c9c')
      if (tile === Tile.ForceRandom) {
        for (const [x, y] of [[9, 9], [22, 9], [9, 22], [22, 22]]) dot(x, y, 3, '#c0a8f0')
        dot(16, 16, 4, '#e8dcff')
        break
      }
      // Three chevrons pointing the way the floor pushes.
      const dir: Dir =
        tile === Tile.ForceUp ? 0 : tile === Tile.ForceRight ? 1 : tile === Tile.ForceDown ? 2 : 3
      for (const offset of [0, 10, 20]) {
        const shape =
          dir === 0
            ? [[6, 10 + offset], [16, 2 + offset], [26, 10 + offset], [16, 6 + offset]]
            : dir === 2
              ? [[6, 22 - offset], [16, 30 - offset], [26, 22 - offset], [16, 26 - offset]]
              : dir === 1
                ? [[22 - offset, 6], [30 - offset, 16], [22 - offset, 26], [26 - offset, 16]]
                : [[10 + offset, 6], [2 + offset, 16], [10 + offset, 26], [6 + offset, 16]]
        poly(shape, '#c0a8f0')
      }
      break
    }

    case Tile.ToggleWall:
      r(0, 0, 32, 32, '#1e6b42')
      r(0, 0, 32, 3, '#2f9c60')
      r(0, 0, 3, 32, '#2f9c60')
      r(0, 29, 32, 3, '#12482c')
      r(29, 0, 3, 32, '#12482c')
      r(8, 8, 16, 16, '#2a7a4a')
      break

    case Tile.ToggleFloor:
      floor()
      r(0, 0, 32, 2, '#2a7a4a')
      r(0, 30, 32, 2, '#2a7a4a')
      r(0, 0, 2, 32, '#2a7a4a')
      r(30, 0, 2, 32, '#2a7a4a')
      break

    case Tile.GreenButton:
      floor()
      dot(16, 16, 10, '#12482c')
      dot(16, 16, 8, '#2f9c60')
      dot(14, 14, 3, '#7fe0a8')
      break

    default:
      floor()
  }
}

/** Player, block and monsters, drawn over whatever tile they stand on. */
export function drawEntity(
  ctx: CanvasRenderingContext2D,
  kind: EntityKind,
  px: number,
  py: number,
  size: number,
  dir: Dir = 2,
) {
  const u = size / 32
  const r = (x: number, y: number, w: number, h: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.fillRect(px + x * u, py + y * u, w * u, h * u)
  }
  const dot = (x: number, y: number, rad: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(px + x * u, py + y * u, rad * u, 0, Math.PI * 2)
    ctx.fill()
  }
  const poly = (points: number[][], fill: string) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(px + x * u, py + y * u)
      else ctx.lineTo(px + x * u, py + y * u)
    })
    ctx.closePath()
    ctx.fill()
  }

  switch (kind) {
    case 'player': {
      /*
       * The hero is a bean, which is the whole joke -- so it has to be told
       * apart from the beans it is collecting at a glance. It is bigger, a
       * lighter and yellower green, and it has a face; the eyes look the way it
       * is walking, which also makes a stalled move visible.
       */
      poly([[10, 6], [22, 5], [27, 13], [24, 25], [15, 28], [7, 22], [6, 12]], '#2f5a0c')
      poly([[11, 7], [21, 6], [25, 13], [22, 24], [15, 26], [9, 21], [8, 12]], '#c6e85a')
      poly([[13, 9], [19, 8], [21, 12], [17, 13], [14, 12]], '#eafab0')
      const [ex, ey] = dir === 0 ? [0, -2] : dir === 2 ? [0, 2] : dir === 1 ? [2, 0] : [-2, 0]
      dot(13, 16, 3.4, '#ffffff')
      dot(20, 15, 3.4, '#ffffff')
      dot(13 + ex, 16 + ey, 1.7, '#1d2a08')
      dot(20 + ex, 15 + ey, 1.7, '#1d2a08')
      break
    }

    case 'block':
      r(2, 2, 28, 28, '#7a5c34')
      r(3, 3, 26, 26, '#a8865a')
      r(3, 3, 26, 3, '#c9a878')
      r(3, 26, 26, 3, '#6b4f2c')
      r(3, 14, 26, 4, '#8a6c42')
      r(14, 3, 4, 26, '#8a6c42')
      break

    case 'bug':
      dot(16, 16, 10, '#4f7a12')
      dot(16, 16, 8, '#a3d84a')
      r(15, 7, 2, 18, '#4f7a12')
      dot(12, 11, 2, '#1d2a08')
      dot(20, 11, 2, '#1d2a08')
      // Legs, on the two sides square to its heading.
      for (const y of [11, 16, 21]) {
        r(3, y, 5, 2, '#4f7a12')
        r(24, y, 5, 2, '#4f7a12')
      }
      break

    case 'fireball':
      dot(16, 17, 10, '#b8340c')
      dot(16, 18, 7, '#ff7a1e')
      dot(16, 19, 4, '#ffd066')
      poly([[10, 10], [16, 1], [22, 10]], '#ff7a1e')
      break

    case 'ball':
      dot(16, 16, 11, '#5a6472')
      dot(16, 16, 9, '#e0e6ee')
      dot(12, 12, 3, '#ffffff')
      r(5, 15, 22, 3, '#5a6472')
      break

    case 'walker':
      poly([[16, 4], [27, 14], [24, 27], [8, 27], [5, 14]], '#7a2a90')
      poly([[16, 7], [24, 15], [22, 25], [10, 25], [8, 15]], '#c04ad8')
      dot(13, 15, 2.4, '#2a0a30')
      dot(20, 15, 2.4, '#2a0a30')
      break

    default:
  }
}
