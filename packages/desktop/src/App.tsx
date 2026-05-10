import { useState, useCallback, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import ThreadBar from "./components/ThreadBar";
import ChatPane from "./components/ChatPane";
import { useHub } from "./hooks/useHub";
import { useConfig } from "./hooks/useConfig";
import { usePersistence } from "./hooks/usePersistence";
import type { Thread, Message, ToolCall } from "./lib/types";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const SEND_DEBOUNCE_MS = 1500;

export default function App() {
  const { config } = useConfig();
  const { connected, agents, agentStatuses, sendMessage, onMessage } = useHub(
    config?.hub ?? { url: "wss://octopus.chrm.fr", token: "" },
  );

  // Active agent
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  // Threads per agent: agentId → Thread[]
  const [threads, setThreads] = useState<Record<string, Thread[]>>({});

  // Load/save threads via persistence hook
  const { loadThreads } = usePersistence(threads, setThreads);
  const [loaded, setLoaded] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);

  // Streaming state
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [contextPct, setContextPct] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);

  // Refs for stable streaming
  const curMsgId = useRef<string | null>(null);
  const streamBufRef = useRef("");
  const curAgentRef = useRef<string | null>(null);
  const curThreadRef = useRef<string | null>(null);

  // Send debounce refs
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextRef = useRef<string | null>(null);
  const inputVersionRef = useRef(0);
  const sendVersionRef = useRef(0);

  // Load persisted threads on mount
  useEffect(() => {
    if (!loaded && agents.length > 0) {
      const saved = loadThreads();
      if (saved) setThreads(saved);
      setLoaded(true);
    }
  }, [loaded, agents, loadThreads]);

  // Default to first agent
  if (!activeAgent && agents.length > 0) {
    setActiveAgent(agents[0].id);
  }

  const agentLabel =
    config?.agents.find((a) => a.id === activeAgent)?.label ??
    agents.find((a) => a.id === activeAgent)?.label ??
    "";

  const agentModel =
    config?.agents.find((a) => a.id === activeAgent)?.model ?? model;

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

  // ── Actually send the message ────────────────────────────────────
  const doSend = useCallback(
    (content: string) => {
      if (!activeAgent) return;

      const agentId = activeAgent;
      let thread = currentThread;

      if (!thread) thread = createThread(agentId);

      const msgId = crypto.randomUUID();
      curMsgId.current = msgId;
      curAgentRef.current = agentId;
      curThreadRef.current = thread.id;

      const userMsg: Message = {
        id: `user-${msgId}`,
        role: "user",
        content,
        timestamp: Date.now(),
      };

      setThreads((prev) => ({
        ...prev,
        [agentId]: prev[agentId].map((t) =>
          t.id === thread!.id
            ? { ...t, messages: [...t.messages, userMsg], title: content.slice(0, 40) }
            : t,
        ),
      }));

      setStreamingContent(null);
      setToolCalls([]);
      streamBufRef.current = "";

      sendMessage({
        type: "send_message",
        id: msgId,
        agent: agentId,
        session: thread.id,
        content,
        model: agentModel,
      });
    },
    [activeAgent, currentThread, createThread, sendMessage, agentModel],
  );

  // ── Debounced send ──────────────────────────────────────────────
  const queueSend = useCallback((text: string) => {
    const version = ++sendVersionRef.current;
    pendingTextRef.current = text;

    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);

    sendTimerRef.current = setTimeout(() => {
      if (sendVersionRef.current === version) {
        doSend(text);
        pendingTextRef.current = null;
        sendTimerRef.current = null;
      }
    }, SEND_DEBOUNCE_MS);
  }, [doSend]);

  // If the user keeps typing after pressing Enter, cancel the pending send
  const notifyInputChange = useCallback(() => {
    const v = ++inputVersionRef.current;
    if (sendTimerRef.current && pendingTextRef.current) {
      // Only cancel if the user actually typed more (not just cursor move)
      // This is signaled by ChatPane calling this on input changes
      if (v > sendVersionRef.current + 1) {
        clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
        pendingTextRef.current = null;
      }
    }
  }, []);

  const handleSend = useCallback(
    (content: string, immediate = false) => {
      if (immediate) {
        if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
        pendingTextRef.current = null;
        doSend(content);
      } else {
        queueSend(content);
      }
    },
    [doSend, queueSend],
  );

  // ── Cancel ──────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    if (curMsgId.current && activeAgent) {
      sendMessage({
        type: "cancel",
        id: curMsgId.current,
        agent: activeAgent,
        session: activeThread ?? undefined,
      });
    }
    setStreamingContent(null);
    setToolCalls([]);
    streamBufRef.current = "";
  }, [activeAgent, activeThread, sendMessage]);

  // ── Select agent ─────────────────────────────────────────────────
  const handleSelectAgent = useCallback((id: string) => {
    setActiveAgent(id);
    setActiveThread(null);
    setStreamingContent(null);
    setToolCalls([]);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = agents.findIndex((a) => a.id === activeAgent);
        if (idx > 0) setActiveAgent(agents[idx - 1].id);
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = agents.findIndex((a) => a.id === activeAgent);
        if (idx < agents.length - 1) setActiveAgent(agents[idx + 1].id);
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const list = threads[activeAgent ?? ""] ?? [];
        if (list.length === 0) return;
        const idx = list.findIndex((t) => t.id === activeThread);
        if (idx > 0) setActiveThread(list[idx - 1].id);
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const list = threads[activeAgent ?? ""] ?? [];
        if (list.length === 0) return;
        const idx = list.findIndex((t) => t.id === activeThread);
        if (idx < list.length - 1) setActiveThread(list[idx + 1].id);
      }

      if (e.key === "n") {
        e.preventDefault();
        if (activeAgent) createThread(activeAgent);
      }
    },
    [agents, activeAgent, activeThread, threads, createThread],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ── Streaming responses ─────────────────────────────────────────
  const handleStreamMsg = useCallback((msg: any) => {
    switch (msg.type) {
      case "chunk":
        streamBufRef.current += msg.content ?? "";
        setStreamingContent(streamBufRef.current);
        break;
      case "done":
        if (msg.id && curMsgId.current === msg.id) {
          const agentId = msg.agent ?? curAgentRef.current;
          const threadId = curThreadRef.current;
          const finalContent = streamBufRef.current || msg.content || "";

          streamBufRef.current = "";
          setStreamingContent(null);
          setToolCalls([]);
          setContextPct(msg.usage?.context_pct ?? 0);

          if (agentId && threadId) {
            const assMsg: Message = {
              id: `assist-${msg.id}`,
              role: "assistant",
              content: finalContent,
              usage: msg.usage,
              model: msg.model,
              timestamp: Date.now(),
            };
            setThreads((prev) => ({
              ...prev,
              [agentId]: (prev[agentId] ?? []).map((t) =>
                t.id === threadId
                  ? { ...t, messages: [...t.messages, assMsg] }
                  : t,
              ),
            }));
          }
        }
        break;
      case "tool_progress":
        setToolCalls((prev) => {
          const filtered = prev.filter(
            (t) => !(t.tool === msg.tool && t.status === "running"),
          );
          return [
            ...filtered,
            { tool: msg.tool, status: msg.status ?? "running", summary: msg.summary },
          ];
        });
        break;
    }
  }, []);

  useEffect(() => {
    const unsub = onMessage(handleStreamMsg);
    return unsub;
  }, [handleStreamMsg, onMessage]);

  // ── Split view ──────────────────────────────────────────────────
  const [splitCount] = useState(1);

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        agentStatuses={agentStatuses}
        activeAgent={activeAgent}
        onSelectAgent={handleSelectAgent}
        agentLabels={Object.fromEntries(
          (config?.agents ?? []).map((a) => [a.id, a.label]),
        )}
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
              onInputChange={notifyInputChange}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
