// WhatsApp side of codex-voice.
// - /api/pcm (WebSocket): the wa-bridge streams a WhatsApp call's audio here
//   (16 kHz mono i16 LE, binary), and receives the model's voice back the same way.
// - /api/wa/*: status, QR, and hangup, proxied from the bridge for the UI.
import { WebSocketServer } from 'ws'
import { openPcmCall } from './pcm-call.mjs'

const BRIDGE_URL = process.env.WA_BRIDGE_URL ?? 'http://127.0.0.1:3340'
const TOKEN = process.env.VOICE_TOKEN ?? ''
const VOICE = process.env.WA_VOICE ?? 'cove'
const IDLE_MS = Number(process.env.WA_IDLE_MINUTES ?? 5) * 60_000
const MAX_MS = Number(process.env.WA_MAX_CALL_MINUTES ?? 60) * 60_000

const ONE_TO_ONE = `Você está numa chamada de voz do WhatsApp. Fale português do Brasil, de forma breve e natural, como numa ligação.`
const GROUP = `Você está numa chamada de voz em grupo do WhatsApp, com várias pessoas. Fale português do Brasil, de forma breve e natural.
Você se chama Codex. Responda só quando alguém falar com você pelo nome ou fizer uma pergunta claramente dirigida a você. Quando as pessoas estiverem conversando entre si, fique em silêncio.`

/** Active WhatsApp calls, shown in the UI. */
export const waCalls = new Map()

function log(...args) {
  console.log('[wa]', ...args)
}

export function attachWhatsApp(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/api/pcm') return socket.destroy()
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, ws => handlePcmSocket(ws, url))
  })
}

async function handlePcmSocket(ws, url) {
  const caller = url.searchParams.get('caller') ?? '?'
  const group = url.searchParams.get('group')
  const instructions = [group ? GROUP : ONE_TO_ONE, process.env.WA_INSTRUCTIONS].filter(Boolean).join('\n\n')
  let lastActivity = Date.now()
  let pcm
  let closed = false
  const startedAt = Date.now()

  const finish = reason => {
    if (closed) return
    closed = true
    log(`chamada de ${caller} encerrada: ${reason}`)
    clearInterval(watchdog)
    if (pcm) waCalls.delete(pcm.callId)
    pcm?.close()
    if (ws.readyState === ws.OPEN) ws.close(1000, reason.slice(0, 100))
  }
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) finish('silêncio prolongado')
    else if (Date.now() - startedAt > MAX_MS) finish('duração máxima')
  }, 5000)

  // Audio can arrive while the GPT-Live call is still opening; drop it until then.
  ws.on('message', (data, binary) => {
    if (!binary || !pcm) return
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data)
    const aligned = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
    pcm.push(new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2))
  })
  ws.on('close', () => finish('WhatsApp desligou'))
  ws.on('error', error => finish(`erro no socket: ${error.message}`))

  try {
    pcm = await openPcmCall({
      voice: VOICE,
      instructions,
      onAudio: frame => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), { binary: true })
      },
      onEvent: event => {
        if (['input_transcript.added', 'output_transcript.added', 'turn.done', 'local.delegation'].includes(event.type)) lastActivity = Date.now()
        if (event.type === 'turn.done' && event.turn?.transcript?.trim()) log(`${caller} ${event.turn.role}: ${event.turn.transcript.trim()}`)
        if (event.type === 'error' || event.type === 'local.error') log('erro:', event.message ?? JSON.stringify(event.error))
        if (event.type === 'local.closed') finish('sessão de voz encerrada')
      },
    })
  } catch (error) {
    log(`não abriu GPT-Live para ${caller}: ${error.message}`)
    return finish('falha ao abrir voz')
  }
  if (closed) return pcm.close()
  waCalls.set(pcm.callId, { callId: pcm.callId, caller, group, startedAt })
  log(`chamada de ${caller}${group ? ` (grupo ${group})` : ''} ligada ao GPT-Live ${pcm.callId}`)
}

/** Handles /api/wa/* routes. Returns false when the path is not ours. */
export async function handleWaRoute(req, res, url) {
  if (!url.pathname.startsWith('/api/wa/')) return false
  const path = url.pathname.slice('/api/wa'.length)
  try {
    if (req.method === 'GET' && path === '/status') {
      const bridge = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...bridge, reachable: true, calls: [...waCalls.values()] }))
      return true
    }
    if (req.method === 'GET' && path === '/qr.svg') {
      const upstream = await fetch(`${BRIDGE_URL}/qr.svg`, { signal: AbortSignal.timeout(3000) })
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain', 'Cache-Control': 'no-store' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
      return true
    }
    if (req.method === 'POST' && (path === '/allowed' || path === '/policy/mode')) {
      let body = ''
      for await (const chunk of req) body += chunk
      const upstream = await fetch(`${BRIDGE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(3000),
      })
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
      return true
    }
    if (req.method === 'POST' && path === '/hangup') {
      const upstream = await fetch(`${BRIDGE_URL}/hangup`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(r => r.json())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(upstream))
      return true
    }
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ reachable: false, error: error.message, calls: [...waCalls.values()] }))
    return true
  }
  res.writeHead(404).end()
  return true
}
