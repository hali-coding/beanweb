import { useEffect, useRef } from 'react'
import { WindowLayer } from '@/wm/WindowLayer'
import { launchApp } from '@/apps/registry'
import { Deskbar } from './Deskbar'
import { DesktopIcons } from './DesktopIcons'
import { Alerts } from './Alerts'
import { SavePanel } from './SavePanel'
import { KeyPanel } from './KeyPanel'
import { Shutdown } from './Shutdown'
import { ThemeCurtain } from './ThemeCurtain'
import { useShortcuts } from './useShortcuts'

export function Desktop() {
  useShortcuts()
  const booted = useRef(false)

  // Open a Tracker on home the first time the desktop mounts, so the session
  // starts with something on screen. The ref survives StrictMode's double
  // effect in development, which would otherwise open two windows.
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    launchApp('tracker', { path: '/boot/home' }, 'home')
  }, [])

  // A file dropped anywhere the desktop does not handle is navigated to by the
  // browser, which unloads the tab and takes the whole session with it. These
  // two listeners sit on the window so they run after any app's own handler
  // has had its turn, and only cancel the default.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  return (
    <div className="b-desktop">
      <div className="b-workspace">
        <DesktopIcons />
        <WindowLayer />
      </div>
      <Deskbar />
      <SavePanel />
      <KeyPanel />
      <Shutdown />
      <Alerts />
      {/* Renders nothing until the theme changes, and portals to document.body
          when it does -- position in this list is immaterial. */}
      <ThemeCurtain />
    </div>
  )
}
