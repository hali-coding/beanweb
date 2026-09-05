import { AboutIcon, LeafIcon } from '@/lib/icons'
import { Button } from '@/widgets/controls'
import { confirmResetDisk } from '@/lib/disk'
import { useDesktop } from '@/store/desktop'
import { useFs } from '@/store/fs'
import { registerApp } from './registry'
import type { AppProps } from './registry'
import './about.css'

const REPO_URL = 'https://github.com/hali-coding/beanweb'

/** Modelled on R5's "About this System": logo block left, spec sheet right. */
export function About({ windowId }: AppProps) {
  const requestClose = useDesktop((s) => s.requestClose)
  const nodeCount = useFs((s) => Object.keys(s.nodes).length)

  const cores = navigator.hardwareConcurrency || 1

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
        <dt>Source</dt>
        <dd>
          <a className="about-link" href={REPO_URL} target="_blank" rel="noreferrer">
            github.com/hali-coding/beanweb
          </a>
        </dd>
      </dl>

      <p className="about-credit">
        An affectionate homage. Not affiliated with Be Incorporated or the Haiku
        project; all artwork here is original.
      </p>

      <div className="about-buttons">
        <Button onClick={() => void confirmResetDisk()}>Reset disk…</Button>
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
  defaultH: 352,
  minW: 320,
  minH: 300,
  singleton: true,
  hidden: true,
})
