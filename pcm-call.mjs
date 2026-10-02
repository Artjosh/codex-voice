// GPT-Live call driven by raw PCM instead of a browser: a server-side WebRTC peer
// (werift) with Opus encode/decode (opusscript). Used by the WhatsApp bridge, whose
// call media is 16 kHz mono i16 in 60 ms frames (960 samples).
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS } from 'werift'
import OpusScript from 'opusscript'
import { randomInt } from 'node:crypto'
import { createCall, hangupCall, subscribeCall } from './server.mjs'

export const WA_RATE = 16_000
export const WA_FRAME = 960 // 60 ms @ 16 kHz
const RTC_RATE = 48_000
const RTC_FRAME = 960 // 20 ms @ 48 kHz

/** 16 kHz to 48 kHz, linear interpolation. */
export function upsample3(input) {
  const out = new Int16Array(input.length * 3)
  for (let i = 0; i < input.length; i++) {
    const a = input[i]
    const b = i + 1 < input.length ? input[i + 1] : a
    out[i * 3] = a
    out[i * 3 + 1] = Math.round(a + (b - a) / 3)
    out[i * 3 + 2] = Math.round(a + (2 * (b - a)) / 3)
  }
  return out
}

/** 48 kHz to 16 kHz, averaging each group of 3 samples (cheap low-pass). */
export function downsample3(input) {
  const out = new Int16Array(Math.floor(input.length / 3))
  for (let i = 0; i < out.length; i++) out[i] = Math.round((input[i * 3] + input[i * 3 + 1] + input[i * 3 + 2]) / 3)
  return out
}

/**
 * Opens a GPT-Live call fed by PCM.
 * - push(frame): 16 kHz mono Int16Array, any length (buffered into 20 ms Opus packets).
 * - onAudio(frame): called with 960-sample 16 kHz frames of the model's voice.
 * - onEvent(event): GPT-Live and local events (transcripts, delegations, closed).
 */
export async function openPcmCall({ voice, instructions, onAudio, onEvent = () => {} }) {
  const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS()] } })
  const track = new MediaStreamTrack({ kind: 'audio' })
  const transceiver = pc.addTransceiver(track, { direction: 'sendrecv' })
  pc.createDataChannel('oai-events')

  const encoder = new OpusScript(RTC_RATE, 1, OpusScript.Application.VOIP)
  const decoder = new OpusScript(RTC_RATE, 1, OpusScript.Application.VOIP)
  let closed = false
  let unsubscribe = () => {}

  // Model voice: Opus RTP -> 48 kHz PCM -> 16 kHz -> 960-sample frames.
  let outBuffer = new Int16Array(0)
  transceiver.onTrack.subscribe(remote => {
    remote.onReceiveRtp.subscribe(rtp => {
      if (closed || !rtp.payload?.length) return
      let pcm
      try {
        const decoded = decoder.decode(rtp.payload)
        pcm = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2)
      } catch {
        return
      }
      const down = downsample3(pcm)
      const merged = new Int16Array(outBuffer.length + down.length)
      merged.set(outBuffer)
      merged.set(down, outBuffer.length)
      let offset = 0
      while (merged.length - offset >= WA_FRAME) {
        onAudio(merged.slice(offset, offset + WA_FRAME))
        offset += WA_FRAME
      }
      outBuffer = merged.slice(offset)
    })
  })

  // Caller audio: 16 kHz PCM -> 48 kHz -> 20 ms Opus packets, paced by a 20 ms clock.
  const queue = []
  let pending = new Int16Array(0)
  const ssrc = randomInt(1, 2 ** 31)
  let sequence = randomInt(0, 65535)
  let timestamp = randomInt(0, 2 ** 31)
  const silence = new Int16Array(RTC_FRAME)
  const sendPacket = pcm => {
    const payload = encoder.encode(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), RTC_FRAME)
    const header = new RtpHeader({ payloadType: 111, sequenceNumber: sequence, timestamp, ssrc, marker: false })
    sequence = (sequence + 1) & 0xffff
    timestamp = (timestamp + RTC_FRAME) >>> 0
    track.writeRtp(new RtpPacket(header, Buffer.from(payload)))
  }
  let nextTick = performance.now()
  let timer
  const tick = () => {
    if (closed) return
    // Keep at most ~200 ms queued so the model hears callers with low latency.
    while (queue.length > 10) queue.shift()
    sendPacket(queue.shift() ?? silence)
    nextTick += 20
    timer = setTimeout(tick, Math.max(0, nextTick - performance.now()))
  }

  const push = frame => {
    if (closed) return
    const up = upsample3(frame)
    const merged = new Int16Array(pending.length + up.length)
    merged.set(pending)
    merged.set(up, pending.length)
    let offset = 0
    while (merged.length - offset >= RTC_FRAME) {
      queue.push(merged.slice(offset, offset + RTC_FRAME))
      offset += RTC_FRAME
    }
    pending = merged.slice(offset)
  }

  await pc.setLocalDescription(await pc.createOffer())
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve()
    pc.iceGatheringStateChange.subscribe(state => { if (state === 'complete') resolve() })
    setTimeout(resolve, 3000)
  })

  let callId
  try {
    const answer = await createCall({ sdp: pc.localDescription.sdp, voice, instructions })
    callId = answer.callId
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
  } catch (error) {
    await pc.close()
    throw error
  }
  unsubscribe = subscribeCall(callId, event => {
    onEvent(event)
    if (event.type === 'local.closed') close()
  })
  timer = setTimeout(tick, 20)

  async function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    unsubscribe()
    hangupCall(callId)
    await pc.close().catch(() => {})
    encoder.delete?.()
    decoder.delete?.()
    onEvent({ type: 'local.pcm.closed' })
  }

  return { callId, push, close }
}
