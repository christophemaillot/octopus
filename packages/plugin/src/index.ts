import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

let GLOBAL_LOCK = false;

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octopus",
  errorMessage: "octopus plugin runtime not initialized",
});

export default definePluginEntry({
  id: "octopus",
  name: "Octopus",
  description: "Bridge between Octopus Hub and local OpenClaw agents",
  register(api) {
    if (GLOBAL_LOCK) return;
    GLOBAL_LOCK = true;

    const cfg = api.pluginConfig as any;
    const HUB_TOKEN = (() => {
      try { return readFileSync("/etc/octopus/hub.token", "utf8").trim(); }
      catch { return cfg?.token || ""; }
    })();

    const hubUrl = "ws://127.0.0.1:3700";
    const authToken = cfg?.token || HUB_TOKEN;

    api.logger.info(`octopus: starting (url=${hubUrl})`);

    let ws = null as WebSocket | null;
    let reconnectTimer = null as ReturnType<typeof setTimeout> | null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processing = false;

    function send(msg: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function connect() {
      if (shuttingDown || connecting || processing) return;
      if (ws?.readyState === WebSocket.OPEN) return;
      connecting = true;
      if (ws) { intentionalClose = true; ws.terminate(); intentionalClose = false; ws = null; }

      try {
        ws = new WebSocket(hubUrl);
        ws.onopen = () => {
          connecting = false;
          ws!.send(JSON.stringify({ type: "auth", role: "agent", token: authToken, agents: [{ id: "main", label: "Basile", model: api.runtime.agent.defaults.model }] }));
        };
        ws.onmessage = async (raw) => {
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.type !== "send_message") return;

          processing = true;
          try {
            const msgId = msg.id || randomUUID();
            const agentId = msg.agent || "main";
            const sessionKey = `octopus:${agentId}:${msg.session || randomUUID()}`;
            send({ type: "agent_status", agent: agentId, status: "thinking" });

            const opts: any = { sessionKey, message: msg.content || "", deliver: false };
            if (msg.model) opts.model = msg.model;

            const { runId } = await api.runtime.subagent.run(opts);
            const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });
            const { messages: msgs } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
            const last = msgs?.findLast((m: any) => m.role === "assistant");

            send({ type: "done", id: msgId, agent: agentId, content: last?.content || result?.output || "", usage: result?.usage, model: result?.model });
          } catch (e: any) {
            api.logger.error(`octopus: ${e.message}`);
            send({ type: "error", code: "agent_error", message: e.message });
          } finally {
            processing = false;
            if (ws?.readyState !== WebSocket.OPEN) scheduleReconnect();
          }
        };
        ws.onclose = () => { connecting = false; if (intentionalClose) return; ws = null; scheduleReconnect(); };
        ws.onerror = () => { connecting = false; ws?.terminate(); ws = null; scheduleReconnect(); };
      } catch { connecting = false; scheduleReconnect(); }
    }

    function scheduleReconnect() {
      if (shuttingDown || connecting || processing || reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
    }

    connect();

    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { intentionalClose = true; ws.close(1001); }
    });
  },
});
