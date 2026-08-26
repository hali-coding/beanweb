/**
 * The screen font: an original 8x8 bitmap face, one byte per row, MSB left.
 *
 * Drawn on a 6x7 body inside the 8x8 cell, which leaves a column of side
 * bearing and a row of leading — the proportions a CGA-era face used, without
 * copying one. Like `lib/icons.tsx`, this is original artwork; no ROM dump.
 *
 * Modes with taller cells (8x14 in SCREEN 9, 8x16 in SCREEN 0/11/12) letterbox
 * the same 8x8 body rather than switching to a second face. Text there is
 * airier than a real VGA would draw it; every glyph still lands on the exact
 * character cell QBasic would have used, which is what LOCATE depends on.
 */

/** Codes below this are unprintable; the table starts at the space. */
const FIRST = 32

/** 95 glyphs, ASCII 32..126, eight hex bytes each, top row first. */
const PRINTABLE = [
  '0000000000000000', '2020202020002000', '5050500000000000', '5050f850f8505000', //  !"#
  '2078a07028f02000', 'c4c810204c8c0000', '6090a040a8906800', '2020200000000000', // $%&'
  '1020404040201000', '4020101010204000', '0020a870a8200000', '002020f820200000', // ()*+
  '0000000000302040', '000000f800000000', '0000000000303000', '0408102040800000', // ,-./
  '708898a8c8887000', '2060202020207000', '708808102040f800', 'f808103008887000', // 0123
  '10305090f8101000', 'f880f00808887000', '304080f088887000', 'f808102040404000', // 4567
  '7088887088887000', '7088887808106000', '0030300030300000', '0030300030204000', // 89:;
  '1020408040201000', '0000f800f8000000', '4020100810204000', '7088081020002000', // <=>?
  '7088b8a8b8807000', '20508888f8888800', 'f08888f08888f000', '7088808080887000', // @ABC
  'f08888888888f000', 'f88080f08080f800', 'f88080f080808000', '7088809888887000', // DEFG
  '888888f888888800', '7020202020207000', '0808080888887000', '8890a0c0a0908800', // HIJK
  '808080808080f800', '88d8a8a888888800', '8888c8a898888800', '7088888888887000', // LMNO
  'f08888f080808000', '70888888a8906800', 'f08888f0a0908800', '788080700808f000', // PQRS
  'f820202020202000', '8888888888887000', '8888888888502000', '888888a8a8d88800', // TUVW
  '8888502050888800', '8888502020202000', 'f80810204080f800', '7040404040407000', // XYZ[
  '8040201008040000', '7010101010107000', '2050880000000000', '00000000000000f8', // \]^_
  '4020000000000000', '0000700878887800', '8080f0888888f000', '0000788080807800', // `abc
  '0808788888887800', '00007088f8807800', '304840e040404000', '0000788888780870', // defg
  '8080f08888888800', '2000602020207000', '1000301010109060', '808090a0c0a09000', // hijk
  '6020202020207000', '0000d0a8a8a88800', '0000f08888888800', '0000708888887000', // lmno
  '0000f08888f08080', '0000788888780808', '0000b8c080808000', '000078807008f000', // pqrs
  '4040e04040483000', '0000888888887800', '0000888888502000', '000088a8a8a85000', // tuvw
  '0000885020508800', '0000888888780870', '0000f8102040f800', '1820204020201800', // xyz{
  '2020202020202000', '6010100810106000', '0000649800000000', // |}~
]

/**
 * The block and shading characters, which sit high in the code page and are
 * what ASCII-art listings draw with. These deliberately fill all eight columns:
 * a block that left a gutter would not tile.
 */
const HIGH: Record<number, string> = {
  176: '8800220088002200', // light shade
  177: 'aa55aa55aa55aa55', // medium shade
  178: '77dd77dd77dd77dd', // dark shade
  179: '2020202020202020', // vertical bar
  196: '000000ff00000000', // horizontal bar
  219: 'ffffffffffffffff', // full block
  220: '00000000ffffffff', // lower half
  221: 'f0f0f0f0f0f0f0f0', // left half
  222: '0f0f0f0f0f0f0f0f', // right half
  223: 'ffffffff00000000', // upper half
  254: '0000787878780000', // centred square
}

/** Cell height of the face itself; taller cells letterbox it. */
export const GLYPH_H = 8
export const GLYPH_W = 8

const BLANK = new Uint8Array(GLYPH_H)

function decode(hex: string): Uint8Array {
  const rows = new Uint8Array(GLYPH_H)
  for (let i = 0; i < GLYPH_H; i += 1) rows[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return rows
}

/** code -> eight row bytes. Built once; the renderer reads it every frame. */
const GLYPHS = new Map<number, Uint8Array>()
PRINTABLE.forEach((hex, i) => GLYPHS.set(FIRST + i, decode(hex)))
for (const [code, hex] of Object.entries(HIGH)) GLYPHS.set(Number(code), decode(hex))

/**
 * Row bitmaps for a character code. Anything with no glyph renders blank
 * rather than a substitute box — a program that pokes an odd code onto the
 * screen should not have it turn into visual noise.
 */
export function glyph(code: number): Uint8Array {
  return GLYPHS.get(code) ?? BLANK
}

/** Whether a code has artwork. Only the tests care. */
export const hasGlyph = (code: number): boolean => GLYPHS.has(code)
