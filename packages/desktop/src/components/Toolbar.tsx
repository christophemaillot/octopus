interface ToolbarProps {
  connected: boolean;
  model: string;
  contextPct: number;
  agentLabel: string;
  onModelChange: (model: string) => void;
}

const MODELS = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "minimax/MiniMax-M2.7", label: "MiniMax M2.7" },
  { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
];

export default function Toolbar({ connected, model, contextPct, agentLabel, onModelChange }: ToolbarProps) {
  const ctxClass = contextPct < 50 ? "low" : contextPct < 80 ? "med" : "high";

  return (
    <div className="toolbar">
      <span className="toolbar-title">{agentLabel || "Octopus"}</span>
      <span className={`connection-dot${connected ? " connected" : ""}`} title={connected ? "Connecté" : "Déconnecté"} />

      <div className="toolbar-spacer" />

      <div className="context-bar">
        <span>Contexte</span>
        <div className="context-fill">
          <div className={`context-fill-inner ${ctxClass}`} style={{ width: `${contextPct}%` }} />
        </div>
        <span>{Math.round(contextPct)}%</span>
      </div>

      <div className="toolbar-model">
        <select value={model} onChange={(e) => onModelChange(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
