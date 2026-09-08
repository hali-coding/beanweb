#!/usr/bin/env node
/*
 * Scaffold a new package directory.
 *
 *   node pkgs/build.mjs init beanpaint
 *
 * The templates live here as strings rather than as a `template/` directory,
 * for the same reason `build.mjs` imports nothing from `src/`: a scaffold that
 * is itself a package directory would be built by `build.mjs`'s bare form and
 * published by the Packages workflow, and would then have to be excluded from
 * both. One file with no directory to skip is cheaper than that coupling.
 *
 * What it writes is a *working* package -- built, installed and opened it does
 * something -- not a stub with holes to fill in. The manifest is the only file
 * you have to edit before publishing, and only its `id`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory names, and therefore the tail of the default id. */
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** `bean-paint` -> `Bean Paint`. Only a starting point; `--name` overrides it. */
const titleCase = (slug) =>
  slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

/**
 * The placeholder id.
 *
 * `com.example.` deliberately: the id is the install key and is fixed for the
 * life of the package, so a default that reads as a placeholder is one an
 * author notices. Two packages that both shipped as `com.beanweb.something`
 * would be the same application to every BeanWeb that saw them.
 */
const defaultId = (slug) => `com.example.${slug.split('-').join('')}`

function manifestFor({ id, name, slug, publisher, summary, description, extensions }) {
  // Written by hand rather than through JSON.stringify of an object: the field
  // order in docs/packages.md is the order an author reads them in, and the
  // window box stays on one line the way iconedit's does.
  const lines = [
    '{',
    '  "format": 1,',
    `  "id": ${JSON.stringify(id)},`,
    `  "name": ${JSON.stringify(name)},`,
    '  "version": "1.0.0",',
    '  "kind": "sandboxed",',
    '  "entry": "main.js",',
    `  "publisher": ${JSON.stringify(publisher)},`,
    `  "summary": ${JSON.stringify(summary)},`,
  ]
  // Unlike summary, left out entirely rather than defaulted: it is the longer
  // pitch, and a placeholder one is worse than no row in the detail pane.
  if (description) lines.push(`  "description": ${JSON.stringify(description)},`)
  lines.push(
    '  "icon": "icon.svg",',
    '  "window": { "defaultW": 480, "defaultH": 360, "minW": 280, "minH": 200 },',
  )
  if (extensions.length) lines.push(`  "extensions": ${JSON.stringify(extensions)},`)
  lines.push('  "permissions": ["fs"]', '}', '')
  return lines.join('\n')
}

/*
 * A generic application icon on the 32-unit grid BeanWeb draws its own on: a
 * grey window under a partial-width yellow tab. Replace it -- an icon is how
 * an application is recognised in Tracker and the Deskbar, and every package
 * shipping this one looks like every other.
 */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M3.5 4.5h12v4h13v20h-25z" fill="#d8d8d8"/>
  <path d="M3.5 4.5h12v4h-12z" fill="#ffc900"/>
  <g fill="#8c9098">
    <rect x="7" y="13" width="18" height="2"/>
    <rect x="7" y="18" width="18" height="2"/>
    <rect x="7" y="23" width="11" height="2"/>
  </g>
  <path d="M3.5 8.5h12" stroke="#3a4049" stroke-width="1" opacity=".4"/>
  <path d="M3.5 4.5h12v4h13v20h-25z" fill="none" stroke="#3a4049" stroke-width="1.5"
        stroke-linejoin="round"/>
