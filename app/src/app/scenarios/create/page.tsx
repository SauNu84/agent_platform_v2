'use client';

/**
 * Scenario Studio — Classic create form (SAU-214 board request).
 * Fields: Name → auto-slug, Public Description, AI Instructions, Rubric (optional rows), Visibility.
 * Submits JSON to POST /api/scenarios; on success redirects to the new scenario detail page.
 *
 * Remix (SAU-226): opened with `?remix={slug}` it fetches that scenario and
 * pre-fills the form from a cloned config (buildRemixConfig) so the user can edit
 * and save it as their own private draft — the same create path, no separate API.
 */
import { Suspense, useEffect, useState, useId } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { buildRemixConfig } from '@/services/remix';
import { AI_MODELS, DEFAULT_AI_MODEL } from '@/lib/ai-models';
import { OPENAI_VOICES, DEFAULT_VOICE, isOpenAiVoice } from '@/lib/voices';

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

/** Render structured rubric rows back into the free-text "Edit" tab (SAU-238). */
function rubricToText(rows: RubricRow[]): string {
  return rows
    .map((r) => `${r.topic}${r.weight ? ` — ${r.weight}%` : ''}${r.note ? `: ${r.note}` : ''}`)
    .join('\n');
}

function CreateScenarioForm() {
  const router = useRouter();
  const uid = useId();
  const remixFrom = useSearchParams().get('remix');

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  // SAU-238 (board ask #5): two fields from the reference Studio.
  // userInstructions = the human learner's brief (shown in the UI, NOT sent to the model);
  // aiDescription = the AI persona identity, prepended to AI Instructions in the model prompt.
  const [userInstructions, setUserInstructions] = useState('');
  const [aiDescription, setAiDescription] = useState('');
  const [persona, setPersona] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  // SAU-238 (ask #6): which AI model runs this scenario. OpenAI today; registry-extensible.
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  // SAU-238 (ask #10): Appearance — voice (real, wired to live) + static avatar image.
  const [voiceChoice, setVoiceChoice] = useState<string>(DEFAULT_VOICE);
  const [avatarUrl, setAvatarUrl] = useState('');
  // SAU-238 (ask #7): Additional Context for AI — reference text folded into the prompt.
  const [contextTab, setContextTab] = useState<'url' | 'pdf'>('pdf');
  const [contextUrl, setContextUrl] = useState('');
  const [aiContext, setAiContext] = useState('');         // extracted reference text (stored)
  const [contextSource, setContextSource] = useState(''); // where it came from (the URL)
  const [fetchingContext, setFetchingContext] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [rubric, setRubric] = useState<RubricRow[]>([]);
  // Rubric setting (SAU-238): a free-text "Edit" tab the author writes naturally,
  // and a "Processed" tab where an AI parses it into the structured rubric the
  // judge scores against. `rubric` (structured) stays canonical for submit.
  const [rubricTab, setRubricTab] = useState<'edit' | 'processed'>('edit');
  const [rubricOpen, setRubricOpen] = useState(true);
  const [rubricText, setRubricText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [rubricError, setRubricError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remix provenance (SAU-226): when seeded from a source scenario we carry the
  // cloned voice + metadata through submit so the draft is a faithful copy.
  const [remixedName, setRemixedName] = useState<string | null>(null);
  const [voice, setVoice] = useState<{ name: string; language: string } | null>(null);
  const [carriedMetadata, setCarriedMetadata] = useState<Record<string, unknown> | null>(null);

  // Pre-fill from the source scenario's config when opened as a remix.
  useEffect(() => {
    if (!remixFrom) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scenarios/${remixFrom}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Could not load "${remixFrom}" to remix`);
        if (cancelled) return;
        const draft = buildRemixConfig(data.scenario);
        setName(draft.name);
        setSlug(draft.slug);
        setDescription(draft.description ?? '');
        setPersona(draft.persona);
        setVisibility(draft.visibility);
        const rows = draft.rubric.map((r) => ({ topic: r.topic, weight: r.weight, note: r.note ?? '' }));
        setRubric(rows);
        setRubricText(rubricToText(rows));
        setVoice(draft.voice);
        setCarriedMetadata(draft.metadata);
        // SAU-238: carry the human brief + AI description through a remix.
        const md = (data.scenario.metadata ?? {}) as Record<string, unknown>;
        if (typeof md._userInstructions === 'string') setUserInstructions(md._userInstructions);
        if (typeof md._aiDescription === 'string') setAiDescription(md._aiDescription);
        if (typeof md._model === 'string') setAiModel(md._model);
        if (typeof md._aiContext === 'string') setAiContext(md._aiContext);
        if (typeof md._aiContextSource === 'string') { setContextSource(md._aiContextSource); setContextUrl(md._aiContextSource); }
        if (isOpenAiVoice(draft.voice?.name)) setVoiceChoice(draft.voice.name);
        if (typeof md._avatarUrl === 'string') setAvatarUrl(md._avatarUrl);
        setRemixedName(data.scenario.name);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [remixFrom]);

  function applyTemplate(t: Template) {
    setName(t.name);
    if (!slugEdited) setSlug(toSlug(t.name));
    setDescription(t.description);
    setPersona(t.persona);
    const rows = t.rubric.map((r) => ({ ...r }));
    setRubric(rows);
    setRubricText(rubricToText(rows));
    setError(null);
  }

  // Processed tab (SAU-238): parse the free-text rubric into structured criteria
  // via the AI authoring seam, then show the result for review in the Processed tab.
  // Additional Context for AI (SAU-238 ask #7): fetch a URL → extracted reference text.
  async function fetchContext() {
    if (!contextUrl.trim()) { setContextError('Enter a URL first.'); return; }
    setFetchingContext(true);
    setContextError(null);
    try {
      const res = await fetch('/api/authoring/fetch-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: contextUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setAiContext(data.text);
      setContextSource(data.source ?? contextUrl.trim());
    } catch (e) {
      setContextError((e as Error).message);
    } finally {
      setFetchingContext(false);
    }
  }

  // PDF context (SAU-238 ask #8): upload → real server-side text extraction.
  async function uploadPdf(file: File) {
    setFetchingContext(true);
    setContextError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/authoring/extract-pdf', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setAiContext(data.text);
      setContextSource(data.source ?? file.name);
    } catch (e) {
      setContextError((e as Error).message);
    } finally {
      setFetchingContext(false);
    }
  }

  function clearContext() {
    setAiContext('');
    setContextSource('');
    setContextError(null);
  }

  async function parseRubric() {
    if (!rubricText.trim()) { setRubricTab('edit'); setRubricError('Write the rubric in the Edit tab first.'); return; }
    setParsing(true);
    setRubricError(null);
    try {
      const res = await fetch('/api/authoring/parse-rubric', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rubricText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setRubric((data.rubric as RubricRow[]).map((r) => ({ topic: r.topic, weight: r.weight, note: r.note ?? '' })));
      setRubricTab('processed');
    } catch (e) {
      setRubricError((e as Error).message);
    } finally {
      setParsing(false);
    }
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
          // Remix carries the cloned voice + source metadata (incl. _remixedFrom);
          // a fresh scenario just marks itself user-authored. The raw rubric text
          // (SAU-238) rides along as `_rubricText` so the Processed rubric can be
          // generated on first session analysis if it was never processed by hand.
          // Appearance (SAU-238): the chosen OpenAI Realtime voice is wired into the
          // live session; keep the carried language if remixing.
          voice: { name: voiceChoice, language: voice?.language ?? 'en-US' },
          metadata: {
            ...(carriedMetadata ?? { _source: 'user' }),
            ...(avatarUrl.trim() ? { _avatarUrl: avatarUrl.trim() } : {}),
            ...(rubricText.trim() ? { _rubricText: rubricText.trim() } : {}),
            // SAU-238: human brief (UI only) + AI description (folded into the model prompt).
            ...(userInstructions.trim() ? { _userInstructions: userInstructions.trim() } : {}),
            ...(aiDescription.trim() ? { _aiDescription: aiDescription.trim() } : {}),
            _model: aiModel,
            ...(aiContext.trim() ? { _aiContext: aiContext.trim() } : {}),
            ...(contextSource.trim() ? { _aiContextSource: contextSource.trim() } : {}),
          },
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
          <span className="studio-mode-badge">{remixFrom ? 'Remix' : 'Classic'}</span>
        </nav>
        <h1 className="studio-title">{remixFrom ? 'Remix Scenario' : 'Scenario Studio'}</h1>

        {remixedName && (
          <div className="notice" role="status">
            Remixing <strong>{remixedName}</strong> — edit anything below and save it as your own
            private draft. It won&apos;t touch the original.
          </div>
        )}

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

          {/* AI Model (SAU-238 ask #6) — OpenAI today; registry-extensible */}
          <div className="form-group">
            <label htmlFor={`${uid}-model`} className="form-label">AI Model</label>
            <p className="form-hint-block">Which model powers this scenario. We run on <strong>OpenAI</strong> today; more providers are coming.</p>
            <select
              id={`${uid}-model`}
              className="form-input"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
            >
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}{m.badge ? ` — ${m.available ? m.badge : 'coming soon'}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Appearance (SAU-238 ask #10) — voice (real) + static avatar image */}
          <div className="form-group">
            <label className="form-label">Appearance <span className="form-optional">(Optional)</span></label>
            <p className="form-hint-block">How the agent sounds and looks. Voice is live; the avatar image shows in the detail page and the live-demo window.</p>
            <label htmlFor={`${uid}-voice`} className="form-label" style={{ fontSize: 13 }}>Voice</label>
            <select id={`${uid}-voice`} className="form-input" value={voiceChoice} onChange={(e) => setVoiceChoice(e.target.value)}>
              {OPENAI_VOICES.map((v) => (
                <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}{v === DEFAULT_VOICE ? ' (default)' : ''}</option>
              ))}
            </select>
            <label htmlFor={`${uid}-avatar`} className="form-label" style={{ fontSize: 13, marginTop: 12 }}>Custom Avatar (Static Image)</label>
            <div className="rubric-row">
              <input
                id={`${uid}-avatar`}
                type="url"
                className="form-input rubric-topic"
                placeholder="https://…/avatar.png — image URL for the agent"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
              />
              {avatarUrl.trim() && /^https?:\/\//.test(avatarUrl) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" width={40} height={40} style={{ borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border)' }} />
              )}
            </div>
            <p className="form-hint">Animated / video &ldquo;live avatars&rdquo; (lip-sync) are a premium 3rd-party feature — not in this build.</p>
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

          {/* User Instruction (SAU-238) — shown to the human learner, NOT sent to the agent */}
          <div className="form-group">
            <label htmlFor={`${uid}-userinstr`} className="form-label">User Instruction</label>
            <p className="form-hint-block">The learner&apos;s brief — their goal and what to do in this scenario. Shown to the user before/during the session; <strong>not</strong> sent to the AI (so it can&apos;t see the playbook).</p>
            <textarea
              id={`${uid}-userinstr`}
              className="form-textarea"
              rows={4}
              placeholder="Your Goal: e.g., Convince the VP of Engineering to adopt your tool. They're skeptical and short on time — lead with proof."
              value={userInstructions}
              onChange={(e) => setUserInstructions(e.target.value)}
            />
          </div>

          {/* Description for AI (SAU-238) — persona identity, prepended to the model prompt */}
          <div className="form-group">
            <label htmlFor={`${uid}-aidesc`} className="form-label">Description for AI</label>
            <p className="form-hint-block">Who the AI <em>is</em> — a short persona identity. This is prepended to the AI Instructions in the system prompt the model receives, so it <strong>does</strong> shape the agent.</p>
            <textarea
              id={`${uid}-aidesc`}
              className="form-textarea"
              rows={4}
              placeholder="You are Alex Chen, VP of Engineering at a 75-person company. Cost-conscious, risk-averse, currently happy with your existing tooling."
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
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

          {/* Additional Context for AI (SAU-238 ask #7) — grounding folded into the prompt */}
          <div className="form-group">
            <label className="form-label">Additional Context for AI</label>
            <p className="form-hint-block">Attach reference material the agent should treat as ground truth (a product page, spec, policy). It&apos;s folded into the AI&apos;s system prompt, so it <strong>does</strong> improve answers.</p>
            <div className="tabs" role="tablist">
              {([['pdf', '📄 PDF'], ['url', '🔗 URL']] as const).map(([id, lbl]) => (
                <button
                  key={id} type="button" role="tab" aria-selected={contextTab === id}
                  className={`tab ${contextTab === id ? 'active' : ''}`}
                  onClick={() => setContextTab(id)}
                >{lbl}</button>
              ))}
            </div>
            <div className="tab-body">
              {aiContext ? (
                <div className="report-panel">
                  <p className="form-hint-block" style={{ margin: 0 }}>
                    ✓ Context attached{contextSource ? <> from {/^https?:\/\//.test(contextSource)
                      ? <a href={contextSource} target="_blank" rel="noreferrer">{contextSource}</a>
                      : <strong>{contextSource}</strong>}</> : ''} — <strong>{aiContext.length.toLocaleString()}</strong> chars.
                  </p>
                  <p className="ld-sim" style={{ marginTop: 6 }}>{aiContext.slice(0, 240)}{aiContext.length > 240 ? '…' : ''}</p>
                  <button type="button" className="btn-ghost-sm" onClick={clearContext}>Remove context</button>
                </div>
              ) : contextTab === 'pdf' ? (
                <>
                  <label className="btn-sm" style={{ cursor: 'pointer', display: 'inline-block' }}>
                    {fetchingContext ? 'Reading PDF…' : '⬆ Upload PDF context'}
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      style={{ display: 'none' }}
                      disabled={fetchingContext}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPdf(f); e.target.value = ''; }}
                    />
                  </label>
                  <p className="form-hint">We extract the PDF&apos;s text and fold it into the AI&apos;s system prompt. (Scanned/image-only PDFs have no extractable text.)</p>
                </>
              ) : (
                <>
                  <div className="rubric-row">
                    <input
                      type="url"
                      className="form-input rubric-topic"
                      placeholder="https://example.com/page-the-agent-should-know"
                      value={contextUrl}
                      onChange={(e) => setContextUrl(e.target.value)}
                    />
                    <button type="button" className="btn-sm" onClick={fetchContext} disabled={fetchingContext || !contextUrl.trim()}>
                      {fetchingContext ? 'Fetching…' : 'Fetch'}
                    </button>
                  </div>
                  <p className="form-hint">Paste a public web page URL — we extract its readable text.</p>
                </>
              )}
              {contextError && <div className="notice" role="alert">{contextError}</div>}
            </div>
          </div>

          {/* Rubrik (SAU-238): Edit (free text) + Processed (AI-parsed structure) */}
          <div className="form-group">
            <button
              type="button"
              className="rubric-collapse"
              aria-expanded={rubricOpen}
              onClick={() => setRubricOpen((o) => !o)}
            >
              <span className="rubric-chevron" aria-hidden="true">{rubricOpen ? '⌄' : '›'}</span>
              <span className="rubric-icon" aria-hidden="true">📋</span>
              <span className="form-label" style={{ margin: 0 }}>Rubrik <span className="form-optional">(Optional)</span></span>
            </button>

            {rubricOpen && (
              <>
                <p className="form-hint-block rubric-info">
                  <span aria-hidden="true">ⓘ </span>Processed rubrik will be generated on first session analysis.
                </p>

                <div className="tabs" role="tablist">
                  <button
                    type="button" role="tab" aria-selected={rubricTab === 'edit'}
                    className={`tab ${rubricTab === 'edit' ? 'active' : ''}`}
                    onClick={() => setRubricTab('edit')}
                  ><span aria-hidden="true">✎</span> Edit</button>
                  <button
                    type="button" role="tab" aria-selected={rubricTab === 'processed'}
                    className={`tab ${rubricTab === 'processed' ? 'active' : ''}`}
                    onClick={() => setRubricTab('processed')}
                  ><span aria-hidden="true">✦</span> Processed{rubric.length ? ` (${rubric.length})` : ''}</button>
                </div>

                {rubricTab === 'edit' ? (
                  <div className="tab-body">
                    <p className="form-hint-block">
                      Describe what a good session looks like in plain language — one criterion per line.
                      Add an importance like <code>40%</code> if you want; the AI fills in the rest.
                    </p>
                    <textarea
                      className="form-textarea form-textarea-tall"
                      rows={6}
                      placeholder={'Communication clarity — explains ideas simply: 40%\nTechnical depth — backs claims with specifics\nHandles objections calmly'}
                      value={rubricText}
                      onChange={(e) => setRubricText(e.target.value)}
                    />
                    <div className="rubric-actions">
                      <button type="button" className="btn-sm rubric-process" onClick={parseRubric} disabled={parsing || !rubricText.trim()}>
                        <span aria-hidden="true">✦</span> {parsing ? 'Processing…' : 'Process Rubrik'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="tab-body">
                    {rubric.length === 0 ? (
                      <div className="report-panel rubric-empty">
                        <button type="button" className="btn-sm rubric-process" onClick={parseRubric} disabled={parsing}>
                          <span aria-hidden="true">✦</span> {parsing ? 'Processing…' : 'Process Rubrik'}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="form-row-head">
                          <p className="form-hint-block" style={{ margin: 0 }}>AI-parsed criteria — review and adjust before saving.</p>
                          <button type="button" className="btn-ghost-sm" onClick={addRubricRow}>+ Add criterion</button>
                        </div>
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
                        <p className="form-hint rubric-total">
                          Total weight: {rubric.reduce((s, r) => s + (r.weight || 0), 0)}% {rubric.reduce((s, r) => s + (r.weight || 0), 0) !== 100 ? '(must sum to 100 to publish)' : '✓'}
                        </p>
                      </>
                    )}
                  </div>
                )}
                {rubricError && <div className="notice" role="alert">{rubricError}</div>}
              </>
            )}
          </div>

          {error && <div className="notice" role="alert">{error}</div>}

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting || !slug || !persona}>
              {submitting ? 'Creating…' : remixFrom ? 'Save Remix' : 'Create Scenario'}
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

// useSearchParams (remix) requires a Suspense boundary at the route level.
export default function CreateScenarioPage() {
  return (
    <Suspense fallback={null}>
      <CreateScenarioForm />
    </Suspense>
  );
}
