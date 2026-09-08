/**
 * The Coffee Shop's HTTP face.
 *
 * Everything here is routing and response-shaping; `index.mjs` does the actual
 * work of turning a directory of `.pkg` files into a catalogue. Deliberately
 * plain `node:http` rather than a framework -- three routes and a download
 * stream do not need one, and it keeps the Docker image to Node plus one
 * dependency (`fflate`, the same zip reader `src/lib/packages/archive.ts` uses
 * in the browser).
 *
 * Mounted at `/api/coffeeshop` so it reverse-proxies behind Apache HTTPd
 * unchanged -- see README.md for the `ProxyPass` lines.
 */

import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { buildIndex, matchesQuery } from './index.mjs'

const PORT = Number(process.env.PORT) || 8080
const PKG_DIR = process.env.PKG_DIR || '/pkgs'
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 30_000
const BASE_PATH = '/api/coffeeshop'

let index = { listings: [], byId: new Map(), warnings: [], scannedAt: 0 }

function rescan() {
  const next = buildIndex(PKG_DIR)
  index = next
  const suffix = next.warnings.length ? ` (${next.warnings.length} skipped)` : ''
  console.log(`[coffeeshop] scanned ${PKG_DIR}: ${next.listings.length} package(s)${suffix}`)
  for (const w of next.warnings) console.warn(`[coffeeshop] ${w}`)
}

rescan()
setInterval(rescan, SCAN_INTERVAL_MS).unref()

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function withCors(res) {
  // A public, read-only catalogue: no cookies, no auth header, nothing an
  // origin check would be protecting. Apache's reverse proxy makes this
  // same-origin in production; the open CORS is what lets `npm run dev`'s
  // Vite server on a different port hit a locally-run backend directly.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

const server = createServer((req, res) => {
  withCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  let pathname
  try {
    ;({ pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`))
  } catch {
    sendJson(res, 400, { error: 'bad request' })
    return
  }

  if (!pathname.startsWith(BASE_PATH)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const segments = pathname
    .slice(BASE_PATH.length)
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)

  try {
    route(req, res, segments)
  } catch (err) {
    console.error('[coffeeshop]', err)
    sendJson(res, 500, { error: 'internal error' })
  }
})

function route(req, res, segments) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  // GET /api/coffeeshop/health
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'health')) {
    sendJson(res, 200, { status: 'ok', packages: index.listings.length, scannedAt: index.scannedAt })
    return
  }

  if (segments[0] !== 'packages') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  // GET /api/coffeeshop/packages?q=
  if (segments.length === 1) {
    const q = url.searchParams.get('q') ?? ''
    sendJson(res, 200, index.listings.filter((l) => matchesQuery(l, q)))
    return
  }

  const id = segments[1]
  const listing = index.listings.find((l) => l.id === id)
  const record = index.byId.get(id)

  // GET /api/coffeeshop/packages/:id
  if (segments.length === 2) {
    if (!listing) {
      sendJson(res, 404, { error: `no package "${id}"` })
      return
    }
    sendJson(res, 200, listing)
    return
  }

  // GET /api/coffeeshop/packages/:id/download
  if (segments.length === 3 && segments[2] === 'download') {
    if (!listing || !record) {
      sendJson(res, 404, { error: `no package "${id}"` })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': record.sizeBytes,
      'Content-Disposition': `attachment; filename="${id}.pkg"`,
    })
    createReadStream(join(PKG_DIR, record.filename)).pipe(res)
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

server.listen(PORT, () => {
  console.log(`[coffeeshop] listening on :${PORT}, serving ${BASE_PATH} from ${PKG_DIR}`)
})
