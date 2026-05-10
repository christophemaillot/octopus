// ── Protocol types (matches SPEC.md v0.2) ─────────────────────────────

export interface AgentInfo {
  id: string;
  label: string;
  model: string;
}

export interface HubMessage {
  type: string;
  id?: string;
  agent?: string;
  session?: string;
  content?: string;
  model?: string;
  status?: string;
  tool?: string;
  summary?: string;
  index?: number;
  usage?: { input_tokens: number; output_tokens: number; context_pct: number };
  agents?: AgentInfo[];
  code?: string;
  message?: string;
  peer_id?: string;
  kind?: string;
  role?: string;
}

export interface Thread {
  id: string;
  agentId: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCall[];
  usage?: { input_tokens: number; output_tokens: number; context_pct: number };
  model?: string;
  timestamp: number;
}

export interface ToolCall {
  tool: string;
  status: "running" | "completed" | "error";
  summary?: string;
}

export interface Pane {
  id: string;
  agentId: string;
  threadId: string | null; // null = new thread
}

export type AgentStatus = "idle" | "thinking" | "streaming" | "error";
