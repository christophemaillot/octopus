import { useState, useRef, useEffect } from "react";
import { marked } from "marked";
import type { Thread, ToolCall, RunState } from "../lib/types";

marked.use({ gfm: true, breaks: true });

interface ChatPaneProps {
  thread: Thread | null;
  streamingContent: string | null;
  isThinking: boolean;
  toolCalls: ToolCall[];
  activeUserMessageId?: string | null;
  runState: RunState;
  onSend: (content: string, immediate?: boolean) => void;
  onCancel: () => void;
  onInputChange?: () => void;
}

export default function ChatPane({
  thread,
  streamingContent,
  isThinking,
  toolCalls,
  activeUserMessageId,
  runState,
  onSend,
  onCancel,
  onInputChange,
}: ChatPaneProps) {
  const [input, setInput] = useState("");
  const [showTools, setShowTools] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages, streamingContent, isThinking, toolCalls]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
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
  const toolAnchorExists = !!activeUserMessageId && messages.some((msg) => msg.id === activeUserMessageId);
  const renderStreamingTools = () => (
    <div className="tool-panel">
      <button className="tool-panel-toggle" onClick={() => setShowTools((v) => !v)}>
        {showTools ? "▾" : "▸"} tools · {toolCalls.length}
        {runState === "tool" && <span className="tool-live">running</span>}
      </button>
      {showTools && toolCalls.map((tc, i) => (
        <ToolCallBadge key={`stream-${i}`} call={tc} />
      ))}
    </div>
  );

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
          <div key={msg.id} className={`message-row ${msg.role}${msg.status ? ` ${msg.status}` : ""}${msg.deliveryMode === "steer" ? " steer" : ""}`}>
            {!!msg.toolCalls?.length && (
              <details className="tool-panel compact">
                <summary>tools · {msg.toolCalls.length}</summary>
                {msg.toolCalls.map((tc, i) => (
                  <ToolCallBadge key={i} call={tc} />
                ))}
              </details>
            )}
            {msg.content && (
              <div className={`msg ${msg.role}${msg.status ? ` ${msg.status}` : ""}${msg.deliveryMode === "steer" ? " steer" : ""}`}>
                {msg.deliveryMode === "steer" && <div className="msg-mode-badge" title="Message injecté dans le run en cours">↪ orienter</div>}
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
            {toolCalls.length > 0 && msg.id === activeUserMessageId && renderStreamingTools()}
          </div>
        ))}

        {/* Streaming tool calls */}
        {toolCalls.length > 0 && !toolAnchorExists && renderStreamingTools()}

        {/* Streaming content */}
        {isThinking && !streamingContent && (
          <div className="msg assistant typing-indicator" aria-label="L'agent écrit">
            <span />
            <span />
            <span />
          </div>
        )}

        {streamingContent && (
          <div className="msg assistant">
            <FormattedMessage content={streamingContent} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-area" style={{ flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Tapez un message… (Entrée pour envoyer, Shift+Entrée pour sauter une ligne)"
            rows={1}
          />
          {streamingContent || isThinking ? (
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
