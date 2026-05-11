// Octopus Hub — central message broker (like Telegram API server)
//
// Architecture:
//   OpenClaw Agents (plugin)  ──WS──┐
//                                    ├──→  Hub (hub.chrm.fr)  ←── Desktop Clients
//   OpenClaw Pax            ──WS──┘
//
// The hub:
// - Accepts WS connections from agent plugins (outbound, like bots)
// - Accepts WS connections from desktop clients (outbound, like users)
// - Routes messages between clients and the right agent instance
// - Knows which agents are on which connection

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "octopus-hub", version)]
struct Args {
    /// Port d'écoute
    #[arg(long, default_value_t = 3700)]
    port: u16,

    /// Token d'auth requis pour les connexions
    #[arg(long)]
    token: Option<String>,

    /// Répertoire de persistence du hub
    #[arg(long)]
    data_dir: Option<String>,
}

// ── Message types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agents: Option<Vec<AgentInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    since: Option<u64>,
    #[serde(default, rename = "ackSeq", skip_serializing_if = "Option::is_none")]
    ack_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sessions: Option<Vec<ReplaySession>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, rename = "statusCode", skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    headers: Option<serde_json::Value>,
    #[serde(default, rename = "bodyBase64", skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ReplaySession {
    agent: String,
    session: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedEvent {
    seq: u64,
    timestamp_ms: u128,
    agent: String,
    session: String,
    message: WsMessage,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AgentInfo {
    id: String,
    label: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    models: Vec<ModelInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ModelInfo {
    id: String,
    label: String,
    #[serde(
        default,
        rename = "contextWindow",
        skip_serializing_if = "Option::is_none"
    )]
    context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    available: Option<bool>,
}

// ── Connection types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum PeerKind {
    /// Plugin OpenClaw (héberge des agents)
    Agent,
    /// Client desktop
    Client,
}

struct Peer {
    id: String,
    kind: PeerKind,
    /// Pour un agent: les agents qu'il héberge (id → label)
    hosted_agents: HashMap<String, AgentInfo>,
    /// Canal pour envoyer des messages vers ce peer
    tx: mpsc::UnboundedSender<Message>,
}

// ── Shared state ─────────────────────────────────────────────────────────────

struct AppState {
    peers: Mutex<HashMap<String, Peer>>,
    /// Index: agent_id → peer_id (pour routage rapide)
    agent_routes: Mutex<HashMap<String, String>>,
    /// Index: message_id → client peer_id (pour éviter de broadcaster une réponse à tous les clients)
    pending_requests: Mutex<HashMap<String, String>>,
    pending_canvas: Mutex<HashMap<String, oneshot::Sender<WsMessage>>>,
    events: Mutex<Vec<PersistedEvent>>,
    next_seq: Mutex<u64>,
    event_log_path: PathBuf,
    token: Option<String>,
}

// ── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,octopus_hub=debug")
        .init();

    let args = Args::parse();
    tracing::info!("octopus-hub starting on :{}", args.port);

    let data_dir = args
        .data_dir
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    fs::create_dir_all(&data_dir)?;
    let event_log_path = data_dir.join("events.jsonl");
    let events = load_events(&event_log_path)?;
    let next_seq = events.last().map(|event| event.seq + 1).unwrap_or(1);
    tracing::info!(
        "loaded {} persisted events from {}",
        events.len(),
        event_log_path.display()
    );

    let state = Arc::new(AppState {
        peers: Mutex::new(HashMap::new()),
        agent_routes: Mutex::new(HashMap::new()),
        pending_requests: Mutex::new(HashMap::new()),
        pending_canvas: Mutex::new(HashMap::new()),
        events: Mutex::new(events),
        next_seq: Mutex::new(next_seq),
        event_log_path,
        token: args.token,
    });

    // Accepteur WS principal
    let listen_addr = format!("0.0.0.0:{}", args.port);
    let listener = TcpListener::bind(&listen_addr).await?;
    tracing::info!("listening on {listen_addr}");

    while let Ok((stream, addr)) = listener.accept().await {
        let state = state.clone();
        tokio::spawn(handle_connection(stream, addr, state));
    }

    Ok(())
}

// ── Connection handler ────────────────────────────────────────────────────────

