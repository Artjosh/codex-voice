// Live test of the WhatsApp audio path without WhatsApp: acts like wa-bridge, streaming
// test/fixtures/question.wav as 16 kHz 60 ms PCM frames over /api/pcm, and checks that
// GPT-Live answers (delegation + spoken audio) and that hangup from either side works.
// Spends about 40 s of voice on the logged-in plan.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { downsample3, WA_FRAME } from '../pcm-call.mjs'

const PORT = 8792
const TOKEN = 'pcm-live-test'
const root = fileURLToPath(new URL('..', import.meta.url))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const logs = []
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), VOICE_TOKEN: TOKEN, WA_BRIDGE_URL: 'http://127.0.0.1:9' },
  stdio: 'pipe',
})
server.stdout.on('data', d => logs.push(String(d)))
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
await new Promise(resolve => server.stdout.on('data', d => { if (String(d).includes('codex-voice on')) resolve() }))

const wav = readFileSync(fileURLToPath(new URL('./fixtures/question.wav', import.meta.url)))
const data = wav.indexOf('data') + 8
const pcm48 = new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + data + ((wav.length - data) & ~1)))
const pcm16 = downsample3(pcm48)

try {
  const denied = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/pcm?caller=1`)
    ws.on('open', () => resolve(false))
    ws.on('error', () => resolve(true))
  })
  check('rejects socket without token', denied)

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/pcm?caller=5511999999999`, { headers: { authorization: `Bearer ${TOKEN}` } })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  let frames = 0
  let loud = 0
  let badSize = 0
  ws.on('message', (msg, binary) => {
    if (!binary) return
    if (msg.length !== WA_FRAME * 2) badSize++
    frames++
    const s = new Int16Array(msg.buffer, msg.byteOffset, msg.length / 2)
    let sum = 0
    for (const v of s) sum += Math.abs(v)
    if (sum / s.length > 300) loud++
  })
  const closedByServer = new Promise(resolve => ws.on('close', (code, reason) => resolve(`${code} ${reason}`)))

  let i = 0
  const pump = setInterval(() => {
    const frame = i + WA_FRAME <= pcm16.length ? pcm16.slice(i, i + WA_FRAME) : new Int16Array(WA_FRAME)
    i += WA_FRAME
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(frame.buffer), { binary: true })
  }, 60)

  const until = Date.now() + 45_000
  while (Date.now() < until && !logs.join('').match(/assistant: .*ca[mn]berra/i)) await new Promise(r => setTimeout(r, 500))
  const transcript = logs.join('')
  check('caller speech transcribed', /user: .*australia/i.test(transcript))
  check('delegated answer spoken', /assistant: .*ca[mn]berra/i.test(transcript), transcript.match(/assistant: (.*ca[mn]berra[^\n]*)/i)?.[1]?.slice(0, 100))
  check('model audio returned as 960-sample frames', frames > 50 && badSize === 0, `${frames} frames, ${loud} with speech`)
  check('model audio is not silence', loud > 20)

  clearInterval(pump)
  ws.close()
  await new Promise(r => setTimeout(r, 2000))
  check('caller hangup closes GPT-Live call', /encerrada: WhatsApp desligou/.test(logs.join('')))
  void closedByServer
} finally {
  server.kill()
}
const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
