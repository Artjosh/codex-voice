// Local voice server: brokers GPT-Live (gpt-live-1-codex) WebRTC calls through the
// ChatGPT OAuth session from auth.mjs (own login, or Codex's). The access token never
// leaves this process; the browser only exchanges SDP and receives events over SSE.
//
// Private, undocumented endpoints (same ones the Codex app uses). They can change
// or disappear without notice.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { getAuth, authStatus, startLogin, logout, APP_AUTH_PATH, CODEX_AUTH_PATH } from './auth.mjs'
import { attachWhatsApp, handleWaRoute } from './wa.mjs'

const PORT = Number(process.env.PORT ?? 8787)
// 0.0.0.0 only inside the container; docker-compose publishes it on 127.0.0.1.
const HOST = process.env.HOST ?? '127.0.0.1'
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

const SIGNALING_URL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas'
const SIDEBAND_URL = callId => `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const LIVE_MODEL = 'gpt-live-1-codex'
const VOICES = ['cove', 'arbor', 'breeze', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale']
const DELEGATE_MODEL = process.env.DELEGATE_MODEL ?? 'gpt-5.6-terra'
const DELEGATE_EFFORT = process.env.DELEGATE_EFFORT ?? 'low'
const DELEGATE_WEB_SEARCH = process.env.DELEGATE_WEB_SEARCH !== '0'
const ORIGINATOR = process.env.CODEX_ORIGINATOR ?? 'codex_cli_rs'
const CLIENT_VERSION = process.env.CODEX_VERSION ?? '0.159.2'
const DELEGATION_RESULT_MAX_CHARS = 1800

const BASE_INSTRUCTIONS = `You are the realtime voice layer of a personal assistant. You have no tools of your own.
Delegate any request that requires real work, reasoning, current information, or actions to the client through a delegation.
Delegate each user request once and wait for its result. New user follow-ups, corrections, and explicit retries are new requests. Backend results are not user requests; do not delegate them or repeat the original request when they arrive.
Keep the conversation natural while delegated work runs.
Context on the commentary channel is silent background. You may use it, but never read it aloud.
Context on the speakable channel is your answer to deliver naturally in your own words. Never mention the channel or the delegation.`

const DEFAULT_USER_INSTRUCTIONS = 'Fale em português do Brasil por padrão. Seja breve e natural.'

const DELEGATE_INSTRUCTIONS = `You are the reasoning backend of a voice assistant. Your answer will be spoken aloud by a voice model.
Answer in the user's language. Be concise: a few short sentences. Plain text only: no markdown, lists, code blocks, URLs, or emoji.`

// ---------- auth ----------

function baseHeaders(auth, sessionId) {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
    originator: ORIGINATOR,
    'User-Agent': `${ORIGINATOR}/${CLIENT_VERSION}`,
    version: CLIENT_VERSION,
    session_id: sessionId,
  }
}

function liveHeaders(auth, call) {
  return {
    ...baseHeaders(auth, call.sessionId),
    'OpenAI-Alpha': 'quicksilver=v2',
    'x-session-id': call.realtimeId,
    'session-id': call.sessionId,
    'thread-id': call.sessionId,
  }
}

// Runs fn(auth); on 401/403 refreshes once and retries.
async function withAuth(fn) {
  let result = await fn(await getAuth())
  if (result.status === 401 || result.status === 403) result = await fn(await getAuth({ forceRefresh: true }))
  return result
}

// ---------- calls ----------

const calls = new Map()

function emit(call, event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  call.backlog.push(line)
  if (call.backlog.length > 500) call.backlog.shift()
  for (const res of call.listeners) res.write(line)
  for (const fn of call.subscribers) fn(event)
}

/** Server-side consumers (the WhatsApp PCM bridge) watch a call's events with this. */
export function subscribeCall(callId, fn) {
  const call = calls.get(callId)
  if (!call) throw new Error('unknown call')
  call.subscribers.add(fn)
  return () => call.subscribers.delete(fn)
}

export function hangupCall(callId) {
  const call = calls.get(callId)
  if (call) hangup(call)
}

export function parseCallId(location, sessionHeader) {
  const fromLocation = location?.split('?')[0]?.split('/').find(part => /^rtc_[\w-]+$/.test(part))
  return fromLocation ?? sessionHeader ?? undefined
}

function describeSignalingFailure(status, detail) {
  if (status === 404) return 'Voz Codex indisponível nesta conta (404). A rota exige plano pago com Codex voice.'
  if (status === 401 || status === 403) return `Acesso negado (${status}). Rode "codex login" e tente de novo.`
  return `Falha ao abrir chamada (${status}): ${detail}`
}

