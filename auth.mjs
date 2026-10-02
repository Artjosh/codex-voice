// ChatGPT OAuth session for codex-voice.
//
// Two token sources:
// - "app":   this app's own session in .data/auth.json, created by the "Entrar com ChatGPT"
//            login. Independent from Codex, so refreshes never rotate Codex's tokens.
// - "codex": fallback to Codex's ~/.codex/auth.json. Refreshes are written back to that file
//            so Codex keeps working with the rotated refresh token.
import { createServer } from 'node:http'
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ISSUER = 'https://auth.openai.com'
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
// Port and path are on the Codex client's redirect allow-list.
const CALLBACK_PORT = 1455
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const APP_DIR = dirname(fileURLToPath(import.meta.url))
export const APP_AUTH_PATH = process.env.CODEX_VOICE_AUTH ?? join(APP_DIR, '.data', 'auth.json')
export const CODEX_AUTH_PATH = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')

export function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, path)
}

async function loadSource() {
  const app = await readJsonFile(APP_AUTH_PATH)
  if (app?.tokens?.access_token) return { source: 'app', path: APP_AUTH_PATH, raw: app }
  const codex = await readJsonFile(CODEX_AUTH_PATH)
  if (codex?.tokens?.access_token) return { source: 'codex', path: CODEX_AUTH_PATH, raw: codex }
  return null
}

function toAuth(loaded) {
  const { tokens } = loaded.raw
  const claims = decodeJwt(tokens.id_token ?? '')
  const authClaims = claims['https://api.openai.com/auth'] ?? {}
  const exp = decodeJwt(tokens.access_token).exp
  return {
    source: loaded.source,
    accessToken: tokens.access_token,
    accountId: tokens.account_id ?? authClaims.chatgpt_account_id,
    email: claims.email,
    plan: authClaims.chatgpt_plan_type,
    expiresAt: exp ? exp * 1000 : null,
  }
}

let refreshing = null

async function refresh(loaded) {
  refreshing ??= (async () => {
    // Re-read: another process (Codex) may have rotated the token since we loaded it.
    const current = (await readJsonFile(loaded.path)) ?? loaded.raw
    const response = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: current.tokens.refresh_token }),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw new Error(`Renovação do login falhou (${response.status}). Entre com ChatGPT de novo. ${detail}`)
    }
    const fresh = await response.json()
    current.tokens = {
      ...current.tokens,
      ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
      ...(fresh.access_token ? { access_token: fresh.access_token } : {}),
      ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
    }
    current.last_refresh = new Date().toISOString()
    await writeJsonAtomic(loaded.path, current)
    console.log(`[auth] refreshed ${loaded.source} session`)
    return { ...loaded, raw: current }
  })().finally(() => { refreshing = null })
  return refreshing
}

/** Returns a usable session, refreshing it first when it is near expiry or when forced. */
export async function getAuth({ forceRefresh = false } = {}) {
  let loaded = await loadSource()
  if (!loaded) throw new Error('Sem login. Clique em "Entrar com ChatGPT".')
  const auth = toAuth(loaded)
  if (forceRefresh || (auth.expiresAt && auth.expiresAt - Date.now() < REFRESH_MARGIN_MS)) {
    loaded = await refresh(loaded)
    return toAuth(loaded)
  }
  return auth
}

export async function authStatus() {
  const loaded = await loadSource()
  if (!loaded) return { loggedIn: false, login: loginState() }
  const { accessToken, accountId, ...info } = toAuth(loaded)
  return { loggedIn: true, ...info, login: loginState() }
}

export async function logout() {
  await rm(APP_AUTH_PATH, { force: true })
}

// ---------- browser login (OAuth authorization code + PKCE) ----------

let pending = null

function loginState() {
  if (!pending) return null
  return { status: pending.status, error: pending.error ?? null }
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${title}</h2><p>${text}</p></div></body>`
}

/**
 * Starts the callback listener and returns the URL the user must open.
 * switchAccount asks OpenAI to show the login form even when the browser is already signed in.
 */
export async function startLogin({ switchAccount = false } = {}) {
  if (pending?.status === 'waiting') {
    // Replace the unfinished login so its port can be reused.
    clearTimeout(pending.timer)
    const old = pending.server
    pending = null
    await new Promise(resolve => { old.close(resolve); old.closeAllConnections() })
  }
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const url = new URL(`${ISSUER}/oauth/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
    ...(switchAccount ? { prompt: 'login' } : {}),
  }).toString()

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, REDIRECT_URI)
    if (reqUrl.pathname !== '/auth/callback') {
      res.writeHead(404).end()
      return
    }
    const finish = (status, title, text, error) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(title, text))
      pending = { ...pending, status: error ? 'error' : 'done', error }
      clearTimeout(pending.timer)
      server.close()
    }
    if (reqUrl.searchParams.get('state') !== state) return finish(400, 'Falhou', 'Estado inválido. Tente de novo.', 'invalid state')
    const oauthError = reqUrl.searchParams.get('error')
    if (oauthError) return finish(400, 'Falhou', reqUrl.searchParams.get('error_description') ?? oauthError, oauthError)
    try {
      const response = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: reqUrl.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      })
      if (!response.ok) throw new Error(`token exchange ${response.status}: ${(await response.text()).slice(0, 200)}`)
      const tokens = await response.json()
      const claims = decodeJwt(tokens.id_token ?? '')
      await writeJsonAtomic(APP_AUTH_PATH, {
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id,
        },
        last_refresh: new Date().toISOString(),
      })
      console.log(`[auth] logged in as ${claims.email ?? 'unknown'}`)
      finish(200, 'Pronto', 'Login feito. Pode fechar esta aba e voltar ao Codex Voice.')
    } catch (error) {
      finish(500, 'Falhou', error.message, error.message)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Porta ${CALLBACK_PORT} ocupada (login do Codex aberto?). Feche e tente de novo.`)
      : error))
    server.listen(CALLBACK_PORT, process.env.CALLBACK_HOST ?? '127.0.0.1', resolve)
  })
  const timer = setTimeout(() => {
    if (pending?.status === 'waiting') pending = { ...pending, status: 'error', error: 'timeout' }
    server.close()
  }, LOGIN_TIMEOUT_MS)
  pending = { status: 'waiting', url: url.toString(), timer, server }
  return { url: url.toString() }
}
