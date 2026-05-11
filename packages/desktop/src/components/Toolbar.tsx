import type { ModelInfo, RunState, SendMode } from "../lib/types";

interface ToolbarProps {
  connected: boolean;
  model: string;
  models: ModelInfo[];
  contextPct: number;
  agentLabel: string;
  agentAvailable: boolean;
  runState: RunState;
  sendMode: SendMode;
  pendingCount: number;
  activeTool: string | null;
  thinkingLevel?: string;
  actualModel?: string;
  onModelChange: (model: string) => void;
  onSendModeChange: (mode: SendMode) => void;
  onOpenCanvas: () => void;
}

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "minimax/MiniMax-M2.7", label: "MiniMax M2.7" },
  { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
];

export default function Toolbar({
  connected,
  model,
  models,
  contextPct,
  agentLabel,
  agentAvailable,
  runState,
  sendMode,
  pendingCount,
  activeTool,
  thinkingLevel,
  actualModel,
  onModelChange,
  onSendModeChange,
  onOpenCanvas,
}: ToolbarProps) {
  const ctxClass = contextPct < 50 ? "low" : contextPct < 80 ? "med" : "high";
  const choices = models.length > 0 ? models : FALLBACK_MODELS;
  const stateLabel = runState === "idle"
    ? (agentAvailable ? "idle" : "offline")
    : runState;

  return (
    <div className="toolbar">
      <span className="toolbar-title">{agentLabel || "Octopus"}</span>
      <span className={`connection-dot${connected ? " connected" : ""}`} title={connected ? "Hub connecté" : "Hub déconnecté"} />
      <span className={`agent-availability${agentAvailable ? " online" : " offline"}`} title={agentAvailable ? "Agent disponible" : "Agent indisponible"}>
        {agentAvailable ? "agent ok" : "agent off"}
      </span>
      <span className={`run-pill ${runState}`} title={activeTool ? `Tool: ${activeTool}` : undefined}>
        {activeTool ? `tool: ${activeTool}` : stateLabel}
      </span>
      {thinkingLevel && <span className="meta-pill">thinking {thinkingLevel}</span>}
      {actualModel && actualModel !== model && <span className="meta-pill" title="Modèle réellement utilisé">used {actualModel}</span>}

      <div className="toolbar-spacer" />

      <div className="context-bar">
        <span>Contexte</span>
        <div className="context-fill">
          <div className={`context-fill-inner ${ctxClass}`} style={{ width: `${contextPct}%` }} />
        </div>
        <span>{Math.round(contextPct)}%</span>
      </div>

      <div className="toolbar-send-mode" title="Mode d'envoi">
        <select value={sendMode} onChange={(e) => onSendModeChange(e.target.value as SendMode)}>
          <option value="queue">queue{pendingCount > 0 ? ` (${pendingCount})` : ""}</option>
          <option value="instant">instant</option>
        </select>
      </div>

      <button className="toolbar-button" onClick={onOpenCanvas} disabled={!agentAvailable} title="Ouvrir le Canvas OpenClaw">
        Canvas
      </button>

      <div className="toolbar-model">
        <select value={model} onChange={(e) => onModelChange(e.target.value)}>
          {choices.map((m) => (
            <option key={m.id} value={m.id} disabled={m.available === false}>
              {m.label || m.id}{m.available === false ? " (indispo)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
