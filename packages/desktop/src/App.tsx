import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import ThreadBar from "./components/ThreadBar";
import ChatPane from "./components/ChatPane";
import { useHub } from "./hooks/useHub";
import { useConfig } from "./hooks/useConfig";
import { usePersistence } from "./hooks/usePersistence";
import type { Thread, Message, ToolCall, RunState, SendMode } from "./lib/types";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const SEND_DEBOUNCE_MS = 1500;

interface PendingSend {
  id: string;
  agentId: string;
  threadId: string;
  content: string;
  model: string;
}

interface CanvasPanelState {
  agentId: string;
  title: string;
  url: string;
}

function hubHttpBase(wsUrl: string): string {
  try {
    const url = new URL(wsUrl || "wss://octopus.chrm.fr");
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://octopus.chrm.fr";
  }
}

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
  const [isThinking, setIsThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [replayStateLoaded, setReplayStateLoaded] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [sendMode, setSendMode] = useState<SendMode>("queue");
  const [pendingCount, setPendingCount] = useState(0);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [actualModels, setActualModels] = useState<Record<string, string>>({});
  const [canvasPanel, setCanvasPanel] = useState<CanvasPanelState | null>(null);

  // Refs for stable streaming
  const curMsgId = useRef<string | null>(null);
  const streamBufRef = useRef("");
  const curAgentRef = useRef<string | null>(null);
  const curThreadRef = useRef<string | null>(null);
  const toolCallsRef = useRef<ToolCall[]>([]);

  // Send debounce refs
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQueueRef = useRef<PendingSend[]>([]);
  const replayRequestedRef = useRef(false);
  const lastSeqRef = useRef(0);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousConnectedRef = useRef<boolean | null>(null);
  const previousAgentIdsRef = useRef<Set<string>>(new Set());

  const addSystemMessage = useCallback((agentId: string, threadId: string | null, content: string) => {
    const targetThreadId = threadId ?? (threads[agentId]?.[0]?.id ?? null);
    if (!targetThreadId) return;
    const sysMsg: Message = {
      id: `system-${crypto.randomUUID()}`,
      role: "system",
      content,
      timestamp: Date.now(),
    };
    setThreads((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] ?? []).map((t) =>
        t.id === targetThreadId
          ? { ...t, messages: [...t.messages, sysMsg] }
          : t,
      ),
    }));
  }, [threads]);

  const clearThinkingWatchdog = useCallback(() => {
    if (thinkingWatchdogRef.current) {
      clearTimeout(thinkingWatchdogRef.current);
      thinkingWatchdogRef.current = null;
    }
  }, []);

  const armThinkingWatchdog = useCallback(() => {
    clearThinkingWatchdog();
    thinkingWatchdogRef.current = setTimeout(() => {
      if (!curMsgId.current) return;
      setIsThinking(false);
      setRunState("error");
      const agentId = curAgentRef.current;
      const threadId = curThreadRef.current;
      if (agentId) addSystemMessage(agentId, threadId, "⚠️ Réponse interrompue : l'agent ne donne plus de nouvelles.");
    }, 90_000);
  }, [addSystemMessage, clearThinkingWatchdog]);

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

  const activeAgentInfo = agents.find((a) => a.id === activeAgent);
  const configuredAgent = config?.agents.find((a) => a.id === activeAgent);
  const agentModel =
    (activeAgent ? selectedModels[activeAgent] : undefined) ??
    activeAgentInfo?.model ??
    configuredAgent?.model ??
    DEFAULT_MODEL;
  const modelChoices = activeAgentInfo?.models ?? [];
  const agentAvailable = connected && !!activeAgentInfo;
  const thinkingLevel = activeAgentInfo?.thinking;
  const actualModel = activeAgent ? actualModels[activeAgent] : undefined;

  const handleModelChange = useCallback((nextModel: string) => {
    if (!activeAgent) return;
    setSelectedModels((prev) => ({ ...prev, [activeAgent]: nextModel }));
  }, [activeAgent]);

  const openCanvas = useCallback((agentId = activeAgent ?? "main", title?: string, url?: string) => {
    const path = url || `/canvas/${agentId}/`;
    const absoluteUrl = path.startsWith("http") ? path : `${hubHttpBase(config?.hub?.url ?? "wss://octopus.chrm.fr")}${path}`;
    setCanvasPanel({
      agentId,
      title: title || `${agentId} Canvas`,
      url: absoluteUrl,
    });
  }, [activeAgent, config?.hub?.url]);

  const currentThreads = threads[activeAgent ?? ""] ?? [];
  const currentThread = currentThreads.find((t) => t.id === activeThread) ?? null;
  const displayedContextPct = useMemo(() => {
    const usage = currentThread?.contextUsage;
    if (!usage) return currentThread?.contextPct ?? 0;
    if (usage.context_pct > 0) return usage.context_pct;

    const used = usage.prompt_tokens ?? usage.input_tokens;
    const budget = usage.context_tokens
      ?? modelChoices.find((m) => m.id === (currentThread?.model ?? agentModel))?.contextWindow;
    return budget && budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : (currentThread?.contextPct ?? 0);
  }, [agentModel, currentThread?.contextPct, currentThread?.contextUsage, currentThread?.model, modelChoices]);

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

  const flushPendingQueue = useCallback(() => {
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;

    const pending = pendingQueueRef.current.splice(0);
    setPendingCount(0);
    if (pending.length === 0) return;

    const groups = new Map<string, PendingSend[]>();
    pending.forEach((item) => {
      const key = `${item.agentId}\u0000${item.threadId}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    });

    for (const items of groups.values()) {
      const last = items[items.length - 1];
      const content = items.map((item) => item.content).join("\n\n");

      curMsgId.current = last.id;
      curAgentRef.current = last.agentId;
      curThreadRef.current = last.threadId;
      setStreamingContent(null);
      setIsThinking(true);
      setToolCalls([]);
      toolCallsRef.current = [];
      setActiveTool(null);
      setRunState("thinking");
      streamBufRef.current = "";
      armThinkingWatchdog();

      setThreads((prev) => ({
        ...prev,
        [last.agentId]: (prev[last.agentId] ?? []).map((t) =>
          t.id === last.threadId
            ? {
                ...t,
                messages: t.messages.map((msg) =>
                  items.some((item) => msg.id === `user-${item.id}`)
                    ? { ...msg, status: "sent" }
                    : msg,
                ),
              }
            : t,
        ),
      }));

      sendMessage({
        type: "send_message",
        id: last.id,
        agent: last.agentId,
        session: last.threadId,
        content,
        model: last.model,
      });
    }
  }, [armThinkingWatchdog, sendMessage]);

  // ── Debounced send ──────────────────────────────────────────────
  const queueSend = useCallback((content: string) => {
    if (!activeAgent) return;

    const agentId = activeAgent;
    const thread = currentThread ?? createThread(agentId);
    const msgId = crypto.randomUUID();

    const userMsg: Message = {
      id: `user-${msgId}`,
      role: "user",
      content,
      status: "pending",
      timestamp: Date.now(),
    };

    pendingQueueRef.current.push({
      id: msgId,
      agentId,
      threadId: thread.id,
      content,
      model: agentModel,
    });
    setPendingCount(pendingQueueRef.current.length);
    setRunState("queued");

    setThreads((prev) => ({
      ...prev,
      [agentId]: (() => {
        const list = prev[agentId] ?? [];
        if (list.some((t) => t.id === thread.id)) {
          return list.map((t) =>
            t.id === thread.id
              ? {
                  ...t,
                  messages: [...t.messages, userMsg],
                  title: t.titleLocked ? t.title : content.slice(0, 40),
                }
              : t,
          );
        }
        return [{ ...thread, messages: [userMsg], title: content.slice(0, 40) }];
      })(),
    }));

    if (sendMode === "instant") {
      setTimeout(flushPendingQueue, 0);
    } else {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      sendTimerRef.current = setTimeout(flushPendingQueue, SEND_DEBOUNCE_MS);
    }
  }, [activeAgent, currentThread, createThread, agentModel, flushPendingQueue, sendMode]);

  const notifyInputChange = useCallback(() => {}, []);

  const handleSend = useCallback(
    (content: string, immediate = false) => {
      if (immediate) {
        queueSend(content);
        setTimeout(flushPendingQueue, 0);
      } else {
        queueSend(content);
      }
    },
    [queueSend, flushPendingQueue],
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
    setIsThinking(false);
    setToolCalls([]);
    toolCallsRef.current = [];
    setActiveTool(null);
    setRunState("idle");
    streamBufRef.current = "";
    clearThinkingWatchdog();
  }, [activeAgent, activeThread, clearThinkingWatchdog, sendMessage]);

  // ── Select agent ─────────────────────────────────────────────────
  const handleSelectAgent = useCallback((id: string) => {
    setActiveAgent(id);
    setActiveThread(null);
    setStreamingContent(null);
    setIsThinking(false);
    setToolCalls([]);
    toolCallsRef.current = [];
    setActiveTool(null);
    setRunState("idle");
  }, []);

  // ── Close thread ─────────────────────────────────────────────────
  const closeThread = useCallback((threadId: string) => {
    if (!activeAgent) return;

    if (sendTimerRef.current) {
      pendingQueueRef.current = pendingQueueRef.current.filter(
        (item) => !(item.agentId === activeAgent && item.threadId === threadId),
      );
      if (pendingQueueRef.current.length === 0) {
        clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
      }
      setPendingCount(pendingQueueRef.current.length);
    }

    if (activeThread === threadId && curThreadRef.current === threadId && curMsgId.current) {
      sendMessage({
        type: "cancel",
        id: curMsgId.current,
        agent: activeAgent,
        session: threadId,
      });
      curMsgId.current = null;
      curThreadRef.current = null;
      curAgentRef.current = null;
      streamBufRef.current = "";
      setStreamingContent(null);
      setIsThinking(false);
      setToolCalls([]);
      toolCallsRef.current = [];
      setActiveTool(null);
      setRunState("idle");
    }

    sendMessage({
      type: "close_thread",
      agent: activeAgent,
      session: threadId,
    });

    setThreads((prev) => {
      const list = prev[activeAgent] ?? [];
      const idx = list.findIndex((t) => t.id === threadId);
      if (idx < 0) return prev;

      const nextList = list.filter((t) => t.id !== threadId);
      if (activeThread === threadId) {
        const nextActive = nextList[Math.min(idx, nextList.length - 1)]?.id ?? null;
        setActiveThread(nextActive);
      }

      return {
        ...prev,
        [activeAgent]: nextList,
      };
    });
  }, [activeAgent, activeThread, sendMessage]);

  const renameThread = useCallback((threadId: string, title: string) => {
    if (!activeAgent) return;
    const nextTitle = title.trim() || "Nouveau";

    setThreads((prev) => ({
      ...prev,
      [activeAgent]: (prev[activeAgent] ?? []).map((t) =>
        t.id === threadId
          ? { ...t, title: nextTitle, titleLocked: true }
          : t,
      ),
    }));
  }, [activeAgent]);

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

      if (e.key === "w") {
        e.preventDefault();
        if (activeThread) closeThread(activeThread);
      }
    },
    [agents, activeAgent, activeThread, threads, createThread, closeThread],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    (async () => {
      try {
        const raw: string | null = await invoke("load_replay_state");
        if (raw) {
          const state = JSON.parse(raw) as { lastSeq?: number };
          lastSeqRef.current = state.lastSeq ?? 0;
        }
      } catch (e) {
        console.warn("No replay state found:", e);
      }
      setReplayStateLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!connected) {
      replayRequestedRef.current = false;
      return;
    }
    if (!replayStateLoaded) return;
    if (replayRequestedRef.current) return;

    replayRequestedRef.current = true;
    sendMessage({ type: "replay", since: lastSeqRef.current });
  }, [connected, replayStateLoaded, sendMessage]);

  useEffect(() => {
    if (previousConnectedRef.current === null) {
      previousConnectedRef.current = connected;
      return;
    }
    if (previousConnectedRef.current === connected) return;

    previousConnectedRef.current = connected;
    if (activeAgent) {
      addSystemMessage(
        activeAgent,
        activeThread,
        connected ? "🟢 Connexion au hub Octopus rétablie." : "🔴 Connexion au hub Octopus perdue.",
      );
    }
  }, [activeAgent, activeThread, addSystemMessage, connected]);

  useEffect(() => {
    const nextIds = new Set(agents.map((agent) => agent.id));
    const prevIds = previousAgentIdsRef.current;

    if (prevIds.size > 0) {
      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          addSystemMessage(id, id === activeAgent ? activeThread : null, "🔴 Gateway/agent déconnecté du hub Octopus.");
          if (id === curAgentRef.current) {
            clearThinkingWatchdog();
            setIsThinking(false);
            setStreamingContent(null);
            setActiveTool(null);
            setRunState("error");
          }
        }
      }

      for (const id of nextIds) {
        if (!prevIds.has(id)) {
          addSystemMessage(id, id === activeAgent ? activeThread : null, "🟢 Gateway/agent reconnecté au hub Octopus.");
        }
      }
    }

    previousAgentIdsRef.current = nextIds;
  }, [activeAgent, activeThread, addSystemMessage, agents, clearThinkingWatchdog]);

  const ackSeq = useCallback((seq?: number) => {
    if (!seq || seq <= lastSeqRef.current) return;
    lastSeqRef.current = seq;

    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => {
      const lastSeq = lastSeqRef.current;
      sendMessage({ type: "ack", ackSeq: lastSeq });
      invoke("save_replay_state", { data: JSON.stringify({ lastSeq }) }).catch((e) =>
        console.warn("Failed to save replay state:", e),
      );
    }, 250);
  }, [sendMessage]);

  // ── Streaming responses ─────────────────────────────────────────
  const handleStreamMsg = useCallback((msg: any) => {
    ackSeq(msg.seq);

    switch (msg.type) {
      case "close_thread": {
        const agentId = msg.agent;
        const threadId = msg.session;
        if (!agentId || !threadId) break;

        setThreads((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] ?? []).filter((t) => t.id !== threadId),
        }));

        if (activeAgent === agentId && activeThread === threadId) {
          setActiveThread(null);
        }
        break;
      }
      case "send_message": {
        const agentId = msg.agent;
        const threadId = msg.session;
        if (!agentId || !threadId || !msg.id) break;

        const userMsg: Message = {
          id: `user-${msg.id}`,
          role: "user",
          content: msg.content ?? "",
          status: "sent",
          timestamp: Date.now(),
        };

        setThreads((prev) => {
          const list = prev[agentId] ?? [];
          const existing = list.find((t) => t.id === threadId);
          if (!existing) {
            return {
              ...prev,
              [agentId]: [{
                id: threadId,
                agentId,
                title: (msg.content ?? "Nouveau").slice(0, 40),
                messages: [userMsg],
                createdAt: Date.now(),
              }, ...list],
            };
          }

          return {
            ...prev,
            [agentId]: list.map((t) => {
              if (t.id !== threadId) return t;
              if (t.messages.some((m) => m.id === userMsg.id)) {
                return {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.id === userMsg.id ? { ...m, status: "sent" } : m,
                  ),
                };
              }
              return {
                ...t,
                messages: [...t.messages, userMsg],
                title: t.titleLocked ? t.title : userMsg.content.slice(0, 40),
              };
            }),
          };
        });
        break;
      }
      case "canvas_open": {
        const agentId = msg.agent ?? activeAgent ?? "main";
        openCanvas(agentId, msg.title ?? "Canvas", msg.url ?? `/canvas/${agentId}/`);
        break;
      }
      case "agent_status":
        if (msg.id && curMsgId.current === msg.id && msg.status === "thinking") {
          setIsThinking(true);
          setRunState("thinking");
          armThinkingWatchdog();
          if (msg.model && msg.agent) {
            setActualModels((prev) => ({ ...prev, [msg.agent]: msg.model }));
          }
        }
        if (msg.id && curMsgId.current === msg.id && msg.status === "idle") {
          setIsThinking(false);
          clearThinkingWatchdog();
        }
        break;
      case "chunk":
        if (msg.id && curMsgId.current && msg.id !== curMsgId.current) break;
        clearThinkingWatchdog();
        setIsThinking(false);
        setRunState("streaming");
        streamBufRef.current = msg.replace ? (msg.content ?? "") : streamBufRef.current + (msg.content ?? "");
        setStreamingContent(streamBufRef.current);
        break;
      case "done": {
        const isCurrentMessage = msg.id && curMsgId.current === msg.id;
        const agentId = msg.agent ?? (isCurrentMessage ? curAgentRef.current : null);
        const threadId = msg.session ?? (isCurrentMessage ? curThreadRef.current : null);
        const finalContent = (isCurrentMessage ? streamBufRef.current : "") || msg.content || "";
        const completedToolCalls = isCurrentMessage ? toolCallsRef.current : [];

        if (isCurrentMessage) {
          streamBufRef.current = "";
          setStreamingContent(null);
          setIsThinking(false);
          setToolCalls([]);
          toolCallsRef.current = [];
          setActiveTool(null);
          setRunState("idle");
          clearThinkingWatchdog();
          curMsgId.current = null;
          curAgentRef.current = null;
          curThreadRef.current = null;
        }

        if (agentId && threadId && msg.id) {
          const assMsg: Message = {
            id: `assist-${msg.id}`,
            role: "assistant",
            content: finalContent,
            toolCalls: completedToolCalls,
            usage: msg.usage,
            model: msg.model,
            timestamp: Date.now(),
          };
          if (msg.model) {
            setActualModels((prev) => ({ ...prev, [agentId]: msg.model }));
          }
          setThreads((prev) => {
            const list = prev[agentId] ?? [];
            const existing = list.find((t) => t.id === threadId);
            if (!existing) {
              return {
                ...prev,
                [agentId]: [{
                  id: threadId,
                  agentId,
                  title: "Thread restauré",
                  contextPct: msg.usage?.context_pct,
                  contextUsage: msg.usage,
                  model: msg.model,
                  messages: [assMsg],
                  createdAt: Date.now(),
                }, ...list],
              };
            }

            return {
              ...prev,
              [agentId]: list.map((t) => {
                if (t.id !== threadId) return t;
                const base = {
                  ...t,
                  contextPct: msg.usage?.context_pct ?? t.contextPct,
                  contextUsage: msg.usage ?? t.contextUsage,
                  model: msg.model ?? t.model,
                };
                if (t.messages.some((m) => m.id === assMsg.id)) return base;
                return { ...base, messages: [...t.messages, assMsg] };
              }),
            };
          });
        }
        break;
      }
      case "error":
        if (msg.id && curMsgId.current && msg.id !== curMsgId.current) break;
        clearThinkingWatchdog();
        setRunState("error");
        setIsThinking(false);
        setStreamingContent(null);
        setActiveTool(null);
        break;
      case "tool_progress":
        if (msg.id && curMsgId.current && msg.id !== curMsgId.current) break;
        setRunState(msg.status === "completed" ? "streaming" : "tool");
        setActiveTool(msg.status === "completed" ? null : (msg.tool ?? null));
        setToolCalls((prev) => {
          const filtered = prev.filter(
            (t) => !(t.tool === msg.tool && t.status === "running"),
          );
          const next = [
            ...filtered,
            { tool: msg.tool, status: msg.status ?? "running", summary: msg.summary },
          ];
          toolCallsRef.current = next;
          return next;
        });
        break;
    }
  }, [ackSeq, activeAgent, activeThread, armThinkingWatchdog, clearThinkingWatchdog, openCanvas]);

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
          model={agentModel}
          models={modelChoices}
          contextPct={displayedContextPct}
          agentLabel={agentLabel}
          agentAvailable={agentAvailable}
          runState={runState}
          sendMode={sendMode}
          pendingCount={pendingCount}
          activeTool={activeTool}
          thinkingLevel={thinkingLevel}
          actualModel={actualModel}
          onModelChange={handleModelChange}
          onSendModeChange={setSendMode}
          onOpenCanvas={() => activeAgent && openCanvas(activeAgent)}
        />

        <ThreadBar
          threads={currentThreads}
          activeThread={activeThread}
          onSelect={setActiveThread}
          onClose={closeThread}
          onRename={renameThread}
          onNew={() => activeAgent && createThread(activeAgent)}
        />

        <div className="pane-grid">
          {Array.from({ length: splitCount }).map((_, i) => (
            <ChatPane
              key={i}
              thread={currentThread}
              streamingContent={streamingContent}
              isThinking={isThinking}
              toolCalls={toolCalls}
              runState={runState}
              onSend={handleSend}
              onCancel={handleCancel}
              onInputChange={notifyInputChange}
            />
          ))}
        </div>
      </div>

      {canvasPanel && (
        <aside className="canvas-panel">
          <div className="canvas-panel-header">
            <div>
              <strong>{canvasPanel.title}</strong>
              <span>{canvasPanel.agentId}</span>
            </div>
            <button onClick={() => setCanvasPanel(null)} title="Fermer le Canvas">×</button>
          </div>
          <iframe title={canvasPanel.title} src={canvasPanel.url} sandbox="allow-scripts allow-forms allow-popups allow-modals" />
        </aside>
      )}
    </div>
  );
}
