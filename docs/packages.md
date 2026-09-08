# BeanWeb packages

A package is an application a user installs into BeanWeb themselves. It is a
zip file named `.pkg` — R5's own installer extension — holding a manifest, an
entry script, and whatever else the app needs.

This document is the format. It exists so that a package built by something
other than BeanWeb still installs, and so whoever builds a package **store**
later has a specification rather than a codebase to read.

## Layout

```text
beanpaint.pkg
├── manifest.json     required
├── main.js           required — the entry named by the manifest
├── index.html        optional — markup placed in the body before the script
├── icon.svg          optional — 32-unit grid, like BeanWeb's own icons
└── …                 anything else, stored and available to the app
```

## manifest.json

```jsonc
{
  "format": 1,                      // required; refuses to install if > 1
  "id": "com.example.beanpaint",     // required; reverse-DNS, lower case
  "name": "Bean Paint",              // required; ≤ 48 characters
  "version": "1.0.0",                // required
  "kind": "sandboxed",               // required; the only kind today
  "entry": "main.js",                // required; a path inside the archive

  "publisher": "Example",
  "summary": "A small painting program.",
  "icon": "icon.svg",
  "window": { "defaultW": 480, "defaultH": 360, "minW": 240, "minH": 180 },
  "singleton": false,                // reuse one window instead of opening more
  "extensions": [".bpaint"],         // file types this app opens
  "permissions": ["fs"]              // shown to the user before installing
}
```

`id` is the install key, the application id and the folder name, so it is fixed
for the life of the package: changing it publishes a different app rather than
an update.

An unknown `permissions` entry is a warning, not an error — it is simply not
granted, so a package built against a later BeanWeb still runs with less.

## Limits

| | |
|---|---|
| Archive | 2 MiB |
| Unpacked total | 8 MiB, checked from the zip's declared sizes before decompressing |
| Icon kept in the index | 16 KiB |

## How a package runs

In an `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, which
puts it on an opaque origin: it cannot read BeanWeb's `localStorage` or
IndexedDB, and `parent.localStorage` throws. The frame's document also carries
`default-src 'none'; connect-src 'none'`, so a package cannot send anywhere what
it is allowed to read.

The entry script runs at the end of `<body>`, so `document.body` exists.

## The `bw` API

Every call returns a promise. Rejection carries the host's reason.

```js
await bw.ready()                       // { pkgId, root, path }
await bw.setTitle('Untitled 1')        // the window tab; trimmed to 64 chars
await bw.close()                       // asks the window to close
await bw.alert(text, kind, buttons)    // kind: 'info' | 'warn' | 'stop'
                                       // resolves the index of the button pressed
```

With the `fs` permission, and **only** inside `/boot/home/packages/<id>/`:

```js
await bw.fs.read(path)                 // string, or null
await bw.fs.write(path, content)
await bw.fs.list(path)                 // array of names
await bw.fs.remove(path)               // boolean
```

Paths are resolved inside the package folder and refused if they land anywhere
else, so `../` buys nothing. The folder itself cannot be removed. A package's
documents survive uninstalling it.

### The opened document

A package that claims an `extensions` entry is launched with the file the user
double-clicked in Tracker. `bw.ready()` reports it as `path`, and that one file
is readable and writable even though it is outside the package folder — the
double-click is the consent, the same way choosing a file from a panel is.

It is the *only* exception, and it is narrow: the path must be named exactly,
there is no relative route to it, nothing else in its directory is reachable,
and it cannot be deleted. Opening a document in an editor grants editing it,
not throwing it away.

`path` is `null` when the window was not opened on a document. The value comes
from the host, never from the guest — no verb here opens a window.

## Adding a source

`PackageSource` in `src/lib/packages/source.ts` is two methods:

```ts
interface PackageSource {
  readonly id: string
  readonly name: string
  readonly browsable: boolean
  list(query?: string): Promise<PackageListing[]>
  fetch(id?: string): Promise<Uint8Array | null>
}
```

`UploadSource` is the only one today and is not browsable — `list()` returns
`[]` and `fetch()` opens a file picker. A store implements the same interface
against an HTTP endpoint and calls `registerSource(...)`; the Installer renders
its sources from `listSources()`, and `installPackage` takes bytes, so nothing
else has to change.

Not addressed here, and needed before a store is trustworthy: **signing**.
`publisher` is an unverified string today.

## A worked example

`pkgs/iconedit` is a complete package — a pixel editor for icons — with its own
standalone build script that imports nothing from `src/`. See `pkgs/README.md`.
