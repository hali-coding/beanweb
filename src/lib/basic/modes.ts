/**
 * Screen modes and their palettes.
 *
 * A mode is fully described by its pixel grid, its text grid and how many
 * attributes it can show. Everything else in the graphics layer reads those
 * numbers rather than branching on the mode number, which is why adding a mode
 * here is all it takes to support one.
 *
 * Colours are stored as attribute *indices*, never RGB. That is what makes
 * PALETTE work — remapping an attribute recolours every pixel already drawn
 * with it, exactly as changing a DAC register did — and what lets POINT hand
 * back the number the program originally passed to PSET.
 */

export interface ModeInfo {
  mode: number
  /** Pixel grid. Zero-sized in SCREEN 0, which has no addressable pixels. */
  width: number
  height: number
  /** Character grid. WIDTH can change `cols`, and `rows` in SCREEN 0. */
  cols: number
  rows: number
  /** Character cell in pixels. The font is 8x8 and letterboxes into taller cells. */
  cellW: number
  cellH: number
  /** Number of attributes an expression may name: 0..colors-1. */
  colors: number
  /** Size of the palette behind those attributes. */
  paletteSize: number
  /** SCREEN 0 has no graphics; every graphics statement is illegal there. */
  graphics: boolean
}

/**
 * The modes QBasic could set. SCREEN 3/4/10 were Hercules/Olivetti/mono-EGA
 * hardware and are left out — a program asking for one gets an error rather
 * than a silent substitution that would draw the wrong colours.
 */
export const MODES: Record<number, ModeInfo> = {
  0: { mode: 0, width: 0, height: 0, cols: 80, rows: 25, cellW: 8, cellH: 16, colors: 16, paletteSize: 16, graphics: false },
  1: { mode: 1, width: 320, height: 200, cols: 40, rows: 25, cellW: 8, cellH: 8, colors: 4, paletteSize: 4, graphics: true },
  2: { mode: 2, width: 640, height: 200, cols: 80, rows: 25, cellW: 8, cellH: 8, colors: 2, paletteSize: 2, graphics: true },
  7: { mode: 7, width: 320, height: 200, cols: 40, rows: 25, cellW: 8, cellH: 8, colors: 16, paletteSize: 16, graphics: true },
  8: { mode: 8, width: 640, height: 200, cols: 80, rows: 25, cellW: 8, cellH: 8, colors: 16, paletteSize: 16, graphics: true },
  9: { mode: 9, width: 640, height: 350, cols: 80, rows: 25, cellW: 8, cellH: 14, colors: 16, paletteSize: 64, graphics: true },
  11: { mode: 11, width: 640, height: 480, cols: 80, rows: 30, cellW: 8, cellH: 16, colors: 2, paletteSize: 256, graphics: true },
  12: { mode: 12, width: 640, height: 480, cols: 80, rows: 30, cellW: 8, cellH: 16, colors: 16, paletteSize: 256, graphics: true },
  13: { mode: 13, width: 320, height: 200, cols: 40, rows: 25, cellW: 8, cellH: 8, colors: 256, paletteSize: 256, graphics: true },
}

/**
 * How much taller than wide a pixel was on the 4:3 display the mode targeted.
 * Everything about aspect follows from this one number: the window stretches
 * the image by it, and CIRCLE's default aspect ratio is its reciprocal, which
 * is what makes CIRCLE draw a round circle in every mode.
 */
export const pixelAspect = (displayW: number, displayH: number) =>
  displayH === 0 ? 1 : (3 / 4) * (displayW / displayH)

/** Pack to the 0xRRGGBB the renderer wants. */
const rgb = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

/**
 * The sixteen EGA/VGA text attributes, in attribute order: the eight dim
 * colours, then the same eight at full intensity. Brown rather than dark
 * yellow at attribute 6 is not a mistake — the hardware really did special-case
 * it, and listings from the period expect the darker shade.
 */
export const EGA16 = Uint32Array.from([
  rgb(0, 0, 0), rgb(0, 0, 170), rgb(0, 170, 0), rgb(0, 170, 170),
  rgb(170, 0, 0), rgb(170, 0, 170), rgb(170, 85, 0), rgb(170, 170, 170),
  rgb(85, 85, 85), rgb(85, 85, 255), rgb(85, 255, 85), rgb(85, 255, 255),
  rgb(255, 85, 85), rgb(255, 85, 255), rgb(255, 255, 85), rgb(255, 255, 255),
])

