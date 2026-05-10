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

function resolvePrimaryModel(config: any): { provider?: string; model?: string; id: string } {
  const primary = config?.agents?.defaults?.model?.primary
    ?? config?.agents?.defaults?.model
    ?? "openai-codex/gpt-5.5";
  const id = String(primary);
  const slash = id.indexOf("/");
  if (slash > 0) {
    return { provider: id.slice(0, slash), model: id.slice(slash + 1), id };
  }
  return { model: id, id };
}

function resultText(result: any): string {
  const payloadText = Array.isArray(result?.payloads)
    ? result.payloads.map((p: any) => p?.text || "").filter(Boolean).join("\n\n")
    : "";
  return payloadText
    || result?.meta?.finalAssistantVisibleText
    || result?.meta?.finalAssistantRawText
    || "";
}

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
    const primaryModel = resolvePrimaryModel(api.config);
    api.logger.info("octopus: starting");

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processing = false;
    let currentMsgId: string | null = null;
    let currentAgentId: string | null = null;

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

      const newWs = new WebSocket(hubUrl);
      ws = newWs;

      newWs.onopen = () => {
        if (newWs !== ws) return; // stale connection
        connecting = false;
        newWs.send(JSON.stringify({
          type: "auth", role: "agent", token: authToken,
          agents: [{ id: "main", label: "Basile", model: primaryModel.id }],
        }));
      };

      newWs.onclose = () => {
        connecting = false;
        if (intentionalClose || newWs !== ws) return;
        ws = null;
        scheduleReconnect();
      };

      newWs.onerror = () => {
        connecting = false;
        if (newWs !== ws) return;
        newWs.terminate();
        ws = null;
        scheduleReconnect();
      };

      newWs.on("message", async (data: Buffer) => {
        if (newWs !== ws) return;
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type !== "send_message") return;

        processing = true;
        try {
          const msgId = msg.id || randomUUID();
          const agentId = msg.agent || "main";
          const sessionId = `octopus:${agentId}:${msg.session || randomUUID()}`;
          currentMsgId = msgId;
          currentAgentId = agentId;

          send({ type: "agent_status", id: msgId, agent: agentId, status: "thinking" });

          const agentDir = api.runtime.agent.resolveAgentDir(api.config);
          const result = await api.runtime.agent.runEmbeddedAgent({
            sessionId,
            runId: randomUUID(),
            sessionFile: path.join(agentDir, "sessions", sessionId.replace(/:/g, "-") + ".jsonl"),
            workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(api.config),
            prompt: msg.content || "",
            provider: primaryModel.provider,
            model: primaryModel.model,
            timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(api.config),
          });

          send({
            type: "done", id: msgId, agent: agentId,
            content: resultText(result),
            usage: result?.meta?.agentMeta?.usage,
            model: result?.meta?.agentMeta?.model || primaryModel.id,
          });
        } catch (e: any) {
          api.logger.error(`octopus: ${e.message}`);
          send({ type: "error", id: currentMsgId, agent: currentAgentId, code: "agent_error", message: e.message });
        } finally {
          processing = false;
          currentMsgId = null;
          currentAgentId = null;
          if (ws?.readyState !== WebSocket.OPEN) scheduleReconnect();
        }
      });
    }

    connect();

    api.on("llm_output", async (event) => {
      if (!processing) return;
      try { send({ type: "chunk", id: currentMsgId, agent: currentAgentId, content: (event.output as any)?.text || "" }); } catch {}
    });

    api.on("before_tool_call", async (event) => {
      if (!processing) return;
      try { send({ type: "tool_progress", id: currentMsgId, agent: currentAgentId, tool: event.toolName, status: "running" }); } catch {}
    });

    api.on("after_tool_call", async (event) => {
      if (!processing) return;
      try { send({ type: "tool_progress", id: currentMsgId, agent: currentAgentId, tool: event.toolName, status: "completed" }); } catch {}
    });

    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { intentionalClose = true; ws.close(1001); }
    });
  },
});
