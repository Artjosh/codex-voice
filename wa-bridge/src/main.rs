//! WhatsApp voice bridge for codex-voice.
//!
//! A separate WhatsApp linked device (its own QR and session file) that answers
//! voice calls, 1:1 or group, from allowed numbers and pipes the call audio to the
//! codex-voice server over a WebSocket. There, a GPT-Live call is opened on the
//! user's ChatGPT plan. Media on both sides is 16 kHz mono i16 in 60 ms frames
//! (960 samples, little-endian on the wire).
//!
//! It shares no session or process with services/whatsapp-web.

use std::collections::{HashMap, VecDeque};
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use qrcode::{QrCode, render::svg};
use serde::Serialize;
use tokio::sync::{RwLock, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use whatsapp_rust::async_channel;
use whatsapp_rust::prelude::*;
use whatsapp_rust::voip::CallHandle;
use whatsapp_rust::wacore::types::call::{CallAction, IncomingCall};
use whatsapp_rust::wacore::types::events::{Event, EventHandler};

const FRAME: usize = 960; // 60 ms @ 16 kHz
const MAX_QUEUED_FRAMES: usize = 8; // ~480 ms of model audio buffered toward WhatsApp

#[derive(Clone)]
struct Config {
    voice_ws: String,
    token: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            voice_ws: env::var("VOICE_WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:8787/api/pcm".into()),
            token: env::var("VOICE_TOKEN").unwrap_or_default(),
        }
    }
}

/// Keeps digits only (and `*`, which accepts anyone).
fn normalize_number(raw: &str) -> String {
    raw.trim().chars().filter(|c| c.is_ascii_digit() || *c == '*').collect()
}

/// Who the bot answers. PROTECTED_CALLERS always wins over this.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    /// Answer everyone.
    All,
    /// Answer everyone except the `deny` list.
    AllExcept,
    /// Answer only the `allow` list.
    OnlyList,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
struct PolicyData {
    mode: Mode,
    allow: Vec<String>,
    deny: Vec<String>,
}

/// Call policy edited from the UI, persisted as JSON next to the session.
struct Policy {
    path: String,
    data: Mutex<PolicyData>,
}

impl Policy {
    /// Loads the saved policy, or seeds one from ALLOWED_CALLERS and the older
    /// `.allowed` file (one number per line; `*` meant everyone).
    fn load(path: String, legacy_allowed: &str) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<PolicyData>(&text).ok())
            .unwrap_or_else(|| {
                let from_env = env::var("ALLOWED_CALLERS").unwrap_or_default();
                let from_file = std::fs::read_to_string(legacy_allowed).unwrap_or_default();
                let numbers: Vec<String> =
                    from_env.split(',').chain(from_file.lines()).map(normalize_number).filter(|n| !n.is_empty()).collect();
                let everyone = numbers.iter().any(|n| n == "*");
                PolicyData {
                    mode: if everyone { Mode::All } else { Mode::OnlyList },
                    allow: numbers.into_iter().filter(|n| n != "*").collect(),
                    deny: Vec::new(),
                }
            });
        let policy = Self { path, data: Mutex::new(data) };
        let _ = policy.update(|_| {});
        policy
    }

    fn answers(&self, number: &str) -> bool {
        let data = self.data.lock().unwrap();
        match data.mode {
            Mode::All => true,
            Mode::AllExcept => !data.deny.iter().any(|n| n == number),
            Mode::OnlyList => data.allow.iter().any(|n| n == number),
        }
    }

    fn snapshot(&self) -> PolicyData {
        self.data.lock().unwrap().clone()
    }

    fn update(&self, change: impl FnOnce(&mut PolicyData)) -> std::io::Result<PolicyData> {
        let mut guard = self.data.lock().unwrap();
        let data = &mut *guard;
        change(data);
        for list in [&mut data.allow, &mut data.deny] {
            list.retain(|n| !n.is_empty() && n != "*");
            list.sort();
            list.dedup();
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(data).unwrap_or_default())?;
        Ok(data.clone())
    }

    /// Puts `number` on `list` ("allow" or "deny"), or takes it off. A number lives on at
    /// most one list, so adding it to one removes it from the other.
    fn set(&self, list: &str, number: &str, on: bool) -> std::io::Result<PolicyData> {
        let number = number.to_string();
        self.update(|data| {
            data.allow.retain(|n| *n != number);
            data.deny.retain(|n| *n != number);
            if on {
                match list {
                    "deny" => data.deny.push(number),
                    _ => data.allow.push(number),
                }
            }
        })
    }
}

