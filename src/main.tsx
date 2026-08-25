import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/reset.css'
import './styles/widgets.css'
import './styles/wm.css'
import './styles/shell.css'

// Registers every application before the first render.
import './apps'

import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
