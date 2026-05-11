import { useState, useRef, useCallback, useEffect } from "react";
import type { HubMessage, AgentInfo, AgentStatus } from "../lib/types";
import type { HubConfig } from "../lib/config";

export interface HubState {
  connected: boolean;
  agents: AgentInfo[];
  agentStatuses: Record<string, AgentStatus>;
  sendMessage: (msg: HubMessage) => void;
  onMessage: (handler: (msg: HubMessage) => void) => void;
  lastError: string | null;
}

export function useHub(hubCfg: HubConfig | null): HubState {
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({});
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(msg: HubMessage) => void>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (!hubCfg) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = hubCfg.url || "wss://octopus.chrm.fr";
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setLastError(null);
      // Auth as client with token from config
      ws.send(JSON.stringify({
        type: "auth",
        role: "client",
        token: hubCfg.token || "",
      }));
      // Request agent list
      ws.send(JSON.stringify({ type: "list_agents" }));
    };

    ws.onmessage = (event) => {
      try {
        const msg: HubMessage = JSON.parse(event.data);
        handleMessage(msg);
        handlersRef.current.forEach((h) => h(msg));
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setConnected(false);
      setAgents([]);
      setAgentStatuses({});
      wsRef.current = null;
      if (mountedRef.current) {
        reconnectTimerRef.current = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setLastError("Connection error");
    };
  }, [hubCfg]);

  const handleMessage = useCallback((msg: HubMessage) => {
    switch (msg.type) {
      case "auth_ok":
        console.log(`Authenticated as ${msg.kind ?? "client"}`);
        setConnected(true);
        break;
      case "agent_list":
        if (msg.agents) {
          setAgents(msg.agents);
          setAgentStatuses((prev) => {
            const next: Record<string, AgentStatus> = {};
            msg.agents!.forEach((a) => (next[a.id] = prev[a.id] ?? "idle"));
            return next;
          });
        }
        break;
      case "agent_status":
        if (msg.agent && msg.status) {
          setAgentStatuses((prev) => ({
            ...prev,
            [msg.agent!]: msg.status as AgentStatus,
          }));
        }
        break;
      case "done":
        if (msg.agent) {
          setAgentStatuses((prev) => ({ ...prev, [msg.agent!]: "idle" }));
        }
        break;
      case "error":
        setLastError(msg.message ?? "Unknown error");
        if (msg.agent) {
          setAgentStatuses((prev) => ({ ...prev, [msg.agent!]: "error" }));
        }
        break;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((msg: HubMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const onMessage = useCallback((handler: (msg: HubMessage) => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  return { connected, agents, agentStatuses, sendMessage, onMessage, lastError };
}
