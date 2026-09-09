import { useMemo } from 'react'

import type { MenuItem } from '@/widgets/Menu'
import { launchApp, useApps } from '@/apps/registry'
import { useDesktop } from '@/store/desktop'

/**
 * The Be menu: every visible app, About, and the two power items.
 *
 * Lives apart from the Deskbar because it has two callers. R5 put this same
 * menu under a right-click on the desktop, and duplicating the list is how the
 * two would come to disagree about what is installed -- `useApps()` is
 * subscribed for exactly that reason, since a package registers an app after
 * either menu has mounted.
 */
export function useAppMenuItems(): MenuItem[] {
  const apps = useApps()
  const beginShutdown = useDesktop((s) => s.beginShutdown)

  return useMemo(
    () => [
      ...apps
        .filter((app) => !app.hidden)
        .map((app) => ({
          label: app.name,
          onSelect: () => launchApp(app.id),
        })),
      { separator: true },
      { label: 'About BeanWeb…', onSelect: () => launchApp('about') },
      { separator: true },
      // R5 spelled these without an ellipsis even though both can stop to ask.
      { label: 'Restart', onSelect: () => void beginShutdown('restart') },
      { label: 'Shut Down', onSelect: () => void beginShutdown('shutdown') },
    ],
    [apps, beginShutdown],
  )
}