/** CGA's two four-colour sets, selected by COLOR's second argument in SCREEN 1. */
export const CGA_PALETTES = [
  // Palette 0: green / red / brown
  Uint32Array.from([EGA16[0], EGA16[2], EGA16[4], EGA16[6]]),
  // Palette 1: cyan / magenta / white — the one nearly every listing uses
  Uint32Array.from([EGA16[0], EGA16[3], EGA16[5], EGA16[7]]),
]

/**
 * The 256-entry VGA default: the 16 text attributes, a 16-step grey ramp, then
 * 216 colours as 24 hues x 3 saturations x 3 values, and 8 unused blacks. The
 * ramp is generated rather than tabulated because it is a formula, and a table
 * of 720 numbers would only be a place for typos to hide.
 */
export function vga256(): Uint32Array {
  const p = new Uint32Array(256)
  p.set(EGA16, 0)

  // 16 greys, evenly spaced across the full range.
  for (let i = 0; i < 16; i += 1) {
    const v = Math.round((i / 15) * 255)
    p[16 + i] = rgb(v, v, v)
  }

  // 216 colours: three value bands, each three saturation bands, 24 hues.
  const values = [255, 128, 64]
  const floors = [0, 0.5, 0.75]
  let at = 32
  for (const value of values) {
    for (const floor of floors) {
      for (let h = 0; h < 24; h += 1) {
        const [r, g, b] = hueToRgb((h / 24) * 6, value, value * floor)
        p[at++] = rgb(r, g, b)
      }
    }
  }
  return p
}

/** Six-segment hue sweep between a floor and a peak. */
function hueToRgb(h: number, peak: number, floor: number): [number, number, number] {
  const span = peak - floor
  const seg = Math.floor(h) % 6
  const f = h - Math.floor(h)
  const rise = Math.round(floor + span * f)
  const fall = Math.round(floor + span * (1 - f))
  const lo = Math.round(floor)
  const hi = Math.round(peak)
  switch (seg) {
    case 0: return [hi, rise, lo]
    case 1: return [fall, hi, lo]
    case 2: return [lo, hi, rise]
    case 3: return [lo, fall, hi]
    case 4: return [rise, lo, hi]
    default: return [hi, lo, fall]
  }
}

/** The palette a mode powers up with. */
export function defaultPalette(info: ModeInfo): Uint32Array {
  if (info.mode === 13) return vga256()
  if (info.mode === 1) return Uint32Array.from(CGA_PALETTES[1])
  if (info.colors === 2) return Uint32Array.from([EGA16[0], EGA16[15]])
  const p = new Uint32Array(Math.max(info.paletteSize, 16))
  // Attributes beyond 16 exist in modes 11/12 but start black, as on the card.
  p.set(EGA16, 0)
  return p
}

/**
 * PALETTE's colour argument is a hardware DAC value, not RGB: six bits per
 * channel, blue in the high byte. In the EGA modes it is instead a 6-bit index
 * into the 64 colours the card could make, which is the same encoding at one
 * bit per channel pair — both land here.
 */
export function dacToRgb(value: number, sixBitChannels: boolean): number {
  const v = Math.trunc(value)
  if (sixBitChannels) {
    const r = Math.min(63, v & 63)
    const g = Math.min(63, (v >> 8) & 63)
    const b = Math.min(63, (v >> 16) & 63)
    return rgb(scale6(r), scale6(g), scale6(b))
  }
  // EGA: bits are r g b R G B, the capital letters being the low-intensity half.
  const bits = v & 63
  const r = ((bits >> 2) & 1) * 170 + ((bits >> 5) & 1) * 85
  const g = ((bits >> 1) & 1) * 170 + ((bits >> 4) & 1) * 85
  const b = (bits & 1) * 170 + ((bits >> 3) & 1) * 85
  return rgb(Math.min(255, r), Math.min(255, g), Math.min(255, b))
}

const scale6 = (c: number) => Math.round((c / 63) * 255)
