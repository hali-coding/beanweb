import { useEffect, useRef } from 'react'
import { AlertIcon } from '@/lib/icons'
import { Button } from '@/widgets/controls'
import { selectAlerts, useDesktop } from '@/store/desktop'

/**
 * BAlert. Only the newest alert is shown; the rest queue behind it, which is
 * what R5 does when several alerts fire at once.
 */
export function Alerts() {
  const alerts = useDesktop(selectAlerts)
  const dismissAlert = useDesktop((s) => s.dismissAlert)
  const alert = alerts[alerts.length - 1]
  const defaultRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (alert) defaultRef.current?.focus()
  }, [alert])

  useEffect(() => {
    if (!alert) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Escape takes the first button, which is Cancel by convention here.
        dismissAlert(alert.id, 0)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        dismissAlert(alert.id, alert.defaultButton)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [alert, dismissAlert])

  if (!alert) return null

  return (
    <div className="b-alert-scrim">
      <div className="b-alert" role="alertdialog" aria-modal="true" aria-label={alert.title}>
        <div className="b-alert-body">
          <span className="b-alert-icon">
            <AlertIcon kind={alert.kind} size={32} />
          </span>
          <p className="b-alert-text">{alert.text}</p>
        </div>
        <div className="b-alert-buttons">
          {alert.buttons.map((label, i) => (
            <Button
              key={label}
              ref={i === alert.defaultButton ? defaultRef : undefined}
              isDefault={i === alert.defaultButton}
              onClick={() => dismissAlert(alert.id, i)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
