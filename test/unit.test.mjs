import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSpeakable, parseCallId, chunkContext } from '../server.mjs'
import { decodeJwt } from '../auth.mjs'

test('toSpeakable strips markdown citations, links and URLs', () => {
  const input = 'A capital é **Camberra**. Tem 485 mil habitantes. ([abs.gov.au](https://www.abs.gov.au/x?utm_source=openai))'
  assert.equal(toSpeakable(input), 'A capital é Camberra. Tem 485 mil habitantes.')
  assert.equal(toSpeakable('Veja [o site](https://a.b/c) agora'), 'Veja o site agora')
  assert.equal(toSpeakable('Fonte: https://x.y/z .'), 'Fonte:.')
})

test('parseCallId reads rtc id from Location or falls back to session header', () => {
  assert.equal(parseCallId('/v1/realtime/calls/rtc_abc-123?x=1', null), 'rtc_abc-123')
  assert.equal(parseCallId('https://api.openai.com/v1/realtime/calls/rtc_Z9', null), 'rtc_Z9')
  assert.equal(parseCallId(null, 'rtc_from_header'), 'rtc_from_header')
  assert.equal(parseCallId('/v1/other/path', null), undefined)
})

test('decodeJwt decodes payload and tolerates garbage', () => {
  const payload = { email: 'a@b.c', exp: 123 }
  const token = `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`
  assert.deepEqual(decodeJwt(token), payload)
  assert.deepEqual(decodeJwt('not-a-jwt'), {})
})

test('chunkContext splits at 500 UTF-8 bytes without breaking characters', () => {
  assert.deepEqual(chunkContext('oi'), ['oi'])
  assert.deepEqual(chunkContext(''), [''])
  const text = 'ção'.repeat(300) // 5 bytes each
  const chunks = chunkContext(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every(c => Buffer.byteLength(c) <= 500))
  assert.equal(chunks.length, 3)
})
