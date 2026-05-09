// Octopus Hub — pont WebSocket entre clients desktop et le plugin OpenClaw
//
// Architecture:
//   Desktop Tauri  —WS :3700—>  Hub  —WS :3701—>  Plugin (OpenClaw)
//
// Le hub :
// 1. Maintient une connexion persistante vers le plugin OpenClaw
// 2. Accepte les connexions des clients desktop
// 3. Route les messages entre clients et plugin (via le champ `session`)

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "octopus-hub", version)]
struct Args {
    /// Adresse du serveur WebSocket du plugin OpenClaw
    #[arg(long, default_value = "ws://127.0.0.1:3701")]
    upstream: String,

    /// Port d'écoute pour les clients desktop
    #[arg(long, default_value_t = 3700)]
    port: u16,

    /// Token d'authentification pour le plugin
    #[arg(long)]
    token: Option<String>,
}

// ── Types sérialisables ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<UsageInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agents: Option<Vec<AgentInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    messages: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UsageInfo {
    input_tokens: u32,
    output_tokens: u32,
    context_pct: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AgentInfo {
    id: String,
    label: String,
    #[serde(rename = "model")]
    model_name: String,
    status: String,
}

// ── État partagé ─────────────────────────────────────────────────────────────

struct AppState {
    /// Tâche d'écriture vers le plugin (broadcast)
    plugin_tx: mpsc::UnboundedSender<Message>,
    /// Connexions client actives (id → sender)
    clients: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
    /// Token d'auth pour le plugin
    token: Option<String>,
}

// ── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,octopus_hub=debug")
        .init();

    let args = Args::parse();
    tracing::info!("octopus-hub starting...");

    // 1. Connexion au plugin
    let up_url = Url::parse(&args.upstream)?;
    tracing::info!("connecting to plugin at {}", up_url);

    let (plugin_ws, _) = connect_async(up_url.as_str()).await?;
    let (mut plugin_writer, mut plugin_reader) = plugin_ws.split();

    // Canal pour envoyer des messages au plugin
    let (plugin_tx, mut plugin_rx) = mpsc::unbounded_channel::<Message>();

    // Tâche : écriture vers le plugin
    tokio::spawn(async move {
        while let Some(msg) = plugin_rx.recv().await {
            if let Err(e) = plugin_writer.send(msg).await {
                tracing::error!("plugin send error: {e}");
                break;
            }
        }
    });

    // 2. Authentification auprès du plugin
    let auth_msg = serde_json::json!({
        "type": "auth",
        "content": args.token.as_deref().unwrap_or(""),
    });
    plugin_tx.send(Message::Text(auth_msg.to_string()))?;

    tracing::info!("sent auth to plugin, waiting for auth_ok...");

    // 3. État partagé
    let state = Arc::new(AppState {
        plugin_tx,
        clients: Mutex::new(HashMap::new()),
        token: args.token,
    });

    // 4. Tâche : lecture depuis le plugin (broadcast à tous les clients)
    let state_b = state.clone();
    tokio::spawn(async move {
        while let Some(msg) = plugin_reader.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let clients: tokio::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Message>>> = state_b.clients.lock().await;
                    for (_id, tx) in clients.iter() {
                        let _ = tx.send(Message::Text(text.clone()));
                    }
                }
                Ok(Message::Close(_)) => {
                    tracing::warn!("plugin connection closed");
                    break;
                }
                Ok(Message::Ping(_data)) => {
                    // forwarded below if needed
                }
                Ok(Message::Pong(_)) => {}
                Err(e) => {
                    tracing::error!("plugin read error: {e}");
                    break;
                }
                _ => {}
            }
        }
        // Plugin disconnected — broadcast to all clients
        let clients: tokio::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Message>>> = state_b.clients.lock().await;
        for (_id, tx) in clients.iter() {
            let _ = tx.send(Message::Text(
                serde_json::json!({"type": "error", "code": "plugin_disconnected", "message": "Agent connection lost"}).to_string(),
            ));
        }
        tracing::warn!("plugin reader task ended");
    });

    // 5. Accepteur de clients desktop
    let listen_addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("listening for desktop clients on {listen_addr}");

    let listener = TcpListener::bind(&listen_addr).await?;

    while let Ok((stream, addr)) = listener.accept().await {
        tracing::info!("new client connection from {addr}");
        let state = state.clone();
        tokio::spawn(handle_client(stream, addr, state));
    }

    Ok(())
}

// ── Handler par client ────────────────────────────────────────────────────────

async fn handle_client(
    stream: TcpStream,
    addr: std::net::SocketAddr,
    state: Arc<AppState>,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::error!("failed to accept WS from {addr}: {e}");
            return;
        }
    };

    let client_id = uuid_v4_simple();
    let (mut ws_writer, mut ws_reader) = ws_stream.split();

    // Canal pour envoyer des messages à CE client
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Enregistrer le client
    {
        let mut clients: tokio::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Message>>> = state.clients.lock().await;
        clients.insert(client_id.clone(), tx);
        tracing::debug!("client {client_id} registered ({addr})");
    }

    // Tâche : écriture vers le client (reçoit les messages du plugin broadcastés)
    let client_id_w = client_id.clone();
    let write_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = ws_writer.send(msg).await {
                tracing::debug!("client {client_id_w} write error: {e}");
                break;
            }
        }
    });

    // Lecture : messages du client → plugin
    while let Some(msg) = ws_reader.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Forward raw text to plugin
                if let Err(e) = state.plugin_tx.send(Message::Text(text.clone())) {
                    tracing::error!("forward to plugin failed: {e}");
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(data)) => {
                let _ = state.plugin_tx.send(Message::Pong(data));
            }
            Err(e) => {
                tracing::debug!("client {client_id} read error: {e}");
                break;
            }
            _ => {}
        }
    }

    // Nettoyage
    write_handle.abort();
    let mut clients: tokio::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Message>>> = state.clients.lock().await;
    clients.remove(&client_id);
    tracing::info!("client {client_id} disconnected ({addr})");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn uuid_v4_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("c{:x}", now.as_nanos())
}
