/**
 * The host half of the sandbox protocol.
 *
 * A package runs in an iframe on an opaque origin and can therefore touch
 * nothing of BeanWeb's directly. Everything it is allowed to do arrives here as
 * a message and leaves as a reply.
 *
 * There is no DOM in this file. Like `lib/basic/host.ts`, the outside world is
 * a small injected interface -- which is what lets the whole protocol be tested
 * under jsdom, where an iframe's scripts never run at all. `apps/SandboxHost`
 * supplies the real implementation and owns the `postMessage` plumbing.
 *
 * Two rules the wire format depends on:
 *
 *  - Every path a guest names is resolved inside its own folder and rejected if
 *    it lands anywhere else. That folder is the guest's entire view of the disk.
 *  - A verb the manifest has no permission for is refused here, not at the call
 *    site, so there is one place to read to know what a package can do.
 */

import { resolvePath } from '@/store/fs'
import type { AlertKind } from '@/lib/types'
import type { Permission } from './types'

/** Where a package's own files live on the virtual disk. */
export const PACKAGES_DIR = '/boot/home/packages'

export const packageRoot = (pkgId: string): string => `${PACKAGES_DIR}/${pkgId}`

/** What the bridge is allowed to do on the guest's behalf. */
export interface BridgeHost {
  setTitle(title: string): void
  close(): void
  alert(kind: AlertKind, text: string, buttons?: string[]): Promise<number>
  readFile(path: string): string | undefined
  writeFile(path: string, content: string): void
  listDir(path: string): string[]
  removeFile(path: string): boolean
}

export interface BridgeContext {
  pkgId: string
  permissions: readonly Permission[]
}

export interface GuestMessage {
  id: number
  verb: string
  [arg: string]: unknown
}

export interface HostReply {
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

/** A message is ours if it has a numeric id and a verb. Anything else is noise. */
export function isGuestMessage(data: unknown): data is GuestMessage {
  if (!data || typeof data !== 'object') return false
  const m = data as Partial<GuestMessage>
  return typeof m.id === 'number' && typeof m.verb === 'string'
}

/**
 * Resolve a guest path inside its own folder, or null if it escapes.
 *
 * `resolvePath` already collapses `.` and `..` and clamps at the root, so the
 * only thing left to check is where it landed. Re-implementing the traversal
 * rules here is how the two would drift apart.
 */
export function resolveInPackage(pkgId: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  const root = packageRoot(pkgId)
  const resolved = resolvePath(root, path)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return null
  return resolved
}

const FS_VERBS = new Set(['fs.read', 'fs.write', 'fs.list', 'fs.remove'])

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Build the handler for one package's frame.
 *
 * Returns a function taking a guest message and resolving the reply to post
 * back. It never throws: a guest that sends nonsense gets `ok: false` and a
 * reason, because the alternative is an unhandled rejection in a message
 * listener and a frame that hangs waiting for an answer.
 */
export function createBridge(ctx: BridgeContext, host: BridgeHost) {
  const denied = (id: number, error: string): HostReply => ({ id, ok: false, error })

  return async function handle(message: GuestMessage): Promise<HostReply> {
    const { id, verb } = message

    if (FS_VERBS.has(verb) && !ctx.permissions.includes('fs')) {
      return denied(id, 'This package did not ask for filesystem access.')
    }

    try {
      switch (verb) {
        case 'ready':
          return { id, ok: true, value: { pkgId: ctx.pkgId, root: packageRoot(ctx.pkgId) } }

        case 'setTitle': {
          const title = str(message.title)
          if (title === null) return denied(id, 'setTitle needs a string.')
          // Trimmed and capped: the tab is chrome, and a guest must not be able
          // to push the Deskbar around with a title a thousand characters long.
          host.setTitle(title.trim().slice(0, 64))
          return { id, ok: true }
        }

        case 'close':
          host.close()
          return { id, ok: true }

        case 'alert': {
          const text = str(message.text)
          if (text === null) return denied(id, 'alert needs a string.')
          const kind = (['info', 'warn', 'stop'] as const).includes(message.kind as AlertKind)
            ? (message.kind as AlertKind)
            : 'info'
          const buttons = Array.isArray(message.buttons)
            ? message.buttons.filter((b): b is string => typeof b === 'string').slice(0, 3)
            : undefined
          return { id, ok: true, value: await host.alert(kind, text.slice(0, 2000), buttons) }
        }

        case 'fs.read': {
          const path = resolveInPackage(ctx.pkgId, message.path)
          if (!path) return denied(id, 'That path is outside the package folder.')
          return { id, ok: true, value: host.readFile(path) ?? null }
        }

        case 'fs.write': {
          const path = resolveInPackage(ctx.pkgId, message.path)
          if (!path) return denied(id, 'That path is outside the package folder.')
          const content = str(message.content)
          if (content === null) return denied(id, 'fs.write needs a string.')
          host.writeFile(path, content)
          return { id, ok: true }
        }

        case 'fs.list': {
          const path = resolveInPackage(ctx.pkgId, message.path ?? '.')
          if (!path) return denied(id, 'That path is outside the package folder.')
          return { id, ok: true, value: host.listDir(path) }
        }

        case 'fs.remove': {
          const path = resolveInPackage(ctx.pkgId, message.path)
          if (!path) return denied(id, 'That path is outside the package folder.')
          // The folder itself is not the guest's to delete.
          if (path === packageRoot(ctx.pkgId)) return denied(id, 'Cannot remove the package folder.')
          return { id, ok: true, value: host.removeFile(path) }
        }

        default:
          return denied(id, `"${verb}" is not something a package can ask for.`)
      }
    } catch (err) {
      return denied(id, (err as Error).message)
    }
  }
}