#[derive(Default)]
struct CallStats {
    from_whatsapp: AtomicU64,
    from_whatsapp_loud: AtomicU64,
    foreign_audio: AtomicU64,
    to_whatsapp: AtomicU64,
}

#[derive(Clone, Serialize)]
struct ActiveCall {
    call_id: String,
    caller: String,
    group: Option<String>,
}

#[derive(Default, Serialize)]
struct Status {
    connected: bool,
    qr: Option<String>,
    qr_valid_for: Option<u64>,
    /// Bumped on every new QR so pages can swap the image right away.
    qr_seq: u64,
    last_event: Option<String>,
    last_rejected: Option<String>,
}

struct App {
    config: Config,
    policy: Policy,
    /// PROTECTED_CALLERS: phone numbers or LIDs (digits) the bot must never act on.
    protected: Vec<String>,
    status: RwLock<Status>,
    client: RwLock<Option<Arc<Client>>>,
    calls: Mutex<HashMap<String, (ActiveCall, Arc<CallHandle>)>>,
}

impl App {
    async fn note(&self, text: String) {
        eprintln!("{text}");
        self.status.write().await.last_event = Some(text);
    }
}

// ---------- calls ----------

struct CallObserver {
    app: Arc<App>,
}

impl EventHandler for CallObserver {
    fn handle_event(&self, event: Arc<Event>) {
        let Event::IncomingCall(call) = &*event else { return };
        match &call.action {
            CallAction::Offer { .. } => {
                if call.offline {
                    return; // replayed from the offline queue: the call is already over
                }
                let app = self.app.clone();
                let call = call.clone();
                tokio::spawn(async move { answer(app, *call).await });
            }
            CallAction::Terminate { call_id, reason, .. } => {
                let app = self.app.clone();
                let text = format!("chamada {call_id} encerrada pelo outro lado ({})", reason.as_deref().unwrap_or("sem motivo"));
                tokio::spawn(async move { app.note(text).await });
            }
            _ => {}
        }
    }
}

