#!/usr/bin/env node
/**
 * BeanWeb driver — launches the dev server, drives the desktop in a real
 * browser, and takes screenshots.
 *
 * Uses playwright-core against the *system* Chrome (channel: 'chrome'), so no
 * browser download is needed. There is no chromium-cli on this machine.
 *
 *   node .claude/skills/run-beanweb/driver.mjs smoke      # canned flow + shots
 *   node .claude/skills/run-beanweb/driver.mjs shot NAME  # one screenshot
 *   node .claude/skills/run-beanweb/driver.mjs repl       # stdin command loop
 *
 * REPL commands (one per line):
 *   open <AppName>        launch an app via the Deskbar menu (Tracker, BASIC…)
 *   click <selector>
 *   dblclick <selector>
 *   type <selector> <text>
 *   key <selector> <Key>  e.g. `key .term-input Enter`
 *   text <selector>       print textContent
 *   count <selector>      print how many match
 *   eval <js>             run in the page, print the result
 *   ss [name]             screenshot -> .claude/skills/run-beanweb/shots/
 *   sleep <ms>
 *   quit
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
/** Fixed port with --strictPort: Vite silently picks the next free port
 *  otherwise, and the driver would attach to someone else's server. */
const PORT = 5199
const URL = `http://localhost:${PORT}/`

mkdirSync(SHOTS, { recursive: true })

/* ------------------------------------------------------------ dev server */

