# Octopus Protocol — Spec v0.1

## Transport

- **WebSocket** (`ws://` ou `wss://`) — connexion persistante
- **Port hub :** `3700`
- **Encodage :** JSON (UTF-8), un message par frame
- **Keepalive :** ping/pong toutes les 30s

---

## Authentification

```json
{
  "type": "auth",
  "token": "op_..."
}
```

Réponse :

```json
{
  "type": "auth_ok",
  "user": "christophe",
  "agents": ["basile", "kip", "bellis", "numi"]
}
```

Le hub vérifie le token, répond avec la liste des agents accessibles.
Tout message non-auth avant `auth_ok` est rejeté.

---

## Messages Client → Hub

### `send_message` — Envoyer un message à un agent

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

| Champ | Obligatoire | Description |
|---|---|---|
| `id` | oui | ID côté client (pour traçabilité) |
| `agent` | oui | ID de l'agent cible |
| `session` | oui | ID de session (ou nouvelle si inconnue) |
| `content` | oui | Texte du message |
| `model` | non | Surcharge du modèle pour ce message |

### `cancel` — Annuler la génération en cours

```json
{
  "type": "cancel",
  "agent": "kip",
  "session": "sess_456"
}
```

### `list_agents` — Demander la liste des agents

```json
{
  "type": "list_agents"
}
```

### `get_history` — Historique d'une session

```json
{
  "type": "get_history",
  "session": "sess_456",
  "limit": 50
}
```

### `set_model` — Changer le modèle par défaut d'un agent

```json
{
  "type": "set_model",
  "agent": "kip",
  "model": "deepseek/deepseek-v4-pro"
}
```

### `get_status` — État courant de l'agent

```json
{
  "type": "get_status"
}
```

---

## Messages Hub → Client

### `chunk` — Fragment de réponse streaming

```json
{
  "type": "chunk",
  "id": "msg_123",
  "agent": "kip",
  "session": "sess_456",
  "content": "Demain, il fera ",
  "index": 0
}
```

Le client concatène les chunks par `id` dans l'ordre d'`index`.

### `done` — Fin du message

```json
{
  "type": "done",
  "id": "msg_123",
  "agent": "kip",
  "session": "sess_456",
  "usage": {
    "input_tokens": 450,
    "output_tokens": 120,
    "context_pct": 34
  },
  "model": "deepseek/deepseek-v4-flash"
}
```

Le champ `usage` inclut la consommation de contexte.

### `tool_progress` — Un outil est appelé

```json
{
  "type": "tool_progress",
  "id": "msg_123",
  "agent": "kip",
  "tool": "exec",
  "status": "running",
  "summary": "analyse du fichier metrics.json"
}
```

| `status` | Signification |
|---|---|
| `running` | L'outil démarre |
| `completed` | L'outil termine |
| `error` | L'outil a échoué |

Le client peut afficher ça dans un bloc repliable, pas dans le flux texte.

### `agent_status` — Changement d'état de l'agent

```json
{
  "type": "agent_status",
  "agent": "kip",
  "status": "thinking",
  "details": "Génération de la réponse..."
}
```

| `status` | Description |
|---|---|
| `idle` | Agent disponible |
| `thinking` | Réflexion / raisonnement |
| `streaming` | Génération en cours |
| `error` | Erreur |

### `session_list` — Résultat de `list_agents` / infos session

```json
{
  "type": "agent_list",
  "agents": [
    {
      "id": "basile",
      "label": "Basile",
      "model": "deepseek/deepseek-v4-flash",
      "status": "idle",
      "sessions": [
        { "id": "sess_001", "preview": "Bonjour...", "message_count": 12 }
      ]
    }
  ]
}
```

### `history` — Résultat de `get_history`

```json
{
  "type": "history",
  "session": "sess_456",
  "messages": [
    { "role": "user", "content": "Salut", "ts": "..." },
    { "role": "assistant", "content": "Salut !", "ts": "..." }
  ]
}
```

### `error` — Erreur

```json
{
  "type": "error",
  "code": "agent_unavailable",
  "message": "L'agent kip est indisponible"
}
```

### `pong` — Réponse au ping

```json
{
  "type": "pong",
  "ts": 1715000000
}
```

---

## Flux typique d'une conversation

```
Client                          Hub                         OpenClaw
  │                              │                             │
  │──── auth(token) ────────────>│                             │
  │<─── auth_ok(agents) ────────│                             │
  │                              │                             │
  │──── send_message ──────────>│                             │
  │                              │──── agentTurn ────────────>│
  │                              │<─── tool_progress ─────────│
  │<─── tool_progress ──────────│                             │
  │                              │<─── chunk ────────────────│
  │<─── chunk ──────────────────│                             │
  │                              │<─── chunk ────────────────│
  │<─── chunk ──────────────────│                             │
  │                              │<─── done ─────────────────│
  │<─── done(usage) ────────────│                             │
```

---

## Reconnexion

Le client stocke son `session` ID localement.
À la reconnexion, il renvoie les sessions actives dans `auth` :

```json
{
  "type": "auth",
  "token": "op_...",
  "sessions": ["sess_456", "sess_789"]
}
```

Le hub restaure le contexte et peut renvoyer les messages manqués.

---

## Erreurs standards

| `code` | Signification |
|---|---|
| `auth_required` | Token manquant ou invalide |
| `agent_unavailable` | Agent hors ligne |
| `session_not_found` | Session inconnue |
| `rate_limited` | Trop de requêtes |
| `internal_error` | Erreur serveur |
