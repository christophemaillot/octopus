import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

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

    api.logger.info(`octopus: starting`);

    // ── WebSocket state ──────────────────────────────────────────────
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processing = false;

    function send(msg: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function scheduleReconnect() {
      if (shuttingDown || connecting || processing || reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
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
        ws.onclose = () => { connecting = false; if (intentionalClose) return; ws = null; scheduleReconnect(); };
        ws.onerror = () => { connecting = false; ws?.terminate(); ws = null; scheduleReconnect(); };
      } catch { connecting = false; scheduleReconnect(); }
    }

    connect();

    // ── Message handler (async, sets processing=true) ──────────────
    ws!.onmessage = async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== "send_message") return;

      processing = true;
      const msgId = msg.id || randomUUID();
      const agentId = msg.agent || "main";
      const sessionId = `octopus:${agentId}:${msg.session || randomUUID()}`;

      try {
        send({ type: "agent_status", agent: agentId, status: "thinking" });

        // Run a full embedded agent turn (same pipeline as Telegram)
        const agentDir = api.runtime.agent.resolveAgentDir(api.config);
        const result = await api.runtime.agent.runEmbeddedAgent({
          sessionId,
          runId: randomUUID(),
          sessionFile: path.join(agentDir, "sessions", `${sessionId.replace(/:/g, "-")}.jsonl`),
          workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(api.config),
          prompt: msg.content || "",
          timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(api.config),
        });

        // Extract assistant response
        const fullContent = result?.output || "";

        send({ type: "done", id: msgId, agent: agentId, content: fullContent, usage: result?.usage, model: result?.model });
      } catch (e: any) {
        api.logger.error(`octopus: ${e.message}`);
        send({ type: "error", code: "agent_error", message: e.message });
      } finally {
        processing = false;
        if (ws?.readyState !== WebSocket.OPEN) scheduleReconnect();
      }
    };

    // ── Hooks for streaming ─────────────────────────────────────────
    api.on("llm_output", async (event) => {
      if (!processing) return;
      try {
        send({ type: "chunk", content: (event.output as any)?.text || "" });
      } catch {}
    });

    api.on("before_tool_call", async (event) => {
      if (!processing) return;
      try {
        send({ type: "tool_progress", tool: event.toolName, status: "running" });
      } catch {}
    });

    api.on("after_tool_call", async (event) => {
      if (!processing) return;
      try {
        send({ type: "tool_progress", tool: event.toolName, status: "completed" });
      } catch {}
    });

    // ── Cleanup ─────────────────────────────────────────────────────
    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { intentionalClose = true; ws.close(1001); }
    });
  },
});
