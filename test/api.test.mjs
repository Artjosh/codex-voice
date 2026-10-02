// HTTP tests against a server with no credentials. No OpenAI request is made,
// except the login test, which only builds the authorize URL locally.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8790
const base = `http://127.0.0.1:${PORT}`
const home = mkdtempSync(join(tmpdir(), 'codex-voice-test-'))
let server

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), CODEX_HOME: home, CODEX_VOICE_AUTH: join(home, 'app-auth.json') },
    stdio: 'pipe',
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { if (String(data).includes('codex-voice on')) resolve() })
    server.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
})

after(() => {
  server?.kill()
  rmSync(home, { recursive: true, force: true })
})

test('serves the UI and config', async () => {
  const html = await fetch(`${base}/`).then(r => r.text())
  assert.match(html, /<title>Codex Voice<\/title>/)
  const config = await fetch(`${base}/api/config`).then(r => r.json())
  assert.ok(config.voices.includes('cove'))
})

test('reports logged out without credentials', async () => {
  const status = await fetch(`${base}/api/auth`).then(r => r.json())
  assert.equal(status.loggedIn, false)
})

test('rejects a call without SDP and without login', async () => {
  let res = await fetch(`${base}/api/call`, { method: 'POST', body: '{}' })
  assert.equal(res.status, 400)
  res = await fetch(`${base}/api/call`, { method: 'POST', body: JSON.stringify({ sdp: 'v=0\r\n' }) })
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /Sem login/)
})

test('unknown calls and paths return 404, traversal is refused', async () => {
  assert.equal((await fetch(`${base}/api/calls/rtc_nope/events`)).status, 404)
  assert.equal((await fetch(`${base}/api/calls/rtc_nope/context`, { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await fetch(`${base}/nope.js`)).status, 404)
  assert.notEqual((await fetch(`${base}/..%2Fserver.mjs`)).status, 200)
})

test('login builds a PKCE authorize URL and rejects a forged callback', async () => {
  const { url } = await fetch(`${base}/api/auth/login`, { method: 'POST' }).then(r => r.json())
  const auth = new URL(url)
  assert.equal(auth.origin, 'https://auth.openai.com')
  assert.equal(auth.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(auth.searchParams.get('state'))

  const forged = await fetch('http://127.0.0.1:1455/auth/callback?code=x&state=wrong')
  assert.equal(forged.status, 400)
  const status = await fetch(`${base}/api/auth`).then(r => r.json())
  assert.equal(status.login.status, 'error')
  assert.equal(status.login.error, 'invalid state')
})

test('switching account restarts the login with prompt=login on the same port', async () => {
  const first = await fetch(`${base}/api/auth/login`, { method: 'POST', body: '{}' }).then(r => r.json())
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ switchAccount: true }) })
  assert.equal(res.status, 200)
  const second = new URL((await res.json()).url)
  assert.equal(second.searchParams.get('prompt'), 'login')
  assert.notEqual(second.searchParams.get('state'), new URL(first.url).searchParams.get('state'))
  const forged = await fetch(`http://127.0.0.1:1455/auth/callback?code=x&state=${new URL(first.url).searchParams.get('state')}`)
  assert.equal(forged.status, 400, 'old state must be rejected by the new listener')
})
