# Octopus Protocol — Spec v0.2

## Architecture

```
OpenClaw Helios  ──WS──┐
(Basile, Kip...)        │
                        ├──→  Hub hub.chrm.fr  ←── Desktop Clients
OpenClaw Pax     ──WS──┤     (message broker)     (Tauri app)
(Pax agent)             │
                        └──→  Desktop Clients
```

Le **Hub** est le serveur central (comme l'API Telegram).
Les **plugins OpenClaw** se connectent au hub (outbound, comme des bots Telegram).
Les **clients desktop** se connectent aussi au hub.

## Transport

- **WebSocket** — connexion persistante bidirectionnelle
- **Port :** 3700
- **Encodage :** JSON (UTF-8), un message par frame

---

## Authentification

Chaque connexion doit envoyer un message `auth` en premier (timeout 5s).

### Agent (plugin OpenClaw)

```json
{
  "type": "auth",
  "role": "agent",
  "token": "op_...",
  "agents": [
    { "id": "basile", "label": "Basile", "model": "deepseek/deepseek-v4-flash" },
    { "id": "kip", "label": "Kip", "model": "anthropic/claude-sonnet-4-6" }
  ]
}
```

### Client (desktop)

```json
{
  "type": "auth",
  "role": "client",
  "token": "op_..."
}
```

### Réponse

```json
{
  "type": "auth_ok",
  "peer_id": "p1a2b3c4",
  "kind": "agent"
}
```

---

## Messages

### `list_agents` — Client → Hub

```json
{
  "type": "list_agents"
}
```

Réponse :

```json
{
  "type": "agent_list",
  "agents": [
    { "id": "basile", "label": "Basile", "model": "deepseek/deepseek-v4-flash" },
    { "id": "kip", "label": "Kip", "model": "anthropic/claude-sonnet-4-6" },
    { "id": "pax", "label": "Pax", "model": "openai/gpt-4.1" }
  ]
}
```

### `send_message` — Client → Hub → Agent Plugin

```json
{
  "type": "send_message",
  "id": "msg_123",
  "agent": "kip",
  "session": "sess_456",
  "content": "Quel temps fait-il demain ?",
  "model": "minimax/MiniMax-M2.7"
}
```

Le hub route vers le bon plugin en fonction de l'`agent`.

### `agent_status` — Plugin → Hub → Client

```json
{
  "type": "agent_status",
  "agent": "kip",
  "status": "thinking"
}
```

| `status` | Signification |
|---|---|
| `idle` | Agent disponible |
| `thinking` | Réflexion / raisonnement |
| `streaming` | Génération en cours |
| `error` | Erreur |

### `tool_progress` — Plugin → Hub → Client

```json
{
  "type": "tool_progress",
  "id": "msg_123",
  "agent": "kip",
  "tool": "web_search",
  "status": "running",
  "summary": "Recherche météo Bordeaux"
}
```

### `done` — Plugin → Hub → Client

```json
{
  "type": "done",
  "id": "msg_123",
  "agent": "kip",
  "session": "sess_456",
  "content": "Demain il fera 18°C...",
  "usage": {
    "input_tokens": 450,
    "output_tokens": 120,
    "context_pct": 34
  },
  "model": "deepseek/deepseek-v4-flash"
}
```

### `error` — N'importe qui → Hub → Destinataire

```json
{
  "type": "error",
  "code": "agent_unavailable",
  "message": "Agent 'kip' is not connected"
}
```

### `ping` / `pong`

```json
{ "type": "ping" }
{ "type": "pong" }
```

---

## Flux typique

```
Client              Hub              Plugin (Helios)     Plugin (Pax)
  │                  │                   │                   │
  │── auth ─────────>│                   │                   │
  │<── auth_ok ─────│                   │                   │
  │                  │<── auth ──────────│                   │
  │                  │── auth_ok ───────>│                   │
  │                  │                                          │
  │── send_message ─>│                   │                     │
  │  (agent: kip)    │── send_message ──>│                     │
  │                  │<── agent_status ──│                     │
  │<── agent_status ─│                   │                     │
  │                  │                   │                     │
  │                  │                   │  [subagent run]     │
  │                  │                   │                     │
  │                  │<── done ──────────│                     │
  │<── done ─────────│                   │                     │
  │                  │                                          │
  │── list_agents ──>│                   │                     │
  │<── agent_list ───│                   │                     │
  │  [basile, kip,   │                   │                     │
  │   pax]           │                   │                     │
```

---

## Erreurs standards

| Code | Signification |
|---|---|
| `invalid_json` | JSON mal formé |
| `auth_required` | Message reçu avant auth |
| `invalid_token` | Token invalide |
| `agent_unavailable` | Agent déconnecté ou inconnu |
| `agent_error` | Erreur interne de l'agent |
| `session_not_found` | Session inconnue |