</svg>
`

function entryFor({ name, extensions }) {
  const subject = extensions.length
    ? `\`notes.txt\` in its own folder -- or, when Tracker opened it\n * on a \`${extensions[0]}\`, that file.`
    : '`notes.txt` in its own folder.'

  return `/*
 * ${name} -- a BeanWeb package.
 *
 * Plain ES2020 in one file with no build step: a package is whatever is in the
 * zip, and the browser runs this as it stands. Everything it can reach goes
 * through \`window.bw\`; docs/packages.md is the whole API.
 *
 * Two things this frame cannot do, both on purpose:
 *
 *   - \`alert()\`, \`confirm()\` and \`prompt()\` are blocked. The iframe is
 *     sandboxed with \`allow-scripts\` and nothing else, so there is no
 *     \`allow-modals\`. Ask with \`bw.alert(text, kind, buttons)\`, which
 *     resolves the index of the button pressed.
 *   - \`fetch()\` never leaves. The document carries \`connect-src 'none'\`, so
 *     a package cannot send anywhere what it is allowed to read.
 *
 * This one edits ${subject}
 */

/** Inside /boot/home/packages/<id>/, which is the only place we may write. */
const STORE = 'notes.txt'

const app = {
  /** The document Tracker opened us on, or null. Set by bw.ready(). */
  path: null,
  saved: '',
}

/* --- markup and style ---------------------------------------------------
 *
 * The frame is a bare document with none of BeanWeb's CSS in it, so a package
 * draws its own chrome. These greys are the R5 panel ramp; the real ones and
 * the tint_color() arithmetic behind them are in src/styles/tokens.css.
 */

document.body.innerHTML = [
  '<div class="bar">',
  '  <button id="save">Save</button>',
  '  <button id="revert">Revert</button>',
  '  <span class="where" id="where"></span>',
  '</div>',
  '<textarea id="text" spellcheck="false"></textarea>',
].join('')

const style = document.createElement('style')
style.textContent = \`
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column;
       font: 12px/15px system-ui, sans-serif; color: #000; background: #d8d8d8; }
.bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
       border-bottom: 1px solid #979797; }
.where { margin-left: auto; color: #565656; overflow: hidden;
         text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; padding: 2px 12px; background: #d8d8d8; color: #000;
         border: 1px solid #979797; border-radius: 3px;
         box-shadow: inset 1px 1px 0 #fff, inset -1px -1px 0 #b0b0b0; }
button:active { box-shadow: inset 1px 1px 0 #b0b0b0; }
button:disabled { color: #969696; box-shadow: none; }
textarea { flex: 1; margin: 0; padding: 8px; border: 0; resize: none;
           font: 12px/16px ui-monospace, monospace; color: #000; background: #fff; }
textarea:focus { outline: 2px solid #0000e5; outline-offset: -2px; }
\`
document.head.appendChild(style)

const el = (id) => document.getElementById(id)
const text = el('text')

/* --- the bridge ---------------------------------------------------------- */

async function boot() {
  /*
   * \`ready\` is the first call every package makes. It names the package, the
   * folder it may write to, and the document it was opened on -- \`path\` is
   * null unless the user double-clicked a file this package claims.
   */
  const info = await bw.ready()
  app.path = info.path

  await bw.setTitle(app.path ? app.path.split('/').pop() : '${name}')
  el('where').textContent = app.path || info.root + '/' + STORE

  await load()

  el('save').addEventListener('click', save)
  el('revert').addEventListener('click', load)
  text.addEventListener('input', paint)
  window.addEventListener('keydown', (e) => {
    // R5 used Alt where other systems use Ctrl, and BeanWeb keeps that.
    if (e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save()
    }
  })
}

/*
 * A relative path is resolved inside the package folder and refused if it
 * lands anywhere else, so \`../\` buys nothing. The opened document is the one
 * exception: it is named absolutely, and only that exact path is reachable.
 */
async function load() {
  const content = await bw.fs.read(app.path || STORE)
  text.value = app.saved = content === null ? '' : content
  paint()
}

async function save() {
  try {
    await bw.fs.write(app.path || STORE, text.value)
    app.saved = text.value
    paint()
  } catch (err) {
    // Every bw call rejects with the host's own reason: a path outside the
    // package folder, a permission the manifest did not ask for, a full disk.
    await bw.alert(String((err && err.message) || err), 'stop')
  }
}

function paint() {
  const dirty = text.value !== app.saved
  el('save').disabled = !dirty
  el('revert').disabled = !dirty
}

boot().catch((err) => {
  document.body.textContent = String((err && err.message) || err)
})
`
}

/**
 * Write a new package directory.
 *
 * Returns what it wrote. Throws rather than exiting, so the caller owns the
 * process -- the same division `packDir` and `build` keep in build.mjs.
 */
export function scaffold(parent, slug, options = {}) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `"${slug}" is not a package directory name: lower case, digits and dashes, starting with a letter.`,
    )
  }

  const name = options.name || titleCase(slug)
  const id = options.id || defaultId(slug)
  const extensions = (options.extensions || []).map((e) => e.toLowerCase())
  for (const ext of extensions) {
    if (!ext.startsWith('.') || ext.length < 2 || /[\/\\.\s]/.test(ext.slice(1))) {
      throw new Error(`"${ext}" is not a file extension; write it as ".bpaint".`)
    }
  }

  const dir = join(parent, slug)
  const files = {
    'manifest.json': manifestFor({
      id,
      name,
      slug,
      publisher: options.publisher || 'Unknown',
      summary: options.summary || 'A BeanWeb application.',
      description: options.description || '',
      extensions,
    }),
    'main.js': entryFor({ name, extensions }),
    'icon.svg': ICON,
  }

  /*
   * `recursive: false` on purpose: an existing directory throws EEXIST and
   * nothing is written, so `init` over a package you already have cannot
   * overwrite its entry script. Creating the parent is fine.
   */
  mkdirSync(parent, { recursive: true })
  mkdirSync(dir)
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content)
  }

  return { dir, slug, id, name, extensions, files: Object.keys(files).sort() }
}

export { defaultId, titleCase }
