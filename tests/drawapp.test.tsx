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

  it('places a line of text where it was clicked', () => {
    mount()
    fireEvent.click(tool('Text'))
    click(surface(), [40, 90])
    const text = $<SVGTextElement>('[data-id] text')!
    expect(text.textContent).toBe('Text')
    expect(text.getAttribute('x')).toBe('40')
    // The side panel offers the content of a selected text object.
    const field = $<HTMLInputElement>('.draw-side input[aria-label="Text content"]')!
    fireEvent.change(field, { target: { value: 'Beans' } })
    expect($('[data-id] text')!.textContent).toBe('Beans')
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

  it('inserts a node when a segment is double-clicked', () => {
    mount()
    fireEvent.click(tool('Rectangle'))
    drag([10, 10], [110, 60])
    fireEvent.click(menuItem('Object', 'Convert to curves'))
    fireEvent.doubleClick($('[data-seg="0"]')!)
    expect($$('[data-node$=":p"]')).toHaveLength(5)
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
