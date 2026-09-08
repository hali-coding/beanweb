import type { ComponentType } from 'react'

import { PACKAGES_DIR } from '@/lib/packages/bridge'
import type { InstalledPackage } from '@/lib/packages/types'
import { sanitize } from '@/lib/draw/svg'
import { AppIcon, type IconProps } from '@/lib/icons'
import { registerApp, unregisterApp } from './registry'
import { SandboxHost } from './SandboxHost'

/**
 * Turning an installed package into an entry in the app registry.
 *
 * Lives under `apps/` rather than in `lib/packages/` because it is the one part
 * of the feature that is React: the registry wants a component and an icon
 * component, and `lib/packages` is otherwise DOM-free so the format layer stays
 * inside the jsdom suite.
 */

/** Where a package's own documents live. Re-exported so callers have one name. */
export { PACKAGES_DIR }

/**
 * A package's icon, or the generic application icon.
 *
 * The SVG comes out of a file the user was handed by someone else and is
 * rendered into *this* page, so it goes through the same `sanitize()` that
 * `lib/draw/svg.ts` puts foreign drawing markup through -- a `<script>` or an
 * `onload=` in an icon would otherwise run on the desktop. That sanitiser walks
 * the parsed DOM rather than regexing markup, which is why it is the one to
 * reuse rather than write a second.
 */
export function packageIcon(svg: string | undefined): ComponentType<IconProps> {
  if (!svg) return AppIcon

  let markup: string
  try {
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    if (parsed.querySelector('parsererror') || root.localName !== 'svg') return AppIcon
    markup = sanitize(root)
  } catch {
    return AppIcon
  }
  if (!markup) return AppIcon

  return function PackageIcon({ size = 32, className }: IconProps) {
    return (
      <span
        className={className}
        style={{ display: 'inline-flex', width: size, height: size }}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    )
  }
}

/** Put an installed package into the registry, so it launches like any app. */
export function registerPackageApp(pkg: InstalledPackage) {
  const { manifest } = pkg

  registerApp({
    id: manifest.id,
    name: manifest.name,
    component: (props) => <SandboxHost {...props} pkgId={manifest.id} />,
    icon: packageIcon(pkg.iconSvg),
    defaultW: manifest.window.defaultW,
    defaultH: manifest.window.defaultH,
    minW: manifest.window.minW,
    minH: manifest.window.minH,
    singleton: manifest.singleton,
    extensions: manifest.extensions,
  })
}

export function unregisterPackageApp(id: string) {
  unregisterApp(id)
}