async fn handle_connection(stream: TcpStream, addr: std::net::SocketAddr, state: Arc<AppState>) {
    if is_plain_http(&stream).await {
        handle_http_connection(stream, addr, state).await;
        return;
    }

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::error!("ws accept error from {addr}: {e}");
            return;
        }
    };

    let (mut ws_writer, mut ws_reader) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let peer_id = format!("p{:x}", fast_rand());

    // ── Phase 1: Attendre auth ────────────────────────────────────────
    let auth_message = loop {
        match ws_reader.next().await {
            Some(Ok(Message::Text(text))) => {
                let msg: WsMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(_) => {
                        let _ = ws_writer
                            .send(Message::Text(
                                serde_json::json!({"type": "error", "code": "invalid_json", "message": "Invalid JSON"}).to_string(),
                            ))
                            .await;
                        continue;
                    }
                };

                if msg.msg_type == "auth" {
                    break msg;
                }

                let _ = ws_writer
                    .send(Message::Text(
                        serde_json::json!({"type": "error", "code": "auth_required", "message": "Authenticate first"}).to_string(),
                    ))
                    .await;
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                tracing::debug!("{addr} auth read error: {e}");
                return;
            }
            None => return,
        }
    };

    // ── Phase 2: Valider auth ─────────────────────────────────────────
    // Vérifier le token
    let provided_token = auth_message.token.as_deref().unwrap_or("");
    // Dev mode: skip token validation for now
    // In production, uncomment the validation block below
    /*
    if let Some(expected) = &state.token {
        if !expected.is_empty() && provided_token != expected {
            tracing::warn!("{addr} invalid token");
            let _ = ws_writer
                .send(Message::Text(
                    serde_json::json!({"type": "error", "code": "invalid_token", "message": "Invalid token"}).to_string(),
                ))
                .await;
            return;
        }
    }
    */
    tracing::info!("{addr} authenticated (dev mode, no token check)");

    // Déterminer le type de peer
    let kind = match auth_message.role.as_deref() {
        Some("agent") => PeerKind::Agent,
        _ => PeerKind::Client,
    };

    // Enregistrer
    {
        let mut peers = state.peers.lock().await;
        let peer = Peer {
            id: peer_id.clone(),
            kind: kind.clone(),
            hosted_agents: HashMap::new(),
            tx: tx.clone(),
        };
        peers.insert(peer_id.clone(), peer);
    }

    // Si c'est un agent, enregistrer ses agents dans l'index
    let mut hosted_agent_ids: Vec<String> = Vec::new();
    if kind == PeerKind::Agent {
        if let Some(agents) = &auth_message.agents {
            let mut agent_routes = state.agent_routes.lock().await;
            let mut peers = state.peers.lock().await;

            for agent in agents {
                agent_routes.insert(agent.id.clone(), peer_id.clone());
                hosted_agent_ids.push(agent.id.clone());
                tracing::info!("agent registered: {} ({})", agent.id, agent.label);
            }

            if let Some(peer) = peers.get_mut(&peer_id) {
                for agent in agents {
                    peer.hosted_agents.insert(agent.id.clone(), agent.clone());
                }
            }
        }
    }

    // Répondre auth_ok
    let kind_str = if kind == PeerKind::Agent {
        "agent"
    } else {
        "client"
    };
    let ack = serde_json::json!({
        "type": "auth_ok",
        "peer_id": peer_id,
        "kind": kind_str,
    });
    let _ = ws_writer.send(Message::Text(ack.to_string())).await;
    tracing::info!("{addr} authenticated as {kind:?} (peer={peer_id})");

    // ── Phase 3: Boucle de messages ───────────────────────────────────

    let peer_id_r = peer_id.clone();
    let state_r = state.clone();

    // Tâche: écriture vers ce peer (messages entrants)
    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_writer.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Tâche: lecture depuis ce peer (messages sortants)
    let read_task = tokio::spawn(async move {
        while let Some(msg) = ws_reader.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let parsed: WsMessage = match serde_json::from_str(&text) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    route_message(parsed, &peer_id_r, &state_r).await;
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) => {}
                Ok(Message::Pong(_)) => {}
                Ok(Message::Binary(_)) => {}
                Ok(Message::Frame(_)) => {}
                Err(e) => {
                    tracing::debug!("peer {peer_id_r} read error: {e}");
                    break;
                }
            }
        }
    });

    // Attendre que l'une des tâches se termine
    tokio::select! {
        _ = write_task => {},
        _ = read_task => {},
    }

    // ── Nettoyage ─────────────────────────────────────────────────────
    cleanup_peer(&peer_id, &hosted_agent_ids, &state).await;
    tracing::info!("peer {peer_id} disconnected ({addr})");
}

