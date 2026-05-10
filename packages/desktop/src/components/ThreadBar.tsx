import type { Thread } from "../lib/types";

interface ThreadBarProps {
  threads: Thread[];
  activeThread: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export default function ThreadBar({ threads, activeThread, onSelect, onNew }: ThreadBarProps) {
  return (
    <div className="thread-bar">
      {threads.map((t) => (
        <button
          key={t.id}
          className={`thread-tab${t.id === activeThread ? " active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          {t.title || "Nouveau"}
        </button>
      ))}
      <button className="thread-new" onClick={onNew} title="Nouveau thread">+</button>
    </div>
  );
}
