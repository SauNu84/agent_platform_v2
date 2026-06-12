'use client';

/**
 * Knowledge Bases tab client island (SAU-253) — surfaces the existing reusable
 * Knowledge Base feature (SAU-243) inside Settings: list your knowledge bases,
 * create one, or delete one. Documents (PDF/DOCX/TXT) are uploaded while
 * building a scenario in the Studio, which searches them via RAG during
 * conversations. Talks to the existing /api/knowledge-bases routes.
 */
import { useState } from 'react';

interface KbView {
  id: string;
  title: string;
  description: string | null;
  docCount: number;
  createdAt: string;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export default function KnowledgeBaseSettings({ initial }: { initial: KbView[] }) {
  const [kbs, setKbs] = useState<KbView[]>(initial);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/knowledge-bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create knowledge base.');
      const kb = json.knowledgeBase;
      setKbs((prev) => [{ ...kb, docCount: kb.docCount ?? 0 }, ...prev]);
      setTitle('');
      setDescription('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/knowledge-bases/${id}`, { method: 'DELETE' });
    if (res.ok) setKbs((prev) => prev.filter((k) => k.id !== id));
  }

  return (
    <div className="settings-section">
      <h2>Knowledge Bases</h2>
      <p className="billing-muted">
        Knowledge bases let you upload documents (PDF, DOCX, TXT) that your AI scenarios can search during
        conversations via RAG. Create one to get started — add documents while building a scenario in the Studio.
      </p>

      <div className="settings-kb-create">
        <input
          type="text"
          className="settings-input"
          placeholder="Knowledge base name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
        <input
          type="text"
          className="settings-input"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="btn" onClick={create} disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : '+ Create knowledge base'}
        </button>
      </div>

      {error && <p className="billing-error" role="alert">{error}</p>}

      {kbs.length === 0 ? (
        <p className="billing-muted">No knowledge bases yet.</p>
      ) : (
        <table className="billing-table">
          <thead>
            <tr><th>Name</th><th>Documents</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {kbs.map((kb) => (
              <tr key={kb.id}>
                <td>
                  <strong>{kb.title}</strong>
                  {kb.description && <div className="billing-muted">{kb.description}</div>}
                </td>
                <td>{kb.docCount}</td>
                <td>{fmtDate(kb.createdAt)}</td>
                <td className="num">
                  <button type="button" className="btn-remove-text" onClick={() => remove(kb.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