// ── Routing ───────────────────────────────────────────────────────────────────

async fn route_message(msg: WsMessage, sender_id: &str, state: &Arc<AppState>) {
    match msg.msg_type.as_str() {
        // Un client envoie un message vers un agent
        "send_message" => {
            let agent_id = msg.agent.as_deref().unwrap_or("main");
            if let Err(err) = persist_event(msg.clone(), state).await {
                tracing::warn!("failed to persist send_message: {err}");
            }
            if let Some(message_id) = &msg.id {
                let mut pending = state.pending_requests.lock().await;
                pending.insert(message_id.clone(), sender_id.to_string());
            }

            let agent_routes = state.agent_routes.lock().await;

            if let Some(peer_id) = agent_routes.get(agent_id) {
                let peers = state.peers.lock().await;
                if let Some(peer) = peers.get(peer_id) {
                    let _ = peer
                        .tx
                        .send(Message::Text(serde_json::to_string(&msg).unwrap()));
                }
            } else {
                // Agent inconnu, renvoyer une erreur à l'émetteur
                let peers = state.peers.lock().await;
                if let Some(sender) = peers.get(sender_id) {
                    let err = serde_json::json!({
                        "type": "error",
                        "code": "agent_unavailable",
                        "message": format!("Agent '{agent_id}' is not connected"),
                    });
                    let _ = sender.tx.send(Message::Text(err.to_string()));
                }
            }
        }

        // Un client ferme un thread. C'est une tombstone persistée: les replays futurs
        // peuvent supprimer le thread et la compaction retire son historique.
        "close_thread" => {
            if let Err(err) = persist_event(msg.clone(), state).await {
                tracing::warn!("failed to persist close_thread: {err}");
            }

            if let (Some(agent), Some(session)) = (&msg.agent, &msg.session) {
                tracing::info!("thread closed: {agent}/{session}");
            }

            if let Err(err) = compact_events(state).await {
                tracing::warn!("failed to compact after close_thread: {err}");
            }

            let peers = state.peers.lock().await;
            for (peer_id, peer) in peers.iter() {
                if peer_id == sender_id || peer.kind == PeerKind::Agent {
                    continue;
                }
                let _ = peer
                    .tx
                    .send(Message::Text(serde_json::to_string(&msg).unwrap()));
            }
        }

        // Une réponse d'agent → client qui a émis la requête si l'id est connu,
        // fallback broadcast pour les messages globaux sans id.
        "canvas_http_response" => {
            if let Some(request_id) = &msg.id {
                let tx = state.pending_canvas.lock().await.remove(request_id);
                if let Some(tx) = tx {
                    let _ = tx.send(msg);
                }
            }
        }

        "canvas_open" => {
            let peers = state.peers.lock().await;
            for (peer_id, peer) in peers.iter() {
                if peer_id == sender_id || peer.kind == PeerKind::Agent {
                    continue;
                }
                let _ = peer
                    .tx
                    .send(Message::Text(serde_json::to_string(&msg).unwrap()));
            }
        }

        "chunk" | "done" | "tool_progress" | "agent_status" | "error" | "pong" => {
            if matches!(
                msg.msg_type.as_str(),
                "chunk" | "done" | "tool_progress" | "agent_status" | "error"
            ) {
                if let Err(err) = persist_event(msg.clone(), state).await {
                    tracing::warn!("failed to persist {}: {err}", msg.msg_type);
                }
            }

            let target_peer_id = if let Some(message_id) = &msg.id {
                let pending = state.pending_requests.lock().await;
                pending.get(message_id).cloned()
            } else {
                None
            };

            let peers = state.peers.lock().await;
            if let Some(peer_id) = target_peer_id {
                if let Some(peer) = peers.get(&peer_id) {
                    let _ = peer
                        .tx
                        .send(Message::Text(serde_json::to_string(&msg).unwrap()));
                }
                drop(peers);
                if matches!(msg.msg_type.as_str(), "done" | "error") {
                    if let Some(message_id) = &msg.id {
                        let mut pending = state.pending_requests.lock().await;
                        pending.remove(message_id);
                    }
                }
                return;
            }

            for (peer_id, peer) in peers.iter() {
                // Ne pas renvoyer à l'émetteur (agent)
                if peer_id == sender_id {
                    continue;
                }
                let _ = peer
                    .tx
                    .send(Message::Text(serde_json::to_string(&msg).unwrap()));
            }
        }

        // Un client demande la liste des agents
        "list_agents" => {
            let agent_routes = state.agent_routes.lock().await;
            let peers = state.peers.lock().await;

            let mut agent_list: Vec<AgentInfo> = Vec::new();
            for (agent_id, peer_id) in agent_routes.iter() {
                if let Some(peer) = peers.get(peer_id) {
                    if let Some(info) = peer.hosted_agents.get(agent_id) {
                        agent_list.push(info.clone());
                    }
                }
            }

            // Drop locks before sending response to avoid deadlock
            drop(agent_routes);
            drop(peers);

            let peers = state.peers.lock().await;
            if let Some(sender) = peers.get(sender_id) {
                let resp = serde_json::json!({
                    "type": "agent_list",
                    "agents": agent_list,
                });
                let _ = sender.tx.send(Message::Text(resp.to_string()));
            }
        }

        // Un client reconnecté demande les événements persistés.
        // V1: replay de tous les événements depuis `since` (0 par défaut), avec filtre sessions optionnel.
        "replay" => {
            let since = msg.since.unwrap_or(0);
            let session_filter = msg.sessions.as_ref().map(|sessions| {
                sessions
                    .iter()
                    .map(|s| (s.agent.clone(), s.session.clone()))
                    .collect::<std::collections::HashSet<_>>()
            });

            let events = state.events.lock().await;
            let replay: Vec<WsMessage> = events
                .iter()
                .filter(|event| event.seq > since)
                .filter(|event| {
                    session_filter
                        .as_ref()
                        .map(|filter| {
                            filter.contains(&(event.agent.clone(), event.session.clone()))
                        })
                        .unwrap_or(true)
                })
                .map(|event| {
                    let mut message = event.message.clone();
                    message.seq = Some(event.seq);
                    message
                })
                .collect();
            drop(events);

            let peers = state.peers.lock().await;
            if let Some(sender) = peers.get(sender_id) {
                for message in replay {
                    let _ = sender
                        .tx
                        .send(Message::Text(serde_json::to_string(&message).unwrap()));
                }
            }
        }

        // Ack desktop: v2 uses this as a cheap compaction trigger. The hub remains
        // stateless per-client for now; the durable cursor lives in the desktop.
        "ack" => {
            if let Some(seq) = msg.ack_seq {
                tracing::debug!("client {sender_id} acked seq {seq}");
            }
            if let Err(err) = compact_events(state).await {
                tracing::warn!("failed to compact on ack: {err}");
            }
        }

        _ => {
            tracing::warn!("unhandled message type: {}", msg.msg_type);
        }
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async fn cleanup_peer(peer_id: &str, hosted_agents: &[String], state: &Arc<AppState>) {
    let mut agent_routes = state.agent_routes.lock().await;
    for agent_id in hosted_agents {
        if agent_routes
            .get(agent_id)
            .map(|s| s == peer_id)
            .unwrap_or(false)
        {
            agent_routes.remove(agent_id);
            tracing::info!("agent {agent_id} deregistered");
        }
    }
    drop(agent_routes);

    let mut pending = state.pending_requests.lock().await;
    pending.retain(|_, pending_peer_id| pending_peer_id != peer_id);
    drop(pending);

    let mut peers = state.peers.lock().await;
    peers.remove(peer_id);
}

// ── Minimal HTTP surface ─────────────────────────────────────────────────────

async fn is_plain_http(stream: &TcpStream) -> bool {
    let mut buf = [0u8; 1024];
    let Ok(Ok(n)) = timeout(Duration::from_millis(500), stream.peek(&mut buf)).await else {
        return false;
    };
    if n == 0 {
        return false;
    }
    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
    !head.contains("upgrade: websocket")
        && (head.starts_with("get ")
            || head.starts_with("head ")
            || head.starts_with("post ")
            || head.starts_with("options "))
}

async fn handle_http_connection(mut stream: TcpStream, addr: std::net::SocketAddr, state: Arc<AppState>) {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        match stream.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        }
    }

    let req = String::from_utf8_lossy(&buf);
    let mut lines = req.lines();
    let Some(first) = lines.next() else { return; };
    let parts: Vec<&str> = first.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = write_http_response(&mut stream, 400, &[("content-type", "text/plain")], b"bad request").await;
        return;
    }

    let method = parts[0].to_ascii_uppercase();
    let target = parts[1];
    tracing::debug!("http {addr} {method} {target}");

    if method == "OPTIONS" {
        let _ = write_http_response(&mut stream, 204, &[("access-control-allow-origin", "*")], b"").await;
        return;
    }

    if target == "/" {
        let agent_routes = state.agent_routes.lock().await;
        let body = serde_json::json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"agents":agent_routes.keys().collect::<Vec<_>>()}).to_string();
        let _ = write_http_response(&mut stream, 200, &[("content-type", "application/json")], body.as_bytes()).await;
        return;
    }

    if let Some(rest) = target.strip_prefix("/canvas/") {
        let (agent, tail) = rest.split_once('/').unwrap_or((rest, ""));
        if agent.is_empty() {
            let _ = write_http_response(&mut stream, 404, &[("content-type", "text/plain")], b"missing agent").await;
            return;
        }
        if !rest.contains('/') && !target.contains('?') {
            let location = format!("/canvas/{agent}/");
            let _ = write_http_response(&mut stream, 302, &[("location", &location)], b"").await;
            return;
        }

        let canvas_path = format!("/__openclaw__/canvas/{tail}");
        match proxy_canvas_request(agent, &method, &canvas_path, state.clone()).await {
            Ok(mut resp) => {
                let mut body = resp.body_base64.as_deref()
                    .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
                    .unwrap_or_default();
                let headers_json = resp.headers.take().unwrap_or_else(|| serde_json::json!({}));
                let content_type = headers_json.get("content-type").and_then(|v| v.as_str()).unwrap_or("application/octet-stream");

                if content_type.contains("text/html") {
                    if let Ok(mut html) = String::from_utf8(body.clone()) {
                        let base = format!("/canvas/{agent}/");
                        html = html.replace("/__openclaw__/canvas/", &base);
                        if !html.contains("<base ") {
                            html = html.replace("<head>", &format!("<head><base href=\"{base}\">"));
                        }
                        body = html.into_bytes();
                    }
                }

                let status = resp.status_code.unwrap_or(502);
                let _ = write_http_response(
                    &mut stream,
                    status,
                    &[("content-type", content_type), ("cache-control", "no-store")],
                    if method == "HEAD" { b"" } else { &body },
                ).await;
            }
            Err(err) => {
                tracing::warn!("canvas proxy failed for {agent}: {err}");
                let _ = write_http_response(&mut stream, 502, &[("content-type", "text/plain")], err.to_string().as_bytes()).await;
            }
        }
        return;
    }

    let _ = write_http_response(&mut stream, 404, &[("content-type", "text/plain")], b"not found").await;
}

