# pkgs/

Application packages for BeanWeb. Each directory here is one package, built
into a `.pkg` you can install from the Installer.

These are **not** part of the app. Nothing in `src/` imports them and nothing
here imports `src/`; `pkgs/build.mjs` is a standalone node script, so a package
could move to its own repository unchanged. That independence is the point —
it is the check that the format really is a format.

```bash
npm run build:pkgs            # every directory here
node pkgs/build.mjs iconedit  # just one
```

Output lands in `pkgs/dist/<id>.pkg` (gitignored). Install it with the
Installer's *File → Install from this computer…*.

`docs/packages.md` is the format and the `bw` API.

## CI

`.github/workflows/packages.yml` builds these on any change to `pkgs/` or to
`src/lib/packages/` — the format itself, because a change there can make a
package that built yesterday unreadable — and on demand from the Actions tab.

It attaches a **packages** artifact holding every `.pkg`, a `SHA256SUMS` and a
`packages.json` manifest. The build is verified by reading each archive back
through the Installer's own reader, so what you download is known to install
and not merely known to exist. Checksums are taken last, after the step that
rebuilds them, which the byte-stable build is what makes meaningful.

`node pkgs/build.mjs --json` is what the workflow uses: one JSON array on
stdout and nothing else, with failures on stderr and a non-zero exit.

## iconedit

**IconEdit** — a pixel editor for icons on the same 32-unit grid BeanWeb draws
its own on. It is the worked example: 600-odd lines of plain ES2020 with no
build step, exercising most of what a package can do.

- `bw.fs` to save, open and list `.bicon` files in its own folder
- `bw.setTitle` for the window tab, `bw.alert` for confirmations
- `bw.ready().path` to load the document Tracker opened it on
- *Export SVG* writes a drawing that opens in Draw

It also shows the two things a sandboxed frame cannot do. There is no
`allow-modals`, so `prompt()` and `confirm()` are blocked and the name sheet
and file list are drawn by hand. And there is no network: the CSP is
`connect-src 'none'`, so a `fetch` fails before it leaves the frame.

### The `.bicon` format

Text, so one opens in StyledEdit and reads as a picture of itself:

```text
beanicon 1 32
................................
..........5555555555............
```

A header line of `beanicon <format> <size>`, then one line per row and one
character per pixel: a hex digit indexes the sixteen-colour palette in
`main.js`, and `.` is transparent. The palette is part of the format —
appending to it is safe, reordering it silently recolours every icon ever
saved.
