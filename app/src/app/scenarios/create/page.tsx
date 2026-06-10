'use client';

/**
 * Scenario Studio — Classic create form (SAU-214 board request).
 * Fields: Name → auto-slug, Public Description, AI Instructions, Rubric (optional rows), Visibility.
 * Submits JSON to POST /api/scenarios; on success redirects to the new scenario detail page.
 */
import { useState, useId } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface RubricRow { topic: string; weight: number; note: string; }

interface Template {
  label: string;
  name: string;
  description: string;
  persona: string;
  rubric: RubricRow[];
}

const TEMPLATES: Template[] = [
  {
    label: 'Job Interview',
    name: 'Job Interview Practice',
    description: 'Practice common job interview scenarios with a realistic interviewer.',
    persona: "You are an experienced technical interviewer conducting a job interview. Ask thoughtful questions, probe for depth, and give the candidate room to think. Focus on competency-based questions. After each answer, ask one follow-up before moving on. Keep the tone professional but warm.",
    rubric: [
      { topic: 'Communication Clarity', weight: 30, note: '' },
      { topic: 'Technical Depth', weight: 40, note: '' },
      { topic: 'Problem-Solving Approach', weight: 30, note: '' },
    ],
  },
  {
    label: 'Sales Call',
    name: 'Sales Discovery Call',
    description: 'Practice enterprise sales discovery conversations with a skeptical buyer.',
    persona: "You are a skeptical VP-level enterprise buyer evaluating a new software solution. You have real problems but limited time and budget. Push back on vendor claims, ask for specifics, and probe ROI. Be engaged but challenging — you need to be convinced, not sold to.",
    rubric: [
      { topic: 'Needs Discovery', weight: 35, note: '' },
      { topic: 'Objection Handling', weight: 35, note: '' },
      { topic: 'Value Articulation', weight: 30, note: '' },
    ],
  },
];

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export default function CreateScenarioPage() {
  const router = useRouter();
  const uid = useId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [persona, setPersona] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [rubric, setRubric] = useState<RubricRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyTemplate(t: Template) {
    setName(t.name);
    if (!slugEdited) setSlug(toSlug(t.name));
    setDescription(t.description);
    setPersona(t.persona);
    setRubric(t.rubric.map((r) => ({ ...r })));
    setError(null);
  }

  function handleNameChange(v: string) {
    setName(v);
    if (!slugEdited) setSlug(toSlug(v));
  }

  function handleSlugChange(v: string) {
    setSlugEdited(true);
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/--+/g, '-').slice(0, 60));
  }

  function addRubricRow() {
    setRubric((r) => [...r, { topic: '', weight: 0, note: '' }]);
  }

  function updateRubricRow(i: number, patch: Partial<RubricRow>) {
    setRubric((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function removeRubricRow(i: number) {
    setRubric((r) => r.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) { setError('Slug is required'); return; }
    if (!persona) { setError('AI Instructions are required'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: slug,
          name: name || slug,
          description: description || undefined,
          persona,
          rubric: rubric.filter((r) => r.topic.trim()),
          visibility,
          metadata: { _source: 'user' },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      router.push(`/scenarios/${data.scenario.slug}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const preview = name || slug ? {
    name: name || slug,
    description: description || 'A live voice role-play to practice one high-stakes conversation.',
    role: 'Practice',
  } : null;

  return (
    <div className="studio-layout">
      {/* Left: form */}
      <div className="studio-form">
        <nav className="studio-nav">
          <Link href="/library" className="back-link">← Scenarios</Link>
          <span className="studio-mode-badge">Classic</span>
        </nav>
        <h1 className="studio-title">Scenario Studio</h1>

        {/* Templates */}
        <section className="studio-section">
          <p className="studio-section-label">Start with a template</p>
          <div className="studio-chips">
            {TEMPLATES.map((t) => (
              <button key={t.label} type="button" className="chip" onClick={() => applyTemplate(t)}>
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <form onSubmit={handleSubmit}>
          {/* Name */}
          <div className="form-group">
            <label htmlFor={`${uid}-name`} className="form-label">Name</label>
            <input
              id={`${uid}-name`}
              type="text"
              className="form-input"
              placeholder="e.g., PM Interviewer: Analytics Case, Sales Coach: Enterprise Discovery"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
            />
          </div>

          {/* Slug */}
          <div className="form-group">
            <label htmlFor={`${uid}-slug`} className="form-label">
              ID / Slug <span className="form-hint">kebab-case, auto-generated from name</span>
            </label>
            <input
              id={`${uid}-slug`}
              type="text"
              className="form-input form-input-mono"
              placeholder="my-scenario-slug"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required
            />
          </div>

          {/* Visibility */}
          <div className="form-group form-inline">
            <label className="form-label">Visibility</label>
            <div className="radio-group">
              {(['private', 'public'] as const).map((v) => (
                <label key={v} className="radio-label">
                  <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Public Description */}
          <div className="form-group">
            <label htmlFor={`${uid}-desc`} className="form-label">Public Description</label>
            <textarea
              id={`${uid}-desc`}
              className="form-textarea"
              rows={3}
              placeholder="What participants see before starting — describe the scenario's purpose and what they'll practice."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* AI Instructions */}
          <div className="form-group">
            <label htmlFor={`${uid}-persona`} className="form-label">
              AI Instructions <span className="form-required">*</span>
            </label>
            <p className="form-hint-block">Define the AI&apos;s personality, tone, and conversation agenda. Include: 1) Role &amp; tone, 2) Questions to ask, 3) How to end the session.</p>
            <textarea
              id={`${uid}-persona`}
              className="form-textarea form-textarea-tall"
              rows={6}
              placeholder="You are a [role]. Your goal is to [objective]. Ask [types of questions]..."
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              required
            />
          </div>

          {/* Rubric */}
          <div className="form-group">
            <div className="form-row-head">
              <label className="form-label">Rubric <span className="form-optional">(Optional)</span></label>
              <button type="button" className="btn-ghost-sm" onClick={addRubricRow}>+ Add criterion</button>
            </div>
            {rubric.length === 0 && (
              <p className="form-hint-block">Add scored criteria to enable LLM-judge analysis after each session.</p>
            )}
            {rubric.map((row, i) => (
              <div key={i} className="rubric-row">
                <input
                  type="text"
                  className="form-input rubric-topic"
                  placeholder="Criterion name"
                  value={row.topic}
                  onChange={(e) => updateRubricRow(i, { topic: e.target.value })}
                />
                <input
                  type="number"
                  className="form-input rubric-weight"
                  placeholder="Weight %"
                  min={0}
                  max={100}
                  value={row.weight || ''}
                  onChange={(e) => updateRubricRow(i, { weight: Number(e.target.value) })}
                />
                <button type="button" className="btn-remove" onClick={() => removeRubricRow(i)} aria-label="Remove">×</button>
              </div>
            ))}
            {rubric.length > 0 && (
              <p className="form-hint rubric-total">
                Total weight: {rubric.reduce((s, r) => s + (r.weight || 0), 0)}% {rubric.reduce((s, r) => s + (r.weight || 0), 0) !== 100 ? '(must sum to 100 to publish)' : '✓'}
              </p>
            )}
          </div>

          {error && <div className="notice" role="alert">{error}</div>}

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting || !slug || !persona}>
              {submitting ? 'Creating…' : 'Create Scenario'}
            </button>
            <Link href="/library" className="btn-ghost">Cancel</Link>
          </div>
        </form>
      </div>

      {/* Right: Live Preview */}
      <aside className="studio-preview">
        <div className="preview-header">
          <span className="preview-dot red" /><span className="preview-dot amber" /><span className="preview-dot green" />
          <span className="preview-title">Live Preview</span>
        </div>
        <p className="preview-sub">Updates when you fill in the fields.</p>
        {preview ? (
          <div className="preview-card">
            <div className="preview-avatar" style={{ background: 'linear-gradient(135deg, #06b6d4, #0891b2)' }} />
            <h3 className="preview-name">{preview.name}</h3>
            <p className="preview-desc">{preview.description}</p>
            <div className="badges">
              <span className="badge">Private</span>
              <span className="badge sales">Practice</span>
            </div>
          </div>
        ) : (
          <div className="preview-empty">Fill in the Name to see a preview.</div>
        )}
      </aside>
    </div>
  );
}