async fn proxy_canvas_request(agent: &str, method: &str, path: &str, state: Arc<AppState>) -> anyhow::Result<WsMessage> {
    let peer_id = {
        let routes = state.agent_routes.lock().await;
        routes.get(agent).cloned()
    }.ok_or_else(|| anyhow::anyhow!("agent '{agent}' is not connected"))?;

    let request_id = format!("canvas-{:x}", fast_rand());
    let (tx, rx) = oneshot::channel();
    state.pending_canvas.lock().await.insert(request_id.clone(), tx);

    let req = WsMessage {
        msg_type: "canvas_http_request".to_string(),
        id: Some(request_id.clone()),
        agent: Some(agent.to_string()),
        method: Some(method.to_string()),
        path: Some(path.to_string()),
        ..empty_message()
    };

    let sent = {
        let peers = state.peers.lock().await;
        peers.get(&peer_id)
            .map(|peer| peer.tx.send(Message::Text(serde_json::to_string(&req).unwrap())).is_ok())
            .unwrap_or(false)
    };

    if !sent {
        state.pending_canvas.lock().await.remove(&request_id);
        anyhow::bail!("agent '{agent}' route is unavailable");
    }

    match timeout(Duration::from_secs(20), rx).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(_)) => anyhow::bail!("canvas response channel closed"),
        Err(_) => {
            state.pending_canvas.lock().await.remove(&request_id);
            anyhow::bail!("canvas request timed out")
        }
    }
}

