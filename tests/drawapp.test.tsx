import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { Draw } from '@/apps/Draw'
import { Alerts } from '@/shell/Alerts'
import { SavePanel } from '@/shell/SavePanel'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'
import { parseSVG } from '@/lib/draw'
import type { RectShape } from '@/lib/draw'

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)]
const byText = <T extends Element = HTMLElement>(sel: string, text: string) =>
  $$<T>(sel).find((n) => n.textContent === text)!

/**
 * The app plus the two modal layers it talks to. `Desktop` renders SavePanel
 * before Alerts so the panel's own overwrite prompt paints above it; the order
 * is copied here for the same reason.
 */
function mount(args?: Record<string, string>) {
  const id = useDesktop.getState().openWindow({ appId: 'draw', title: 'Draw' })
  const view = render(
    <>
      <Draw windowId={id} args={args} />
      <SavePanel />
      <Alerts />
    </>,
  )
  return { id, ...view }
}

const surface = () => $<SVGSVGElement>('.draw-surface')!
const tool = (label: string) => $$<HTMLButtonElement>('.draw-tool').find((b) => b.getAttribute('aria-label') === label)!

/**
 * Under jsdom `getBoundingClientRect()` is all zeros and the zoom is 1, so
 * `toDocPoint` degenerates to the raw client coordinates -- which is exactly
 * what lets these tests drive the real gesture code with plain numbers.
 */
