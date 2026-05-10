import { useState, useRef, useEffect } from "react";
import type { Thread, Message, ToolCall } from "../lib/types";

interface ChatPaneProps {
  thread: Thread | null;
  streamingContent: string | null;
  toolCalls: ToolCall[];
  onSend: (content: string) => void;
  onCancel: () => void;
}

export default function ChatPane({ thread, streamingContent, toolCalls, onSend, onCancel }: ChatPaneProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages, streamingContent, toolCalls]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
                    {msg.usage.input_tokens > 0 && <span>{msg.usage.input_tokens}→{msg.usage.output_tokens} tok</span>}
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
      <div className="input-area">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Tapez un message…"
          rows={1}
        />
        {streamingContent ? (
          <button onClick={onCancel} style={{ background: "var(--red)" }} title="Arrêter">■</button>
        ) : (
          <button onClick={handleSend} disabled={!input.trim()} title="Envoyer">▶</button>
        )}
      </div>
    </div>
  );
}

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
  // Simple markdown-like formatting (code blocks, bold, inline code)
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const code = part.slice(3, -3).replace(/^\w+\n/, ""); // strip optional lang
          return <pre key={i}><code>{code}</code></pre>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
