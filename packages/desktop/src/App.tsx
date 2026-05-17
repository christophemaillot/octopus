import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import ThreadBar from "./components/ThreadBar";
import ChatPane from "./components/ChatPane";
import { useHub } from "./hooks/useHub";
import { useConfig } from "./hooks/useConfig";
import { usePersistence } from "./hooks/usePersistence";
import type { AgentInfo, Thread, Message, ToolCall, RunState, SendMode, DeliveryPreference } from "./lib/types";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const SEND_DEBOUNCE_MS = 1500;
const MAX_PANES = 3;

interface PendingSend {
  id: string;
  agentId: string;
  threadId: string;
  content: string;
  model: string;
  deliveryPreference: DeliveryPreference;
}

interface CanvasPanelState {
  agentId: string;
  title: string;
  url: string;
  reloadKey: number;
}

interface GatewayNotice {
  id: string;
  status: "connected" | "disconnected";
  agentIds: string[];
  text: string;
}

interface ConversationPane {
  id: string;
  agentId: string | null;
  threadId: string | null;
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
    config?.hub ?? null,
  );

  const [panes, setPanes] = useState<ConversationPane[]>([
    { id: "pane-main", agentId: null, threadId: null },
  ]);
  const [activePaneId, setActivePaneId] = useState("pane-main");
  const [paneSplitPct, setPaneSplitPct] = useState(50);
  const [paneResizing, setPaneResizing] = useState(false);

  // Threads per agent: agentId → Thread[]
  const [threads, setThreads] = useState<Record<string, Thread[]>>({});

  // Load/save threads via persistence hook
  const { loadThreads } = usePersistence(threads, setThreads);
  const [loaded, setLoaded] = useState(false);

  // Streaming state
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [replayStateLoaded, setReplayStateLoaded] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [sendMode] = useState<SendMode>("queue");
  const [deliveryPreference, setDeliveryPreference] = useState<DeliveryPreference>("steer");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [actualModels, setActualModels] = useState<Record<string, string>>({});
  const [canvasPanel, setCanvasPanel] = useState<CanvasPanelState | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(560);
  const [canvasResizing, setCanvasResizing] = useState(false);
  const [gatewayNotice, setGatewayNotice] = useState<GatewayNotice | null>(null);

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
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastThreadByAgentRef = useRef<Record<string, string | null>>({});

  const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0];
  const activeAgent = activePane?.agentId ?? null;
  const activeThread = activePane?.threadId ?? null;

  const updatePane = useCallback((paneId: string, patch: Partial<ConversationPane>) => {
    setPanes((prev) => prev.map((pane) => (
      pane.id === paneId ? { ...pane, ...patch } : pane
    )));
  }, []);

  const showGatewayNotice = useCallback((notice: Omit<GatewayNotice, "id">) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setGatewayNotice({ ...notice, id: crypto.randomUUID() });
    noticeTimerRef.current = setTimeout(() => setGatewayNotice(null), 6000);
  }, []);

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

  useEffect(() => {
    if (agents.length === 0) return;
    setPanes((prev) => prev.map((pane, index) => {
      const fallbackAgent = pane.agentId && agents.some((agent) => agent.id === pane.agentId)
        ? pane.agentId
        : (agents[index]?.id ?? agents[0].id);
      const list = threads[fallbackAgent] ?? [];
      const threadId = pane.threadId && list.some((thread) => thread.id === pane.threadId)
        ? pane.threadId
        : (list[list.length - 1]?.id ?? null);
      return {
        ...pane,
        agentId: fallbackAgent,
        threadId,
      };
    }));
  }, [agents, threads]);

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
      reloadKey: Date.now(),
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
  const createThread = useCallback((agentId: string, paneId = activePaneId): Thread => {
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
    updatePane(paneId, { agentId, threadId: thread.id });
    return thread;
  }, [activePaneId, updatePane]);

  const flushPendingQueue = useCallback(() => {
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;

    const pending = pendingQueueRef.current.splice(0);
    if (pending.length === 0) return;

    const groups = new Map<string, PendingSend[]>();
    pending.forEach((item) => {
      const key = `${item.agentId}\u0000${item.threadId}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    });

    for (const items of groups.values()) {
      const last = items[items.length - 1];
      const content = items.map((item) => item.content).join("\n\n");
      const attachToCurrentRun = !curMsgId.current;

      if (attachToCurrentRun) {
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
      }

      sendMessage({
        type: "send_message",
        id: last.id,
        agent: last.agentId,
        session: last.threadId,
        content,
        model: last.model,
        deliveryPreference: last.deliveryPreference,
      });
    }
  }, [armThinkingWatchdog, sendMessage]);

  // ── Debounced send ──────────────────────────────────────────────
  const queueSend = useCallback((content: string, paneId = activePaneId) => {
    const pane = panes.find((item) => item.id === paneId) ?? activePane;
    const paneAgent = pane?.agentId ?? null;
    if (!paneAgent) return;

    const agentId = paneAgent;
    const paneThreads = threads[agentId] ?? [];
    const paneThread = paneThreads.find((thread) => thread.id === pane?.threadId) ?? null;
    const thread = paneThread ?? createThread(agentId, paneId);
    const paneModel =
      selectedModels[agentId] ??
      agents.find((agent) => agent.id === agentId)?.model ??
      config?.agents.find((agent) => agent.id === agentId)?.model ??
      DEFAULT_MODEL;
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
      model: paneModel,
      deliveryPreference,
    });
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
  }, [activePane, activePaneId, agents, config?.agents, createThread, deliveryPreference, flushPendingQueue, panes, selectedModels, sendMode, threads]);

  const notifyInputChange = useCallback(() => {}, []);

  const handleSend = useCallback(
    (content: string, immediate = false, paneId = activePaneId) => {
      if (immediate) {
        queueSend(content, paneId);
        setTimeout(flushPendingQueue, 0);
      } else {
        queueSend(content, paneId);
      }
    },
    [activePaneId, queueSend, flushPendingQueue],
  );

  // ── Cancel ──────────────────────────────────────────────────────
  const handleCancel = useCallback((pane: ConversationPane = activePane) => {
    const paneAgent = pane?.agentId ?? activeAgent;
    const paneThread = pane?.threadId ?? activeThread;
    if (curMsgId.current && paneAgent) {
      sendMessage({
        type: "cancel",
        id: curMsgId.current,
        agent: paneAgent,
        session: paneThread ?? undefined,
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
  }, [activeAgent, activePane, activeThread, clearThinkingWatchdog, sendMessage]);

  // ── Select agent ─────────────────────────────────────────────────
  const handleSelectAgent = useCallback((id: string) => {
    if (activeAgent) lastThreadByAgentRef.current[activeAgent] = activeThread;
    const list = threads[id] ?? [];
    const preferred = lastThreadByAgentRef.current[id];
    const nextThread = preferred && list.some((t) => t.id === preferred)
      ? preferred
      : (list[list.length - 1]?.id ?? null);

    updatePane(activePaneId, { agentId: id, threadId: nextThread });
    setStreamingContent(null);
    setIsThinking(false);
    setToolCalls([]);
    toolCallsRef.current = [];
    setActiveTool(null);
    setRunState("idle");
  }, [activeAgent, activePaneId, activeThread, threads, updatePane]);

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
        updatePane(activePaneId, { threadId: nextActive });
      }

      return {
        ...prev,
        [activeAgent]: nextList,
      };
    });
  }, [activeAgent, activePaneId, activeThread, sendMessage, updatePane]);

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

      const target = e.target as HTMLElement | null;
      const isEditing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.isContentEditable;
      const navMod = mod && e.altKey;

      if (navMod && e.key === "ArrowUp") {
        e.preventDefault();
        const idx = agents.findIndex((a) => a.id === activeAgent);
        if (idx > 0) handleSelectAgent(agents[idx - 1].id);
      }

      if (navMod && e.key === "ArrowDown") {
        e.preventDefault();
        const idx = agents.findIndex((a) => a.id === activeAgent);
        if (idx < agents.length - 1) handleSelectAgent(agents[idx + 1].id);
      }

      if (navMod && e.key === "ArrowLeft") {
        e.preventDefault();
        const list = threads[activeAgent ?? ""] ?? [];
        if (list.length === 0) return;
        const idx = list.findIndex((t) => t.id === activeThread);
        if (idx > 0) updatePane(activePaneId, { threadId: list[idx - 1].id });
      }

      if (navMod && e.key === "ArrowRight") {
        e.preventDefault();
        const list = threads[activeAgent ?? ""] ?? [];
        if (list.length === 0) return;
        const idx = list.findIndex((t) => t.id === activeThread);
        if (idx < list.length - 1) updatePane(activePaneId, { threadId: list[idx + 1].id });
      }

      if (!isEditing && e.key === "n") {
        e.preventDefault();
        if (activeAgent) createThread(activeAgent);
      }

      if (!isEditing && e.key === "w") {
        e.preventDefault();
        if (activeThread) closeThread(activeThread);
      }
    },
    [agents, activeAgent, activePaneId, activeThread, threads, createThread, closeThread, handleSelectAgent, updatePane],
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

        setPanes((prev) => prev.map((pane) => (
          pane.agentId === agentId && pane.threadId === threadId
            ? { ...pane, threadId: null }
            : pane
        )));
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
          deliveryMode: msg.deliveryMode === "steer" ? "steer" : "turn",
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
      case "gateway_status": {
        const agentIds = Array.isArray((msg as any).agents)
          ? (msg as any).agents.map(String)
          : (msg.agent ? [msg.agent] : []);
        const status = msg.status === "disconnected" ? "disconnected" : "connected";
        const names = agentIds.join(", ") || "agent";
        const text = status === "connected"
          ? `🟢 Gateway reconnecté : ${names}`
          : `🔴 Gateway déconnecté : ${names}`;
        showGatewayNotice({ status, agentIds, text });
        if (activeAgent && agentIds.includes(activeAgent)) {
          addSystemMessage(activeAgent, activeThread, text);
        }
        break;
      }
      case "message_delivery": {
        const agentId = msg.agent;
        const threadId = msg.session;
        if (!agentId || !threadId || !msg.id) break;

        const status: Message["status"] =
          msg.status === "accepted"
            ? "accepted"
            : msg.status === "queued_after_turn"
              ? "queued_after_turn"
              : msg.status === "steered_or_queued" || msg.status === "steered" || msg.deliveryMode === "steer"
                ? "steered"
                : msg.status === "started_turn"
                  ? "sent"
                  : "accepted";
        const deliveryMode: Message["deliveryMode"] =
          status === "steered" ? "steer" : msg.deliveryMode === "turn" ? "turn" : undefined;

        setThreads((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] ?? []).map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  messages: t.messages.map((message) =>
                    message.id === `user-${msg.id}` ? { ...message, status, deliveryMode } : message,
                  ),
                }
              : t,
          ),
        }));

        if (
          msg.id === curMsgId.current &&
          (msg.status === "queued_after_turn" || msg.status === "steered_or_queued" || msg.status === "steered")
        ) {
          setIsThinking(false);
          setRunState("idle");
          clearThinkingWatchdog();
          curMsgId.current = null;
          curAgentRef.current = null;
          curThreadRef.current = null;
        }
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
                const messages = t.messages.map((message) =>
                  message.id === `user-${msg.id}` ? { ...message, status: "sent" as const } : message,
                );
                if (messages.some((m) => m.id === assMsg.id)) return { ...base, messages };
                return { ...base, messages: [...messages, assMsg] };
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
  }, [ackSeq, activeAgent, activeThread, addSystemMessage, armThinkingWatchdog, clearThinkingWatchdog, openCanvas, showGatewayNotice]);

  useEffect(() => {
    const unsub = onMessage(handleStreamMsg);
    return unsub;
  }, [handleStreamMsg, onMessage]);

  // ── Split view ──────────────────────────────────────────────────
  const splitEnabled = panes.length > 1;
  const addPane = useCallback(() => {
    if (panes.length >= MAX_PANES) return;
    const nextPaneId = `pane-${crypto.randomUUID()}`;
    setPanes((prev) => {
      if (prev.length >= MAX_PANES) return prev;

      const usedAgents = new Set(prev.map((pane) => pane.agentId).filter(Boolean));
      const nextAgent = agents.find((agent) => !usedAgents.has(agent.id))?.id
        ?? activeAgent
        ?? agents[0]?.id
        ?? null;
      const nextThreads = nextAgent ? (threads[nextAgent] ?? []) : [];
      const usedThreads = new Set(prev
        .filter((pane) => pane.agentId === nextAgent)
        .map((pane) => pane.threadId)
        .filter(Boolean));
      const nextThread = nextThreads.find((thread) => !usedThreads.has(thread.id))?.id
        ?? nextThreads[nextThreads.length - 1]?.id
        ?? null;

      return [...prev, { id: nextPaneId, agentId: nextAgent, threadId: nextThread }];
    });
    setActivePaneId(nextPaneId);
  }, [activeAgent, agents, panes.length, threads]);

  const closePane = useCallback((paneId: string) => {
    setPanes((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((pane) => pane.id !== paneId);
      if (!next.some((pane) => pane.id === activePaneId)) {
        setActivePaneId(next[0]?.id ?? "pane-main");
      }
      return next;
    });
  }, [activePaneId]);

  const toggleSplit = useCallback(() => {
    if (panes.length === 1) {
      addPane();
      return;
    }

    setPanes((prev) => {
      const kept = prev.find((pane) => pane.id === activePaneId) ?? prev[0];
      setActivePaneId(kept.id);
      return [kept];
    });
  }, [activePaneId, addPane, panes.length]);

  const selectPaneAgent = useCallback((paneId: string, agentId: string) => {
    const pane = panes.find((item) => item.id === paneId);
    if (pane?.agentId) lastThreadByAgentRef.current[pane.agentId] = pane.threadId;
    const list = threads[agentId] ?? [];
    const preferred = lastThreadByAgentRef.current[agentId];
    const nextThread = preferred && list.some((thread) => thread.id === preferred)
      ? preferred
      : (list[list.length - 1]?.id ?? null);
    setActivePaneId(paneId);
    updatePane(paneId, { agentId, threadId: nextThread });
  }, [panes, threads, updatePane]);

  const startPaneResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement?.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    setPaneResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const cleanup = () => {
      setPaneResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cleanup);
    };
    const onMove = (moveEvent: MouseEvent) => {
      const pct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setPaneSplitPct(Math.min(72, Math.max(28, pct)));
    };
    const onUp = () => cleanup();

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cleanup);
  }, []);

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

      {gatewayNotice && (
        <div className={`gateway-notice ${gatewayNotice.status}`}>
          {gatewayNotice.text}
        </div>
      )}

      <div className="main">
        <Toolbar
          connected={connected}
          model={agentModel}
          models={modelChoices}
          contextPct={displayedContextPct}
          agentLabel={agentLabel}
          agentAvailable={agentAvailable}
          runState={runState}
          deliveryPreference={deliveryPreference}
          activeTool={activeTool}
          thinkingLevel={thinkingLevel}
          actualModel={actualModel}
          splitEnabled={splitEnabled}
          canAddPane={panes.length < MAX_PANES}
          onModelChange={handleModelChange}
          onDeliveryPreferenceChange={setDeliveryPreference}
          onAddPane={addPane}
          onToggleSplit={toggleSplit}
          onOpenCanvas={() => {
            if (!activeAgent) return;
            if (canvasPanel?.agentId === activeAgent) {
              setCanvasPanel(null);
            } else {
              openCanvas(activeAgent);
            }
          }}
        />

        {!splitEnabled && (
          <ThreadBar
            threads={currentThreads}
            activeThread={activeThread}
            onSelect={(threadId) => updatePane(activePaneId, { threadId })}
            onClose={closeThread}
            onRename={renameThread}
            onNew={() => activeAgent && createThread(activeAgent)}
          />
        )}

        <div className="pane-grid">
          {panes.map((pane, index) => {
            const paneThreads = threads[pane.agentId ?? ""] ?? [];
            const paneThread = paneThreads.find((thread) => thread.id === pane.threadId) ?? null;
            const isRunPane = curAgentRef.current === pane.agentId && curThreadRef.current === pane.threadId;
            const paneStyle = panes.length === 2
              ? { flexBasis: index === 0 ? `${paneSplitPct}%` : `${100 - paneSplitPct}%` }
              : undefined;

            return (
              <div
                key={pane.id}
                className={`pane-frame${pane.id === activePaneId ? " active" : ""}`}
                style={paneStyle}
                onMouseDown={() => setActivePaneId(pane.id)}
              >
                {splitEnabled && (
                  <PaneHeader
                    pane={pane}
                    active={pane.id === activePaneId}
                    agents={agents}
                    agentLabels={Object.fromEntries(
                      (config?.agents ?? []).map((agent) => [agent.id, agent.label]),
                    )}
                    threads={paneThreads}
                    thread={paneThread}
                    paneCount={panes.length}
                    canAddPane={panes.length < MAX_PANES}
                    onSelectAgent={(agentId) => selectPaneAgent(pane.id, agentId)}
                    onSelectThread={(threadId) => {
                      setActivePaneId(pane.id);
                      updatePane(pane.id, { threadId });
                    }}
                    onNewThread={() => {
                      if (!pane.agentId) return;
                      setActivePaneId(pane.id);
                      createThread(pane.agentId, pane.id);
                    }}
                    onAddPane={addPane}
                    onClosePane={() => closePane(pane.id)}
                  />
                )}
                <ChatPane
                  thread={paneThread}
                  streamingContent={isRunPane ? streamingContent : null}
                  isThinking={isRunPane && isThinking}
                  toolCalls={isRunPane ? toolCalls : []}
                  activeUserMessageId={isRunPane && curMsgId.current ? `user-${curMsgId.current}` : null}
                  runState={isRunPane ? runState : "idle"}
                  onSend={(content, immediate) => {
                    setActivePaneId(pane.id);
                    handleSend(content, immediate, pane.id);
                  }}
                  onCancel={() => {
                    setActivePaneId(pane.id);
                    handleCancel(pane);
                  }}
                  onInputChange={notifyInputChange}
                />
                {panes.length === 2 && index === 0 && (
                  <div className="pane-divider" onMouseDown={startPaneResize} />
                )}
              </div>
            );
          })}
          {paneResizing && <div className="pane-resize-overlay" />}
        </div>
      </div>

      {canvasPanel && (
        <aside className="canvas-panel" style={{ width: canvasWidth }}>
          <div
            className="canvas-resize-handle"
            onMouseDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = canvasWidth;
              setCanvasResizing(true);
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";

              const cleanup = () => {
                setCanvasResizing(false);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                window.removeEventListener("blur", cleanup);
              };
              const onMove = (moveEvent: MouseEvent) => {
                const max = Math.round(window.innerWidth * 0.72);
                const next = Math.min(max, Math.max(360, startWidth - (moveEvent.clientX - startX)));
                setCanvasWidth(next);
              };
              const onUp = () => cleanup();

              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
              window.addEventListener("blur", cleanup);
            }}
          />
          {canvasResizing && <div className="canvas-resize-overlay" />}
          <div className="canvas-panel-header">
            <div>
              <strong>{canvasPanel.title}</strong>
              <span>{canvasPanel.agentId}</span>
            </div>
            <button onClick={() => setCanvasPanel(null)} title="Fermer le Canvas">×</button>
          </div>
          <iframe
            key={`${canvasPanel.url}-${canvasPanel.reloadKey}`}
            title={canvasPanel.title}
            src={`${canvasPanel.url}${canvasPanel.url.includes("?") ? "&" : "?"}_octopusReload=${canvasPanel.reloadKey}`}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
          />
        </aside>
      )}
    </div>
  );
}

interface PaneHeaderProps {
  pane: ConversationPane;
  active: boolean;
  agents: AgentInfo[];
  agentLabels: Record<string, string>;
  threads: Thread[];
  thread: Thread | null;
  paneCount: number;
  canAddPane: boolean;
  onSelectAgent: (agentId: string) => void;
  onSelectThread: (threadId: string | null) => void;
  onNewThread: () => void;
  onAddPane: () => void;
  onClosePane: () => void;
}

function PaneHeader({
  pane,
  active,
  agents,
  agentLabels,
  threads,
  thread,
  paneCount,
  canAddPane,
  onSelectAgent,
  onSelectThread,
  onNewThread,
  onAddPane,
  onClosePane,
}: PaneHeaderProps) {
  return (
    <div className={`pane-header${active ? " active" : ""}`}>
      <select
        className="pane-header-select agent"
        value={pane.agentId ?? ""}
        onChange={(event) => onSelectAgent(event.target.value)}
        title="Agent affiché dans cette colonne"
      >
        {!pane.agentId && <option value="">Agent</option>}
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agentLabels[agent.id] ?? agent.label}
          </option>
        ))}
      </select>

      <select
        className="pane-header-select thread"
        value={thread?.id ?? ""}
        onChange={(event) => onSelectThread(event.target.value || null)}
        disabled={!pane.agentId || threads.length === 0}
        title="Conversation affichée dans cette colonne"
      >
        <option value="">{threads.length === 0 ? "Aucun thread" : "Thread"}</option>
        {threads.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title || "Nouveau"}
          </option>
        ))}
      </select>

      <button className="pane-header-button" onClick={onNewThread} disabled={!pane.agentId} title="Nouveau thread">
        +
      </button>
      <button className="pane-header-button" onClick={onAddPane} disabled={!canAddPane} title="Ajouter une colonne">
        ▥
      </button>
      <button className="pane-header-button" onClick={onClosePane} disabled={paneCount <= 1} title="Fermer cette colonne">
        ×
      </button>
    </div>
  );
}