fn empty_message() -> WsMessage {
    WsMessage {
        msg_type: String::new(), id: None, role: None, agent: None, agents: None,
        session: None, content: None, model: None, token: None, status: None, tool: None,
        summary: None, code: None, message: None, usage: None, seq: None, since: None,
        ack_seq: None, sessions: None, method: None, path: None, title: None, url: None,
        status_code: None, headers: None, body_base64: None,
    }
}

async fn write_http_response(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK", 204 => "No Content", 302 => "Found", 400 => "Bad Request",
        404 => "Not Found", 502 => "Bad Gateway", _ => "OK",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\ncontent-length: {}\r\n", body.len());
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn fast_rand() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OCTOPUS_HUB_DATA_DIR") {
        return PathBuf::from(dir);
    }

    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".local/share/octopus-hub"))
        .unwrap_or_else(|_| PathBuf::from("./octopus-hub-data"))
}

fn load_events(path: &PathBuf) -> anyhow::Result<Vec<PersistedEvent>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<PersistedEvent>(&line) {
            Ok(event) => events.push(event),
            Err(err) => tracing::warn!("skipping invalid event log line: {err}"),
        }
    }

    events.sort_by_key(|event| event.seq);
    Ok(events)
}

async fn persist_event(
    mut message: WsMessage,
    state: &Arc<AppState>,
) -> anyhow::Result<Option<u64>> {
    let Some(agent) = message.agent.clone() else {
        return Ok(None);
    };
    let Some(session) = message.session.clone() else {
        return Ok(None);
    };

    let mut next_seq = state.next_seq.lock().await;
    let seq = *next_seq;
    *next_seq += 1;
    drop(next_seq);

    message.seq = Some(seq);
    let event = PersistedEvent {
        seq,
        timestamp_ms: now_millis(),
        agent,
        session,
        message,
    };

    let mut events = state.events.lock().await;
    events.push(event.clone());
    drop(events);

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.event_log_path)?;
    serde_json::to_writer(&mut file, &event)?;
    file.write_all(b"\n")?;
    file.flush()?;

    Ok(Some(seq))
}

