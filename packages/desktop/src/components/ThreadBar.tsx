import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Thread } from "../lib/types";

interface ThreadBarProps {
  threads: Thread[];
  activeThread: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
}

export default function ThreadBar({ threads, activeThread, onSelect, onClose, onRename, onNew }: ThreadBarProps) {
  const [editingThread, setEditingThread] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const startEditing = (thread: Thread) => {
    setEditingThread(thread.id);
    setDraftTitle(thread.title || "Nouveau");
  };

  const commitEditing = () => {
    if (!editingThread) return;
    onRename(editingThread, draftTitle);
    setEditingThread(null);
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditing();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingThread(null);
    }
  };

  useEffect(() => {
    if (editingThread && !threads.some((t) => t.id === editingThread)) {
      setEditingThread(null);
    }
  }, [editingThread, threads]);

  return (
    <div className="thread-bar">
      {threads.map((t) => (
        <div
          key={t.id}
          className={`thread-tab${t.id === activeThread ? " active" : ""}${editingThread === t.id ? " editing" : ""}`}
          title={t.title || "Nouveau"}
        >
          {editingThread === t.id ? (
            <input
              className="thread-title-input"
              value={draftTitle}
              autoFocus
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={commitEditing}
              onKeyDown={handleEditKeyDown}
            />
          ) : (
            <button
              className="thread-select"
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => startEditing(t)}
              title="Double-clic pour renommer"
            >
              <span className="thread-title">{t.title || "Nouveau"}</span>
            </button>
          )}
          <button
            className="thread-close"
            aria-label={`Fermer ${t.title || "ce thread"}`}
            title="Fermer le thread"
            onClick={() => onClose(t.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button className="thread-new" onClick={onNew} title="Nouveau thread">+</button>
    </div>
  );
}
