import { useState, useRef, useEffect } from "react";
import { marked } from "marked";
import type { Thread, ToolCall } from "../lib/types";

marked.use({ gfm: true, breaks: true });

interface ChatPaneProps {
  thread: Thread | null;
  streamingContent: string | null;
  toolCalls: ToolCall[];
  onSend: (content: string, immediate?: boolean) => void;
  onCancel: () => void;
  onInputChange?: () => void;
}

export default function ChatPane({
  thread,
  streamingContent,
  toolCalls,
  onSend,
  onCancel,
  onInputChange,
}: ChatPaneProps) {
  const [input, setInput] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevStreamingRef = useRef<string | null>(null);

  // Scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages, streamingContent, toolCalls]);

  // Reset pending counter when stream ends
  useEffect(() => {
    if (!streamingContent && prevStreamingRef.current) {
      setPendingCount(0);
    }
    prevStreamingRef.current = streamingContent;
  }, [streamingContent]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setPendingCount((c) => c + 1);
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();

      const text = input.trim();
      if (!text) return;

      // Queue the message (debounced send)
      setInput("");
      onSend(text);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    onInputChange?.();
  };

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 150)}px`;
    }
  }, [input]);

  const messages = thread?.messages ?? [];

  return (
    <div className="pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Messages */}
      <div className="messages">
        {messages.length === 0 && !streamingContent && (
          <div style={{ textAlign: "center", color: "var(--text-dim)", marginTop: 60, fontSize: 14 }}>
            Commencez une conversation avec cet agent.
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.toolCalls?.map((tc, i) => (
              <ToolCallBadge key={i} call={tc} />
            ))}
            {msg.content && (
              <div className={`msg ${msg.role}`}>
                <FormattedMessage content={msg.content} />
                {msg.usage && (
                  <div className="msg-footer">
                    {msg.model && <span>{msg.model}</span>}
                    {msg.usage.input_tokens > 0 && (
                      <span>
                        {msg.usage.input_tokens}→{msg.usage.output_tokens} tok
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Streaming tool calls */}
        {toolCalls.map((tc, i) => (
          <ToolCallBadge key={`stream-${i}`} call={tc} />
        ))}

        {/* Streaming content */}
        {streamingContent && (
          <div className="msg assistant">
            <FormattedMessage content={streamingContent} />
            <span className="spinner" style={{ display: "inline-block", marginLeft: 4 }} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-area" style={{ flexDirection: "column", gap: 4 }}>
        {pendingCount > 0 && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              textAlign: "center",
            }}
          >
            {pendingCount > 1
              ? `${pendingCount} messages en attente d'envoi`
              : "Message mis en attente (appuyez sur Entrée à nouveau pour envoyer, ou attendez)"}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Tapez un message… (Entrée pour envoyer, Shift+Entrée pour sauter une ligne)"
            rows={1}
          />
          {streamingContent ? (
            <button onClick={onCancel} style={{ background: "var(--red)" }} title="Arrêter">
              ■
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()} title="Envoyer">
              ▶
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ToolCallBadge({ call }: { call: ToolCall }) {
  return (
    <div className={`tool-call ${call.status}`}>
      {call.status === "running" && <span className="spinner" />}
      {call.status === "completed" && <span style={{ color: "var(--green)" }}>✓</span>}
      {call.status === "error" && <span style={{ color: "var(--red)" }}>✗</span>}
      <span>{call.tool}</span>
      {call.summary && <span style={{ color: "var(--text-dim)" }}>— {call.summary}</span>}
    </div>
  );
}

function FormattedMessage({ content }: { content: string }) {
  const html = marked.parse(content, { async: false }) as string;
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  );
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "blocked:");
}

export type { ChatPaneProps };
