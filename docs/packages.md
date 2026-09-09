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
  "description": "A longer pitch, shown only in the detail pane.\nMay hold its own line breaks.",
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

`permissions` is the one field the user is asked about before anything is
installed. **Permissions**, below, is what the entries mean.

`summary` and `description` are both optional and both shown by Coffee Shop,
but for different jobs: `summary` is the one line that fits beside a listing,
`description` is the longer pitch shown only in the detail pane, where line
breaks in it are kept. A package can carry either, neither, or both.

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

Coffee Shop says all of this to the user in *Help → About Packages*. That
window is this section in plain words, so a change here belongs in
`src/apps/PackageHelp.tsx` too.

## Permissions

`permissions` is what a package asks the host to do on its behalf. It is
declared in the manifest rather than requested at runtime so that the whole ask
can be shown to the user *before* the package is on their disk.

| Permission | What the user is told |
|---|---|
| `fs` | Read and write files in its own folder |

That is the entire list today.

A permission is not what keeps a package honest. The sandbox and the CSP are,
and they hold whether or not the manifest is truthful — a package that omits
`fs` and calls `bw.fs.read` anyway is refused just the same. What a permission
does is two narrower things: it is the sentence the user agrees to, and it is
the switch the bridge checks before it will answer a verb at all.

### Granted without asking

`ready`, `setTitle`, `close` and `alert` need no permission, and a package that
declares none still gets all four. None of them reaches anything of the user's:
they report what the host already told the guest, retitle or close the guest's
own window, or draw a modal the user answers themselves.

There is no permission for the network, and there is not going to be one. The
guest document carries `connect-src 'none'` and no verb proxies a request, so
*may this app go online* is not a question this format can ask.

### What `fs` grants

The four `bw.fs.*` calls, and nothing else. It is checked in
`lib/packages/bridge.ts` before the verb is dispatched, so a package without it
gets a rejected promise rather than a partial write. It also decides whether
`/boot/home/packages/<id>/` is created at all: a package that cannot write does
not leave an empty folder behind.

`fs` says *whether*, never *where*. The scope is fixed by the host and enforced
separately, by resolving every path the guest names and comparing it against:

- `/boot/home/packages/<id>/` — the package's own folder, and
- the one document the window was opened on, if there is one.

Nothing widens that. A package that wants `/boot/home/documents` cannot ask for
it: there is no wording for it in the manifest, and `resolveForPackage` would
refuse the path even if there were. Which is why the table above says *its own
folder* — the label is the promise, and the promise is the whole grant.

### Unknown entries

An unknown permission is a **warning, not an error**. It is simply not granted,
so a package built against a later BeanWeb installs and runs with less rather
than not at all — the forward-compatible direction, because the failure is the
safe one. It is also left out of the list shown to the user: a line naming
access that was never granted would be worse than no line.

### How it reaches the user

Installing raises a confirmation naming the package, its publisher and every
permission it asks for, as *It will be able to…* — or *It has asked for no
special access*, which is a thing worth saying out loud. Cancel is a real
answer; nothing is written until Install is pressed.

After that, Coffee Shop's *Installed* tab carries the same list under
**Access**, so the ask is answerable later and not only in the moment. Its
*Help → About Packages* window is the third telling: what a package can never
do, and what each grant actually reaches, for someone deciding before there is
a package selected at all.
Installing over an existing package re-asks with the *new* manifest's list, so
a version that wants more has to be agreed to again.

### Adding one

1. `Permission`, `PERMISSIONS` and `PERMISSION_LABELS` in
   `lib/packages/types.ts`. The label is the security-relevant part: it is the
   whole of what the user knows about the grant, so it has to describe the
   scope the bridge actually enforces, not the verb's name.
2. The gate in `lib/packages/bridge.ts`, as a set of verbs checked before the
   dispatch — `FS_VERBS` is the pattern. Refuse at the door, so a half-done
   operation is not a state the host can be left in.
3. A row in the table above.
4. A line in *What it may ask for* in `src/apps/PackageHelp.tsx`. That window
   is the only description of the grant a user reads outside the install
   confirmation; a permission missing from it is one nobody was told about.

Older BeanWebs will treat it as an unknown entry and not grant it, which is the
behaviour that makes adding one safe.

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

`UploadSource` is the only unbrowsable one — `list()` returns `[]` and
`fetch()` opens a file picker. `coffeeShopSource`
(`lib/packages/coffeeshop.ts`) is the second: browsable, backed by an HTTP
endpoint, and it and its backend (`coffeeshop/`, a standalone Node service —
see `coffeeshop/README.md`) are the worked example of this section rather
than a hypothetical. The app both live in, **Coffee Shop** (`apps/CoffeeShop.tsx`),
is the one place a package is installed, removed or browsed from — its *File*
menu renders an "Install from…" item for every non-browsable source via
`listSources()`, and its *Browse* tab is `coffeeShopSource`'s catalogue,
directly. A *third* source — a different store, say — implements the same
interface and shows up in the File menu the same way `UploadSource` does if
it is not browsable; a browsable one needs a pane of its own the way *Browse*
is `coffeeShopSource`'s, because `list()` alone is not a UI. `installPackage`
takes bytes regardless of which kind, so nothing below either path changes.

Not addressed here, and needed before a store is trustworthy: **signing**.
`publisher` is an unverified string today, in an uploaded `.pkg` and in Coffee
Shop's catalogue alike.

## Starting one

```bash
node pkgs/build.mjs init bean-paint --name "Bean Paint" --ext .bpaint
node pkgs/build.mjs bean-paint
```

The first writes a package directory — manifest, entry script and icon — that
already builds and runs; the second packs it into `pkgs/dist/<id>.pkg`. Set
your own `id` before publishing: the default is a `com.example.` placeholder,
and the id is the install key. `pkgs/README.md` has the options.

Neither command is part of BeanWeb — `pkgs/build.mjs` imports nothing from
`src/`, so a package it scaffolds can live in its own repository and build
there with a copy of the script.

## A worked example

`pkgs/iconedit` is a complete package — a pixel editor for icons — with its own
standalone build script that imports nothing from `src/`. See `pkgs/README.md`.
