import { useState, useCallback, useRef } from "react";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import ThreadBar from "./components/ThreadBar";
import ChatPane from "./components/ChatPane";
import { useHub } from "./hooks/useHub";
import type { Thread, Message, ToolCall } from "./lib/types";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export default function App() {
  const { connected, agents, agentStatuses, sendMessage } = useHub();

  // Active agent
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  // Threads per agent: agentId → Thread[]
  const [threads, setThreads] = useState<Record<string, Thread[]>>({});
  const [activeThread, setActiveThread] = useState<string | null>(null);

  // Streaming state
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [contextPct, setContextPct] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);

  // Track the current message ID being streamed
  const curMsgId = useRef<string | null>(null);

  // Default to first agent
  if (!activeAgent && agents.length > 0) {
    setActiveAgent(agents[0].id);
  }

  const agentLabel = agents.find((a) => a.id === activeAgent)?.label ?? "";

  const currentThreads = threads[activeAgent ?? ""] ?? [];
  const currentThread = currentThreads.find((t) => t.id === activeThread) ?? null;

  // ── Create new thread ─────────────────────────────────────────────
  const createThread = useCallback((agentId: string): Thread => {
    const thread: Thread = {
      id: crypto.randomUUID(),
      agentId,
      title: "Nouveau",
      messages: [],
      createdAt: Date.now(),
    };
    setThreads((prev) => ({
      ...prev,
      [agentId]: [...(prev[agentId] ?? []), thread],
    }));
    setActiveThread(thread.id);
    return thread;
  }, []);

  // ── Send message ──────────────────────────────────────────────────
  const handleSend = useCallback(
    (content: string) => {
      if (!activeAgent) return;

      const agentId = activeAgent;
      let thread = currentThread;

      // Auto-create thread if none active
      if (!thread) {
        thread = createThread(agentId);
      }

      const msgId = crypto.randomUUID();
      curMsgId.current = msgId;

      // Add user message to thread
      const userMsg: Message = {
        id: `user-${msgId}`,
        role: "user",
        content,
        timestamp: Date.now(),
      };

      setThreads((prev) => ({
        ...prev,
        [agentId]: prev[agentId].map((t) =>
          t.id === thread!.id ? { ...t, messages: [...t.messages, userMsg], title: content.slice(0, 40) } : t
        ),
      }));

      // Clear streaming state
      setStreamingContent("");
      setToolCalls([]);

      // Create a placeholder for the assistant response
      const assId = `assist-${msgId}`;

      // We'll attach to the WebSocket message handler for responses.
      // For now, use a one-time listener pattern via sendMessage callback.
      sendMessage({
        type: "send_message",
        id: msgId,
        agent: agentId,
        session: thread.id,
        content,
        model,
      });

      // Poll for response via a one-shot onmessage handler isn't great,
      // but for v0.1 we'll manage it via the hook's ref pattern.
      // The real streaming will come when we implement the plugin's chunk streaming.
    },
    [activeAgent, currentThread, createThread, sendMessage, model]
  );

  // ── Cancel ────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    if (curMsgId.current && activeAgent) {
      sendMessage({ type: "cancel", id: curMsgId.current, agent: activeAgent, session: activeThread ?? undefined });
    }
    setStreamingContent(null);
    setToolCalls([]);
  }, [activeAgent, activeThread, sendMessage]);

  // ── Select agent ───────────────────────────────────────────────────
  const handleSelectAgent = useCallback(
    (id: string) => {
      setActiveAgent(id);
      setActiveThread(null);
      setStreamingContent(null);
      setToolCalls([]);
    },
    []
  );

  // ── Split view: number of panes ────────────────────────────────────
  const [splitCount, setSplitCount] = useState(1);

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        agentStatuses={agentStatuses}
        activeAgent={activeAgent}
        onSelectAgent={handleSelectAgent}
      />

      <div className="main">
        <Toolbar
          connected={connected}
          model={model}
          contextPct={contextPct}
          agentLabel={agentLabel}
          onModelChange={setModel}
        />

        <ThreadBar
          threads={currentThreads}
          activeThread={activeThread}
          onSelect={setActiveThread}
          onNew={() => activeAgent && createThread(activeAgent)}
        />

        <div className="pane-grid">
          {Array.from({ length: splitCount }).map((_, i) => (
            <ChatPane
              key={i}
              thread={currentThread}
              streamingContent={streamingContent}
              toolCalls={toolCalls}
              onSend={handleSend}
              onCancel={handleCancel}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
