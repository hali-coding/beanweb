# Coffee Shop backend

The index server behind **Coffee Shop**, BeanWeb's app store. It scans a
directory of `.pkg` files -- the same format `docs/packages.md` defines, built
by `pkgs/build.mjs` or by anything else that writes a valid one -- and serves a
catalogue of them at `/api/coffeeshop`, which the `apps/CoffeeShop.tsx` window
in the main app reads through `lib/packages/coffeeshop.ts`'s `PackageSource`.

Independent of `src/` on purpose, the same reasoning `pkgs/` gives for itself:
nothing here imports from the app and nothing in the app imports from here, so
this could live in its own repository and BeanWeb would only need to know its
URL. It talks plain JSON over HTTP; the browser is the only client it assumes.

## Running it

```bash
npm install
PKG_DIR=/path/to/pkgs PORT=8080 npm start
```

| Env var | Default | |
|---|---|---|
| `PORT` | `8080` | what it listens on |
| `PKG_DIR` | `/pkgs` | directory scanned for `*.pkg` files |
| `SCAN_INTERVAL_MS` | `30000` | how often it re-scans, so a `.pkg` dropped into the directory shows up without a restart |

### Talking to it from `npm run dev`

The frontend always fetches the relative path `/api/coffeeshop` -- see
`lib/packages/coffeeshop.ts` -- so it never needs its own setting for where
this server is. In production that path *is* this server, because Apache
reverse-proxies it (below). In dev there is no Apache in front of Vite, so
`vite.config.ts`'s `server.proxy` stands in for it, forwarding
`/api/coffeeshop` to `http://localhost:8080`:

```bash
cd coffeeshop && PKG_DIR=/path/to/pkgs npm start   # :8080, one terminal
npm run dev                                        # :5173, another terminal
```

Point the dev proxy elsewhere by changing `target` in `vite.config.ts`'s
`server.proxy['/api/coffeeshop']` -- a different port, or a Coffee Shop backend
running on another machine entirely.

`npm test` runs `index.mjs`'s scanning logic under `node --test` against a temp
directory -- no server, no Docker.

## Docker

```bash
npm run build:pkgs                 # from the repo root, if you want the sample packages
cd coffeeshop
docker compose up --build
```

`docker-compose.yml` mounts `../pkgs/dist` read-only at `/pkgs`. Point it at a
real catalogue by changing that volume, or build the image directly:

```bash
docker build -t beanweb-coffeeshop .
docker run -p 8080:8080 -v /path/to/pkgs:/pkgs:ro beanweb-coffeeshop
```

## Reverse proxying behind Apache HTTPd

The whole reason this lives under `/api/coffeeshop` rather than at its own
root: it drops straight behind `mod_proxy` alongside the static BeanWeb build,
one origin, no CORS to reason about in production.

```apache
ProxyPass        /api/coffeeshop http://coffeeshop:8080/api/coffeeshop
ProxyPassReverse /api/coffeeshop http://coffeeshop:8080/api/coffeeshop
```

(`mod_proxy` and `mod_proxy_http` need to be enabled.) The server also sends a
permissive `Access-Control-Allow-Origin: *` on every response so it can be hit
directly in development -- from `npm run dev`'s Vite server on a different
port -- without the proxy in front of it. That header costs nothing here: the
catalogue is public and read-only, there is no cookie or auth header to leak,
and nothing is ever written.

## Endpoints

All read-only (`GET`); nothing here writes to `PKG_DIR`.

| | |
|---|---|
| `GET /api/coffeeshop/health` | `{ status, packages, scannedAt }` |
| `GET /api/coffeeshop/packages?q=` | every listing whose id, name, summary or publisher contains `q` (case-insensitive; omit `q` for all of them) |
| `GET /api/coffeeshop/packages/:id` | one listing, 404 if `:id` is not in the catalogue |
| `GET /api/coffeeshop/packages/:id/download` | the raw `.pkg` bytes, streamed from disk unchanged |

A listing:

```jsonc
{
  "id": "com.example.beanpaint",
  "name": "Bean Paint",
  "version": "1.0.0",
  "kind": "sandboxed",
  "summary": "A small painting program.",   // optional
  "publisher": "Example",                    // optional
  "iconSvg": "<svg ...>",                    // optional, capped at 16 KiB
  "sizeBytes": 7340
}
```

This is `PackageListing` in `src/lib/packages/source.ts` with one addition:
`iconSvg`, the manifest's `icon` file inlined as text so the browse list can
show artwork before anything is installed. It goes through the same
`sanitize()` every other package icon does (`apps/packageApp.tsx`'s
`packageIcon`) once it reaches the browser -- this server does not sanitise or
otherwise trust it, it only caps its size.

## What it does not do

- **No signing.** `publisher` is exactly as trustworthy as the string in the
  manifest, same as every other `.pkg` source. `docs/packages.md` names this as
  the one thing missing before a store is trustworthy; it is still missing
  here.
- **No write path.** Publishing a package is "put a `.pkg` file in `PKG_DIR`";
  there is no upload endpoint, and there will not be one without also deciding
  who is allowed to call it.
- **No per-package validation beyond what it takes to list one.** A `.pkg`
  that scans (readable zip, a `manifest.json` with `id`/`name`/`version`/`kind`)
  is listed even if `docs/packages.md`'s fuller rules -- checked client-side by
  `lib/packages/manifest.ts`'s `validatePackage` -- would flag it. Coffee
  Shop's own confirmation is still the last word before anything is written
  to a user's disk.
