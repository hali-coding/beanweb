import { useEffect, useRef, useState } from 'react'

import { buildDocument, buildErrorDocument } from '@/lib/packages/document'
import { createBridge, isGuestMessage, packageRoot, type BridgeHost } from '@/lib/packages/bridge'
import type { PackageManifest } from '@/lib/packages/types'
import { useFs } from '@/store/fs'
import { packagesReady, readPayload, usePackages } from '@/store/packages'
import { useDesktop } from '@/store/desktop'
import type { AppProps } from './registry'
import './sandboxhost.css'

/**
 * The window an installed package runs in.
 *
 * One iframe, and the rule that makes the whole feature safe to ship:
 * **`allow-scripts` without `allow-same-origin`**. The two together are
 * documented as defeating the sandbox entirely -- the guest would reach this
 * origin and everything in it, including the sealed Anthropic key that
 * `lib/keystore.ts` is honest about not being able to hide from a script on the
 * page. `allow-scripts` alone puts the guest on an *opaque* origin: its
 * `localStorage` and IndexedDB are not ours, `parent.localStorage` throws, and
 * `beanweb.settings.v1` is unreachable. Do not add `allow-same-origin` here for
 * any reason; if a package seems to need it, the bridge needs a verb instead.
 *
 * The guest also carries its own CSP (see `lib/packages/document.ts`), which is
 * what stops it sending anywhere what the `fs` permission lets it read.
 */
export function SandboxHost({ windowId, args, pkgId }: AppProps & { pkgId: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<string | null>(null)

  const pkg = usePackages((s) => s.installed.find((p) => p.manifest.id === pkgId))
  const manifest: PackageManifest | undefined = pkg?.manifest

  /* Load the payload. Deliberately awaits `packagesReady` first, so "no code
     stored" is never reported while IndexedDB simply has not answered yet. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!manifest) return
      await packagesReady
      const files = await readPayload(pkgId)
      if (cancelled) return
      setDoc(
        files
          ? buildDocument(manifest, files)
          : buildErrorDocument('This package’s files are missing. Reinstall it to run it again.'),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [pkgId, manifest])

  /* The package's own folder, created lazily so a package that never writes
     does not leave an empty directory behind. */
  useEffect(() => {
    if (!manifest?.permissions.includes('fs')) return
    const fs = useFs.getState()
    const root = packageRoot(pkgId)
    if (!fs.exists(root)) {
      fs.mkdir('/boot/home/packages')
      fs.mkdir(root)
    }
  }, [pkgId, manifest])

  /*
   * The bridge, and the one identity check that matters.
   *
   * An opaque origin posts `event.origin === "null"`, so checking the origin
   * proves nothing at all -- every sandboxed frame on the page looks alike.
   * What is checkable is *which window* sent it, so the source is compared
   * against this frame's own `contentWindow` and anything else is dropped.
   * Replying goes out with `'*'`, which is unavoidable for an opaque origin and
   * costs nothing, because the frame being posted to is one we built.
   */
  useEffect(() => {
    if (!manifest) return
    const desktop = useDesktop.getState()

    const host: BridgeHost = {
      setTitle: (title) => desktop.setTitle(windowId, title || manifest.name),
      close: () => void desktop.requestClose(windowId),
      alert: (kind, text, buttons) => desktop.showAlert(kind, manifest.name, text, buttons),
      readFile: (path) => useFs.getState().read(path),
      writeFile: (path, content) => useFs.getState().write(path, content),
      listDir: (path) => useFs.getState().list(path).map((n) => n.name),
      removeFile: (path) => useFs.getState().remove(path),
    }

    const handle = createBridge(
      { pkgId, permissions: manifest.permissions, openPath: args?.path },
      host,
    )

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (!isGuestMessage(event.data)) return
      void handle(event.data).then((reply) => {
        frame.current?.contentWindow?.postMessage(reply, '*')
      })
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [pkgId, manifest, windowId, args?.path])

  if (!manifest) {
    return <div className="sandbox sandbox--empty">This package is no longer installed.</div>
  }

  return (
    <div className="sandbox">
      {doc === null ? (
        <div className="sandbox--empty">Loading {manifest.name}…</div>
      ) : (
        <iframe
          ref={frame}
          className="sandbox-frame"
          // NEVER add allow-same-origin: see the note above.
          sandbox="allow-scripts"
          srcDoc={doc}
          title={manifest.name}
        />
      )}
    </div>
  )
}