const drag = (from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(surface(), { button: 0, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(window)
}

const click = (el: Element, at: [number, number] = [0, 0]) => {
  fireEvent.pointerDown(el, { button: 0, clientX: at[0], clientY: at[1] })
  fireEvent.pointerUp(window)
}

const openMenu = (title: string) => {
  act(() => {
    fireEvent.pointerDown(byText('.draw .b-menubar-item', title), { button: 0 })
  })
  return $$<HTMLButtonElement>('.b-menu-item')
}
const menuItem = (title: string, label: string) =>
  openMenu(title).find((n) => n.textContent?.startsWith(label))!

const alertButton = (label: string) =>
  $$<HTMLButtonElement>('.b-alert-buttons .b-button').find((b) => b.textContent === label)!

describe('Draw: tools and drawing', () => {
  it('starts on the pick tool with an empty page', () => {
    mount()
    expect($('.draw')!.getAttribute('data-tool')).toBe('pick')
    expect($('.draw-status')!.textContent).toContain('0 objects')
  })

  it('switches tools from the toolbox', () => {
    mount()
    fireEvent.click(tool('Ellipse'))
    expect($('.draw')!.getAttribute('data-tool')).toBe('ellipse')
    expect(tool('Ellipse').getAttribute('aria-pressed')).toBe('true')
  })

  it('drags out a rectangle at the coordinates released', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 20], [110, 70])
    const rect = $<SVGRectElement>('[data-id] rect')!
    expect(rect.getAttribute('x')).toBe('10')
    expect(rect.getAttribute('y')).toBe('20')
    expect(rect.getAttribute('width')).toBe('100')
    expect(rect.getAttribute('height')).toBe('50')
  })

  it('drags out an ellipse and returns to the pick tool', () => {
    mount()
    fireEvent.click(tool('Ellipse'))
    drag([100, 100], [200, 160])
    const el = $<SVGEllipseElement>('[data-id] ellipse')!
    expect(el.getAttribute('cx')).toBe('150')
    expect(el.getAttribute('rx')).toBe('50')
    expect(el.getAttribute('ry')).toBe('30')
    // Drawing one shape hands the pointer back, as CorelDRAW does.
    expect($('.draw')!.getAttribute('data-tool')).toBe('pick')
  })

  it('ignores a stray click that draws nothing', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([50, 50], [51, 51])
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('collects a freehand stroke into one open path', () => {
    mount()
    fireEvent.click(tool('Freehand'))
    fireEvent.pointerDown(surface(), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 30 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 25 })
    fireEvent.pointerUp(window)
    const d = $<SVGPathElement>('[data-id] path')!.getAttribute('d')!
    expect(d.startsWith('M 10 10')).toBe(true)
    expect(d).not.toContain('Z')
  })

  it('builds a polyline click by click and finishes on a double-click', () => {
    mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [50, 0])
    click(surface(), [50, 40])
    expect($$('[data-id]')).toHaveLength(0) // still in progress
    fireEvent.doubleClick(surface())
    expect($<SVGPathElement>('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 50 0 L 50 40')
  })

  it('snaps a polyline point onto a nearby corner of an existing shape', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(tool('Polyline'))
    // Four units off the rect's top-left corner, well inside the snap radius.
    click(surface(), [14, 13])
    click(surface(), [200, 200])
    fireEvent.doubleClick(surface())
    const line = $$<SVGPathElement>('[data-id] path').at(-1)!
    expect(line.getAttribute('d')).toBe('M 10 10 L 200 200')
  })

  it('leaves a point alone when nothing is near enough to snap to', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(tool('Polyline'))
    click(surface(), [40, 13])
    click(surface(), [200, 200])
    fireEvent.doubleClick(surface())
    expect($$<SVGPathElement>('[data-id] path').at(-1)!.getAttribute('d')).toBe('M 40 13 L 200 200')
  })

  it('closes the polyline when the last click lands back on the first point', () => {
    mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [50, 0])
    click(surface(), [50, 40])
    // Near the start, not on it: the snap is what makes this a closing click.
    click(surface(), [3, 2])
    // It finishes there too -- no double-click, and no Object -> Close curve.
    expect($<SVGPathElement>('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 50 0 L 50 40 Z')
    expect($('.draw')!.getAttribute('data-tool')).toBe('pick')
  })

  it('does not leave a duplicate node under a double-click that finishes', () => {
    mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [50, 0])
    // A real double-click presses once more on the point just placed first.
    click(surface(), [50, 40])
    click(surface(), [50, 40])
    fireEvent.doubleClick(surface())
    expect($<SVGPathElement>('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 50 0 L 50 40')
  })

  it('takes back the last polyline point on Backspace', () => {
    mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [50, 0])
    click(surface(), [50, 40])
    fireEvent.keyDown(window, { key: 'Backspace' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect($<SVGPathElement>('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 50 0')
  })

  it('does not leave the polyline rubber-band listener on the window', () => {
    // The listener has to outlive the pointerup of its own click -- the band
    // follows the pointer *between* clicks -- so nothing about its lifetime is
    // a drag's. Two lines drawn without a move between them used to leave the
    // first one's listener attached for the life of the tab, both of them then
    // writing the same `cur`.
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const live = () => {
      const fns = new Set<unknown>()
      for (const c of add.mock.calls) if (c[0] === 'pointermove') fns.add(c[1])
      for (const c of remove.mock.calls) if (c[0] === 'pointermove') fns.delete(c[1])
      return fns.size
    }

    const { unmount } = mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [50, 0])
    expect(live()).toBe(1)
    fireEvent.doubleClick(surface())

    // A second line begun before the pointer has moved: the first listener is
    // still on the window and has had no chance to drop itself.
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 60])
    click(surface(), [50, 60])
    expect(live()).toBe(1)
    fireEvent.doubleClick(surface())

    unmount()
    expect(live()).toBe(0)
  })

  it('places a line of text where it was clicked, ready to be typed over', () => {
    mount()
    fireEvent.click(tool('Text'))
    click(surface(), [40, 90])
    const text = $<SVGTextElement>('[data-id] text')!
    expect(text.textContent).toBe('Text')
    expect(text.getAttribute('x')).toBe('40')
    // It opens for typing where it sits, so the placeholder can be replaced
    // without first finding the field in the side panel.
    const editor = $<HTMLInputElement>('input[aria-label="Edit text"]')!
    expect(editor.value).toBe('Text')
    // And the object itself is not drawn twice while the editor stands in.
    expect($('[data-id]')!.getAttribute('visibility')).toBe('hidden')
    fireEvent.change(editor, { target: { value: 'Beans' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect($('[data-id] text')!.textContent).toBe('Beans')
    expect($('input[aria-label="Edit text"]')).toBeNull()
    expect($('[data-id]')!.getAttribute('visibility')).toBeNull()
  })

  it('offers the content of a selected text object in the side panel too', () => {
    mount()
    fireEvent.click(tool('Text'))
    click(surface(), [40, 90])
    fireEvent.keyDown($('input[aria-label="Edit text"]')!, { key: 'Escape' })
    const field = $<HTMLInputElement>('.draw-side input[aria-label="Text content"]')!
    fireEvent.change(field, { target: { value: 'Beans' } })
    expect($('[data-id] text')!.textContent).toBe('Beans')
  })
})

describe('Draw: the line tool', () => {
  /** The shape's own path; `Hitbox` renders a second one in the same group. */
  const line = () => $$<SVGPathElement>('[data-id] > path')[0]

  it('draws a single straight line between the two points', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([10, 20], [110, 70])
    expect(line().getAttribute('d')).toBe('M 10 20 L 110 70')
    expect($$('[data-id]')).toHaveLength(1)
    // One drawn shape hands the pointer back, as the other shape tools do.
    expect($('.draw')!.getAttribute('data-tool')).toBe('pick')
  })

  it('keeps a horizontal line, which has no height at all', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([10, 40], [120, 40])
    // The rect tool's `w < 2 || h < 2` guard would throw this away, and a
    // vertical one with it -- the two lines people draw most.
    expect(line().getAttribute('d')).toBe('M 10 40 L 120 40')
  })

  it('keeps a vertical line, which has no width at all', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([50, 10], [50, 130])
    expect(line().getAttribute('d')).toBe('M 50 10 L 50 130')
  })

  it('ignores a stray click that draws nothing', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([50, 50], [51, 51])
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('snaps both ends onto nearby points', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([0, 0], [100, 0])
    fireEvent.click(tool('Line'))
    // Starts three units off one end and finishes two off the other.
    drag([3, 2], [98, 2])
    expect($$<SVGPathElement>('[data-id] > path').at(-1)!.getAttribute('d')).toBe('M 0 0 L 100 0')
  })

  it('is a stroke with no fill, and is grabbable along its length', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([10, 20], [110, 70])
    expect(line().getAttribute('fill')).toBe('none')
    // An unfilled path encloses nothing, so a filled hit copy catches nothing
    // and the only target would be a one-unit stroke.
    const hit = $$<SVGPathElement>('[data-id] > path')[1]
    expect(hit.getAttribute('stroke')).toBe('transparent')
    expect(Number(hit.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(8)
  })

  it('gives the node tool something to bend', () => {
    mount()
    fireEvent.click(tool('Line'))
    drag([0, 0], [100, 0])
    fireEvent.click(tool('Node'))
    click($$<SVGPathElement>('[data-id] > path')[1], [50, 0])
    expect($$('[data-node$=":p"]')).toHaveLength(2)
  })
})

