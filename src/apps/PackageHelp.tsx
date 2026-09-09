import { PackageHelpIcon } from '@/lib/icons'
import { Box, Button } from '@/widgets/controls'
import { useDesktop } from '@/store/desktop'
import { registerApp, type AppProps } from './registry'
import './packagehelp.css'

/**
 * *Help → About Packages* in Coffee Shop.
 *
 * A window rather than an alert, for the reason About BeanWeb is one: this is
 * a page to read and to come back to, it carries links, and an alert is a
 * question. Hidden from the Deskbar because it is Coffee Shop's help, not an
 * application of its own -- the same standing About has.
 *
 * What it says is the security story, in the user's words rather than the
 * repository's: `docs/packages.md` is the specification and stays the
 * reference, and this window links to it rather than restating it. Keep the
 * two honest with each other -- the sentences here are a promise about what
 * the code does, and they are the only version of it a user ever sees.
 */

const PKGS_URL = 'https://github.com/hali-coding/beanweb/tree/main/pkgs'
const FORMAT_URL = 'https://github.com/hali-coding/beanweb/blob/main/docs/packages.md'

export function PackageHelp({ windowId }: AppProps) {
  const requestClose = useDesktop((s) => s.requestClose)

  return (
    <div className="pkghelp">
      <div className="pkghelp-hero">
        <PackageHelpIcon size={44} />
        <div>
          <h1 className="pkghelp-title">About Packages</h1>
          <p className="pkghelp-sub">
            What an app from Coffee Shop can and cannot do on this desk
          </p>
        </div>
      </div>

      <Box label="It runs in a sandbox">
        <p className="pkghelp-p">
          A package is not part of BeanWeb. It runs in its own frame, sealed with{' '}
          <code>sandbox="allow-scripts"</code> and deliberately <em>without</em>{' '}
          <code>allow-same-origin</code>, which puts it on an origin of its own: it cannot read
          this desktop's storage, cannot see your files or your API key, and a reach for the page
          around it simply throws.
        </p>
        <p className="pkghelp-p">
          The frame also carries <code>default-src 'none'; connect-src 'none'</code>, so it has no
          network at all — nothing it is shown can be sent anywhere. There is no permission for
          the network, and there is not going to be one.
        </p>
        <p className="pkghelp-p">
          Everything else it does, it asks BeanWeb to do, by message, over one bridge that answers
          a fixed list of requests and nothing outside it.
        </p>
      </Box>

      <Box label="What it may ask for">
        <dl className="pkghelp-grants">
          <dt>Always</dt>
          <dd>
            Retitle its own window, close it, and raise an alert you answer. None of these reaches
            anything of yours.
          </dd>
          <dt>With Access</dt>
          <dd>
            Read, write, list and remove files in <code>/boot/home/packages/&lt;id&gt;</code> — its
            own folder, and nowhere else. The host resolves every path it names before acting on
            it, so there is no route out of that folder.
          </dd>
          <dt>By opening</dt>
          <dd>
            If you double-click a document a package claims, it gets that one file — not the
            folder around it, and it cannot delete it. The double-click is the consent.
          </dd>
        </dl>
        <p className="pkghelp-p pkghelp-note">
          The permissions a package asks for are listed before it is installed, and again under
          <b> Access</b> in the <b>Installed</b> tab. Removing a package leaves its documents
          folder where it is.
        </p>
      </Box>

      <Box label="Writing one">
        <p className="pkghelp-p">
          A package is a zip named <code>.pkg</code> holding a <code>manifest.json</code>, an entry
          script and an optional icon. There is no build step and no framework — plain HTML,
          JavaScript and CSS are enough.
        </p>
        <p className="pkghelp-p">
          The packages that ship with BeanWeb are the worked examples, source and all:
        </p>
        <p className="pkghelp-p">
          <a className="pkghelp-link" href={PKGS_URL} target="_blank" rel="noreferrer">
            github.com/hali-coding/beanweb/tree/main/pkgs
          </a>
        </p>
        <p className="pkghelp-p">
          <code>node pkgs/build.mjs init &lt;name&gt;</code> there scaffolds one that already
          builds, installs and runs. The format itself is written up in{' '}
          <a className="pkghelp-link" href={FORMAT_URL} target="_blank" rel="noreferrer">
            docs/packages.md
          </a>
          .
        </p>
      </Box>

      <div className="pkghelp-buttons">
        <span className="b-spacer" />
        <Button isDefault onClick={() => void requestClose(windowId)}>
          OK
        </Button>
      </div>
    </div>
  )
}

registerApp({
  id: 'packagehelp',
  name: 'About Packages',
  component: PackageHelp,
  icon: PackageHelpIcon,
  defaultW: 460,
  defaultH: 600,
  minW: 340,
  minH: 300,
  singleton: true,
  hidden: true,
})