async fn answer(app: Arc<App>, call: IncomingCall) {
    let CallAction::Offer { call_id, call_creator, caller_pn, group_jid, is_video, .. } = &call.action else { return };
    let caller = caller_pn.as_ref().unwrap_or(call_creator).user.to_string();
    let group = group_jid.as_ref().map(|g| g.to_string());
    let Some(client) = app.client.read().await.clone() else { return };

    // Protected contacts (PROTECTED_CALLERS): never answered, rejected, listed or logged
    // by number. The call keeps ringing on the phone as if this bot did not exist.
    let ids = [Some(&call.from), Some(call_creator), caller_pn.as_ref()];
    if ids.into_iter().flatten().any(|jid| app.protected.contains(&jid.user.to_string())) {
        app.note("chamada de contato protegido: ignorada".into()).await;
        return;
    }

    // Anything else we do not take is ignored, never rejected: a reject from this linked
    // device would decline the call on the phone too.
    let busy = !app.calls.lock().unwrap().is_empty();
    let allowed = app.policy.answers(&caller);
    if !allowed || busy {
        let why = if busy { "já em outra chamada" } else { "fora da política de atendimento (ajuste na tela do codex-voice)" };
        if !allowed {
            app.status.write().await.last_rejected = Some(caller.clone());
        }
        app.note(format!("ignorando chamada {call_id} de {caller}: {why}")).await;
        return;
    }
    app.note(format!(
        "atendendo chamada {call_id} de {caller}{}{}",
        group.as_deref().map(|g| format!(" no grupo {g}")).unwrap_or_default(),
        if *is_video { " (vídeo, respondendo só com áudio)" } else { "" }
    ))
    .await;

    // Group invitations: pre-accept right away so the call service sends the group relay
    // (media block); accept().start() waits for that relay.
    let is_group_invite = call.group.is_some();
    eprintln!("oferta {call_id}: grupo={} bloco_de_mídia={}", is_group_invite, call.media().is_some());
    if is_group_invite && let Err(e) = client.voip().preaccept_group_invite(&call).await {
        app.note(format!("falha no pré-aceite do grupo {call_id}: {e}")).await;
        return;
    }

    // Voice server first: no point answering if the model side is down.
    let mut url = format!("{}?caller={caller}", app.config.voice_ws);
    if let Some(g) = &group {
        url.push_str(&format!("&group={}", g.split('@').next().unwrap_or_default()));
    }
    let mut request = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => return app.note(format!("VOICE_WS_URL inválida: {e}")).await,
    };
    if !app.config.token.is_empty()
        && let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", app.config.token))
    {
        request.headers_mut().insert("authorization", value);
    }
    let ws = match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            app.note(format!("servidor de voz indisponível ({e}); chamada não atendida")).await;
            return;
        }
    };
    let (mut ws_tx, mut ws_rx) = ws.split();

    let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(3);
    let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(16);
    // The call service only sends the group relay after this early call-scoped accept
    // (without it no group_update arrives at all); accept().start() then completes the join.
    if is_group_invite && let Err(e) = client.voip().accept_group_invite(&call).await {
        app.note(format!("falha ao aceitar convite do grupo {call_id}: {e}")).await;
        let _ = ws_tx.send(Message::Close(None)).await;
        return;
    }
    // Both 1:1 and group calls run MLOW PCM inside the library: phones send MLOW in groups
    // too (live check), and the library mixes group participants itself.
    let accepted = client.voip().accept(&call).audio(mic_rx, spk_tx).start().await;
    let handle = match accepted {
        Ok(h) => Arc::new(h),
        Err(e) => {
            app.note(format!("falha ao atender chamada {call_id}: {e}")).await;
            let _ = ws_tx.send(Message::Close(None)).await;
            return;
        }
    };
    let info = ActiveCall { call_id: call_id.clone(), caller: caller.clone(), group: group.clone() };
    app.calls.lock().unwrap().insert(call_id.clone(), (info, handle.clone()));
    app.note(format!("chamada {call_id} conectada ao GPT-Live")).await;

    // Model audio -> jitter queue, drained by the 60 ms pacer into the call's "microphone".
    let queue = Arc::new(Mutex::new(VecDeque::<Vec<i16>>::new()));
    let stats = Arc::new(CallStats::default());
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(64);

    let reader = {
        let queue = queue.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut pending: Vec<i16> = Vec::new();
            while let Some(Ok(message)) = ws_rx.next().await {
                match message {
                    Message::Binary(bytes) => {
                        pending.extend(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
                        let mut q = queue.lock().unwrap();
                        while pending.len() >= FRAME {
                            q.push_back(pending.drain(..FRAME).collect());
                        }
                        while q.len() > MAX_QUEUED_FRAMES {
                            q.pop_front();
                        }
                    }
                    Message::Text(text) => eprintln!("voz: {text}"),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            // Voice side ended (idle timeout, error, hangup in the UI): end the WhatsApp call too.
            handle.terminate().await;
        })
    };

    let pacer = {
        let queue = queue.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let next = queue.lock().unwrap().pop_front();
                if next.is_some() {
                    stats.to_whatsapp.fetch_add(1, Ordering::Relaxed);
                }
                let frame = next.unwrap_or_else(|| vec![0; FRAME]);
                if mic_tx.is_closed() {
                    break;
                }
                let _ = mic_tx.try_send(frame);
            }
        })
    };

    // Per-call audio counters, logged when the call ends: frames from WhatsApp (and how many
    // carried speech) and frames of model voice sent back into the call.
    // Library media counters every 10 s: where inbound packets stop (decrypt, decode, sink).
    let media_stats = {
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(10));
            tick.tick().await;
            loop {
                tick.tick().await;
                eprintln!("estatísticas de mídia: {:?}", handle.media_stats());
            }
        })
    };
    let events = {
        let handle = handle.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            let events = handle.events();
            while let Ok(event) = events.recv().await {
                let text = format!("{event:?}");
                if text.starts_with("ForeignAudio") {
                    stats.foreign_audio.fetch_add(1, Ordering::Relaxed);
                } else {
                    eprintln!("evento de mídia: {}", text.chars().take(200).collect::<String>());
                }
            }
        })
    };
    let speaker = {
        let out_tx = out_tx.clone();
        let stats = stats.clone();
        tokio::spawn(async move {
            while let Ok(frame) = spk_rx.recv().await {
                stats.from_whatsapp.fetch_add(1, Ordering::Relaxed);
                if frame.iter().map(|s| (*s as i32).abs()).sum::<i32>() / frame.len().max(1) as i32 > 300 {
                    stats.from_whatsapp_loud.fetch_add(1, Ordering::Relaxed);
                }
                let bytes: Vec<u8> = frame.iter().flat_map(|s| s.to_le_bytes()).collect();
                if out_tx.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
        })
    };

    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let close = matches!(message, Message::Close(_));
            if ws_tx.send(message).await.is_err() || close {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });

    handle.wait_ended().await;
    events.abort();
    media_stats.abort();
    eprintln!("estatísticas de mídia (fim): {:?}", handle.media_stats());
    app.note(format!(
        "áudio da chamada {call_id}: do WhatsApp {} quadros ({} com voz), opus estrangeiro {}, voz do modelo enviada {} quadros",
        stats.from_whatsapp.load(Ordering::Relaxed),
        stats.from_whatsapp_loud.load(Ordering::Relaxed),
        stats.foreign_audio.load(Ordering::Relaxed),
        stats.to_whatsapp.load(Ordering::Relaxed)
    ))
    .await;
    app.calls.lock().unwrap().remove(call_id.as_str());
    let _ = out_tx.send(Message::Close(None)).await;
    pacer.abort();
    speaker.abort();
    let _ = tokio::time::timeout(Duration::from_secs(3), writer).await;
    reader.abort();
    app.note(format!("chamada {call_id} finalizada")).await;
}

