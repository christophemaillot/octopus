/**
 * Octopus Plugin — Agent-side connector for Octopus Hub
 *
 * Architecture:
 *   Desktop Tauri  ←WS→  Hub (hub.chrm.fr)  ←WS→  Plugin (this)
 *
 * The plugin connects OUT to the hub (like a Telegram bot connects
 * to Telegram's API). It announces its agents and routes messages
 * between the hub and the local OpenClaw instance.
 *
 * The hub is the central message broker — similar to Telegram's API server.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

interface HubMessage {
  type: string;
  id?: string;
  agent?: string;
  session?: string;
  content?: string;
  model?: string;
  limit?: number;
  code?: string;
  message?: string;
  tool?: string;
  status?: string;
  summary?: string;
  index?: number;
  usage?: { input_tokens: number; output_tokens: number; context_pct: number };
}

// ── Runtime store ────────────────────────────────────────────────────────────

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octopus",
  errorMessage: "octopus plugin runtime not initialized",
});

// ── Plugin entry ─────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "octopus",
  name: "Octopus",
  description: "Bridge between Octopus Hub and local OpenClaw agents",
  register(api) {
    const cfg = api.pluginConfig as {
      hubUrl?: string;
      token?: string;
      reconnectDelay?: number;
    };

    const hubUrl = process.env.OCTOPUS_HUB_URL ?? cfg.hubUrl ?? "wss://octopus.chrm.fr:443";
    const authToken = process.env.OCTOPUS_HUB_TOKEN ?? cfg.token ?? "";
    const reconnectDelay = cfg.reconnectDelay ?? 5000;

    // Agents hosted on this instance
    const localAgents: Array<{ id: string; label: string; model: string }> = [
      {
        id: "main",
        label: "Basile",
        model: api.runtime.agent.defaults.model,
      },
    ];

    api.logger.info(`octopus: will connect to hub at ${hubUrl}`);

    // ── Connection manager ─────────────────────────────────────────────
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;

    function connect() {
      if (shuttingDown || connecting || (ws && ws.readyState === WebSocket.OPEN)) return;

      connecting = true;
      api.logger.info(`octopus: connecting to hub...`);

      // Close old socket if any
      if (ws) {
        intentionalClose = true;
        try { ws.close(); } catch {}
        intentionalClose = false;
        ws = null;
      }

      try {
        ws = new WebSocket(hubUrl);

        ws.on("open", () => {
          connecting = false;
          api.logger.info("octopus: connected to hub");

          // Authenticate
          ws!.send(
            JSON.stringify({
              type: "auth",
              role: "agent",
              token: authToken,
              agents: localAgents,
            }),
          );
        });

        ws.on("message", async (raw: Buffer) => {
          let msg: HubMessage;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          await handleHubMessage(msg, ws!, api);
        });

        ws.on("close", (code: number, reason: Buffer) => {
          connecting = false;
          if (intentionalClose) return;
          api.logger.warn(
            `octopus: hub disconnected (code=${code}, reason=${reason.toString()})`,
          );
          ws = null;
          scheduleReconnect();
        });

        ws.on("error", (err: Error) => {
          connecting = false;
          api.logger.error(`octopus: hub websocket error: ${err.message}`);
          try { ws?.close(); } catch {}
          ws = null;
          scheduleReconnect();
        });
      } catch (err) {
        api.logger.error(`octopus: failed to connect: ${err}`);
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (shuttingDown || connecting || reconnectTimer) return;
      api.logger.info(`octopus: reconnecting in ${reconnectDelay}ms...`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
    }

    // ── Start connection ──────────────────────────────────────────────
    connect();

    // ── Gateway lifecycle ──────────────────────────────────────────────
    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close(1001, "gateway shutting down");
    });
  },
});

// ── Message handler ──────────────────────────────────────────────────────────

async function handleHubMessage(
  msg: HubMessage,
  ws: WebSocket,
  api: any, // OpenClawPluginApi — using any for simplicity in v0.1
) {
  // Auth response from hub
  if (msg.type === "auth_ok") {
    api.logger.info("octopus: authenticated with hub");
    return;
  }

  // Error from hub
  if (msg.type === "error") {
    api.logger.error(`octopus: hub error: ${msg.message}`);
    return;
  }

  // ── send_message — hub wants this agent to process a message ─────────
  if (msg.type === "send_message") {
    const msgId = msg.id ?? randomUUID();
    const agentId = msg.agent ?? "main";
    const sessionKey = msg.session
      ? `octopus:${agentId}:${msg.session}`
      : `octopus:${agentId}:${randomUUID()}`;

    api.logger.info(
      `octopus: processing message for agent=${agentId} session=${sessionKey}`,
    );

    // Notify hub that processing started
    sendToHub(ws, {
      type: "agent_status",
      agent: agentId,
      status: "thinking",
    });

    try {
      // Run subagent to process the message
      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: msg.content ?? "",
        model: msg.model,
        deliver: false,
      });

      const result = await api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: 120_000,
      });

      // Get the assistant's final message
      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 10,
      });

      const lastMsg = messages?.findLast(
        (m: any) => m.role === "assistant",
      );
      const fullContent = lastMsg?.content ?? result?.output ?? "";

      sendToHub(ws, {
        type: "done",
        id: msgId,
        agent: agentId,
        session: msg.session,
        content: fullContent,
        usage: result?.usage,
        model: result?.model,
      });
    } catch (err: any) {
      api.logger.error(`octopus: agent error: ${err.message}`);
      sendToHub(ws, {
        type: "error",
        id: msgId,
        agent: agentId,
        session: msg.session,
        code: "agent_error",
        message: err.message,
      });
    }

    return;
  }

  // ── ping — respond with pong ────────────────────────────────────────
  if (msg.type === "ping") {
    sendToHub(ws, { type: "pong" });
    return;
  }

  api.logger.warn(`octopus: unknown hub message type: ${msg.type}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendToHub(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
