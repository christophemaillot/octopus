/**
 * Octopus Plugin — Bridge between Octopus desktop client and OpenClaw agents
 *
 * Architecture:
 *   Desktop Tauri  —WS—>  Hub Rust  —HTTP SSE—>  Plugin  —agent—>  OpenClaw
 *
 * The plugin exposes a WebSocket endpoint that the hub connects to.
 * Messages flow:
 *   hub → plugin → subagent run → hooks (llm_output, before_tool_call) → hub
 *
 * Events sent to the hub follow the protocol in SPEC.md.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Types ────────────────────────────────────────────────────────────────────

interface WsMessage {
  type: string;
  id?: string;
  agent?: string;
  session?: string;
  content?: string;
  model?: string;
  limit?: number;
  sessions?: string[];
}

interface StreamEvent {
  type: "chunk" | "done" | "tool_progress" | "error";
  id?: string;
  agent?: string;
  session?: string;
  content?: string;
  tool?: string;
  status?: string;
  summary?: string;
  index?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    context_pct: number;
  };
  model?: string;
  code?: string;
  message?: string;
}

// ── Runtime store ────────────────────────────────────────────────────────────

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octopus",
  errorMessage: "octopus plugin runtime not initialized",
});

// ── Active streams ───────────────────────────────────────────────────────────
// runId → { hub connection, stream events accumulator }

const activeRuns = new Map<string, { ws: WebSocket; events: StreamEvent[] }>();

// ── Plugin entry ─────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "octopus",
  name: "Octopus",
  description: "Bridge between Octopus desktop client and OpenClaw agents",
  register(api) {
    const cfg = api.pluginConfig as { port?: number; authToken?: string };
    const wsPort = cfg.port ?? 3701;

    // ── Set up WebSocket server ──────────────────────────────────────────
    // We attach the WSS to the Gateway's HTTP server via registerHttpRoute
    // For now, start a standalone WS server on a separate port.
    // (registerHttpRoute doesn't natively support WS upgrade, so we use a
    //  separate port. In a future version, we can integrate with the Gateway.)

    const wss = new WebSocketServer({ port: wsPort });
    api.logger.info(`octopus: WebSocket server listening on :${wsPort}`);

    // Track authenticated connections
    const connections = new Set<WebSocket>();

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      api.logger.info(`octopus: new connection from ${req.socket.remoteAddress}`);

      // The hub must send auth within 5 seconds
      let authenticated = false;
      const authTimer = setTimeout(() => {
        if (!authenticated) {
          ws.close(4001, "auth timeout");
        }
      }, 5000);

      ws.on("message", (raw: Buffer) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          sendError(ws, "invalid_json", "Invalid JSON");
          return;
        }

        // ── Auth ──────────────────────────────────────────────────────
        if (msg.type === "auth") {
          if (cfg.authToken && msg.content !== cfg.authToken) {
            ws.close(4001, "invalid token");
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          ws.send(JSON.stringify({
            type: "auth_ok",
            user: "octopus",
            agents: [], // will be populated from runtime
          }));
          connections.add(ws);
          return;
        }

        if (!authenticated) {
          sendError(ws, "auth_required", "Authenticate first");
          return;
        }

        // ── List agents ───────────────────────────────────────────────
        if (msg.type === "list_agents") {
          ws.send(JSON.stringify({
            type: "agent_list",
            agents: [
              { id: "main", label: "Basile", model: api.runtime.agent.defaults.model, status: "idle" },
              { id: "kip", label: "Kip", model: api.runtime.agent.defaults.model, status: "idle" },
            ],
          }));
          return;
        }

        // ── Send message ──────────────────────────────────────────────
        if (msg.type === "send_message") {
          const msgId = msg.id ?? randomUUID();
          const sessionKey = msg.session
            ? `octopus:${msg.agent ?? "main"}:${msg.session}`
            : `octopus:${msg.agent ?? "main"}:${randomUUID()}`;
          const runId = randomUUID();

          activeRuns.set(runId, { ws, events: [] });

          // Notify hub that processing started
          ws.send(JSON.stringify({
            type: "agent_status",
            agent: msg.agent ?? "main",
            session: msg.session,
            status: "thinking",
          }));

          // Launch subagent (fire-and-forget with promise tracking)
          api.runtime.subagent
            .run({
              sessionKey,
              message: msg.content ?? "",
              model: msg.model,
              deliver: false,
            })
            .then(async ({ runId: subRunId }) => {
              const result = await api.runtime.subagent.waitForRun({
                runId: subRunId,
                timeoutMs: 120_000,
              });

              // Read final messages
              const { messages } = await api.runtime.subagent.getSessionMessages({
                sessionKey,
                limit: 10,
              });

              const lastMsg = messages?.findLast((m: any) => m.role === "assistant");
              const fullContent = lastMsg?.content ?? result?.output ?? "";

              // Send final done event
              ws.send(JSON.stringify({
                type: "done",
                id: msgId,
                agent: msg.agent ?? "main",
                session: msg.session,
                content: fullContent,
              }));

              activeRuns.delete(runId);
            })
            .catch((err: Error) => {
              ws.send(JSON.stringify({
                type: "error",
                id: msgId,
                agent: msg.agent ?? "main",
                session: msg.session,
                code: "agent_error",
                message: err.message,
              }));
              activeRuns.delete(runId);
            });

          return;
        }

        // ── Cancel ────────────────────────────────────────────────────
        if (msg.type === "cancel") {
          // Subagent cancellation isn't directly supported in the SDK yet.
          // For v0.1, we acknowledge the cancel.
          ws.send(JSON.stringify({
            type: "done",
            id: msg.id,
            agent: msg.agent,
            session: msg.session,
            content: "[cancelled]",
          }));
          return;
        }

        // ── Get history ───────────────────────────────────────────────
        if (msg.type === "get_history") {
          const sessionKey = `octopus:${msg.agent ?? "main"}:${msg.session}`;
          api.runtime.subagent
            .getSessionMessages({ sessionKey, limit: msg.limit ?? 50 })
            .then(({ messages }) => {
              ws.send(JSON.stringify({
                type: "history",
                session: msg.session,
                messages: messages ?? [],
              }));
            })
            .catch((err: Error) => {
              ws.send(JSON.stringify({
                type: "error",
                code: "session_not_found",
                message: err.message,
              }));
            });
          return;
        }

        sendError(ws, "unknown_type", `Unknown message type: ${msg.type}`);
      });

      ws.on("close", () => {
        connections.delete(ws);
        api.logger.info("octopus: connection closed");
      });

      ws.on("error", (err: Error) => {
        api.logger.error(`octopus: websocket error: ${err.message}`);
        connections.delete(ws);
      });
    });

    wss.on("error", (err: Error) => {
      api.logger.error(`octopus: wss error: ${err.message}`);
    });

    // ── Register hooks for streaming interception ─────────────────────
    // These hooks capture subagent events and forward them to the hub
    // connection associated with the run.

    api.on("llm_output", async (event) => {
      const runId = event.ctx.runId;
      if (!runId) return;

      // Check if any active run matches this subagent run
      for (const [activeRunId, state] of activeRuns) {
        const output = event.output as { text?: string } | undefined;
        if (output?.text) {
          try {
            state.ws.send(JSON.stringify({
              type: "chunk",
              content: output.text,
            }));
          } catch {
            // connection probably closed
          }
        }
      }
    });

    api.on("before_tool_call", async (event) => {
      const runId = event.runId;
      if (!runId) return;

      for (const [, state] of activeRuns) {
        try {
          state.ws.send(JSON.stringify({
            type: "tool_progress",
            tool: event.toolName,
            status: "running",
            params: event.params,
          }));
        } catch {
          // connection probably closed
        }
      }
    });

    api.on("after_tool_call", async (event) => {
      for (const [, state] of activeRuns) {
        try {
          state.ws.send(JSON.stringify({
            type: "tool_progress",
            tool: event.toolName,
            status: "completed",
          }));
        } catch {
          // connection probably closed
        }
      }
    });

    // ── Register HTTP route for health check ──────────────────────────
    api.registerHttpRoute({
      path: "/octopus/health",
      auth: "plugin",
      match: "exact",
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          status: "ok",
          connections: connections.size,
          active_runs: activeRuns.size,
        }));
        return true;
      },
    });

    // ── Gateway lifecycle ─────────────────────────────────────────────
    api.on("gateway_stop", async () => {
      wss.close();
      for (const ws of connections) {
        ws.close(1001, "gateway shutting down");
      }
      connections.clear();
      activeRuns.clear();
    });
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendError(ws: WebSocket, code: string, message: string) {
  ws.send(JSON.stringify({ type: "error", code, message }));
}
