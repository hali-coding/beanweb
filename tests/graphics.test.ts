import { describe, expect, it } from 'vitest'
import { Interpreter, Screen, build, recordingHost } from '@/lib/basic'
import type { RecordingHost } from '@/lib/basic'
import { useFs } from '@/store/fs'

/**
 * The graphics layer, driven the way a program drives it.
 *
 * Everything here goes through real BASIC source rather than calling `Screen`
 * directly, because the interesting bugs live in the seams: STEP resolving
 * against the wrong cursor, a colour argument that was left out, VIEW and
 * WINDOW composing in the wrong order. A unit test on `Screen.pset` would miss
 * every one of them.
 *
 * `Screen` is pure data with no canvas, which is the only reason this can run
 * under jsdom at all.
 */

interface Run {
  screen: Screen
  host: RecordingHost
  vm: Interpreter
  error: string | null
}

/** Compile and run to completion, or to a generous step ceiling. */
function run(source: string): Run {
  const host = recordingHost()
  const screen = new Screen(0)
  const vm = new Interpreter(build(source), host, undefined, screen)
  vm.start()
  let guard = 0
  while (vm.status === 'running' && guard < 500) {
    vm.runSlice({ maxSteps: 20000 })
    guard += 1
  }
  return { screen, host, vm, error: vm.error ? vm.error.toString() : null }
}

/** Run and fail loudly if the program did not finish cleanly. */
function ok(source: string): Run {
  const r = run(source)
  expect(r.error).toBeNull()
  return r
}

/** The attribute at a physical pixel, ignoring VIEW and WINDOW. */
const at = (s: Screen, x: number, y: number) => s.pixels[y * s.info.width + x]

/** Count the pixels holding an attribute — a cheap shape assertion. */
const count = (s: Screen, attr: number) => s.pixels.reduce((n, v) => (v === attr ? n + 1 : n), 0)

describe('SCREEN', () => {
  it('sets the pixel and character grids for a mode', () => {
    const { screen } = ok('SCREEN 13')
    expect(screen.info.width).toBe(320)
    expect(screen.info.height).toBe(200)
    expect(screen.cols).toBe(40)
    expect(screen.rows).toBe(25)
    expect(screen.pixels.length).toBe(320 * 200)
  })

  it('tells the app to show the screen, once per mode', () => {
    const { host } = ok('SCREEN 12\nPSET (1, 1)\nPSET (2, 2)')
    expect(host.calls.filter((c) => c.call === 'show')).toHaveLength(1)
  })

  it('does not show a screen for a program that only prints', () => {
    const { host } = ok('PRINT "no pixels here"')
    expect(host.calls.some((c) => c.call === 'show')).toBe(false)
  })

  it('rejects a mode the hardware never had', () => {
    expect(run('SCREEN 4').error).toContain('Illegal function call')
  })

  it('refuses to draw in SCREEN 0, which has no pixels', () => {
    expect(run('PSET (10, 10), 4').error).toContain('Illegal function call')
  })

  it('clears the screen when the mode is set again', () => {
    const { screen } = ok('SCREEN 13\nPSET (10, 10), 5\nSCREEN 13')
    expect(at(screen, 10, 10)).toBe(0)
  })
})

describe('PSET and POINT', () => {
  it('sets a pixel and reads it back', () => {
    const { screen, host } = ok('SCREEN 13\nPSET (10, 20), 5\nPRINT POINT(10, 20)')
    expect(at(screen, 10, 20)).toBe(5)
    expect(host.output()).toContain('5')
  })

  it('defaults to the current foreground colour', () => {
    const { screen } = ok('SCREEN 13\nCOLOR 9\nPSET (3, 3)')
    expect(at(screen, 3, 3)).toBe(9)
  })

  it('PRESET with no colour erases to the background', () => {
    const { screen } = ok('SCREEN 13\nPSET (4, 4), 12\nPRESET (4, 4)')
    expect(at(screen, 4, 4)).toBe(0)
  })

  it('STEP moves relative to the graphics cursor', () => {
    const { screen } = ok('SCREEN 13\nPSET (10, 10), 1\nPSET STEP(5, 3), 2')
    expect(at(screen, 15, 13)).toBe(2)
  })

  it('POINT outside the screen is -1', () => {
    const { host } = ok('SCREEN 13\nPRINT POINT(500, 500)')
    expect(host.output()).toContain('-1')
  })
})

