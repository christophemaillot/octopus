import type { DeliveryPreference, ModelInfo, RunState } from "../lib/types";

interface ToolbarProps {
  connected: boolean;
  model: string;
  models: ModelInfo[];
  contextPct: number;
  agentLabel: string;
  agentAvailable: boolean;
  runState: RunState;
  deliveryPreference: DeliveryPreference;
  activeTool: string | null;
  thinkingLevel?: string;
  actualModel?: string;
  onModelChange: (model: string) => void;
  onDeliveryPreferenceChange: (preference: DeliveryPreference) => void;
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
  deliveryPreference,
  activeTool,
  thinkingLevel,
  actualModel,
  onModelChange,
  onDeliveryPreferenceChange,
  onOpenCanvas,
}: ToolbarProps) {
  const ctxClass = contextPct < 50 ? "low" : contextPct < 80 ? "med" : "high";
  const choices = models.length > 0 ? models : FALLBACK_MODELS;
  const ctxRounded = Math.round(contextPct);
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

      <div className="context-gauge" title={`Contexte ${ctxRounded}%`}>
        <div className={`context-gauge-ring ${ctxClass}`} style={{ "--pct": contextPct } as React.CSSProperties}>
          <span>{ctxRounded}</span>
        </div>
      </div>

      <div className="toolbar-delivery-mode" title="Comportement si un tour agent est actif">
        <select
          value={deliveryPreference}
          onChange={(e) => onDeliveryPreferenceChange(e.target.value as DeliveryPreference)}
        >
          <option value="steer">orienter</option>
          <option value="queue_after_turn">après tour</option>
        </select>
      </div>

      <button className="toolbar-icon-button" onClick={onOpenCanvas} disabled={!agentAvailable} title="Ouvrir le Canvas OpenClaw">
        ◰
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
