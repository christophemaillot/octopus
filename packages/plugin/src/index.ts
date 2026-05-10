/**
 * Octopus Plugin — Agent-side connector for Octopus Hub
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
    const cfg = api.pluginConfig as { hubUrl?: string; token?: string; reconnectDelay?: number };

    const HUB_TOKEN = (() => {
      try { return readFileSync("/etc/octopus/hub.token", "utf8").trim(); }
      catch { return cfg.token || ""; }
    })();

    // Connect directly to the hub (not through nginx) for stability
    const hubUrl = "ws://127.0.0.1:3700";
    const authToken = cfg.token || HUB_TOKEN;
    const reconnectDelay = 3000;

    const localAgents = [
      { id: "main", label: "Basile", model: api.runtime.agent.defaults.model },
    ];

    api.logger.info(`octopus: hubUrl=${hubUrl}`);

    // ── State ─────────────────────────────────────────────────────
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processingCount = 0;

    function sendJson(msg: Record<string, unknown>) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    }

    function scheduleReconnect() {
      if (shuttingDown || connecting || processingCount > 0 || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
    }

    function connect() {
      if (shuttingDown || connecting || processingCount > 0) return;
      if (ws && ws.readyState === WebSocket.OPEN) return;

      connecting = true;

      // Close previous socket
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
          ws!.send(JSON.stringify({
            type: "auth", role: "agent", token: authToken, agents: localAgents,
          }));
        });

        ws.on("message", async (raw: Buffer) => {
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }

          if (msg.type === "auth_ok") return;

          if (msg.type === "send_message") {
            processingCount++;
            try {
              const msgId = msg.id ?? randomUUID();
              const agentId = msg.agent ?? "main";
              const sessionKey = msg.session
                ? `octopus:${agentId}:${msg.session}`
                : `octopus:${agentId}:${randomUUID()}`;

              sendJson({ type: "agent_status", agent: agentId, status: "thinking" });

              const subOptions: any = { sessionKey, message: msg.content ?? "", deliver: false };
              if (msg.model) subOptions.model = msg.model;

              const { runId } = await api.runtime.subagent.run(subOptions);
              const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
              const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
              const lastMsg = messages?.findLast((m: any) => m.role === "assistant");
              const content = lastMsg?.content ?? result?.output ?? "";

              sendJson({
                type: "done", id: msgId, agent: agentId, session: msg.session,
                content, usage: result?.usage, model: result?.model,
              });

              processingCount--;
              // Reconnect if disconnected during processing
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                connecting = false;
                scheduleReconnect();
              }
            } catch (err: any) {
              api.logger.error(`octopus: error: ${err.message}`);
              sendJson({ type: "error", code: "agent_error", message: err.message });
              processingCount--;
              scheduleReconnect();
            }
            return;
          }

          api.logger.warn(`octopus: unknown msg: ${msg.type}`);
        });

        ws.on("close", () => {
          connecting = false;
          if (intentionalClose) return;
          ws = null;
          scheduleReconnect();
        });

        ws.on("error", () => {
          connecting = false;
          try { ws?.terminate(); } catch {}
          ws = null;
          scheduleReconnect();
        });

      } catch (err) {
        connecting = false;
        scheduleReconnect();
      }
    }

    connect();

    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { intentionalClose = true; ws.close(1001, "shutdown"); }
    });
  },
});
