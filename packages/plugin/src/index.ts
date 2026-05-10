/**
 * Octopus Plugin — Agent-side connector for Octopus Hub
 *
 * Architecture:
 *   Desktop Tauri  ←WS→  Hub (hub.chrm.fr)  ←WS→  Plugin (this)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octopus",
  errorMessage: "octopus plugin runtime not initialized",
});

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

    const HUB_TOKEN = (() => {
      try {
        return readFileSync("/etc/octopus/hub.token", "utf8").trim();
      } catch {
        return cfg.token || "2ae22ad5b40778fa3ddaa465fcf03380";
      }
    })();
    const hubUrl = cfg.hubUrl ?? "wss://octopus.chrm.fr:443";
    const authToken = cfg.token || HUB_TOKEN;
    const reconnectDelay = cfg.reconnectDelay ?? 5000;

    const localAgents = [
      { id: "main", label: "Basile", model: api.runtime.agent.defaults.model },
    ];

    api.logger.info(`octopus: will connect to hub at ${hubUrl}`);

    // ── State ─────────────────────────────────────────────────────
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processingCount = 0;

    function sendJson(msg: Record<string, unknown>) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    function scheduleReconnect() {
      if (shuttingDown || connecting || processingCount > 0 || reconnectTimer) return;
      api.logger.info(`octopus: reconnecting in ${reconnectDelay}ms...`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
    }

    function connect() {
      if (shuttingDown || connecting || processingCount > 0) return;
      if (ws && ws.readyState === WebSocket.OPEN) return;

      connecting = true;
      api.logger.info("octopus: connecting to hub...");

      if (ws) {
        intentionalClose = true;
        try { ws.terminate(); } catch {}
        intentionalClose = false;
        ws = null;
      }

      try {
        ws = new WebSocket(hubUrl);

        ws.on("open", () => {
          connecting = false;
          api.logger.info("octopus: connected to hub");
          ws!.send(JSON.stringify({
            type: "auth",
            role: "agent",
            token: authToken,
            agents: localAgents,
          }));
        });

        ws.on("message", async (raw: Buffer) => {
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }

          if (msg.type === "auth_ok") {
            api.logger.info("octopus: authenticated with hub");
            return;
          }

          if (msg.type === "error") {
            api.logger.error(`octopus: hub error: ${msg.message}`);
            return;
          }

          if (msg.type === "send_message") {
            processingCount++;
            try {
              await handleMessage(msg, api, sendJson);
            } catch (err: any) {
              api.logger.error(`octopus: handler error: ${err.message}`);
              sendJson({
                type: "error",
                id: msg.id,
                code: "handler_error",
                message: err.message,
              });
            } finally {
              processingCount--;
            }
            return;
          }

          api.logger.warn(`octopus: unknown hub message type: ${msg.type}`);
        });

        ws.on("close", () => {
          connecting = false;
          if (intentionalClose) return;
          api.logger.warn("octopus: hub disconnected");
          ws = null;
          scheduleReconnect();
        });

        ws.on("error", (err: Error) => {
          connecting = false;
          api.logger.error(`octopus: hub error: ${err.message}`);
          try { ws?.terminate(); } catch {}
          ws = null;
          scheduleReconnect();
        });
      } catch (err) {
        connecting = false;
        api.logger.error(`octopus: connect error: ${err}`);
        scheduleReconnect();
      }
    }

    connect();

    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        intentionalClose = true;
        ws.close(1001, "gateway shutting down");
      }
    });
  },
});

// ── Message handler ─────────────────────────────────────────────────

async function handleMessage(
  msg: any,
  api: any,
  send: (msg: Record<string, unknown>) => void,
) {
  const msgId = msg.id ?? randomUUID();
  const agentId = msg.agent ?? "main";
  const sessionKey = msg.session
    ? `octopus:${agentId}:${msg.session}`
    : `octopus:${agentId}:${randomUUID()}`;

  api.logger.info(`octopus: processing message for agent=${agentId} session=${sessionKey}`);

  // Notify hub
  send({ type: "agent_status", agent: agentId, status: "thinking" });

  try {
    const subOptions: any = { sessionKey, message: msg.content ?? "", deliver: false };
    if (msg.model) subOptions.model = msg.model;

    const { runId } = await api.runtime.subagent.run(subOptions);
    const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });

    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 10,
    });

    const lastMsg = messages?.findLast((m: any) => m.role === "assistant");
    const fullContent = lastMsg?.content ?? result?.output ?? "";

    send({
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
    send({
      type: "error",
      id: msgId,
      agent: agentId,
      code: "agent_error",
      message: err.message,
    });
  }
}
