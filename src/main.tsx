import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/reset.css'
import './styles/widgets.css'
import './styles/wm.css'
import './styles/shell.css'

// Registers every application before the first render.
import './apps'
import { registerInstalledPackages } from './lib/packages/install'

import App from './App'

/*
 * Installed packages join the registry alongside the built-ins, and before the
 * first render for the same reason: a window restored for a package has to be
 * able to resolve its app on the very first pass, or it paints as empty chrome.
 * The index this reads is synchronous localStorage; the packages' code is
 * fetched from IndexedDB later, when a window actually opens.
 */
registerInstalledPackages()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
