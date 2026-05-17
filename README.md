# Octopus

Octopus is a multi-agent desktop client for OpenClaw. The project provides a
Tauri/React desktop app, a Rust hub, and an OpenClaw plugin that connects local
agents to the client over WebSocket.

The goal is to talk to several OpenClaw agents from a single desktop interface,
track their state in real time, keep conversation history, and expose Canvas
views produced by agents.

## Features

- Connects to a central WebSocket hub with token-based authentication.
- Dynamically discovers OpenClaw agents connected to the hub.
- Multi-agent desktop UI with an agent list, status indicators, and
  per-agent conversations.
- Local thread persistence in `~/.config/octopus/sessions/`.
- Streaming agent replies, live tool progress, and Markdown message rendering.
- Per-agent model selection based on models available in OpenClaw.
- Delivery modes to steer an active agent turn or queue a message after the
  current turn.
- Event replay from the hub after reconnecting.
- Minimal HTTP proxy for opening OpenClaw Canvas views in a desktop side panel.
- Startup OpenClaw plugin that publishes local agents and relays messages to the
  hub.

## Architecture

```text
OpenClaw agents
   │
   │  Octopus plugin
   ▼
Octopus Hub  <---->  Octopus Desktop
 WebSocket           Tauri + React
```

The monorepo contains three main packages:

```text
packages/
├── desktop/   Tauri/React desktop app
├── hub/       Rust WebSocket server and Canvas proxy
└── plugin/    TypeScript OpenClaw plugin
```

The hub listens on port `3700` by default. OpenClaw plugins and desktop clients
connect to it over WebSocket, authenticate, then exchange JSON messages. The
protocol is documented in more detail in [SPEC.md](./SPEC.md).

## Configuration

The desktop client reads its configuration from:

```text
~/.config/octopus/octopus.toml
```

An example file is available at
[packages/desktop/config/octopus.toml.example](./packages/desktop/config/octopus.toml.example).

Minimal example:

```toml
[hub]
url = "ws://127.0.0.1:3700"
token = "op_dev_token"

[[agents]]
id = "basile"
label = "Basile"
model = "deepseek/deepseek-v4-flash"
```

Optional avatars are loaded from:

```text
~/.config/octopus/avatars/<agent-id>.png
```

The OpenClaw plugin can read the hub token from its plugin configuration or
from:

```text
/etc/octopus/hub.token
```

## Requirements

- Rust toolchain
- Node.js 22+
- npm
- Tauri CLI
- OpenClaw, to use the agent-side plugin

## Installation

From the repository root:

```bash
npm install
cargo build
```

## Run The Hub

```bash
cargo run -p octopus-hub -- --port 3700 --token op_dev_token
```

Useful options:

```bash
cargo run -p octopus-hub -- --port 3700 --token op_dev_token --data-dir ./data
```

The hub persists events to `events.jsonl` under its data directory. Without
`--data-dir`, it uses its default data directory.

## Run The Desktop App

```bash
cd packages/desktop
npm run tauri dev
```

To build only the frontend:

```bash
cd packages/desktop
npm run build
```

## OpenClaw Plugin

The `@octopus/plugin` package declares an OpenClaw plugin that starts
automatically. It:

- lists available agents and models through the OpenClaw CLI;
- connects the local runtime to the Octopus hub;
- routes incoming messages to the right agent;
- relays chunks, statuses, tool calls, errors, and final replies;
- bridges Canvas HTTP requests.

The plugin manifest is available at
[packages/plugin/openclaw.plugin.json](./packages/plugin/openclaw.plugin.json).

## Protocol

The protocol uses JSON WebSocket frames. The main message types are:

- `auth` / `auth_ok` for authentication;
- `list_agents` / `agent_list` for agent discovery;
- `send_message` to send a message to an agent;
- `chunk`, `tool_progress`, `agent_status`, `done`, and `error` to follow an
  agent run;
- `replay` / `ack` to resume a stream after reconnecting;
- `canvas_http_request`, `canvas_http_response`, and `canvas_open` for Canvas.

See [SPEC.md](./SPEC.md) for the detailed contract.
