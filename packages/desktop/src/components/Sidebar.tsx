import { useState } from "react";
import type { AgentInfo, AgentStatus } from "../lib/types";

interface SidebarProps {
  agents: AgentInfo[];
  agentStatuses: Record<string, AgentStatus>;
  activeAgent: string | null;
  onSelectAgent: (id: string) => void;
}

export default function Sidebar({ agents, agentStatuses, activeAgent, onSelectAgent }: SidebarProps) {
  const [open, setOpen] = useState(false);

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <button className="sidebar-toggle" onClick={() => setOpen(!open)} title={open ? "Réduire" : "Développer"}>
        {open ? "◀" : "▶"}
      </button>
      {agents.map((agent) => {
        const status = agentStatuses[agent.id] ?? "idle";
        const initials = agent.label.slice(0, 2).toUpperCase();
        return (
          <div key={agent.id} className="agent-item" style={open ? { width: "100%", padding: "8px 12px", display: "flex", alignItems: "center", gap: "8px" } : {}}>
            <button
              className={`agent-btn${activeAgent === agent.id ? " active" : ""}${status !== "idle" ? ` ${status}` : ""}`}
              onClick={() => onSelectAgent(agent.id)}
              title={`${agent.label} (${agent.model})`}
            >
              {initials}
              <span className={`status-dot ${status}`} />
            </button>
            {open && <span className="agent-label" style={{ fontSize: 13, marginTop: 0, maxWidth: "none" }}>{agent.label}</span>}
          </div>
        );
      })}
    </aside>
  );
}