describe('Draw: text', () => {
  const editor = () => $<HTMLInputElement>('input[aria-label="Edit text"]')
  const label = () => $('[data-id] text')!.textContent
  /** A placed line of text, with the editor it opens already dismissed. */
  const withText = (at: [number, number] = [40, 90]) => {
    const r = mount()
    fireEvent.click(tool('Text'))
    click(surface(), at)
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    return r
  }

  it('edits a line of text in place when it is double-clicked', () => {
    withText()
    expect(editor()).toBeNull()
    fireEvent.doubleClick($('[data-id] text')!)
    expect(editor()!.value).toBe('Text')
    fireEvent.change(editor()!, { target: { value: 'Beans' } })
    fireEvent.keyDown(editor()!, { key: 'Enter' })
    expect(label()).toBe('Beans')
  })

  it('abandons an edit on Escape, keeping what was there', () => {
    withText()
    fireEvent.doubleClick($('[data-id] text')!)
    fireEvent.change(editor()!, { target: { value: 'scrapped' } })
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    expect(label()).toBe('Text')
    expect(editor()).toBeNull()
  })

  it('edits the text under the text tool rather than stacking another on it', () => {
    withText()
    fireEvent.click(tool('Text'))
    click($('[data-id] text')!, [45, 90])
    // One object, opened for typing. It used to drop a second "Text" on top,
    // which is what "I cannot edit the text" looks like from the outside.
    expect($$('[data-id]')).toHaveLength(1)
    expect(editor()!.value).toBe('Text')
  })

  it('removes a line of text that is emptied, rather than leaving a ghost', () => {
    withText()
    fireEvent.doubleClick($('[data-id] text')!)
    fireEvent.change(editor()!, { target: { value: '' } })
    fireEvent.keyDown(editor()!, { key: 'Enter' })
    // Zero width, unclickable and invisible -- better gone than haunting.
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('counts a whole edit as one undo step, not one per keystroke', () => {
    withText()
    const field = $<HTMLInputElement>('.draw-side input[aria-label="Text content"]')!
    for (const v of ['Te', 'Tex', 'Text!', 'Text!!']) {
      fireEvent.change(field, { target: { value: v } })
    }
    expect(label()).toBe('Text!!')
    fireEvent.click(menuItem('Edit', 'Undo'))
    // One press goes back past the whole run, not one letter of it.
    expect(label()).toBe('Text')
  })

  it('sets the size of the selected text and remembers it for the next one', () => {
    withText()
    const size = $<HTMLInputElement>('.draw-side input[aria-label="Font size"]')!
    expect(size.value).toBe('24')
    fireEvent.change(size, { target: { value: '48' } })
    expect($('[data-id] text')!.getAttribute('font-size')).toBe('48')

    fireEvent.click(tool('Text'))
    click(surface(), [40, 300])
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    expect($$('[data-id] text').at(-1)!.getAttribute('font-size')).toBe('48')
  })

  it('offers the size and the face before anything is placed', () => {
    mount()
    fireEvent.click(tool('Text'))
    expect($('.draw-side input[aria-label="Font size"]')).toBeTruthy()
    expect($('.draw-side [role="group"][aria-label="Font"]')).toBeTruthy()
    // Nothing is selected, so there is no content to offer yet.
    expect($('.draw-side input[aria-label="Text content"]')).toBeNull()
  })

  it('switches the face from the panel', () => {
    withText()
    const serif = $$<HTMLButtonElement>('[role="group"][aria-label="Font"] button')
      .find((b) => b.textContent === 'Serif')!
    fireEvent.click(serif)
    expect($('[data-id] text')!.getAttribute('font-family')).toContain('Georgia')
    expect(serif.getAttribute('aria-pressed')).toBe('true')
  })

  it('saves a real font stack, not a CSS variable', async () => {
    const panelButton = (l: string) =>
      $$<HTMLButtonElement>('.savepanel .b-button').find((b) => b.textContent === l)!
    withText()
    fireEvent.click(menuItem('File', 'Save'))
    await waitFor(() => expect($('.savepanel')).toBeTruthy())
    fireEvent.click(panelButton('Save'))
    await waitFor(() => expect(useFs.getState().read('/boot/home/drawings/Untitled.svg')).toBeTruthy())
    const written = useFs.getState().read('/boot/home/drawings/Untitled.svg')!
    // `var(--font-plain)` resolves to nothing outside this page, so a drawing
    // saved with it opened everywhere else in the reader's default face.
    expect(written).not.toContain('var(--')
    expect(written).toContain('DejaVu Sans')
  })
})

describe('Draw: selection and transforms', () => {
  const withRect = () => {
    const r = mount()
    fireEvent.click(tool('Rectangle'))
    drag([100, 100], [200, 150])
    return r
  }

  it('shows eight resize handles and a rotate grip on the selection', () => {
    withRect()
    expect($$('[data-handle]')).toHaveLength(9)
    expect($('[data-handle="rot"]')).toBeTruthy()
  })

  it('drops the selection when the page is clicked', () => {
    withRect()
    click($('.draw-page')!, [400, 400])
    expect($$('[data-handle]')).toHaveLength(0)
  })

  it('reports the selection in the status line', () => {
    withRect()
    expect($('.draw-status')!.textContent).toContain('Rect')
    expect($('.draw-status')!.textContent).toContain('w 100')
  })

  it('moves a shape by dragging it', () => {
    withRect()
    fireEvent.pointerDown($('[data-id] rect')!, { button: 0, clientX: 150, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 170, clientY: 130 })
    fireEvent.pointerUp(window)
    expect($('[data-id] rect')!.getAttribute('x')).toBe('120')
    expect($('[data-id] rect')!.getAttribute('y')).toBe('110')
  })

  it('grows the page when a shape is dragged off the edge of it', () => {
    withRect()
    // The page is PAGE_W wide; drag the rect's right edge well past it.
    fireEvent.pointerDown($('[data-id] rect')!, { button: 0, clientX: 150, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 550, clientY: 120 })
    fireEvent.pointerUp(window)
    expect($('[data-id] rect')!.getAttribute('x')).toBe('500')
    // Without this the shape sits outside a viewBox that never grew, and the
    // half of it past 512 is clipped away.
    expect(Number(surface().getAttribute('width'))).toBe(600)
  })

  it('resizes from a corner handle, leaving the opposite corner alone', () => {
    withRect()
    fireEvent.pointerDown($('[data-handle="se"]')!, { button: 0, clientX: 200, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 260, clientY: 190 })
    fireEvent.pointerUp(window)
    const rect = $('[data-id] rect')!
    expect(rect.getAttribute('x')).toBe('100')
    expect(rect.getAttribute('y')).toBe('100')
    expect(rect.getAttribute('width')).toBe('160')
    expect(rect.getAttribute('height')).toBe('90')
  })

  it('rotates from the grip and keeps the shape a rect', () => {
    withRect()
    const grip = $('[data-handle="rot"]')!
    // Centre is (150,125); dragging to due-east is a quarter turn from due-north.
    fireEvent.pointerDown(grip, { button: 0, clientX: 150, clientY: 60 })
    fireEvent.pointerMove(window, { clientX: 260, clientY: 125 })
    fireEvent.pointerUp(window)
    const g = $('[data-id]')!
    expect(g.getAttribute('transform')).toMatch(/^rotate\(90 /)
    expect(g.querySelector('rect')).toBeTruthy()
  })

  it('duplicates and deletes through the side panel', () => {
    withRect()
    fireEvent.click(byText('.draw-buttons .b-button', 'Duplicate'))
    expect($$('[data-id]')).toHaveLength(2)
    fireEvent.click(byText('.draw-buttons .b-button', 'Delete'))
    expect($$('[data-id]')).toHaveLength(1)
  })

  it('deletes the selection with the Delete key', () => {
    const { id } = withRect()
    act(() => useDesktop.getState().focusWindow(id))
    act(() => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('reorders with the Arrange menu, front-most last', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [60, 60])
    const first = $('[data-id]')!.getAttribute('data-id')
    fireEvent.click(tool('Rectangle'))
    drag([100, 10], [150, 60])
    // The second rect is selected and is already at the front; send it back.
    fireEvent.click(menuItem('Arrange', 'To back'))
    expect($$('[data-id]')[1].getAttribute('data-id')).toBe(first)
  })

  it('changes the fill of the selected shape from the palette', () => {
    withRect()
    fireEvent.click($$<HTMLButtonElement>('.draw-swatches .draw-swatch')[3])
    expect($('[data-id] rect')!.getAttribute('fill')).not.toBe('#ffc900')
  })
})

describe('Draw: rounded corners', () => {
  const field = () => $<HTMLInputElement>('input[aria-label="Corner radius"]')!

  it('offers the radius while the rectangle tool is up', () => {
    mount()
    expect(field()).toBeNull()
    fireEvent.click(tool('Rectangle'))
    expect(field()).toBeTruthy()
  })

  it('rounds the selected rectangle', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.change(field(), { target: { value: '12' } })
    expect($('[data-id] rect')!.getAttribute('rx')).toBe('12')
  })

  it('remembers the radius for the next rectangle drawn', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.change(field(), { target: { value: '9' } })
    fireEvent.click(tool('Rectangle'))
    drag([150, 10], [250, 60])
    expect($$('[data-id] rect').map((r) => r.getAttribute('rx'))).toEqual(['9', '9'])
  })

  it('is not offered for an ellipse', () => {
    mount()
    fireEvent.click(tool('Ellipse'))
    drag([10, 10], [110, 60])
    expect(field()).toBeNull()
  })
})

describe('Draw: gradient fill', () => {
  const mode = (label: string) =>
    $$<HTMLButtonElement>('.draw-mode').find((b) => b.getAttribute('aria-label') === label)!
  const swatchRows = () => $$('.draw-swatches')

  const withRect = () => {
    const r = mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    return r
  }

  it('starts flat and offers the three fill types', () => {
    withRect()
    expect(mode('Flat fill').getAttribute('aria-pressed')).toBe('true')
    expect(mode('linear gradient')).toBeTruthy()
    expect(mode('radial gradient')).toBeTruthy()
  })

  it('fills a shape with a linear gradient defined in the same SVG', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    const rect = $('[data-id] rect')!
    expect(rect.getAttribute('fill')).toBe('url(#bw-grad-0)')
    const grad = $('#bw-grad-0')!
    expect(grad).toBeTruthy()
    expect(grad.tagName.toLowerCase()).toBe('lineargradient')
    expect(grad.querySelectorAll('stop')).toHaveLength(2)
  })

  it('keeps the flat colour as the first stop when switching', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    expect($('#bw-grad-0 stop')!.getAttribute('stop-color')).toBe('#ffc900')
  })

  it('shows a second swatch row and an angle only for a gradient', () => {
    withRect()
    expect(swatchRows()).toHaveLength(2) // fill + outline
    expect($('input[aria-label="Gradient angle"]')).toBeNull()
    fireEvent.click(mode('linear gradient'))
    expect(swatchRows()).toHaveLength(3)
    expect($<HTMLInputElement>('input[aria-label="Gradient angle"]')!.value).toBe('90')
  })

  it('turns the ramp with the angle field', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    fireEvent.change($('input[aria-label="Gradient angle"]')!, { target: { value: '0' } })
    const grad = $('#bw-grad-0')!
    expect(grad.getAttribute('x1')).toBe('0')
    expect(grad.getAttribute('x2')).toBe('1')
  })

  it('has no angle for a radial gradient', () => {
    withRect()
    fireEvent.click(mode('radial gradient'))
    expect($('#bw-grad-0')!.tagName.toLowerCase()).toBe('radialgradient')
    expect($('input[aria-label="Gradient angle"]')).toBeNull()
  })

  it('sets the far end of the ramp from the second row', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    const second = swatchRows()[1]
    const swatch = second.querySelectorAll<HTMLButtonElement>('.draw-swatch')[0]
    fireEvent.click(swatch)
    const stops = $$('#bw-grad-0 stop')
    expect(stops[1].getAttribute('stop-color')).toBe(swatch.getAttribute('aria-label'))
  })

  it('goes back to a flat fill, keeping the first stop', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    fireEvent.click(mode('Flat fill'))
    expect($('[data-id] rect')!.getAttribute('fill')).toBe('#ffc900')
    expect($('#bw-grad-0')).toBeNull()
  })

  it('reflects the selected shape rather than the last tool colour', () => {
    withRect()
    fireEvent.click(mode('linear gradient'))
    // The tool keeps the style, so the next shape is drawn with the gradient
    // too. Put that one back to flat and the panel is showing the ellipse.
    fireEvent.click(tool('Ellipse'))
    drag([200, 10], [300, 80])
    expect($('[data-id] ellipse')!.getAttribute('fill')).toBe('url(#bw-grad-1)')
    fireEvent.click(mode('Flat fill'))
    expect(mode('Flat fill').getAttribute('aria-pressed')).toBe('true')

    // Selecting the rect again has to bring its gradient back into the panel.
    click($('[data-id] rect')!, [50, 30])
    expect(mode('linear gradient').getAttribute('aria-pressed')).toBe('true')
    expect($<HTMLInputElement>('input[aria-label="Gradient angle"]')!.value).toBe('90')
  })

  it('survives a save and reopen', async () => {
    const panelButton = (label: string) =>
      $$<HTMLButtonElement>('.savepanel .b-button').find((b) => b.textContent === label)!
    withRect()
    fireEvent.click(mode('radial gradient'))
    fireEvent.click(menuItem('File', 'Save'))
    await waitFor(() => expect($('.savepanel')).toBeTruthy())
    fireEvent.click(panelButton('Save'))
    await waitFor(() => expect(useFs.getState().read('/boot/home/drawings/Untitled.svg')).toBeTruthy())

    const written = useFs.getState().read('/boot/home/drawings/Untitled.svg')!
    expect(written).toContain('<radialGradient id="bw-grad-0"')
    const doc = parseSVG(written)
    expect(doc.lossy).toEqual([])
    expect((doc.shapes[0] as RectShape).style.fill).toMatchObject({ kind: 'radial' })
  })
})

