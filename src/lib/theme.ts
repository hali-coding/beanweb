export type Theme = 'light' | 'dark'

/** Kept in step with the `<script>` in index.html, which stamps the root before
 *  first paint so a persisted dark theme does not flash light while React boots. */
export const THEME_ATTR = 'data-theme'

const BACKDROP: Record<Theme, string> = {
  light: '#336698',
  dark: '#1f3e5c',
}

/**
 * Paint a theme.
 *
 * The attribute has to go on the *root element*, not on `.b-desktop`: menus
 * render through a portal into `document.body` (see `widgets/Menu.tsx`), so an
 * attribute set on the desktop div would leave every open menu on the old
 * palette. Nothing else in the codebase writes to `documentElement`.
 */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute(THEME_ATTR, theme)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', BACKDROP[theme])
}

/** The curtain is a flourish. Anyone who has asked for less motion gets the
 *  theme change without one. */
export function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}