export async function createCall({ sdp, voice, instructions }) {
  const call = {
    id: null,
    sessionId: randomUUID(),
    realtimeId: randomUUID(),
    socket: null,
    listeners: new Set(),
    subscribers: new Set(),
    backlog: [],
    history: [],
    headers: null,
    closed: false,
  }
  const session = {
    model: LIVE_MODEL,
    instructions: [BASE_INSTRUCTIONS, (instructions ?? DEFAULT_USER_INSTRUCTIONS).trim()].filter(Boolean).join('\n\n'),
    audio: { output: { voice: VOICES.includes(voice) ? voice : 'cove' } },
    delegation: { type: 'client' },
  }
  const body = JSON.stringify({ sdp, session })
  const response = await withAuth(async auth => {
    call.headers = liveHeaders(auth, call)
    return fetch(SIGNALING_URL, {
      method: 'POST',
      headers: { ...call.headers, Accept: '*/*', 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
    })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(describeSignalingFailure(response.status, text.replace(/\s+/g, ' ').slice(0, 400)))
  const callId = parseCallId(response.headers.get('location'), response.headers.get('openai-session-id'))
  if (!callId || !text.startsWith('v=')) throw new Error('Resposta inválida: sem call id ou SDP answer')
  call.id = callId
  calls.set(callId, call)
  // Sideband attaches after the browser applies the answer; retry a few times.
  openSidebandWithRetry(call).catch(error => emit(call, { type: 'local.error', message: `Sideband: ${error.message}` }))
  return { callId, sdp: text }
}

async function openSidebandWithRetry(call) {
  for (let attempt = 0; ; attempt++) {
    if (call.closed) return
    try { await openSideband(call); return } catch (error) {
      if (attempt === 5) throw error
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt))
    }
  }
}

function openSideband(call) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(SIDEBAND_URL(call.id), { headers: call.headers, handshakeTimeout: 15_000 })
    let opened = false
    socket.on('open', () => {
      opened = true
      call.socket = socket
      emit(call, { type: 'local.sideband', status: 'open' })
      resolve()
    })
    socket.on('message', (data, binary) => { if (!binary) onServerEvent(call, data.toString()) })
    socket.on('error', error => { if (!opened) reject(error); else emit(call, { type: 'local.error', message: error.message }) })
    socket.on('close', code => {
      if (!opened) return reject(new Error(`closed (${code})`))
      if (call.socket === socket) call.socket = null
      emit(call, { type: 'local.sideband', status: 'closed', code })
    })
  })
}

function send(call, message) {
  if (call.socket?.readyState !== WebSocket.OPEN) throw new Error('sideband not connected')
  call.socket.send(JSON.stringify(message))
}

function onServerEvent(call, payload) {
  let event
  try { event = JSON.parse(payload) } catch { return }
  if (event.type === 'output_audio.delta') return // audio already arrives over WebRTC
  emit(call, event)
  if (event.type === 'turn.done' && event.turn?.transcript) {
    call.history.push({ role: event.turn.role, text: event.turn.transcript })
    if (call.history.length > 40) call.history.shift()
  }
  if (event.type === 'delegation.created' && event.item?.id) {
    const input = (event.item.content ?? []).filter(part => part.type === 'input_text').map(part => part.text).join('\n')
    runDelegation(call, event.item.id, input)
  }
}

// The voice route accepts context appends of at most 500 UTF-8 bytes each.
export function chunkContext(text, maxBytes = 500) {
  const chunks = []
  let current = ''
  for (const char of text) {
    if (Buffer.byteLength(current + char) > maxBytes) {
      chunks.push(current)
      current = ''
    }
    current += char
  }
  if (current || !chunks.length) chunks.push(current)
  return chunks
}

function appendContext(call, text, { channel, delegationId }) {
  for (const chunk of chunkContext(text)) {
    const content = [{ type: 'input_text', text: chunk }]
    send(call, delegationId
      ? { type: 'delegation.context.append', delegation_item_id: delegationId, channel, content }
      : { type: 'session.context.append', channel, content })
  }
}

// Answers a voice delegation (itemId set) or a typed message (itemId null) with the backend.
// A delegation answer goes back to the voice to speak. A typed answer is shown as text and
// added as silent context: the voice route only speaks context during an active turn, so
// speakable context sent while the voice is idle would never be heard.
async function runDelegation(call, itemId, input) {
  emit(call, { type: 'local.delegation', id: itemId, status: 'running', input, typed: !itemId })
  let answer
  try {
    answer = await askBackend(call, input)
  } catch (error) {
    answer = `Backend error: ${error.message}. Tell the user briefly that it failed.`
  }
  if (answer.length > DELEGATION_RESULT_MAX_CHARS) answer = `${answer.slice(0, DELEGATION_RESULT_MAX_CHARS - 12).trimEnd()} [truncated]`
  emit(call, { type: 'local.delegation', id: itemId, status: 'done', output: answer, typed: !itemId })
  if (call.closed) return
  try {
    if (itemId) {
      appendContext(call, answer, { channel: 'speakable', delegationId: itemId })
    } else {
      call.history.push({ role: 'assistant', text: answer })
      appendContext(call, `The user typed: "${input}". It was answered on screen with: "${answer}"`, { channel: 'commentary' })
    }
  } catch (error) {
    emit(call, { type: 'local.error', message: `Could not deliver answer to the voice: ${error.message}` })
  }
}

