// ── Protocol types (matches SPEC.md v0.2) ─────────────────────────────

export interface AgentInfo {
  id: string;
  label: string;
  model: string;
  models?: ModelInfo[];
  thinking?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  available?: boolean;
}

export interface HubMessage {
  type: string;
  id?: string;
  agent?: string;
  session?: string;
  content?: string;
  model?: string;
  deliveryMode?: "turn" | "steer";
  status?: string;
  tool?: string;
  summary?: string;
  index?: number;
  seq?: number;
  since?: number;
  ackSeq?: number;
  sessions?: ReplaySession[];
  usage?: UsageInfo;
  agents?: AgentInfo[];
  code?: string;
  message?: string;
  peer_id?: string;
  kind?: string;
  role?: string;
  agentIds?: string[];
  title?: string;
  url?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  replace?: boolean;
}

export interface ReplaySession {
  agent: string;
  session: string;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  context_pct: number;
  prompt_tokens?: number;
  context_tokens?: number;
}

export interface Thread {
  id: string;
  agentId: string;
  title: string;
  titleLocked?: boolean;
  contextPct?: number;
  contextUsage?: UsageInfo;
  model?: string;
  messages: Message[];
  createdAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "pending" | "sent";
  deliveryMode?: "turn" | "steer";
  toolCalls?: ToolCall[];
  usage?: UsageInfo;
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
export type RunState = "idle" | "queued" | "thinking" | "streaming" | "tool" | "error";
export type SendMode = "queue" | "instant";
