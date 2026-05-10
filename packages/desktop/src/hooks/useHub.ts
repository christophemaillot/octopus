import { useState, useRef, useCallback, useEffect } from "react";
import type { HubMessage, AgentInfo, AgentStatus } from "../lib/types";

const HUB_URL = "wss://octopus.chrm.fr";
const HUB_TOKEN = ""; // Public hub for now — will add auth later

export interface HubState {
  connected: boolean;
  agents: AgentInfo[];
  agentStatuses: Record<string, AgentStatus>;
  sendMessage: (msg: HubMessage) => void;
  lastError: string | null;
}

export function useHub(): HubState {
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({});
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: HubMessage) => void)[]>([]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(HUB_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setLastError(null);
      // Auth as client
      ws.send(JSON.stringify({ type: "auth", role: "client", token: HUB_TOKEN }));
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
      setConnected(false);
      wsRef.current = null;
      setTimeout(connect, 3000); // reconnect
    };

    ws.onerror = () => {
      setLastError("Connection error");
    };
  }, []);

  const handleMessage = useCallback((msg: HubMessage) => {
    switch (msg.type) {
      case "auth_ok":
        console.log("Authenticated as", msg.kind);
        break;
      case "agent_list":
        if (msg.agents) {
          setAgents(msg.agents);
          const statuses: Record<string, AgentStatus> = {};
          msg.agents.forEach((a) => (statuses[a.id] = "idle"));
          setAgentStatuses(statuses);
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
        break;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((msg: HubMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { connected, agents, agentStatuses, sendMessage, lastError };
}
