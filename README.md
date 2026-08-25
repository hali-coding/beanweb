# BeanWeb

A BeOS R5 desktop that runs in a browser tab — yellow partial-width window tabs,
grey beveled widgets, and the Deskbar in the top-right corner. No backend: the
window manager, the filesystem and the shell all run client-side.

Built with React 19, TypeScript, Vite and Zustand. ~73 KB of gzipped JS.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest + jsdom
```

`npm run build` produces a static `dist/` you can host anywhere.

## What's in it

- **Window manager** — drag by the yellow tab, resize from the hatched corner or
  any edge, double-click the tab to zoom. Shift-drag slides the tab along the
  window's top edge, the way R5 does it.
- **Tracker** — file manager over a virtual disk, with icon and list views.
- **Terminal** — `help ls cd pwd cat edit open apps mkdir touch rm echo tree date
  uname fortune clear`, with command history on ↑/↓.
- **StyledEdit** — text editor with save, save-as through a browsable file
  panel, a dirty-title marker, a font menu, and a prompt before closing unsaved
  work.
- **Tetris** — 7-bag randomiser, wall kicks, a landing shadow you can switch
  off, and the classic tetromino palette muted a shade to sit against R5 grey.
  Touch pad on phones.
- **Deskbar** — application menu, live clock, and one entry per open window.

Files you create or edit persist in `localStorage`. *About BeanWeb → Reset disk*
restores the original contents.

## Keyboard

R5 used Alt where most systems use Ctrl, so this does too.

| Key | Action |
| --- | --- |
| `Alt+W` | Close the active window |
| `Alt+Tab` | Cycle windows |
| `Alt+S` | Save (StyledEdit) |
| `Esc` | Dismiss a menu or alert |
| `←` `→` `↓` | Move / soft drop (Tetris) |
| `↑` `X` / `Z` | Rotate / rotate back (Tetris) |
| `Space` / `P` | Hard drop / pause (Tetris) |

## Browsers

Works on phones, tablets and desktops — below 768px windows go full-screen and
the Deskbar becomes a bottom dock. Everything uses Pointer Events, so touch and
mouse behave the same.

The R5 scrollbars (beveled trough, stippled knob, arrow ends) need
`::-webkit-scrollbar`, so they render fully in Chrome, Edge and Safari. Firefox
falls back to `scrollbar-color`, which is correctly coloured but plainer.

## Notes

All artwork is original SVG. This is an affectionate homage and is not
affiliated with Be Incorporated or the Haiku project.

Architecture, design-system rules and contributor conventions are in
[CLAUDE.md](CLAUDE.md).