describe('LINE', () => {
  it('draws a segment between two points', () => {
    const { screen } = ok('SCREEN 13\nLINE (0, 0)-(10, 0), 3')
    for (let x = 0; x <= 10; x += 1) expect(at(screen, x, 0)).toBe(3)
  })

  it('continues from the graphics cursor when the start is left out', () => {
    const { screen } = ok('SCREEN 13\nPSET (5, 5), 1\nLINE -(5, 9), 2')
    expect(at(screen, 5, 7)).toBe(2)
  })

  it('B draws a box outline, leaving the middle alone', () => {
    const { screen } = ok('SCREEN 13\nLINE (0, 0)-(4, 4), 7, B')
    expect(at(screen, 0, 0)).toBe(7)
    expect(at(screen, 4, 4)).toBe(7)
    expect(at(screen, 2, 0)).toBe(7)
    expect(at(screen, 2, 2)).toBe(0)
  })

  it('BF fills the box', () => {
    const { screen } = ok('SCREEN 13\nLINE (0, 0)-(4, 4), 7, BF')
    expect(count(screen, 7)).toBe(25)
  })

  it('a style mask leaves gaps', () => {
    const solid = ok('SCREEN 13\nLINE (0, 0)-(60, 0), 1')
    const dashed = ok('SCREEN 13\nLINE (0, 0)-(60, 0), 1, , &HF0F0')
    expect(count(dashed.screen, 1)).toBeLessThan(count(solid.screen, 1))
    expect(count(dashed.screen, 1)).toBeGreaterThan(0)
  })
})

