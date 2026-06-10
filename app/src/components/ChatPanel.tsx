'use client';

/**
 * ChatPanel — a text conversation with the scenario persona (SAU-224).
 *
 * Replaces the live/simulated voice demo on the scenario detail surface. Each send
 * POSTs to `/api/scenarios/[slug]/chat`, which generates the persona reply (live
 * Claude when keyed, deterministic mock otherwise) and persists the conversation
 * as a `session` (status completed). `onSession` bubbles each persisted state up so
 * DetailShell's Sessions tab + count stay live.
 */
import { useRef, useState } from 'react';
import type { SessionSummary } from './DetailShell';

interface Msg { role: 'user' | 'agent'; text: string; at: number }

export interface ChatPanelProps {
  name: string;
  chatEndpoint: string;
  onClose: () => void;
  onSession: (session: SessionSummary) => void;
}

export default function ChatPanel({ name, chatEndpoint, onClose, onSession }: ChatPanelProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);
    const optimistic: Msg = { role: 'user', text, at: Date.now() };
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, optimistic]);
    setInput('');
    try {
      const res = await fetch(chatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, sessionId: sessionIdRef.current ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      sessionIdRef.current = data.sessionId;
      setVendor(data.vendor ?? null);
      const turns: Msg[] = data.turns ?? [];
      setMessages(turns);
      onSession({
        id: data.sessionId,
        status: 'completed',
        startedAt: new Date(turns[0]?.at ?? Date.now()).toISOString(),
        endedAt: new Date(turns[turns.length - 1]?.at ?? Date.now()).toISOString(),
        turns,
      });
    } catch (e) {
      // Roll the optimistic user turn back so the input can be retried.
      setMessages((m) => m.filter((x) => x !== optimistic));
      setInput(text);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const simulated = vendor ? vendor.startsWith('chat:mock') : false;

  return (
    <div className="session-view">
      <nav className="session-nav">
        <button className="back-link" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          ← {name}
        </button>
        <span className="session-meta">
          Chat · {messages.length} turn{messages.length === 1 ? '' : 's'}
          {vendor ? (simulated ? ' · simulated' : ` · ${vendor.replace(/^chat:/, '')}`) : ''}
        </span>
      </nav>
      <h1 className="session-title">{name}</h1>
      <p className="subtitle">Chat with the persona — discuss over text</p>

      {simulated && (
        <div className="demo-banner">
          <strong>Simulated chat.</strong> No model key is configured, so replies are
          deterministic stand-ins — enough to see how a text conversation is captured,
          saved, and scored. With a model key the persona replies for real (same seam).
        </div>
      )}

      {messages.length === 0 ? (
        <div className="session-empty">
          <p>Say something to start the conversation. The persona stays in character and replies over text.</p>
        </div>
      ) : (
        <div className="conversation">
          {messages.map((m, i) => (
            <div key={i} className={`turn turn-${m.role}`}>
              <div className="turn-role">{m.role === 'agent' ? name : 'You'}</div>
              <div className="turn-text">{m.text}</div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="notice" role="alert">Chat failed: {error}</div>}

      <div className="chat-input">
        <textarea
          className="chat-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${name}…  (Enter to send, Shift+Enter for a new line)`}
          rows={2}
          disabled={sending}
        />
        <button className="btn join" onClick={() => void send()} disabled={sending || !input.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