describe('Draw: curves and nodes', () => {
  it('converts a rect to curves and shows its nodes', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(menuItem('Object', 'Convert to curves'))
    // Converting switches to the node tool, which draws a node per corner.
    expect($('.draw')!.getAttribute('data-tool')).toBe('node')
    expect($$('[data-node$=":p"]')).toHaveLength(4)
    expect($('[data-id] path')).toBeTruthy()
  })

  it('outlines a rect under the node tool and says how to get nodes out of it', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(tool('Node'))
    click($('[data-id] rect')!, [50, 30])
    // Not a dead tool: the selection is still drawn, just without handles.
    expect($('.draw-marchers')).toBeTruthy()
    expect($$('[data-handle]')).toHaveLength(0)
    expect($('.draw-status')!.textContent).toContain('convert it to curves')
  })

  it('converts a rect to curves when the node tool double-clicks it', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(tool('Node'))
    click($('[data-id] rect')!, [50, 30])
    fireEvent.doubleClick($('[data-id] rect')!)
    expect($$('[data-node$=":p"]')).toHaveLength(4)
    expect($('[data-id] path')).toBeTruthy()
  })

  /** A two-node line under the node tool, selected at its LAST node. */
  const lineAtLastNode = () => {
    const r = mount()
    fireEvent.click(tool('Line'))
    drag([0, 0], [100, 0])
    fireEvent.click(tool('Node'))
    click($$<SVGPathElement>('[data-id] > path')[1], [50, 0])
    click($('[data-node="1:p"]')!, [100, 0])
    expect($('.draw-status')!.textContent).toContain('node 2 of 2')
    return r
  }

  it('offers no Insert on the last node of an open path, and no Delete at the minimum', () => {
    lineAtLastNode()
    const items = openMenu('Object')
    const item = (l: string) => items.find((n) => n.textContent?.startsWith(l))!
    // There is no segment after the last node of an open path to split, and
    // two nodes is the fewest a line can be drawn with.
    expect(item('Insert node').disabled).toBe(true)
    expect(item('Delete node').disabled).toBe(true)
    // The one that can still act is not dragged down with them.
    expect(item('Smooth node').disabled).toBe(false)
  })

  it('records no undo step when the Delete key is refused at the minimum', () => {
    lineAtLastNode()
    // The key has no disabled state to stop it, so it is the live route into
    // `editNode` at a boundary.
    fireEvent.keyDown(window, { key: 'Delete' })
    expect($('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 100 0')
    // `replaceShape` builds a new document around even an identical shape, and
    // a new object is what `commit` reads as an edit -- so the refusal used to
    // cost an undo step, and one Undo no longer reached the line itself.
    fireEvent.click(menuItem('Edit', 'Undo'))
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('keeps the chosen node when an edit is refused', () => {
    lineAtLastNode()
    fireEvent.keyDown(window, { key: 'Delete' })
    // `after` used to clear the selection for an edit that never happened.
    expect($('.draw-status')!.textContent).toContain('node 2 of 2')
    expect($('[data-node="1:p"]')!.getAttribute('data-active')).toBe('true')
    // And the whole line is certainly not deleted instead.
    expect($$('[data-id]')).toHaveLength(1)
  })

  it('drags a node and moves only that corner', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(menuItem('Object', 'Convert to curves'))
    fireEvent.pointerDown($('[data-node="0:p"]')!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 30, clientY: 0 })
    fireEvent.pointerUp(window)
    expect($('[data-id] path')!.getAttribute('d')!.startsWith('M 30 0')).toBe(true)
  })

  it('keeps the selection when a segment of the edited curve is pressed', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(menuItem('Object', 'Convert to curves'))
    expect($$('[data-node$=":p"]')).toHaveLength(4)
    // The segment stripes are seven units wide and lie over the curve. A press
    // on one used to fall through to "clicked the background" and drop the
    // selection, so clicking your own curve made every node vanish.
    click($('[data-seg="0"]')!, [50, 10])
    expect($$('[data-node$=":p"]')).toHaveLength(4)
  })

  it('inserts a node when a segment is double-clicked', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(menuItem('Object', 'Convert to curves'))
    // The real sequence: a double-click presses first, and that press has to
    // leave the path selected or there is nothing left to split. jsdom's
    // `doubleClick` fires no `pointerdown` of its own, so a test that only
    // called it passed while the browser did nothing at all.
    click($('[data-seg="0"]')!, [50, 10])
    fireEvent.doubleClick($('[data-seg="0"]')!)
    expect($$('[data-node$=":p"]')).toHaveLength(5)
  })

  it('keeps the selection when the marching-ants outline is pressed', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    click($('.draw-marchers')!, [10, 30])
    expect($$('[data-handle]')).toHaveLength(9)
  })

  /** A three-node open path under the node tool, ready to edit. */
  const withCurve = () => {
    const r = mount()
    fireEvent.click(tool('Polyline'))
    click(surface(), [0, 0])
    click(surface(), [40, 0])
    click(surface(), [40, 30])
    fireEvent.doubleClick(surface())
    fireEvent.click(tool('Node'))
    click($('[data-id] path')!, [20, 0])
    return r
  }

  it('acts on the node that was clicked, not on a hardcoded one', () => {
    withCurve()
    click($('[data-node="1:p"]')!, [40, 0])
    fireEvent.click(menuItem('Object', 'Delete node'))
    // The middle node goes. This used to delete `nodes.length - 1` whatever
    // you had clicked, so it always took the last one.
    expect($('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 40 30')
  })

  // One `openMenu` per test: opening the same menubar title again toggles the
  // panel shut, and the second read then finds no items at all.
  it('leaves the node menu disabled until a node is chosen', () => {
    withCurve()
    const items = openMenu('Object')
    const item = (l: string) => items.find((n) => n.textContent?.startsWith(l))!
    expect(item('Insert node').disabled).toBe(true)
    expect(item('Delete node').disabled).toBe(true)
    expect(item('Smooth node').disabled).toBe(true)
  })

  it('enables the node menu once a node is chosen', () => {
    withCurve()
    click($('[data-node="1:p"]')!, [40, 0])
    expect(menuItem('Object', 'Smooth node').disabled).toBe(false)
  })

  it('smooths the chosen node into an actual curve', () => {
    withCurve()
    expect($('[data-id] path')!.getAttribute('d')).not.toContain('C')
    click($('[data-node="1:p"]')!, [40, 0])
    fireEvent.click(menuItem('Object', 'Smooth node'))
    // The whole point of the tool: a straight polygon becomes a curve, and
    // there are grips to drag. Setting the flag alone changed neither.
    expect($('[data-id] path')!.getAttribute('d')).toContain('C')
    expect($$('[data-node="1:in"], [data-node="1:out"]')).toHaveLength(2)
    // The menu now offers the way back.
    expect(menuItem('Object', 'Cusp node')).toBeTruthy()
  })

  it('toggles a node between smooth and cusp on a double-click', () => {
    withCurve()
    click($('[data-node="1:p"]')!, [40, 0])
    expect($('[data-node="1:p"]')!.getAttribute('data-smooth')).toBe('false')
    fireEvent.doubleClick($('[data-node="1:p"]')!)
    expect($('[data-node="1:p"]')!.getAttribute('data-smooth')).toBe('true')
    expect($('[data-id] path')!.getAttribute('d')).toContain('C')
    fireEvent.doubleClick($('[data-node="1:p"]')!)
    // Back to a cusp -- and the handles stay, because that is what a cusp is:
    // two handles that no longer mirror one another. The curve stays a curve.
    expect($('[data-node="1:p"]')!.getAttribute('data-smooth')).toBe('false')
    expect($$('[data-node="1:in"], [data-node="1:out"]')).toHaveLength(2)
  })

  it('marks the chosen node and names it in the status line', () => {
    withCurve()
    click($('[data-node="1:p"]')!, [40, 0])
    expect($('[data-node="1:p"]')!.getAttribute('data-active')).toBe('true')
    expect($('[data-node="0:p"]')!.getAttribute('data-active')).toBe('false')
    expect($('.draw-status')!.textContent).toContain('node 2 of 3')
  })

  it('deletes the chosen node on Delete, and not the whole shape', () => {
    withCurve()
    click($('[data-node="1:p"]')!, [40, 0])
    fireEvent.keyDown(window, { key: 'Delete' })
    expect($$('[data-id]')).toHaveLength(1)
    expect($('[data-id] path')!.getAttribute('d')).toBe('M 0 0 L 40 30')
  })

  it('does not nudge a node when it is merely clicked', () => {
    withCurve()
    const before = $('[data-id] path')!.getAttribute('d')
    // A press two units off the node itself, with no movement.
    click($('[data-node="1:p"]')!, [42, 2])
    expect($('[data-id] path')!.getAttribute('d')).toBe(before)
    // And no undo step was pushed for standing still: one undo goes back past
    // drawing the path itself, rather than past a nudge nobody asked for.
    fireEvent.click(menuItem('Edit', 'Undo'))
    expect($$('[data-id]')).toHaveLength(0)
  })

  it('will not offer to convert text', () => {
    mount()
    fireEvent.click(tool('Text'))
    click(surface(), [20, 20])
    expect(menuItem('Object', 'Convert to curves').disabled).toBe(true)
  })
})