async fn compact_events(state: &Arc<AppState>) -> anyhow::Result<()> {
    let mut events = state.events.lock().await;
    let mut closed_sessions = std::collections::HashSet::new();
    let mut completed_messages = std::collections::HashSet::new();

    for event in events.iter() {
        if event.message.msg_type == "close_thread" {
            closed_sessions.insert((event.agent.clone(), event.session.clone()));
        }
        if matches!(event.message.msg_type.as_str(), "done" | "error") {
            if let Some(id) = &event.message.id {
                completed_messages.insert(id.clone());
            }
        }
    }

    let compacted: Vec<PersistedEvent> = events
        .iter()
        .filter(|event| {
            let key = (event.agent.clone(), event.session.clone());
            if closed_sessions.contains(&key) && event.message.msg_type != "close_thread" {
                return false;
            }

            if matches!(
                event.message.msg_type.as_str(),
                "chunk" | "tool_progress" | "agent_status"
            ) {
                if let Some(id) = &event.message.id {
                    return !completed_messages.contains(id);
                }
            }

            true
        })
        .cloned()
        .collect();

    if compacted.len() == events.len() {
        return Ok(());
    }

    let tmp_path = state.event_log_path.with_extension("jsonl.tmp");
    {
        let mut file = File::create(&tmp_path)?;
        for event in &compacted {
            serde_json::to_writer(&mut file, event)?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
    }
    fs::rename(&tmp_path, &state.event_log_path)?;
    *events = compacted;

    Ok(())
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