// Answers a delegation with a Codex Responses request billed to the same ChatGPT plan.
async function askBackend(call, input) {
  const transcript = call.history.slice(-12).map(entry => `${entry.role}: ${entry.text}`).join('\n')
  const text = transcript ? `Conversation so far:\n${transcript}\n\nRequest:\n${input}` : input
  const body = JSON.stringify({
    model: DELEGATE_MODEL,
    instructions: DELEGATE_INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    tools: DELEGATE_WEB_SEARCH ? [{ type: 'web_search' }] : [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: DELEGATE_EFFORT },
    store: false,
    stream: true,
    include: [],
  })
  const response = await withAuth(auth => fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { ...baseHeaders(auth, call.sessionId), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body,
  }))
  if (!response.ok) throw new Error(`responses ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return readResponseText(response)
}

async function readResponseText(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  let output = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
      if (!data || data === '[DONE]') continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      if (event.type === 'response.output_text.delta') output += event.delta
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(event.response?.error?.message ?? event.error?.message ?? event.message ?? 'response failed')
      }
    }
  }
  return toSpeakable(output) || 'No answer.'
}

// Web search answers carry markdown citations; the voice model would read them aloud.
export function toSpeakable(text) {
  return text
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function hangup(call) {
  if (call.closed) return
  call.closed = true
  try { send(call, { type: 'session.close' }) } catch {}
  setTimeout(() => call.socket?.close(1000, 'session closed'), 500)
  emit(call, { type: 'local.closed' })
  for (const res of call.listeners) res.end()
  setTimeout(() => calls.delete(call.id), 60_000)
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 512 * 1024) throw new Error('body too large')
  }
  return JSON.parse(raw || '{}')
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (await handleWaRoute(req, res, url)) return
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { voices: VOICES, defaultInstructions: DEFAULT_USER_INSTRUCTIONS, delegateModel: DELEGATE_MODEL })
    }
    if (req.method === 'GET' && url.pathname === '/api/auth') return json(res, 200, await authStatus())
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { switchAccount } = await readJson(req)
      return json(res, 200, await startLogin({ switchAccount: !!switchAccount }))
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      await logout()
      return json(res, 200, await authStatus())
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      const { sdp, voice, instructions } = await readJson(req)
      if (typeof sdp !== 'string' || !sdp.startsWith('v=')) return json(res, 400, { error: 'missing SDP offer' })
      return json(res, 200, await createCall({ sdp, voice, instructions }))
    }
    const eventsMatch = url.pathname.match(/^\/api\/calls\/([\w-]+)\/events$/)
    if (req.method === 'GET' && eventsMatch) {
      const call = calls.get(eventsMatch[1])
      if (!call) return json(res, 404, { error: 'unknown call' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      for (const line of call.backlog) res.write(line)
      if (call.closed) return res.end()
      call.listeners.add(res)
      req.on('close', () => call.listeners.delete(res))
      return
    }
    const textMatch = url.pathname.match(/^\/api\/calls\/([\w-]+)\/context$/)
    if (req.method === 'POST' && textMatch) {
      const call = calls.get(textMatch[1])
      if (!call) return json(res, 404, { error: 'unknown call' })
      const { text, channel } = await readJson(req)
      if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'missing text' })
      // "commentary" is silent background for the voice model; anything else is a typed user message.
      if (channel === 'commentary') {
        appendContext(call, text, { channel: 'commentary' })
      } else {
        call.history.push({ role: 'user', text })
        runDelegation(call, null, text)
      }
      return json(res, 200, { ok: true })
    }
    const hangupMatch = url.pathname.match(/^\/api\/calls\/([\w-]+)\/hangup$/)
    if (req.method === 'POST' && hangupMatch) {
      const call = calls.get(hangupMatch[1])
      if (call) hangup(call)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (file.includes('..')) return json(res, 400, { error: 'bad path' })
      const content = await readFile(join(PUBLIC_DIR, file)).catch(() => null)
      if (!content) return json(res, 404, { error: 'not found' })
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
      return res.end(content)
    }
    json(res, 404, { error: 'not found' })
  } catch (error) {
    console.error('[error]', error.message)
    if (!res.headersSent) json(res, 500, { error: error.message })
  }
})

// Localhost only: anyone who can reach this server spends your ChatGPT plan.
// Importing this module (tests) does not start the server.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  attachWhatsApp(server)
  server.listen(PORT, HOST, () => {
    console.log(`codex-voice on http://${HOST}:${PORT}  (auth: ${APP_AUTH_PATH} or ${CODEX_AUTH_PATH}, delegate: ${DELEGATE_MODEL})`)
  })
}
