// Live end-to-end test against the real ChatGPT account. Spends a little plan usage
// (about 1 minute of voice plus one backend answer).
//
// Plays test/fixtures/question.wav as the microphone in headless Edge/Chrome and checks:
// login state, call setup, sideband, delegation answered by the backend and spoken,
// text context, mute, and hangup.
//
//   npm run test:live            (BROWSER=path\to\chrome.exe to override)
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = 8791
const base = `http://127.0.0.1:${PORT}`
const root = fileURLToPath(new URL('..', import.meta.url))
const wav = fileURLToPath(new URL('./fixtures/question.wav', import.meta.url))
const browserPath = process.env.BROWSER ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' })
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
await new Promise(resolve => server.stdout.on('data', d => { if (String(d).includes('codex-voice on')) resolve() }))

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
})

const lines = page => page.evaluate(() => [...document.querySelectorAll('#log .msg')].map(d => ({ cls: d.className.replace('msg ', ''), text: d.textContent })))
async function waitFor(page, label, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const found = (await lines(page)).find(predicate)
    if (found) return found
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

try {
  const page = await browser.newPage()
  await page.goto(base)
  await page.waitForFunction(() => !document.getElementById('account').textContent.startsWith('Verificando'))
  const account = await page.$eval('#account', el => el.textContent)
  check('logged in', !account.startsWith('Sem login'), account)

  await page.waitForSelector('#voice option')
  await page.click('#start')
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Conectado'), { timeout: 30_000 })
    .then(() => check('call connected + sideband open', true))
    .catch(() => check('call connected + sideband open', false))

  const heard = await waitFor(page, 'user transcript', l => l.cls === 'user' && /australia/i.test(l.text), 30_000)
  check('voice input transcribed', !!heard, heard?.text.trim())

  const delegated = await waitFor(page, 'backend answer', l => l.cls === 'deleg' && l.text.startsWith('resposta do backend'), 60_000)
  check('delegation answered by backend', !!delegated && /can?m?berra/i.test(delegated.text), delegated?.text.slice(0, 120))

  const spoken = await waitFor(page, 'spoken answer', l => l.cls === 'assistant' && /ca[mn]berra/i.test(l.text), 30_000)
  check('answer spoken by voice', !!spoken, spoken?.text.trim().slice(0, 120))

  await new Promise(r => setTimeout(r, 3000)) // let the spoken answer finish
  await page.type('#text', 'Responda só com a palavra abacaxi.')
  await page.click('#sendText')
  const fruit = await waitFor(page, 'typed answer', l => l.cls === 'assistant' && /^s*abacaxiW*$/i.test(l.text), 30_000)
  check('typed message answered on screen', !!fruit, fruit?.text.trim())
  if (!fruit || process.env.DEBUG) console.log(JSON.stringify(await lines(page), null, 1))

  await page.click('#mute')
  const micEnabled = await page.evaluate(() => mic.getAudioTracks().every(t => t.enabled))
  check('mute disables mic track', !micEnabled)

  const callId = await page.evaluate(() => callId)
  await page.click('#stop')
  await new Promise(r => setTimeout(r, 3000))
  const backlog = await fetch(`${base}/api/calls/${callId}/events`).then(r => r.text())
  check('hangup closes session', backlog.includes('"local.closed"'))
  check('no errors during call', !/"type":"(local\.)?error"/.test(backlog), (backlog.match(/"message":"[^"]*"/g) ?? []).join(' '))
} finally {
  await browser.close()
  server.kill()
}

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
