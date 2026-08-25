import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

/* Thin React wrappers over the widget CSS. They exist so app code composes
   BeOS controls instead of restating class names, and so every control keeps
   its keyboard and ARIA behaviour in one place. */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Draws R5's outer ring, marking the action Enter triggers. */
  isDefault?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { isDefault, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['b-button', isDefault && 'b-button--default', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
})

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode
}

export function CheckBox({ label, className, ...rest }: ToggleProps) {
  const id = useId()
  return (
    <label className={['b-control-row', className].filter(Boolean).join(' ')} htmlFor={id}>
      <input id={id} type="checkbox" {...rest} />
      <span className="b-checkbox-box" aria-hidden />
      <span>{label}</span>
    </label>
  )
}

export function RadioButton({ label, className, ...rest }: ToggleProps) {
  const id = useId()
  return (
    <label className={['b-control-row', className].filter(Boolean).join(' ')} htmlFor={id}>
      <input id={id} type="radio" {...rest} />
      <span className="b-radio-dot" aria-hidden />
      <span>{label}</span>
    </label>
  )
}

export const TextControl = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextControl({ className, type = 'text', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={['b-textcontrol', className].filter(Boolean).join(' ')}
        {...rest}
      />
    )
  },
)

export function StatusBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div
      className="b-statusbar"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div className="b-statusbar-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Box({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="b-box">
      {label ? <span className="b-box-label">{label}</span> : null}
      {children}
    </div>
  )
}

interface ScrollViewProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

/** A scrollable region wearing R5 scrollbars. */
export function ScrollView({ children, className, ...rest }: ScrollViewProps) {
  return (
    <div className={['b-scroll', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  )
}
