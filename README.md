# codex-voice

Local voice UI for GPT-Live (`gpt-live-1-codex`) that uses a ChatGPT plan instead of an API key.

**Unofficial.** Not affiliated with OpenAI or WhatsApp/Meta.

- The voice side uses the private endpoints and OAuth client of the Codex app. They can change or stop working at any time, and this use is outside what "Sign in with ChatGPT" officially covers.
- The WhatsApp side is an unofficial client (whatsapp-rust). Using it, especially for calls, can get the number banned. Use a spare number, never a business one.
- Voice minutes count against your ChatGPT plan.

## Layout

One repository, two containers (`docker-compose.yml`, project `wa-voice`):

| Path | Container | What |
| --- | --- | --- |
| `server.mjs`, `auth.mjs`, `pcm-call.mjs`, `wa.mjs`, `public/` | `codex-voice` (Node) | UI, ChatGPT login, GPT-Live calls (browser WebRTC or server-side PCM), WhatsApp audio socket |
| `wa-bridge/` | `wa-voice-bridge` (Rust) | WhatsApp linked device: QR, call policy, answers calls, streams PCM to `codex-voice` |
| `wa-bridge/vendor/whatsapp-rust/` | (compiled into the bridge) | Copy of [oxidezap/whatsapp-rust](https://github.com/oxidezap/whatsapp-rust) (MIT) at rev `24652ea` with group-call fixes. It is a plain vendored copy, not a git submodule. |

The two containers talk over the compose network: the bridge opens `ws://codex-voice:8787/api/pcm` per call, and the UI reads bridge status through `codex-voice`.

## Run

```
npm install
npm start          # http://127.0.0.1:8787
```

Open the page, click **Entrar com ChatGPT**, finish the login in the new tab, pick a voice, then click **Ligar**. **Trocar conta** forces the login form (`prompt=login`) even when the browser is already signed in.

## WhatsApp calls (wa-voice stack)

A second WhatsApp linked device answers voice calls (1:1 or group) and puts GPT-Live in the call.

```
cp .env.example .env      # set VOICE_TOKEN (any random string)
docker compose up -d --build
```

Then open http://127.0.0.1:8787:

1. **WhatsApp card**: scan the QR with the bot's phone (Settings › Linked devices › Link a device).
2. Pick who the bot answers in the card: **Todos**, **Todos, exceto bloqueados** or **Só a lista de liberados**, and edit both lists there. The policy persists in the volume (`whatsapp.db.policy.json`). `ALLOWED_CALLERS` only seeds the list on first start. A call outside the policy is ignored, never declined: it keeps ringing on the phone and shows up in the card with **Liberar este número**. `PROTECTED_CALLERS` (`.env`) lists contacts the bot never acts on in any mode; they show as locked in Bloqueados.
3. For a group call, start it from your phone and add the bot. In groups the voice answers only when called by name ("Codex").

The stack is independent from cecchin-backend: its own compose project (`wa-voice`), network, volume (`wa-voice-data`, the session and allow-list) and its own linked device. It does not reuse the Cecchin WhatsApp session: two clients with the same device identity would disconnect each other.

Pieces:

- `wa-bridge/`: Rust, `whatsapp-rust` at the same rev as services/whatsapp-web, with `voip-mlow` + `voip-relay-native`. It accepts allowed calls and streams 16 kHz mono i16 frames (960 samples, 60 ms) to `/api/pcm`.
- `pcm-call.mjs`: server-side WebRTC (werift) with Opus (opusscript). It resamples 16 ⇄ 48 kHz and opens the same GPT-Live call as the browser.
- `wa.mjs`: the `/api/pcm` socket (Bearer `VOICE_TOKEN`), the idle timeout (`WA_IDLE_MINUTES`, default 5), the max duration (`WA_MAX_CALL_MINUTES`, default 60), and the `/api/wa/*` proxy for the UI.

One call at a time; a second call is rejected as busy. The voice minutes come from the ChatGPT plan, so the idle timeout ends silent calls.

## Login

Two token sources, in this order:

1. **Own login** (`.data/auth.json`): created by **Entrar com ChatGPT**. It uses the OAuth authorization-code flow with PKCE, the Codex client ID, and the callback `http://localhost:1455/auth/callback`. It is independent from Codex, so its refreshes never touch Codex's session. **Sair** deletes it.
2. **Codex session** (`~/.codex/auth.json`): the fallback when there is no own login. Refreshes are written back to that file, so Codex keeps working.

The token is refreshed 5 minutes before it expires and again on any 401/403. It never leaves the server process.

Port 1455 is the same one `codex login` uses. Do not run both logins at the same time.

## How it works

1. The browser creates a WebRTC offer (mic + `oai-events` data channel) and sends it to `server.mjs`.
2. The server POSTs `{ sdp, session }` to `chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`. The answer SDP returns to the browser, and audio flows directly between the browser and OpenAI.
3. The server opens the control sideband `wss://api.openai.com/v1/live/{call_id}`.
4. When GPT-Live emits `delegation.created`, the server answers with a Codex Responses request (`chatgpt.com/backend-api/codex/responses`, web search on). It then sends the result back as `delegation.context.append` on the `speakable` channel, and the voice speaks it.
5. Events reach the page over SSE (`/api/calls/:id/events`).

Typed messages go through the same backend. The answer appears on screen and is added to the voice as silent context. The voice route only speaks context during an active turn, so it does not read typed answers aloud.

Voice minutes and backend answers count against the plan's Codex usage.

## Tests

```
npm test           # unit + HTTP tests, no OpenAI calls
npm run test:live  # real call with the logged-in account (~1 min of voice)
node test/pcm-live.mjs   # WhatsApp audio path without WhatsApp (~40 s of voice)
cd wa-bridge && cargo test
```

`test:live` runs headless Edge (or Chrome; set `BROWSER` to choose) with `test/fixtures/question.wav` as the microphone. It checks the login, the call and sideband, transcription, the delegated answer and its spoken version, text context, mute, and hangup.

## Env

| Var | Default |
| --- | --- |
| `PORT` | `8787` |
| `CODEX_HOME` | `~/.codex` |
| `CODEX_VOICE_AUTH` | `.data/auth.json` |
| `DELEGATE_MODEL` | `gpt-5.6-terra` |
| `DELEGATE_EFFORT` | `low` |
| `DELEGATE_WEB_SEARCH` | `1` (set `0` to disable) |
| `CODEX_ORIGINATOR` / `CODEX_VERSION` | `codex_cli_rs` / `0.159.2` |

Voices: `cove`, `arbor`, `breeze`, `ember`, `juniper`, `maple`, `sol`, `spruce`, `vale`.

The server listens on 127.0.0.1 only. Anyone who can reach it spends your plan.

## Patched whatsapp-rust (group calls)

`wa-bridge/vendor/whatsapp-rust` is the pinned rev `24652ea` with fixes found against live WhatsApp group calls. Search for `codex-voice patch` to find each one:

1. **`src/handlers/call.rs`**: `group_update` and group `terminate` come from the call service (`<call_id>@call`), not the creator. They were rejected as "non-creator sender".
2. **`wacore/src/voip/group.rs`**: the relay's `transaction_id` numbers relay allocations (relay tx=1 inside group_update tx=13). It is no longer compared with the roster transaction.
3. **`wacore/src/voip/group.rs`**: the relay can arrive on an older roster transaction after a newer roster-only one. The relay is adopted instead of dropped as stale.
4. **`group.rs` / `group_media.rs`**: `pid 0` is valid; the call creator is pid 0.
5. **`group.rs` + `src/handlers/call.rs`**: roster updates omit unchanged pids. Absent pids are carried over, and media gets the committed snapshot. Without this the relay subscription was re-sent empty and audio stopped after ~8 packets.

The bridge also pre-accepts and early-accepts group invites (`accept_group_invite`); the call service only sends the group relay after that. Phones use MLOW in group calls too, and the library mixes participants itself.

Diagnostics: set `BRIDGE_RUST_LOG=warn,whatsapp_rust::handlers::call=info` (roster pids) and `WA_LOG_STANZAS=1` (call stanzas; binary payloads are shown as byte counts only). The bridge logs `CallHandle::media_stats()` every 10 s during a call.