// ---------- WhatsApp session ----------

async fn run_session(app: Arc<App>, storage: String) {
    loop {
        let store = match SqliteStore::new(&storage).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("não foi possível abrir {storage}: {e}");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let (qr_app, conn_app, out_app) = (app.clone(), app.clone(), app.clone());
        let bot = Bot::builder()
            .with_backend(store)
            .on_qr_code(move |code, timeout| {
                let app = qr_app.clone();
                async move {
                    let mut status = app.status.write().await;
                    status.qr = Some(code);
                    status.qr_seq += 1;
                    status.qr_valid_for = Some(timeout.as_secs());
                    status.connected = false;
                    eprintln!("QR novo: abra /qr.svg e escaneie com o WhatsApp do bot.");
                }
            })
            .on_connected(move |_client| {
                let app = conn_app.clone();
                async move {
                    let mut status = app.status.write().await;
                    status.connected = true;
                    status.qr = None;
                    status.qr_valid_for = None;
                    eprintln!("WhatsApp conectado; aguardando chamadas.");
                }
            })
            .on_logged_out(move |_info| {
                let app = out_app.clone();
                async move {
                    app.status.write().await.connected = false;
                    eprintln!("sessão desconectada pelo celular; um QR novo vai aparecer.");
                }
            })
            .build()
            .await;
        let bot = match bot {
            Ok(b) => b,
            Err(e) => {
                eprintln!("falha ao iniciar cliente WhatsApp: {e}");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let client = bot.client();
        let _subscription = client.subscribe_handler(Arc::new(CallObserver { app: app.clone() }));
        *app.client.write().await = Some(client);
        let reason = bot.run_with_reason().await;
        *app.client.write().await = None;
        app.status.write().await.connected = false;
        let text = format!("{reason:?}");
        // Another client with this same device identity is online. Fighting it would
        // knock it offline too, so stop here until the bridge is restarted.
        if text.contains("Conflict") || text.contains("StreamErrorCode(440)") {
            app.note(format!("conflito: outro cliente está usando esta mesma sessão ({text}); ponte parada até reiniciar")).await;
            return;
        }
        app.note(format!("cliente WhatsApp encerrou ({text}); reconectando")).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

// ---------- HTTP ----------

async fn status(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let status = app.status.read().await;
    let calls: Vec<ActiveCall> = app.calls.lock().unwrap().values().map(|(info, _)| info.clone()).collect();
    let me = app.client.read().await.as_ref().and_then(|c| c.pn()).map(|jid| jid.user.to_string());
    Json(serde_json::json!({
        "connected": status.connected,
        "me": me,
        "qr_available": status.qr.is_some(),
        "qr_valid_for": status.qr_valid_for,
        "qr_id": status.qr_seq,
        "last_event": status.last_event,
        "last_rejected": status.last_rejected,
        "policy": app.policy.snapshot(),
        "protected": app.protected,
        "active_calls": calls,
    }))
}

async fn qr_svg(State(app): State<Arc<App>>) -> Response {
    let Some(code) = app.status.read().await.qr.clone() else {
        return (StatusCode::NOT_FOUND, "sem QR: já conectado ou aguardando").into_response();
    };
    match QrCode::new(code.as_bytes()) {
        Ok(qr) => (
            [("content-type", "image/svg+xml"), ("cache-control", "no-store")],
            qr.render::<svg::Color>().min_dimensions(320, 320).build(),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ListRequest {
    /// "allow" or "deny".
    #[serde(default = "allow_list")]
    list: String,
    number: String,
    #[serde(default = "yes")]
    on: bool,
}

fn allow_list() -> String {
    "allow".into()
}

fn yes() -> bool {
    true
}

async fn set_list(State(app): State<Arc<App>>, Json(request): Json<ListRequest>) -> Response {
    let number = normalize_number(&request.number).replace('*', "");
    if number.is_empty() || !matches!(request.list.as_str(), "allow" | "deny") {
        return (StatusCode::BAD_REQUEST, "número ou lista inválidos").into_response();
    }
    if app.protected.contains(&number) {
        return (StatusCode::FORBIDDEN, "contato protegido pelo .env: não pode ser alterado aqui").into_response();
    }
    match app.policy.set(&request.list, &number, request.on) {
        Ok(policy) => {
            let mut status = app.status.write().await;
            if request.list == "allow" && request.on && status.last_rejected.as_deref() == Some(number.as_str()) {
                status.last_rejected = None;
            }
            Json(serde_json::json!({ "policy": policy })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ModeRequest {
    mode: Mode,
}

async fn set_mode(State(app): State<Arc<App>>, Json(request): Json<ModeRequest>) -> Response {
    match app.policy.update(|data| data.mode = request.mode) {
        Ok(policy) => {
            app.status.write().await.last_rejected = None;
            Json(serde_json::json!({ "policy": policy })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn hangup(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let handles: Vec<Arc<CallHandle>> = app.calls.lock().unwrap().values().map(|(_, h)| h.clone()).collect();
    for handle in &handles {
        handle.terminate().await;
    }
    Json(serde_json::json!({ "ended": handles.len() }))
}

#[tokio::main]
async fn main() {
    // Library logs (whatsapp-rust uses the `log` facade). RUST_LOG picks modules and levels.
    let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"));
    // Stanza dumps use targets with a '/', which RUST_LOG cannot express. Binary payloads
    // (keys, tokens, media) are printed as byte counts only.
    if env::var("WA_LOG_STANZAS").is_ok_and(|v| v == "1") {
        logger.filter(Some("Client/Send"), log::LevelFilter::Debug);
        logger.filter(Some("Client/Recv"), log::LevelFilter::Debug);
    }
    logger.init();
    let config = Config::from_env();
    let storage = env::var("WHATSAPP_STORE").unwrap_or_else(|_| "/data/whatsapp.db".into());
    let policy = Policy::load(format!("{storage}.policy.json"), &format!("{storage}.allowed"));
    eprintln!("política de atendimento: {:?}", policy.snapshot());
    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3340);
    let protected: Vec<String> = env::var("PROTECTED_CALLERS")
        .unwrap_or_default()
        .split(',')
        .map(|n| n.trim().chars().filter(char::is_ascii_digit).collect::<String>())
        .filter(|n| !n.is_empty())
        .collect();
    eprintln!("{} contato(s) protegido(s) carregado(s) de PROTECTED_CALLERS.", protected.len());
    let app = Arc::new(App {
        config,
        policy,
        protected,
        status: RwLock::new(Status::default()),
        client: RwLock::new(None),
        calls: Mutex::new(HashMap::new()),
    });
    tokio::spawn(run_session(app.clone(), storage));

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/status", get(status))
        .route("/qr.svg", get(qr_svg))
        .route("/hangup", post(hangup))
        .route("/allowed", post(set_list))
        .route("/policy/mode", post(set_mode))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    eprintln!("wa-voice-bridge na porta {port}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_digits_and_wildcard() {
        assert_eq!(normalize_number(" +55 (54) 99999-0000 "), "5554999990000");
        assert_eq!(normalize_number("*"), "*");
        assert_eq!(normalize_number("abc"), "");
    }

    fn temp_path(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("wa-{name}-{}", std::process::id())).to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn modes_decide_who_is_answered() {
        let path = temp_path("modes");
        let policy = Policy::load(path.clone(), "/nonexistent");
        assert!(!policy.answers("111"), "only_list with an empty list answers nobody");
        policy.set("allow", "111", true).unwrap();
        policy.set("deny", "222", true).unwrap();
        assert!(policy.answers("111") && !policy.answers("333"));
        policy.update(|d| d.mode = Mode::AllExcept).unwrap();
        assert!(policy.answers("111") && policy.answers("333") && !policy.answers("222"));
        policy.update(|d| d.mode = Mode::All).unwrap();
        assert!(policy.answers("222"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn lists_are_exclusive_and_persist() {
        let path = temp_path("lists");
        let policy = Policy::load(path.clone(), "/nonexistent");
        policy.set("allow", "111", true).unwrap();
        policy.set("deny", "111", true).unwrap();
        let data = Policy::load(path.clone(), "/nonexistent").snapshot();
        assert_eq!(data.deny, vec!["111".to_string()]);
        assert!(data.allow.is_empty(), "adding to deny removes from allow");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seeds_from_legacy_allowed_file() {
        let legacy = temp_path("legacy");
        std::fs::write(&legacy, "5511999990000\n").unwrap();
        let path = temp_path("seed");
        let data = Policy::load(path.clone(), &legacy).snapshot();
        assert_eq!(data.mode, Mode::OnlyList);
        assert_eq!(data.allow, vec!["5511999990000".to_string()]);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&legacy);
    }
}