describe('Draw: undo', () => {
  it('undoes and redoes a drawn shape', () => {
    const { id } = mount()
    act(() => useDesktop.getState().focusWindow(id))
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [60, 60])
    expect($$('[data-id]')).toHaveLength(1)

    act(() => {
      fireEvent.keyDown(window, { key: 'z', altKey: true })
    })
    expect($$('[data-id]')).toHaveLength(0)

    act(() => {
      fireEvent.keyDown(window, { key: 'z', altKey: true, shiftKey: true })
    })
    expect($$('[data-id]')).toHaveLength(1)
  })

  it('greys out Undo when there is nothing to undo', () => {
    mount()
    expect(menuItem('Edit', 'Undo').disabled).toBe(true)
  })
})

describe('Draw: files', () => {
  const panelButton = (label: string) =>
    $$<HTMLButtonElement>('.savepanel .b-button').find((b) => b.textContent === label)!

  it('marks the title dirty and clears it on save', async () => {
    const { id } = mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [60, 60])
    expect(useDesktop.getState().windows[id].title).toBe('Untitled *')

    fireEvent.click(menuItem('File', 'Save'))
    await waitFor(() => expect($('.savepanel')).toBeTruthy())
    fireEvent.click(panelButton('Save'))

    await waitFor(() => expect(useDesktop.getState().windows[id].title).toBe('Untitled.svg'))
    const written = useFs.getState().read('/boot/home/drawings/Untitled.svg')!
    expect(written).toContain('<rect')
    expect(parseSVG(written).shapes).toHaveLength(1)
  })

  it('opens a drawing named at launch', async () => {
    useFs.getState().write(
      '/boot/home/drawings/x.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>',
    )
    mount({ path: '/boot/home/drawings/x.svg' })
    await waitFor(() => expect($('[data-id] ellipse')).toBeTruthy())
    expect(surface().getAttribute('width')).toBe('200')
  })

  it('warns once about parts it cannot edit, and keeps them on save', async () => {
    useFs.getState().write(
      '/boot/home/drawings/odd.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<rect width="10" height="10"/><image href="a.png" width="10" height="10"/></svg>',
    )
    const { id } = mount({ path: '/boot/home/drawings/odd.svg' })
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')!.textContent).toContain('<image>')
    fireEvent.click(alertButton('OK'))

    // Opening it must not have dirtied anything, and a save keeps the image.
    await waitFor(() => expect(useDesktop.getState().windows[id].title).toBe('odd.svg'))
    fireEvent.click(menuItem('File', 'Save'))
    await waitFor(() => expect(useFs.getState().read('/boot/home/drawings/odd.svg')).toContain('a.png'))
  })

  it('refuses a file that is not an SVG', async () => {
    useFs.getState().write('/boot/home/drawings/bad.svg', 'this is not markup at all')
    mount({ path: '/boot/home/drawings/bad.svg' })
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    expect($('.b-alert-text')!.textContent).toMatch(/well-formed|no <svg>/)
  })

  it('hands the drawing to the host on Export', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this)
    })
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [60, 60])
    fireEvent.click(menuItem('File', 'Export SVG'))
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('Untitled.svg')
  })

  it('asks before closing with unsaved work, and Cancel keeps the window', async () => {
    const { id } = mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [60, 60])

    void useDesktop.getState().requestClose(id)
    await waitFor(() => expect($('.b-alert')).toBeTruthy())
    fireEvent.click(alertButton('Cancel'))
    await waitFor(() => expect($('.b-alert')).toBeNull())
    expect(useDesktop.getState().windows[id]).toBeTruthy()
  })

  it('closes without asking when nothing has changed', async () => {
    const { id } = mount()
    await act(async () => {
      await useDesktop.getState().requestClose(id)
    })
    expect(useDesktop.getState().windows[id]).toBeUndefined()
  })

  it('round-trips a drawing through the disk unchanged', async () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(tool('Ellipse'))
    drag([200, 40], [300, 140])

    fireEvent.click(menuItem('File', 'Save'))
    await waitFor(() => expect($('.savepanel')).toBeTruthy())
    fireEvent.click(panelButton('Save'))
    await waitFor(() => expect(useFs.getState().read('/boot/home/drawings/Untitled.svg')).toBeTruthy())

    const written = useFs.getState().read('/boot/home/drawings/Untitled.svg')!
    const reopened = mount({ path: '/boot/home/drawings/Untitled.svg' })
    await waitFor(() => expect(reopened.container.querySelectorAll('[data-id]')).toHaveLength(2))
    expect(written).toContain('<rect')
    expect(written).toContain('<ellipse')
  })
})

describe('Draw: the seeded sample', () => {
  it('opens the drawing that ships on the disk', async () => {
    mount({ path: '/boot/home/drawings/beans.svg' })
    await waitFor(() => expect($$('[data-id]')).toHaveLength(5))
    // No warning: the sample uses only what Draw can edit.
    expect($('.b-alert')).toBeNull()
  })
})
