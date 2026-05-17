import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

let GLOBAL_LOCK = false;

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octopus",
  errorMessage: "octopus plugin runtime not initialized",
});

interface ModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  available?: boolean;
}

interface AgentInfo {
  id: string;
  label: string;
  model: string;
  workspaceDir: string;
  agentDir: string;
  models: ModelInfo[];
}

type DeliveryPreference = "steer" | "queue_after_turn";

function parseFirstJson(raw: string): any {
  const trimmed = raw.trim();
  const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error("no json in command output");
  const first = trimmed[start];
  const end = first === "{" ? trimmed.lastIndexOf("}") : trimmed.lastIndexOf("]");
  if (end < start) throw new Error("truncated json in command output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function readJsonCommand(args: string[]): any {
  const raw = execFileSync("openclaw", args, { encoding: "utf8" });
  return parseFirstJson(raw);
}

function listModels(log?: { warn?: (...args: unknown[]) => void }): ModelInfo[] {
  try {
    const parsed = readJsonCommand(["models", "list", "--json"]);
    return (Array.isArray(parsed?.models) ? parsed.models : [])
      .filter((m: any) => !m?.missing)
      .map((m: any) => ({
        id: String(m?.key ?? ""),
        label: String(m?.name ?? m?.key ?? ""),
        contextWindow: typeof m?.contextWindow === "number" ? m.contextWindow : undefined,
        available: m?.available !== false,
      }))
      .filter((m: ModelInfo) => m.id);
  } catch (err: any) {
    log?.warn?.(`octopus: failed to list models: ${err?.message ?? String(err)}`);
    return [];
  }
}

function listAgents(config: any, models: ModelInfo[], log?: { warn?: (...args: unknown[]) => void }): AgentInfo[] {
  const primary = resolvePrimaryModel(config).id;
  try {
    const parsed = readJsonCommand(["agents", "list", "--json"]);
    return (Array.isArray(parsed) ? parsed : [])
      .filter((agent: any) => agent?.id)
      .map((agent: any) => ({
        id: String(agent.id),
        label: String(agent.identityName || agent.id).replace(/^./, (c) => c.toUpperCase()),
        model: String(agent.model || primary),
        workspaceDir: String(agent.workspace || apiWorkspaceFallback(config)),
        agentDir: String(agent.agentDir || ""),
        models,
      }))
      .filter((agent: AgentInfo) => agent.agentDir && agent.workspaceDir);
  } catch (err: any) {
    log?.warn?.(`octopus: failed to list agents: ${err?.message ?? String(err)}`);
    const agentDir = path.join(process.env.HOME || ".", ".openclaw", "agents", "main", "agent");
    return [{
      id: "main",
      label: "Basile",
      model: primary,
      workspaceDir: apiWorkspaceFallback(config),
      agentDir,
      models,
    }];
  }
}

function apiWorkspaceFallback(config: any): string {
  return String(config?.workspaceDir || path.join(process.env.HOME || ".", ".openclaw", "workspace"));
}

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

function splitModelId(id: string): { provider?: string; model?: string; id: string } {
  const slash = id.indexOf("/");
  if (slash > 0) return { provider: id.slice(0, slash), model: id.slice(slash + 1), id };
  return { model: id, id };
}

function normalizeDeliveryPreference(value: unknown): DeliveryPreference | undefined {
  if (value === "steer" || value === "queue_after_turn") return value;
  if (value === "queue" || value === "followup") return "queue_after_turn";
  return undefined;
}

function deliveryQueueDirective(preference: DeliveryPreference | undefined): string | undefined {
  if (preference === "steer") return "/queue steer";
  if (preference === "queue_after_turn") return "/queue followup";
  return undefined;
}

function commandBodyWithDirectives(
  content: string,
  modelId: string | undefined,
  preference: DeliveryPreference | undefined,
): string {
  const directive = deliveryQueueDirective(preference);
  return [
    modelId ? `/model ${modelId}` : undefined,
    directive,
    content,
  ].filter(Boolean).join("\n");
}

function safeSessionToken(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function buildOctopusSessionKey(agentId: string, clientSession: string): string {
  return [
    "agent",
    safeSessionToken(agentId, "main"),
    "octopus",
    "desktop",
    "direct",
    safeSessionToken(clientSession, "unknown"),
  ].join(":");
}

function queueOutcomeStatus(
  outcome: any,
  preference: DeliveryPreference | undefined,
): "steered" | "queued_after_turn" | "accepted_by_pipeline" | undefined {
  const rawStatus = String(outcome?.status ?? outcome?.disposition ?? "").toLowerCase();
  if (rawStatus === "steered" || rawStatus === "steer") return "steered";
  if (rawStatus === "queued_after_turn" || rawStatus === "followup") return "queued_after_turn";
  if (rawStatus === "accepted_by_pipeline") return "accepted_by_pipeline";

  const rawMode = String(
    outcome?.mode ?? outcome?.queueMode ?? outcome?.deliveryMode ?? outcome?.kind ?? "",
  ).toLowerCase();
  const rawReason = String(outcome?.reason ?? outcome?.code ?? "").toLowerCase();
  const queued = outcome?.queued !== false && outcome?.accepted !== false && outcome?.ok !== false;
  if (!queued) return undefined;

  if (rawMode.includes("followup") || rawReason.includes("followup")) return "queued_after_turn";
  if (rawMode.includes("steer") || rawMode === "queue" || rawReason.includes("steer")) {
    return "steered";
  }
  if (preference === "queue_after_turn") return "queued_after_turn";
  if (preference === "steer") return "steered";
  return undefined;
}

function canvasPath(pathname: string): string {
  const path = pathname || "/__openclaw__/canvas/";
  if (path.startsWith("/__openclaw__/canvas/") || path.startsWith("/__openclaw__/a2ui/")) return path;
  return "/__openclaw__/canvas/";
}

function gatewayAuthHeaders(config: any): Record<string, string> {
  const token = config?.gateway?.auth?.token;
  if (typeof token === "string" && token) return { Authorization: `Bearer ${token}` };
  const password = config?.gateway?.auth?.password;
  if (typeof password === "string" && password) return { "x-openclaw-password": password };
  return {};
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
    let models = listModels(api.logger);
    let octopusAgents = listAgents(api.config, models, api.logger);
    api.logger.info("octopus: starting");

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let connecting = false;
    let intentionalClose = false;
    let processing = false;
    let currentMsgId: string | null = null;
    let currentAgentId: string | null = null;
    let currentSession: string | null = null;
    let currentRunId: string | null = null;
    let currentStreamText = "";
    let sawAgentToolEvent = false;

    function send(msg: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function sendAssistantChunk(agentId: string | null, sessionId: string | null, msgId: string | null, data: any) {
      const fullText = typeof data?.text === "string" ? data.text : "";
      const delta = typeof data?.delta === "string" ? data.delta : "";
      const replace = Boolean(data?.replace);
      if (!fullText && !delta) return;

      if (replace && fullText) {
        currentStreamText = fullText;
        send({ type: "chunk", id: msgId, agent: agentId, session: sessionId, content: fullText, replace: true });
        return;
      }

      if (delta) {
        currentStreamText += delta;
        send({ type: "chunk", id: msgId, agent: agentId, session: sessionId, content: delta });
        return;
      }

      if (fullText === currentStreamText) return;
      const append = fullText.startsWith(currentStreamText);
      const content = append ? fullText.slice(currentStreamText.length) : fullText;
      currentStreamText = fullText;
      send({ type: "chunk", id: msgId, agent: agentId, session: sessionId, content, replace: !append });
    }

    function compactJson(value: unknown, max = 180): string | undefined {
      if (value == null) return undefined;
      try {
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
      } catch {
        const raw = String(value);
        return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
      }
    }

    function sendToolProgress(agentId: string | null, sessionId: string | null, msgId: string | null, data: any) {
      const toolName = String(data?.name || data?.toolName || "tool");
      const phase = String(data?.phase || "update");
      const status = phase === "result" || phase === "end"
        ? (data?.isError || data?.status === "failed" ? "error" : "completed")
        : "running";
      const args = data?.args ?? data?.meta?.args ?? data?.meta?.params ?? data?.params;
      const summary = phase === "start"
        ? compactJson(args) ?? "starting"
        : phase === "update"
          ? compactJson(data?.partialResult ?? data?.output ?? data?.progressText, 140) ?? "running"
          : data?.isError
            ? compactJson(data?.error ?? data?.result, 160) ?? "error"
            : "done";
      sawAgentToolEvent = true;
      send({
        type: "tool_progress",
        id: msgId,
        agent: agentId,
        session: sessionId,
        tool: toolName,
        status,
        summary,
      });
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
        models = listModels(api.logger);
        octopusAgents = listAgents(api.config, models, api.logger);
        newWs.send(JSON.stringify({
          type: "auth", role: "agent", token: authToken,
          agents: octopusAgents.map(({ id, label, model, models }) => ({
          id,
          label,
          model,
          models,
          thinking: api.config?.agents?.defaults?.thinking ?? api.config?.agents?.defaults?.reasoning ?? "off",
        })),
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

        if (msg.type === "canvas_http_request") {
          try {
            const url = new URL(canvasPath(String(msg.path || "")), "http://127.0.0.1:18789");
            const resp = await fetch(url, {
              method: String(msg.method || "GET"),
              headers: gatewayAuthHeaders(api.config),
            });
            const body = Buffer.from(await resp.arrayBuffer()).toString("base64");
            send({
              type: "canvas_http_response",
              id: msg.id,
              agent: msg.agent,
              statusCode: resp.status,
              headers: {
                "content-type": resp.headers.get("content-type") || "application/octet-stream",
                "cache-control": resp.headers.get("cache-control") || "no-store",
              },
              bodyBase64: body,
            });
          } catch (e: any) {
            send({
              type: "canvas_http_response",
              id: msg.id,
              agent: msg.agent,
              statusCode: 502,
              headers: { "content-type": "text/plain" },
              bodyBase64: Buffer.from(e?.message || String(e)).toString("base64"),
            });
          }
          return;
        }

        if (msg.type !== "send_message") return;

        processing = true;
        try {
          const msgId = msg.id || randomUUID();
          const agentId = msg.agent || "main";
          const agent = octopusAgents.find((a) => a.id === agentId) ?? octopusAgents[0];
          if (!agent) throw new Error(`agent '${agentId}' is not configured`);
          const selectedModel = splitModelId(String(msg.model || agent.model));
          const content = String(msg.content || "");
          const clientSession = String(msg.session || randomUUID());
          const deliveryPreference = normalizeDeliveryPreference(msg.deliveryPreference);
          const sessionKey = buildOctopusSessionKey(agentId, clientSession);
          const runId = randomUUID();
          currentMsgId = msgId;
          currentAgentId = agentId;
          currentSession = clientSession;
          currentRunId = null;
          currentStreamText = "";
          sawAgentToolEvent = false;

          send({
            type: "message_delivery",
            id: msgId,
            agent: agentId,
            session: clientSession,
            status: "accepted",
            code: deliveryPreference ?? "configured",
          });
          send({
            type: "agent_status",
            id: msgId,
            agent: agentId,
            session: clientSession,
            status: "thinking",
            model: selectedModel.id,
          });

          let actualModel = selectedModel.id;
          let runStarted = false;
          let replyDelivered = false;
          let queueOutcomeReported = false;
          let streamText = "";
          const sendLocalAssistantChunk = (data: any) => {
            const fullText = typeof data?.text === "string" ? data.text : "";
            const delta = typeof data?.delta === "string" ? data.delta : "";
            const replace = Boolean(data?.replace);
            if (!fullText && !delta) return;

            if (replace && fullText) {
              streamText = fullText;
              if (currentMsgId === msgId) currentStreamText = streamText;
              send({ type: "chunk", id: msgId, agent: agentId, session: clientSession, content: fullText, replace: true });
              return;
            }

            if (delta) {
              streamText += delta;
              if (currentMsgId === msgId) currentStreamText = streamText;
              send({ type: "chunk", id: msgId, agent: agentId, session: clientSession, content: delta });
              return;
            }

            if (fullText === streamText) return;
            const append = fullText.startsWith(streamText);
            const chunk = append ? fullText.slice(streamText.length) : fullText;
            streamText = fullText;
            if (currentMsgId === msgId) currentStreamText = streamText;
            send({ type: "chunk", id: msgId, agent: agentId, session: clientSession, content: chunk, replace: !append });
          };
          const ctxPayload = finalizeInboundContext({
            Body: content,
            BodyForAgent: content,
            RawBody: content,
            CommandBody: commandBodyWithDirectives(content, selectedModel.id, deliveryPreference),
            From: `octopus:${clientSession}`,
            To: `octopus:${agentId}`,
            SessionKey: sessionKey,
            AccountId: "desktop",
            ChatType: "direct",
            ConversationLabel: "Octopus Desktop",
            NativeChannelId: clientSession,
            MessageThreadId: clientSession,
            SenderName: "Octopus Desktop",
            SenderId: "octopus-desktop",
            Provider: "octopus",
            Surface: "octopus",
            MessageSid: msgId,
            MessageSidFull: msgId,
            Timestamp: Date.now(),
            OriginatingChannel: "octopus",
            OriginatingTo: `octopus:${agentId}`,
            CommandAuthorized: true,
          });

          const result = await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: api.config as any,
            dispatcherOptions: {
              deliver: async (payload: any, info: any) => {
                const text = typeof payload?.text === "string" ? payload.text : "";
                if (!text.trim()) return;
                replyDelivered = true;
                if (info?.kind === "tool") {
                  sendToolProgress(agentId, clientSession, msgId, {
                    name: "tool",
                    phase: "result",
                    result: text,
                  });
                  return;
                }
                sendLocalAssistantChunk({ text, replace: true });
              },
              onReplyStart: () => {
                send({
                  type: "agent_status",
                  id: msgId,
                  agent: agentId,
                  session: clientSession,
                  status: "streaming",
                  model: actualModel,
                });
              },
              onError: (err: unknown) => {
                api.logger.warn(`octopus: reply delivery failed: ${err instanceof Error ? err.message : String(err)}`);
              },
            },
            replyOptions: {
              runId,
              onAgentRunStart: (startedRunId: string) => {
                runStarted = true;
                currentRunId = startedRunId;
                send({
                  type: "message_delivery",
                  id: msgId,
                  agent: agentId,
                  session: clientSession,
                  status: "started_turn",
                  code: deliveryPreference ?? "configured",
                });
              },
              onAssistantMessageStart: () => {
                send({
                  type: "agent_status",
                  id: msgId,
                  agent: agentId,
                  session: clientSession,
                  status: "streaming",
                  model: actualModel,
                });
              },
              onPartialReply: (payload: any) => {
                sendLocalAssistantChunk(payload);
              },
              onModelSelected: (ctx: any) => {
                if (ctx?.provider && ctx?.model) actualModel = `${ctx.provider}/${ctx.model}`;
                else if (ctx?.model) actualModel = String(ctx.model);
                send({
                  type: "agent_status",
                  id: msgId,
                  agent: agentId,
                  session: clientSession,
                  status: "thinking",
                  model: actualModel,
                });
              },
              onToolStart: (payload: any) => sendToolProgress(agentId, clientSession, msgId, payload),
              onItemEvent: (payload: any) => sendToolProgress(agentId, clientSession, msgId, payload),
              onCommandOutput: (payload: any) => sendToolProgress(agentId, clientSession, msgId, payload),
              onPatchSummary: (payload: any) => sendToolProgress(agentId, clientSession, msgId, payload),
              onQueueOutcome: (outcome: any) => {
                const status = queueOutcomeStatus(outcome, deliveryPreference);
                if (!status) return;
                queueOutcomeReported = true;
                send({
                  type: "message_delivery",
                  id: msgId,
                  agent: agentId,
                  session: clientSession,
                  status,
                  deliveryMode: status === "steered" ? "steer" : "turn",
                  code: outcome?.reason ?? outcome?.code ?? deliveryPreference ?? "configured",
                });
              },
            } as any,
          });

          if (!runStarted && !replyDelivered && !queueOutcomeReported) {
            const status = result?.queuedFinal
              ? "queued_after_turn"
              : deliveryPreference === "steer"
                ? "steered_or_queued"
                : "accepted_by_pipeline";
            send({
              type: "message_delivery",
              id: msgId,
              agent: agentId,
              session: clientSession,
              status,
              code: deliveryPreference ?? "configured",
            });
          }

          if (runStarted || replyDelivered) {
            send({
              type: "done",
              id: msgId,
              agent: agentId,
              session: clientSession,
              content: streamText,
              model: actualModel,
            });
          }
        } catch (e: any) {
          api.logger.error(`octopus: ${e.message}`);
          send({ type: "error", id: currentMsgId, agent: currentAgentId, session: currentSession, code: "agent_error", message: e.message });
        } finally {
          processing = false;
          currentMsgId = null;
          currentAgentId = null;
          currentSession = null;
          currentRunId = null;
          currentStreamText = "";
          sawAgentToolEvent = false;
          if (ws?.readyState !== WebSocket.OPEN) scheduleReconnect();
        }
      });
    }

    connect();

    api.on("llm_output", async (event) => {
      if (!processing) return;
      if (!currentRunId || event.runId !== currentRunId) return;
      try {
        const fullText = Array.isArray((event as any).assistantTexts)
          ? (event as any).assistantTexts.filter(Boolean).join("\n\n")
          : "";
        if (!fullText || fullText === currentStreamText) return;
        const content = fullText.startsWith(currentStreamText)
          ? fullText.slice(currentStreamText.length)
          : fullText;
        currentStreamText = fullText;
        send({ type: "chunk", id: currentMsgId, agent: currentAgentId, session: currentSession, content });
      } catch {}
    });

    api.on("before_tool_call", async (event) => {
      if (!processing) return;
      if (!currentRunId || event.runId !== currentRunId) return;
      if (sawAgentToolEvent) return;
      try {
        if (!event.error && String(event.toolName || "").startsWith("canvas")) {
          send({
            type: "canvas_open",
            agent: currentAgentId,
            session: currentSession,
            title: "Canvas",
            url: currentAgentId ? `/canvas/${currentAgentId}/` : "/canvas/main/",
          });
        }
        send({
          type: "tool_progress",
          id: currentMsgId,
          agent: currentAgentId,
          session: currentSession,
          tool: event.toolName,
          status: "running",
          summary: event.toolCallId,
        });
      } catch {}
    });

    api.on("after_tool_call", async (event) => {
      if (!processing) return;
      if (!currentRunId || event.runId !== currentRunId) return;
      if (sawAgentToolEvent) return;
      try {
        send({
          type: "tool_progress",
          id: currentMsgId,
          agent: currentAgentId,
          session: currentSession,
          tool: event.toolName,
          status: event.error ? "error" : "completed",
          summary: event.error || (typeof event.durationMs === "number" ? `${event.durationMs}ms` : event.toolCallId),
        });
      } catch {}
    });

    api.on("gateway_stop", () => {
      shuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { intentionalClose = true; ws.close(1001); }
    });
  },
});
