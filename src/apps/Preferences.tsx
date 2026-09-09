import { useId } from 'react'
import { PrefsIcon } from '@/lib/icons'
import { Box, Button, RadioButton } from '@/widgets/controls'
import { confirmResetDisk } from '@/lib/disk'
import { useFs } from '@/store/fs'
import { useSettings, type ClockFormat } from '@/store/settings'
import { registerApp } from './registry'
import './preferences.css'

/**
 * R5 kept one preflet per setting in a Preferences folder. There is not enough
 * here to justify a folder, so this is one panel of labelled boxes -- the shape
 * an R5 preflet had, just with more than one box in it.
 *
 * Everything applies the moment it is chosen. There is no OK button and no
 * Revert, because nothing is being staged: picking Dark drops the curtain
 * immediately, and Reset asks for confirmation on its own.
 */
/**
 * "1:42 PM" / "13:42" -- the current time in the format the radio offers, so
 * the choice is shown rather than described. It is a still, not a clock: this
 * panel has no timer, and a sample that ticks would be a second thing to keep
 * alive for no gain.
 */
function sample(format: ClockFormat): string {
  return new Date().toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: format === '12h' ? 'h12' : 'h23',
  })
}

export function Preferences() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const clock = useSettings((s) => s.clock)
  const setClock = useSettings((s) => s.setClock)
  const nodeCount = useFs((s) => Object.keys(s.nodes).length)

  // Radios only group within a name, and a second window would otherwise share
  // this one's group. The app is a singleton today; this keeps it correct if
  // that ever changes.
  const group = useId()
  const clockGroup = useId()

  return (
    <div className="prefs b-scroll">
      <Box label="Appearance">
        <div className="prefs-choices" role="radiogroup" aria-label="Appearance">
          <RadioButton
            name={group}
            label="Light"
            value="light"
            checked={theme === 'light'}
            onChange={() => setTheme('light')}
          />
          <RadioButton
            name={group}
            label="Dark"
            value="dark"
            checked={theme === 'dark'}
            onChange={() => setTheme('dark')}
          />
        </div>
        <p className="prefs-note">
          The desktop changes behind a curtain, so it is never caught
          half-repainted.
        </p>
      </Box>

      <Box label="Clock">
        <div className="prefs-choices" role="radiogroup" aria-label="Clock">
          <RadioButton
            name={clockGroup}
            label={`12-hour (${sample('12h')})`}
            value="12h"
            checked={clock === '12h'}
            onChange={() => setClock('12h')}
          />
          <RadioButton
            name={clockGroup}
            label={`24-hour (${sample('24h')})`}
            value="24h"
            checked={clock === '24h'}
            onChange={() => setClock('24h')}
          />
        </div>
        <p className="prefs-note">
          How the Deskbar writes the time. Until you choose, it follows this
          browser's own locale.
        </p>
      </Box>

      <Box label="Disk">
        <dl className="prefs-specs">
          <dt>Volume</dt>
          <dd>
            {nodeCount} node{nodeCount === 1 ? '' : 's'} in localStorage
          </dd>
          <dt>Mounted at</dt>
          <dd className="b-fixed">beanweb.fs.v1</dd>
        </dl>
        <div className="prefs-action">
          <Button onClick={() => void confirmResetDisk()}>Reset disk…</Button>
          <p className="prefs-note">
            Discards every file you have created or edited and restores the
            original contents. Also offered by <em>About BeanWeb</em>.
          </p>
        </div>
      </Box>
    </div>
  )
}

registerApp({
  id: 'preferences',
  name: 'Preferences',
  component: Preferences,
  icon: PrefsIcon,
  defaultW: 360,
  defaultH: 430,
  minW: 300,
  minH: 260,
  singleton: true,
})
