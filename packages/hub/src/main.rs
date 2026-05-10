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
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AgentInfo {
    id: String,
    label: String,
    model: String,
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

    let state = Arc::new(AppState {
        peers: Mutex::new(HashMap::new()),
        agent_routes: Mutex::new(HashMap::new()),
        pending_requests: Mutex::new(HashMap::new()),
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

async fn handle_connection(
    stream: TcpStream,
    addr: std::net::SocketAddr,
    state: Arc<AppState>,
) {
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
                    peer.hosted_agents
                        .insert(agent.id.clone(), agent.clone());
                }
            }
        }
    }

    // Répondre auth_ok
    let kind_str = if kind == PeerKind::Agent { "agent" } else { "client" };
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
            if let Some(message_id) = &msg.id {
                let mut pending = state.pending_requests.lock().await;
                pending.insert(message_id.clone(), sender_id.to_string());
            }

            let agent_routes = state.agent_routes.lock().await;

            if let Some(peer_id) = agent_routes.get(agent_id) {
                let peers = state.peers.lock().await;
                if let Some(peer) = peers.get(peer_id) {
                    let _ = peer.tx.send(Message::Text(
                        serde_json::to_string(&msg).unwrap(),
                    ));
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

        // Une réponse d'agent → client qui a émis la requête si l'id est connu,
        // fallback broadcast pour les messages globaux sans id.
        "chunk" | "done" | "tool_progress" | "agent_status" | "error" | "pong" => {
            let target_peer_id = if let Some(message_id) = &msg.id {
                let pending = state.pending_requests.lock().await;
                pending.get(message_id).cloned()
            } else {
                None
            };

            let peers = state.peers.lock().await;
            if let Some(peer_id) = target_peer_id {
                if let Some(peer) = peers.get(&peer_id) {
                    let _ = peer.tx.send(Message::Text(
                        serde_json::to_string(&msg).unwrap(),
                    ));
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
                let _ = peer.tx.send(Message::Text(
                    serde_json::to_string(&msg).unwrap(),
                ));
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

        _ => {
            tracing::warn!("unhandled message type: {}", msg.msg_type);
        }
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async fn cleanup_peer(
    peer_id: &str,
    hosted_agents: &[String],
    state: &Arc<AppState>,
) {
    let mut agent_routes = state.agent_routes.lock().await;
    for agent_id in hosted_agents {
        if agent_routes.get(agent_id).map(|s| s == peer_id).unwrap_or(false) {
            agent_routes.remove(agent_id);
            tracing::info!("agent {agent_id} deregistered");
        }
    }
    drop(agent_routes);

    let mut peers = state.peers.lock().await;
    peers.remove(peer_id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn fast_rand() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}