function startServer() {
  return new Promise((resolve, reject) => {
    // shell:true is required on Windows for npm/npx to resolve.
    const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
      cwd: process.cwd(),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    const onData = (chunk) => {
      out += chunk.toString()
      if (out.includes('ready in') || out.includes(`localhost:${PORT}`)) resolve(proc)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', (code) => reject(new Error(`dev server exited (${code}):\n${out}`)))
    setTimeout(() => reject(new Error(`dev server did not start in 60s:\n${out}`)), 60000)
  })
}

/* ---------------------------------------------------------------- browser */

async function launch() {
  const server = await startServer()
  const browser = await chromium.launch({
    channel: 'chrome', // system Chrome; avoids downloading a browser
    headless: true,
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  // Playwright's 30s default makes a typo'd selector feel like a hang. This app
  // renders instantly, so anything not there in 5s is not coming.
  page.setDefaultTimeout(5000)

  const errors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // Chrome's text for a failed fetch is just "Failed to load resource: ...404",
    // with no URL. The URL lives on location(), and without it the message is
    // not actionable.
    const where = m.location()?.url ?? ''
    errors.push(`console: ${m.text()}${where ? ` <- ${where}` : ''}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`))
  // Record the URL too: "404 (Not Found)" alone is not actionable, and Chrome
  // asks for /favicon.ico unprompted, which is the usual culprit.
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`)
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  // The desktop boots a Tracker window; waiting on it proves React mounted.
  await page.waitForSelector('.b-window', { timeout: 20000 })

  return { server, browser, page, errors }
}

async function shot(page, name) {
  const file = join(SHOTS, `${name.replace(/[^\w.-]/g, '_')}.png`)
  await page.screenshot({ path: file })
  console.log(`shot -> ${file}`)
  return file
}

/**
 * Launch an app the way a user does: click the Deskbar logo, then the menu
 * item. Beats reaching into the store, and exercises the real path.
 */
async function openApp(page, name) {
  await page.click('.b-deskbar-logo')
  await page.waitForSelector('.b-menu', { timeout: 5000 })
  await page.click(`.b-menu-item:has-text("${name}")`)
  await page.waitForTimeout(400)
}

/* ------------------------------------------------------------------ modes */

async function smoke() {
  const { server, browser, page, errors } = await launch()
  const results = []
  const check = (label, ok, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    // 1. The desktop itself.
    const icons = await page.locator('.b-desktop-icon').count()
    check('desktop icons', icons === 4, `${icons} icons`)
    const clock = await page.locator('.b-deskbar-clock').textContent()
    check('deskbar clock', /\d/.test(clock ?? ''), clock ?? '')
    const booted = await page.locator('.b-window-title').first().textContent()
    check('boots a Tracker window', booted === 'home', booted ?? '')
    await shot(page, '01-desktop')

    // 2. Terminal: type a command and read the output back.
    await openApp(page, 'Terminal')
    await page.fill('.term-input', 'echo hello beanweb')
    await page.press('.term-input', 'Enter')
    await page.waitForTimeout(300)
    const termOut = await page.locator('.term-line').last().textContent()
    check('terminal runs a command', termOut?.includes('hello beanweb'), termOut ?? '')
    await shot(page, '02-terminal')

    // 3. BASIC: run a program and read the console.
    await openApp(page, 'BASIC')
    await page.fill('.basic-source', 'FOR i = 1 TO 3\n  PRINT i; "squared"; i * i\nNEXT i')
    await page.click('.basic-bar button:has-text("Run")')
    await page.waitForTimeout(600)
    const basicOut = await page.locator('.basic-output').textContent()
    check('BASIC runs a program', basicOut?.includes('squared'), (basicOut ?? '').trim().slice(0, 40))
    await shot(page, '03-basic')

    // 4. The design's whole point: an infinite loop must not freeze the tab.
    await page.fill('.basic-source', 'DO\nLOOP')
    await page.click('.basic-bar button:has-text("Run")')
    await page.waitForTimeout(500)
    const stateWhileRunning = await page.locator('.basic-state').textContent()
    check('infinite loop keeps running', stateWhileRunning?.includes('running'), stateWhileRunning ?? '')
    // If the UI were blocked this click could never land.
    await page.click('.basic-bar button:has-text("Stop")')
    await page.waitForTimeout(300)
    const stopped = await page.locator('.basic-state').textContent()
    check('Stop interrupts it', stopped?.includes('done'), stopped ?? '')
    await shot(page, '04-basic-stopped')

    // 5. Tetris renders its well.
    await openApp(page, 'Tetris')
    const cells = await page.locator('.tetris-field .tetris-cell').count()
    check('Tetris renders a 10x20 well', cells === 200, `${cells} cells`)
    await shot(page, '05-tetris')

    // 6. Window manager: drag a window by its tab.
    const tab = page.locator('.b-window--active .b-window-tab').first()
    const before = await page.locator('.b-window--active').first().boundingBox()
    await tab.hover()
    await page.mouse.down()
    await page.mouse.move(before.x + 160, before.y + 90, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const after = await page.locator('.b-window--active').first().boundingBox()
    check('window drags', Math.abs(after.x - before.x) > 50, `dx=${Math.round(after.x - before.x)}`)
    await shot(page, '06-dragged')

    // Chrome requests /favicon.ico on its own; the project ships none, and that
    // 404 is not an app defect. Everything else counts.
    const real = errors.filter((e) => !e.includes('favicon.ico'))
    check('no console errors', real.length === 0, real.slice(0, 2).join(' | '))
    if (real.length !== errors.length) console.log('(ignored a favicon.ico 404)')
  } finally {
    console.log('\n' + results.join('\n'))
    await browser.close()
    server.kill()
  }

  const failed = results.filter((r) => r.startsWith('FAIL'))
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASSED')
  process.exit(failed.length ? 1 : 0)
}

async function single(name) {
  const { server, browser, page } = await launch()
  await shot(page, name || 'screenshot')
  await browser.close()
  server.kill()
  process.exit(0)
}

async function repl() {
  const { server, browser, page, errors } = await launch()
  console.log(`ready — ${URL}\ntype commands, or "quit"`)

  const rl = createInterface({ input: process.stdin })
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [cmd, ...rest] = line.split(/\s+/)
    const arg = rest.join(' ')
    try {
      switch (cmd) {
        case 'open': await openApp(page, arg); console.log(`opened ${arg}`); break
        case 'click': await page.click(arg); console.log('clicked'); break
        case 'dblclick': await page.dblclick(arg); console.log('double-clicked'); break
        case 'type': {
          const [sel, ...t] = rest
          await page.fill(sel, t.join(' '))
          console.log('typed')
          break
        }
        case 'key': {
          const [sel, k] = rest
          await page.press(sel, k)
          console.log(`pressed ${k}`)
          break
        }
        case 'text': console.log(await page.locator(arg).first().textContent()); break
        case 'count': console.log(await page.locator(arg).count()); break
        case 'eval': console.log(JSON.stringify(await page.evaluate(arg))); break
        case 'ss': await shot(page, arg || `shot-${Date.now()}`); break
        case 'sleep': await page.waitForTimeout(Number(arg) || 200); break
        case 'errors': console.log(errors.length ? errors.join('\n') : '(none)'); break
        case 'quit': rl.close(); break
        default: console.log(`unknown: ${cmd}`)
      }
    } catch (err) {
      console.log(`ERROR: ${err.message.split('\n')[0]}`)
    }
  }

  await browser.close()
  server.kill()
  process.exit(0)
}

const [mode, ...args] = process.argv.slice(2)
const run = { smoke, shot: () => single(args[0]), repl }[mode ?? 'smoke']
if (!run) {
  console.error('usage: driver.mjs [smoke|shot NAME|repl]')
  process.exit(2)
}
run().catch((err) => {
  console.error(err)
  process.exit(1)
})