describe('CIRCLE', () => {
  it('draws a closed curve around its centre, not through it', () => {
    const { screen } = ok('SCREEN 13\nCIRCLE (100, 100), 40, 14')
    expect(at(screen, 100, 100)).toBe(0)
    expect(count(screen, 14)).toBeGreaterThan(100)
  })

  it('comes out round: the radius is equal on both axes on screen', () => {
    // SCREEN 12 has square pixels, so a circle's bounding box is square too.
    const { screen } = ok('SCREEN 12\nCIRCLE (200, 200), 50, 15')
    let minX = 999
    let maxX = -1
    let minY = 999
    let maxY = -1
    for (let y = 0; y < 480; y += 1) {
      for (let x = 0; x < 640; x += 1) {
        if (at(screen, x, y) !== 15) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    expect(maxX - minX).toBe(100)
    expect(maxY - minY).toBe(100)
  })

  it('draws only the arc between two angles', () => {
    const full = ok('SCREEN 13\nCIRCLE (100, 100), 40, 9')
    const quarter = ok('SCREEN 13\nCIRCLE (100, 100), 40, 9, 0, 1.5708')
    expect(count(quarter.screen, 9)).toBeLessThan(count(full.screen, 9) * 0.6)
    // The arc from 0 to 90 degrees is the one going up and to the right.
    expect(at(quarter.screen, 140, 100)).toBe(9)
    expect(at(quarter.screen, 60, 100)).toBe(0)
  })

  it('a negative angle joins the arc to the centre, making a pie slice', () => {
    const arc = ok('SCREEN 13\nCIRCLE (100, 100), 40, 9, 0, 1.5708')
    const pie = ok('SCREEN 13\nCIRCLE (100, 100), 40, 9, -0.0001, -1.5708')
    expect(count(pie.screen, 9)).toBeGreaterThan(count(arc.screen, 9))
    expect(at(pie.screen, 120, 100)).toBe(9)
  })
})

describe('PAINT', () => {
  it('fills a shape up to its border', () => {
    const { screen } = ok('SCREEN 13\nLINE (10, 10)-(20, 20), 4, B\nPAINT (15, 15), 2, 4')
    expect(at(screen, 15, 15)).toBe(2)
    expect(at(screen, 10, 10)).toBe(4)
    // Nothing leaked out of the box.
    expect(at(screen, 5, 5)).toBe(0)
  })

  it('stops at a border of the same colour it is filling with', () => {
    const { screen } = ok('SCREEN 13\nCIRCLE (100, 100), 30, 6\nPAINT (100, 100), 6')
    expect(at(screen, 100, 100)).toBe(6)
    expect(at(screen, 5, 5)).toBe(0)
  })

  it('fills a whole 640x480 screen without blowing the stack', () => {
    const { screen, error } = run('SCREEN 12\nPAINT (0, 0), 1, 1')
    expect(error).toBeNull()
    expect(count(screen, 1)).toBe(640 * 480)
  })
})

describe('DRAW', () => {
  it('walks the pen with U D L R', () => {
    const { screen } = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 R10 D10 L10 U10"')
    expect(at(screen, 60, 50)).toBe(4)
    expect(at(screen, 60, 60)).toBe(4)
    expect(at(screen, 50, 60)).toBe(4)
  })

  it('B moves without drawing', () => {
    const { screen } = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 BR20 D5"')
    expect(at(screen, 60, 50)).toBe(0)
    expect(at(screen, 70, 52)).toBe(4)
  })

  it('N returns to where the move started', () => {
    const { screen } = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 NR20 D10"')
    expect(at(screen, 60, 50)).toBe(4)
    expect(at(screen, 50, 55)).toBe(4)
  })

  it('S scales the steps', () => {
    const { screen } = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 S8 R10"')
    // Scale 8 is double, so ten units reach twenty pixels.
    expect(at(screen, 70, 50)).toBe(4)
  })

  it('M with a sign is relative, without one absolute', () => {
    const relative = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 M+10,+10"')
    const absolute = ok('SCREEN 13\nPSET (50, 50), 0\nDRAW "C4 M10,10"')
    expect(at(relative.screen, 60, 60)).toBe(4)
    expect(at(absolute.screen, 30, 30)).toBe(4)
  })

  it('refuses the X command rather than silently drawing nothing', () => {
    expect(run('SCREEN 13\nDRAW "X"').error).toContain('VARPTR$')
  })
})

describe('COLOR, LOCATE and text on the screen', () => {
  it('PRINT lands in the character grid', () => {
    const { screen } = ok('PRINT "HELLO"')
    expect(screen.rowText(1)).toBe('HELLO')
  })

  it('LOCATE puts the next PRINT where it says', () => {
    const { screen } = ok('LOCATE 5, 10\nPRINT "HERE";')
    expect(screen.charAt(5, 10)).toBe('H')
    expect(screen.rowText(5).trim()).toBe('HERE')
  })

  it('COLOR sets the attributes the cell is stored with', () => {
    const { screen } = ok('COLOR 14, 1\nPRINT "X";')
    expect(screen.cellAttrs[0] & 255).toBe(14)
    expect((screen.cellAttrs[0] >> 8) & 255).toBe(1)
  })

  it('CSRLIN and POS report where the cursor is', () => {
    // Each is read where it sits in the statement, so they need separate
    // PRINTs: printing CSRLIN first would already have moved the column.
    expect(ok('LOCATE 7, 3\nPRINT CSRLIN').host.output()).toContain('7')
    expect(ok('LOCATE 7, 3\nPRINT POS(0)').host.output()).toContain('3')
  })

  it('SCREEN(row, col) reads a character back', () => {
    const { host } = ok('LOCATE 2, 1\nPRINT "Z";\nPRINT CHR$(SCREEN(2, 1))')
    expect(host.output()).toContain('Z')
  })

  it('PRINT wraps at the right edge and scrolls at the bottom', () => {
    const { screen } = ok('FOR i = 1 TO 30\n  PRINT "line"; i\nNEXT i')
    // Thirty lines into a 25-row screen. The last PRINT ends with a newline,
    // which scrolls once more, so the text sits a row above the cursor.
    expect(screen.rowText(24)).toContain('30')
    expect(screen.rowText(25)).toBe('')
    expect(screen.rowText(1)).not.toContain('line 1 ')
  })

  it('TAB moves to a column, SPC inserts a gap', () => {
    const { screen } = ok('PRINT "A"; TAB(10); "B"; SPC(3); "C";')
    expect(screen.charAt(1, 1)).toBe('A')
    expect(screen.charAt(1, 10)).toBe('B')
    expect(screen.charAt(1, 14)).toBe('C')
  })

  it('VIEW PRINT scrolls only inside its rows', () => {
    const { screen } = ok('LOCATE 1, 1\nPRINT "TOP";\nVIEW PRINT 10 TO 12\nFOR i = 1 TO 8\n  PRINT i\nNEXT i')
    expect(screen.rowText(1)).toBe('TOP')
    // Rows 1 to 9 are untouched by a viewport that starts at 10.
    expect(screen.rowText(11)).toContain('8')
    expect(screen.rowText(9)).toBe('')
  })
})

describe('CLS', () => {
  it('with no argument clears pixels and text', () => {
    const { screen } = ok('SCREEN 13\nPSET (5, 5), 3\nPRINT "X";\nCLS')
    expect(at(screen, 5, 5)).toBe(0)
    expect(screen.rowText(1)).toBe('')
  })

  it('CLS 1 clears the picture but keeps the text', () => {
    const { screen } = ok('SCREEN 13\nLOCATE 1, 1\nPRINT "KEEP";\nPSET (5, 5), 3\nCLS 1')
    expect(at(screen, 5, 5)).toBe(0)
    expect(screen.rowText(1)).toBe('KEEP')
  })

  it('CLS 2 clears the text but keeps the picture', () => {
    const { screen } = ok('SCREEN 13\nLOCATE 1, 1\nPRINT "GONE";\nPSET (5, 5), 3\nCLS 2')
    expect(at(screen, 5, 5)).toBe(3)
    expect(screen.rowText(1)).toBe('')
  })
})

describe('VIEW', () => {
  it('clips drawing to the viewport', () => {
    const { screen } = ok('SCREEN 13\nVIEW (100, 100)-(150, 150)\nLINE (0, 0)-(300, 0), 5')
    // The line is drawn at viewport-relative y=0, which is physical y=100.
    expect(at(screen, 120, 100)).toBe(5)
    expect(at(screen, 50, 100)).toBe(0)
    expect(at(screen, 200, 100)).toBe(0)
  })

  it('VIEW SCREEN keeps coordinates absolute but still clips', () => {
    const { screen } = ok('SCREEN 13\nVIEW SCREEN (100, 100)-(150, 150)\nLINE (0, 120)-(300, 120), 5')
    expect(at(screen, 120, 120)).toBe(5)
    expect(at(screen, 50, 120)).toBe(0)
  })

  it('paints the viewport when given a fill colour', () => {
    const { screen } = ok('SCREEN 13\nVIEW (10, 10)-(19, 19), 6')
    expect(count(screen, 6)).toBe(100)
  })

  it('a bare VIEW gives the whole screen back', () => {
    const { screen } = ok('SCREEN 13\nVIEW (100, 100)-(150, 150)\nVIEW\nPSET (5, 5), 8')
    expect(at(screen, 5, 5)).toBe(8)
  })
})

describe('WINDOW', () => {
  it('maps world coordinates onto the screen', () => {
    const { screen } = ok('SCREEN 12\nWINDOW (0, 0)-(1, 1)\nPSET (1, 1), 4')
    // Without SCREEN, y grows upwards: (1,1) is the top-right corner.
    expect(at(screen, 639, 0)).toBe(4)
  })

  it('WINDOW SCREEN keeps y growing downwards', () => {
    const { screen } = ok('SCREEN 12\nWINDOW SCREEN (0, 0)-(1, 1)\nPSET (1, 1), 4')
    expect(at(screen, 639, 479)).toBe(4)
  })

  it('PMAP converts between the two coordinate systems', () => {
    const { host } = ok('SCREEN 12\nWINDOW SCREEN (0, 0)-(100, 100)\nPRINT PMAP(50, 0)')
    // Half way across a 640-pixel screen.
    expect(host.output()).toContain('320')
  })

  it('a bare WINDOW restores pixel coordinates', () => {
    const { screen } = ok('SCREEN 12\nWINDOW (0, 0)-(1, 1)\nWINDOW\nPSET (5, 5), 7')
    expect(at(screen, 5, 5)).toBe(7)
  })
})

describe('PALETTE', () => {
  it('remaps an attribute without touching the pixels', () => {
    const { screen } = ok('SCREEN 13\nPSET (5, 5), 1\nPALETTE 1, 63')
    // The pixel still holds attribute 1; only what 1 looks like changed.
    expect(at(screen, 5, 5)).toBe(1)
    expect(screen.palette[1]).toBe(0xff0000)
  })

  it('a bare PALETTE puts the mode default back', () => {
    const { screen } = ok('SCREEN 13\nPALETTE 1, 63\nPALETTE')
    expect(screen.palette[1]).toBe(0x0000aa)
  })
})

describe('GET and PUT', () => {
  const sprite = `SCREEN 13
DIM box(400)
LINE (0, 0)-(9, 9), 3, BF
GET (0, 0)-(9, 9), box
`

  it('captures a rectangle and blits it somewhere else', () => {
    const { screen } = ok(`${sprite}PUT (100, 100), box, PSET`)
    expect(at(screen, 105, 105)).toBe(3)
    expect(at(screen, 111, 105)).toBe(0)
  })

  it('writes the header words a listing might read back', () => {
    const { host } = ok(`${sprite}PRINT box(0); box(1)`)
    // Ten pixels wide at eight bits each, and ten rows.
    expect(host.output()).toContain('80')
    expect(host.output()).toContain('10')
  })

  it('XOR twice leaves the screen as it was — how a sprite is animated', () => {
    const { screen } = ok(`${sprite}PSET (100, 100), 7
PUT (100, 100), box, XOR
PUT (100, 100), box, XOR`)
    expect(at(screen, 100, 100)).toBe(7)
    expect(at(screen, 105, 105)).toBe(0)
  })

  it('refuses to PUT from an array nothing was captured into', () => {
    expect(run('SCREEN 13\nDIM a(100)\nPUT (0, 0), a, PSET').error).toContain('no GET filled')
  })
})

describe('WIDTH', () => {
  it('changes the text grid in SCREEN 0', () => {
    const { screen } = ok('WIDTH 40\nPRINT "X";')
    expect(screen.cols).toBe(40)
    expect(screen.charAt(1, 1)).toBe('X')
  })

  it('rejects a width the mode cannot show', () => {
    expect(run('SCREEN 13\nWIDTH 80').error).toContain('Illegal function call')
  })
})

describe('INKEY$ and SLEEP', () => {
  it('INKEY$ is empty when nothing was typed', () => {
    const { host } = ok('a$ = INKEY$\nPRINT "["; a$; "]"')
    expect(host.output()).toContain('[]')
  })

  it('INKEY$ hands back queued keys in order', () => {
    const host = recordingHost()
    host.press('a')
    host.press('b')
    const vm = new Interpreter(build('PRINT INKEY$; INKEY$'), host, undefined, new Screen(0))
    vm.start()
    while (vm.status === 'running') vm.runSlice({ maxSteps: 5000 })
    expect(host.output()).toContain('ab')
  })

  it('SLEEP holds the program, and the pump is told for how long', () => {
    let clock = 0
    const vm = new Interpreter(
      build('SLEEP 2\nPRINT "AWAKE"'),
      recordingHost(),
      () => clock,
      new Screen(0),
    )
    vm.start()
    vm.runSlice({ maxSteps: 100 })
    expect(vm.status).toBe('running')
    expect(vm.sleepDelayMs).toBe(2000)

    clock = 2001
    vm.runSlice({ maxSteps: 100 })
    expect(vm.status).toBe('done')
  })
})

describe('rendering', () => {
  it('turns attributes into RGBA through the palette', () => {
    const { screen } = ok('SCREEN 13\nPSET (0, 0), 4')
    const out = new Uint8ClampedArray(screen.displayW * screen.displayH * 4)
    screen.renderInto(out)
    // Attribute 4 is EGA red.
    expect([out[0], out[1], out[2], out[3]]).toEqual([170, 0, 0, 255])
  })

  it('draws text over the picture', () => {
    const { screen } = ok('SCREEN 13\nLOCATE 1, 1\nPRINT "A";')
    const out = new Uint8ClampedArray(screen.displayW * screen.displayH * 4)
    screen.renderInto(out)
    // The A's apex sits in the third column of the first cell's top row.
    const px = (x: number, y: number) => out[(y * screen.displayW + x) * 4]
    expect(px(2, 0)).toBe(255)
    expect(px(0, 0)).toBe(0)
  })

  it('reports the aspect ratio the mode was displayed at', () => {
    expect(ok('SCREEN 13').screen.aspect).toBeCloseTo(1.2, 5)
    expect(ok('SCREEN 12').screen.aspect).toBeCloseTo(1, 5)
    expect(ok('SCREEN 2').screen.aspect).toBeCloseTo(2.4, 5)
  })

  it('bumps its version when something is drawn, so the window can idle', () => {
    const { screen } = ok('SCREEN 13\nPSET (1, 1), 1')
    const before = screen.version
    screen.renderInto(new Uint8ClampedArray(screen.displayW * screen.displayH * 4))
    expect(screen.version).toBe(before)
  })
})

describe('the programs shipped on the disk', () => {
  const read = (name: string) => useFs.getState().read(`/boot/home/basic/${name}`) ?? ''

  it('sunset.bas draws without error', () => {
    const { screen, error } = run(read('sunset.bas'))
    expect(error).toBeNull()
    expect(screen.info.mode).toBe(13)
    // The sun was flooded, so plenty of pixels carry its attribute.
    expect(count(screen, 44)).toBeGreaterThan(1000)
    expect(screen.rowText(24)).toContain('BEANWEB QBASIC')
  })

  it('stars.bas compiles, and stops on a keystroke', () => {
    const source = read('stars.bas')
    expect(() => build(source)).not.toThrow()

    const host = recordingHost()
    const vm = new Interpreter(build(source), host, undefined, new Screen(0))
    vm.start()
    // Let the starfield turn over, then press a key to break the loop.
    for (let i = 0; i < 20; i += 1) vm.runSlice({ maxSteps: 2000 })
    expect(vm.status).toBe('running')

    host.press('x')
    let guard = 0
    while (vm.status === 'running' && guard < 200) {
      vm.runSlice({ maxSteps: 2000 })
      guard += 1
    }
    expect(vm.status).toBe('done')
    expect(host.output()).toContain('Goodbye')
  })
})
