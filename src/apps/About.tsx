import { AboutIcon, LeafIcon } from '@/lib/icons'
import { Button } from '@/widgets/controls'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './about.css'

/** Modelled on R5's "About this System": logo block left, spec sheet right. */
export function About({ windowId }: AppProps) {
  const requestClose = useDesktop((s) => s.requestClose)
  const showAlert = useDesktop((s) => s.showAlert)
  const reset = useFs((s) => s.reset)
  const nodeCount = useFs((s) => Object.keys(s.nodes).length)

  const cores = navigator.hardwareConcurrency || 1

  const onReset = async () => {
    const answer = await showAlert(
      'stop',
      'Reset filesystem',
      'Every file you have created or edited will be discarded and the\noriginal disk contents restored.\n\nThis cannot be undone.',
      ['Cancel', 'Reset'],
      0,
    )
    if (answer === 1) reset()
  }

  return (
    <div className="about">
      <div className="about-hero">
        <LeafIcon size={44} />
        <div>
          <h1 className="about-title">BeanWeb</h1>
          <p className="about-sub">Version 0.1.0 — a BeOS R5 tribute desktop</p>
        </div>
      </div>

      <dl className="about-specs">
        <dt>Kernel</dt>
        <dd>JavaScript, single-threaded</dd>
        <dt>Renderer</dt>
        <dd>React 19 + DOM compositor</dd>
        <dt>Processors</dt>
        <dd>
          {cores} logical core{cores === 1 ? '' : 's'}
        </dd>
        <dt>Display</dt>
        <dd>
          {window.screen.width}×{window.screen.height} @ {window.devicePixelRatio.toFixed(2)}×
        </dd>
        <dt>Volume</dt>
        <dd>{nodeCount} nodes in localStorage</dd>
      </dl>

      <p className="about-credit">
        An affectionate homage. Not affiliated with Be Incorporated or the Haiku
        project; all artwork here is original.
      </p>

      <div className="about-buttons">
        <Button onClick={onReset}>Reset disk…</Button>
        <span className="b-spacer" />
        <Button isDefault onClick={() => void requestClose(windowId)}>
          OK
        </Button>
      </div>
    </div>
  )
}

registerApp({
  id: 'about',
  name: 'About BeanWeb',
  component: About,
  icon: AboutIcon,
  defaultW: 400,
  defaultH: 330,
  minW: 320,
  minH: 300,
  singleton: true,
  hidden: true,
})
