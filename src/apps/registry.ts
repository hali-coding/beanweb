import { useSyncExternalStore, type ComponentType } from 'react'
import type { IconProps } from '@/lib/icons'
import { useDesktop } from '@/store/desktop'

export interface AppProps {
  windowId: string
  args?: Record<string, string>
}

export interface AppDef {
  id: string
  name: string
  component: ComponentType<AppProps>
  icon: ComponentType<IconProps>
  defaultW: number
  defaultH: number
  minW?: number
  minH?: number
  /** Re-focus the existing window rather than opening a second copy. */
  singleton?: boolean
  /** Hide from the Deskbar's application menu (About, dialogs). */
  hidden?: boolean
  /** File types this app opens, lower case and with the dot -- ['.bas']. */
  extensions?: string[]
}

/**
 * Apps register themselves on import (see apps/index.ts), so this module has no
 * dependency on any app component and there is no import cycle when an app
 * needs to launch another one.
 *
 * The map is also written *after* boot: an installed package registers when it
 * is installed, and unregisters when it is removed. That is why there is a
 * subscription here at all -- the Deskbar's menu and every open window have to
 * notice, and a plain Map cannot tell them.
 */
const apps = new Map<string, AppDef>()
const listeners = new Set<() => void>()

/**
 * The array `useApps` hands React, rebuilt only when the map changes.
 *
 * This cache is load-bearing. `useSyncExternalStore` calls the getter on every
 * render and compares with `Object.is`, so returning a fresh `[...apps.values()]`
 * would never match and would spin into "Maximum update depth exceeded" -- the
 * same failure the `useShallow` rule in CLAUDE.md describes. Build the array in
 * `emit()`, never in the getter.
 */
let snapshot: AppDef[] = []

function emit() {
  snapshot = [...apps.values()]
  for (const listener of listeners) listener()
}

export function registerApp(def: AppDef) {
  apps.set(def.id, def)
  emit()
}

/** Remove an app, for a package being uninstalled. Built-ins never call this. */
export function unregisterApp(id: string) {
  if (apps.delete(id)) emit()
}

export function getApp(id: string): AppDef | undefined {
  return apps.get(id)
}

export function listApps(): AppDef[] {
  return snapshot.filter((a) => !a.hidden)
}

export function subscribeApps(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every registered app, including hidden ones. Callers filter as they need. */
export function appsSnapshot(): AppDef[] {
  return snapshot
}

/**
 * Subscribe a component to the registry. Returns every app, hidden included --
 * the Deskbar filters, and a window needs to resolve a hidden one.
 */
export function useApps(): AppDef[] {
  return useSyncExternalStore(subscribeApps, appsSnapshot, appsSnapshot)
}

/** Which app opens a file, by extension. Falls back to the text editor. */
export function appForFile(name: string): AppDef | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = name.slice(dot).toLowerCase()
  return snapshot.find((a) => a.extensions?.includes(ext))
}

/** Open an app in a new window using its declared default geometry. */
export function launchApp(id: string, args?: Record<string, string>, title?: string) {
  const def = apps.get(id)
  if (!def) return null
  return useDesktop.getState().openWindow({
    appId: id,
    title: title ?? def.name,
    rect: { w: def.defaultW, h: def.defaultH },
    minW: def.minW,
    minH: def.minH,
    args,
    singleton: def.singleton,
  })
}
