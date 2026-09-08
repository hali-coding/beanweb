/**
 * The HTML a package's iframe is given.
 *
 * Assembled here rather than in the component so it can be asserted on in a
 * test -- jsdom never runs an iframe's scripts, so the *content* of the
 * document is the only part of the sandbox the suite can actually check.
 *
 * Everything is inlined. The guest is on an opaque origin and there is no
 * server route serving package files, so it cannot fetch anything of its own;
 * `srcdoc` is the only way its code reaches it.
 */

import { decodeText } from './archive'
import type { PackageFiles, PackageManifest } from './types'

/**
 * The guest's own Content-Security-Policy.
 *
 * The sandbox attribute stops a package *reading* BeanWeb's data. This stops it
 * *sending* anything anywhere -- without it, a package granted `fs` could read
 * the user's files in its folder and POST them off, and the isolation would
 * have bought nothing. `default-src 'none'` denies by default and the rest is
 * the shortest list that still lets a page draw itself.
 *
 * `'unsafe-inline'` is unavoidable and is not the hole it looks like: the whole
 * program is inline by construction, and the guest is alone on its origin with
 * nothing to steal from it.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Close a `</script>` appearing inside the package's own source.
 *
 * The entry script is dropped into a `<script>` element as text, so the parser
 * ends the block at the first `</script` in it -- inside a string literal or a
 * comment just the same -- and the rest of the program becomes markup. Breaking
 * the sequence is the standard fix and changes nothing about what runs.
 */
const escapeScript = (s: string): string => s.replace(/<\/(script)/gi, '<\\/$1')

/**
 * The API a package author writes against.
 *
 * A promise per call over `postMessage`, so a package never sees the wire
 * format. Kept deliberately small: every verb here is one the host has to
 * defend, and `lib/packages/bridge.ts` is the list of what it will answer.
 */
const SHIM = `
(function () {
  var seq = 0
  var pending = new Map()

  window.addEventListener('message', function (e) {
    // The host is the only thing that can reach this frame, but a reply
    // without a matching request is still dropped rather than guessed at.
    var m = e.data
    if (!m || typeof m.id !== 'number') return
    var entry = pending.get(m.id)
    if (!entry) return
    pending.delete(m.id)
    if (m.ok) entry.resolve(m.value)
    else entry.reject(new Error(m.error || 'refused'))
  })

  function call(verb, args) {
    var id = ++seq
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject })
      parent.postMessage(Object.assign({ id: id, verb: verb }, args || {}), '*')
    })
  }

  window.bw = {
    ready: function () { return call('ready') },
    setTitle: function (title) { return call('setTitle', { title: title }) },
    close: function () { return call('close') },
    alert: function (text, kind, buttons) {
      return call('alert', { text: text, kind: kind, buttons: buttons })
    },
    fs: {
      read: function (path) { return call('fs.read', { path: path }) },
      write: function (path, content) { return call('fs.write', { path: path, content: content }) },
      list: function (path) { return call('fs.list', { path: path }) },
      remove: function (path) { return call('fs.remove', { path: path }) },
    },
  }
})()
`

/** A plain page for a package whose entry script is missing or unreadable. */
export function buildErrorDocument(message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>body{font:12px system-ui,sans-serif;margin:0;padding:16px;color:#333}</style>
<p>${escapeHtml(message)}</p>`
}

/**
 * The document for one package.
 *
 * A package may ship its own `index.html`, in which case the shim and the entry
 * script are injected into it; otherwise it gets a bare page. Either way the
 * CSP and the shim come first, so a package cannot displace them by shipping a
 * document of its own.
 */
export function buildDocument(manifest: PackageManifest, files: PackageFiles): string {
  const entry = files[manifest.entry]
  if (!entry) return buildErrorDocument(`This package has no "${manifest.entry}".`)

  const head =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<title>${escapeHtml(manifest.name)}</title>` +
    `<style>html,body{margin:0;height:100%}body{font:12px system-ui,sans-serif}</style>` +
    `<script>${SHIM}</script></head>`

  /*
   * A package's own markup goes in unsanitised, and that is correct: it is
   * alone on an opaque origin with nothing of BeanWeb's to reach, so script it
   * brings is script it could have written in its entry file anyway. Sanitising
   * here would only be theatre. What keeps it honest is the frame, not the
   * markup -- contrast `lib/draw/svg.ts`, where foreign markup is rendered into
   * *this* page and so must be scrubbed.
   */
  const page = files['index.html'] ? decodeText(files['index.html']) : ''

  /*
   * `<body>` is written out explicitly and the entry script goes inside it,
   * last. Without the tag the parser keeps every leading `<meta>`, `<style>`
   * and `<script>` in the head, and a package whose first line touches
   * `document.body` -- which is most of them -- gets null. Found by running one
   * in a real browser; jsdom never executes an iframe's scripts, so nothing in
   * the suite could have caught it.
   */
  return `${head}<body>${page}<script>${escapeScript(decodeText(entry))}</script></body></html>`
}
