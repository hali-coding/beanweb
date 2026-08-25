import type { ComponentType } from 'react'
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
}

/**
 * Apps register themselves on import (see apps/index.ts), so this module has no
 * dependency on any app component and there is no import cycle when an app
 * needs to launch another one.
 */
const apps = new Map<string, AppDef>()

export function registerApp(def: AppDef) {
  apps.set(def.id, def)
}

export function getApp(id: string): AppDef | undefined {
  return apps.get(id)
}

export function listApps(): AppDef[] {
  return [...apps.values()].filter((a) => !a.hidden)
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
