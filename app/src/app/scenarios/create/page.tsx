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
import { AI_MODELS, DEFAULT_AI_MODEL, aiModelById } from '@/lib/ai-models';
import { OPENAI_VOICES, DEFAULT_VOICE, isOpenAiVoice } from '@/lib/voices';
import { AGENT_TYPE_OPTIONS } from '@/domain/super-agent';
import { TOOL_REGISTRY } from '@/domain/scenario';
import {
  selectImportableAgents, buildSubAgentFromScenario, type ImportableAgent,
} from '@/services/super-agent-import';

interface RubricRow { topic: string; weight: number; note: string; }

/**
 * A sub-agent row in the Super Agent authoring form (SAU-307). `droppedTools`
 * (SAU-327) records tool names a snapshot import couldn't carry, so the row can
 * surface a one-time note; it is display-only and not part of the saved config.
 */
interface SubAgentRow { id: string; name: string; instructions: string; tools: string[]; model: string; droppedTools?: string[]; }

/** Tool names an author can attach to a sub-agent (the built-in registry). */
const TOOL_NAMES = Object.keys(TOOL_REGISTRY);

let subAgentSeq = 0;
function newSubAgent(): SubAgentRow {
  subAgentSeq += 1;
  return { id: `sa-${subAgentSeq}`, name: '', instructions: '', tools: [], model: '' };
}

/** A Knowledge Base summary as returned by /api/knowledge-bases (SAU-243). */
interface KbSummary { id: string; title: string; description: string | null; docCount: number; }

const KB_ACCEPT = '.pdf,.docx,.txt';
const KB_MAX_BYTES = 25 * 1024 * 1024;

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

/**
 * Settings tabs (SAU-238 ask #12 — Product Expert redesign): the form was a flat
 * scroll of accordions with required + optional fields interleaved. We group fields
 * by the question the author is answering. Tabs ARE the progressive disclosure, so
 * there are no nested accordions inside. Required fields live in Basics + AI Agent;
 * submit jumps to the tab holding the first invalid field.
 */
const SETTINGS_TABS = [
  { id: 'basics', label: 'Basics', icon: '🧩', blurb: 'Name, link, and who can see this scenario.' },
  { id: 'agent', label: 'AI Agent', icon: '🤖', blurb: 'Who the AI is, how it behaves, and what it knows.' },
  { id: 'session', label: 'Session & Scoring', icon: '🎯', blurb: 'What the learner is told, and how the session is graded.' },
  { id: 'appearance', label: 'Voice & Look', icon: '🎙', blurb: 'How the agent sounds and appears.' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

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

  // Which settings tab is showing (SAU-238 redesign). Basics first.
  const [tab, setTab] = useState<SettingsTab>('basics');
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
  // Agent type (SAU-307): the platform's second agent type. 'default' = single
  // agent (the fields above). 'super' = a supervisor orchestrating inline
  // sub-agents. Composite / Meeting Assistant are board-deferred (shown disabled).
  const [agentType, setAgentType] = useState<'default' | 'super'>('default');
  const [superRole, setSuperRole] = useState('');
  const [superGoal, setSuperGoal] = useState('');
  const [superInstructions, setSuperInstructions] = useState('');
  const [superCommon, setSuperCommon] = useState('');
  const [subAgents, setSubAgents] = useState<SubAgentRow[]>([]);
  // SAU-327: "Add from existing agent…" — snapshot-import one of the author's
  // Default agents as a new sub-agent row. The picker fetches the author's
  // scenarios lazily on first open via the existing GET /api/scenarios.
  const [importOpen, setImportOpen] = useState(false);
  const [importAgents, setImportAgents] = useState<ImportableAgent[]>([]);
  const [importPickId, setImportPickId] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  // SAU-238 (ask #6) → SAU-258: which voice engine powers this scenario (real
  // multi-vendor picker). The stored id is the scenario default; tier gating means
  // premium engines are selectable only by paid authors (free → cost engines).
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  // The author's own voice tier, used to gate premium engines in the picker.
  // SAU-557: only true when a paid plan would ACTUALLY run a different model (server-derived).
  const [engineUpgradeAvailable, setEngineUpgradeAvailable] = useState(false);
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
  // Knowledge Base (SAU-243): reusable multi-doc corpus linked to this scenario.
  // Linked KBs are held in form state and persisted (linked) on submit via
  // `knowledgeBaseIds`; the scenario doesn't exist yet at create time.
  const [kbOpen, setKbOpen] = useState(false);
  const [linkedKbs, setLinkedKbs] = useState<KbSummary[]>([]);
  const [availableKbs, setAvailableKbs] = useState<KbSummary[]>([]);
  const [kbPickId, setKbPickId] = useState('');
  const [kbLoading, setKbLoading] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  // Create Knowledge Base modal.
  const [showKbModal, setShowKbModal] = useState(false);
  const [kbTitle, setKbTitle] = useState('');
  const [kbDesc, setKbDesc] = useState('');
  const [kbFiles, setKbFiles] = useState<File[]>([]);
  const [kbDragOver, setKbDragOver] = useState(false);
  const [kbCreating, setKbCreating] = useState(false);
  const [rubric, setRubric] = useState<RubricRow[]>([]);
  // Rubric setting (SAU-238): a free-text "Edit" tab the author writes naturally,
  // and a "Processed" tab where an AI parses it into the structured rubric the
  // judge scores against. `rubric` (structured) stays canonical for submit.
  const [rubricTab, setRubricTab] = useState<'edit' | 'processed'>('edit');
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

  // ── AI Studio (SAU-244) — conversational authoring alongside the Classic form.
  // The form state above is the single source of truth: the copilot proposes
  // patches that flow into these same setters, and state persists across the
  // Classic⇄AI toggle (it's one component). New scenarios land in AI Studio (the
  // differentiator, spec D3); a remix opens Classic since it's already pre-filled.
  const [studioMode, setStudioMode] = useState<'classic' | 'ai'>(remixFrom ? 'classic' : 'ai');
  const [rightTab, setRightTab] = useState<'form' | 'preview'>('form');
  const [copilotInput, setCopilotInput] = useState('');
  const [copilotEffort, setCopilotEffort] = useState<'flash' | 'deep'>('flash');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotTurns, setCopilotTurns] = useState<
    { role: 'user' | 'copilot'; text: string; ok?: boolean }[]
  >([]);

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
        // SAU-307: carry a Super Agent's supervisor + sub-agents into the remix.
        if (md._agentType === 'super' && md._superAgent && typeof md._superAgent === 'object') {
          const cfg = md._superAgent as {
            supervisor?: { role?: string; goal?: string; instructions?: string; commonInstructions?: string };
            subAgents?: Array<{ id?: string; name?: string; instructions?: string; tools?: string[]; model?: string }>;
          };
          setAgentType('super');
          setSuperRole(cfg.supervisor?.role ?? '');
          setSuperGoal(cfg.supervisor?.goal ?? '');
          setSuperInstructions(cfg.supervisor?.instructions ?? '');
          setSuperCommon(cfg.supervisor?.commonInstructions ?? '');
          setSubAgents((cfg.subAgents ?? []).map((s) => ({
            ...newSubAgent(),
            name: s.name ?? '', instructions: s.instructions ?? '',
            tools: Array.isArray(s.tools) ? s.tools : [], model: s.model ?? '',
          })));
        }
        setRemixedName(data.scenario.name);
        // Carry the source scenario's linked Knowledge Bases into the remix
        // (SAU-243); the auto-link on submit silently drops any the user can't use.
        try {
          const kbRes = await fetch(`/api/scenarios/${remixFrom}/knowledge-bases`);
          if (kbRes.ok) {
            const kbData = await kbRes.json();
            if (!cancelled && Array.isArray(kbData.knowledgeBases)) { setLinkedKbs(kbData.knowledgeBases); setKbOpen(kbData.knowledgeBases.length > 0); }
          }
        } catch { /* non-fatal */ }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [remixFrom]);

  // SAU-258/557: ask the meter whether upgrading would actually change the engine.
  // Falls back to "no" (no quality claim) if the meter isn't available.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/voice/usage');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.meter?.tier) return;
        setEngineUpgradeAvailable(data.meter.engineUpgradeAvailable === true);
      } catch { /* non-fatal — no upgrade claim */ }
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

  // ── Knowledge Base (SAU-243) ──────────────────────────────────────────────
  async function loadAvailableKbs() {
    setKbLoading(true);
    setKbError(null);
    try {
      const res = await fetch('/api/knowledge-bases');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setAvailableKbs(data.knowledgeBases ?? []);
    } catch (e) {
      setKbError((e as Error).message);
    } finally {
      setKbLoading(false);
    }
  }

  function toggleKb() {
    const next = !kbOpen;
    setKbOpen(next);
    if (next && availableKbs.length === 0) loadAvailableKbs();
  }

  function linkExisting() {
    const kb = availableKbs.find((k) => k.id === kbPickId);
    if (!kb || linkedKbs.some((l) => l.id === kb.id)) return;
    setLinkedKbs((l) => [...l, kb]);
    setKbPickId('');
  }

  function unlinkKb(id: string) {
    setLinkedKbs((l) => l.filter((k) => k.id !== id));
  }

  function addKbFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((f) => f.size <= KB_MAX_BYTES && /\.(pdf|docx|txt)$/i.test(f.name));
    const rejected = Array.from(files).length - incoming.length;
    if (rejected > 0) setKbError(`${rejected} file(s) skipped — must be .pdf/.docx/.txt and ≤25MB.`);
    setKbFiles((prev) => [...prev, ...incoming]);
  }

  async function createKb() {
    if (!kbTitle.trim()) { setKbError('Title is required.'); return; }
    setKbCreating(true);
    setKbError(null);
    try {
      const res = await fetch('/api/knowledge-bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: kbTitle.trim(), description: kbDesc.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      const kb: KbSummary = data.knowledgeBase;
      // Upload each chosen document into the new KB.
      let uploaded = 0;
      for (const file of kbFiles) {
        const fd = new FormData();
        fd.append('file', file);
        const up = await fetch(`/api/knowledge-bases/${kb.id}/documents`, { method: 'POST', body: fd });
        if (up.ok) uploaded += 1;
        else { const ed = await up.json().catch(() => ({})); setKbError(`“${file.name}”: ${ed.error ?? up.status}`); }
      }
      const linked: KbSummary = { ...kb, docCount: uploaded };
      setLinkedKbs((l) => [...l, linked]);
      setAvailableKbs((a) => [linked, ...a]);
      // Reset + close the modal.
      setShowKbModal(false);
      setKbTitle(''); setKbDesc(''); setKbFiles([]);
    } catch (e) {
      setKbError((e as Error).message);
    } finally {
      setKbCreating(false);
    }
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

  // ── AI Studio copilot (SAU-244) ───────────────────────────────────────────
  /** Push a returned field set into the form (the copilot's proposed patch). */
  function applyFields(f: {
    name: string; description: string; userInstructions: string;
    aiDescription: string; persona: string; rubric: RubricRow[];
  }) {
    setName(f.name);
    if (!slugEdited && f.name) setSlug(toSlug(f.name));
    setDescription(f.description);
    setUserInstructions(f.userInstructions);
    setAiDescription(f.aiDescription);
    setPersona(f.persona);
    const rows = f.rubric.map((r) => ({ topic: r.topic, weight: r.weight, note: r.note ?? '' }));
    setRubric(rows);
    setRubricText(rubricToText(rows));
  }

  /** True when the draft is empty enough to treat a prompt as "generate from scratch". */
  function draftIsEmpty(): boolean {
    return !name.trim() && !persona.trim() && !description.trim()
      && !aiDescription.trim() && !userInstructions.trim()
      && rubric.filter((r) => r.topic.trim()).length === 0;
  }

  /**
   * Run one copilot turn. Intent is auto-detected: an empty draft generates from
   * scratch (/api/authoring/generate); an existing draft is edited in place
   * (/api/authoring/edit). Either way the copilot proposes — it never publishes.
   */
  async function runCopilot() {
    const instruction = copilotInput.trim();
    if (!instruction || copilotBusy) return;
    setCopilotBusy(true);
    setCopilotInput('');
    setCopilotTurns((t) => [...t, { role: 'user', text: instruction }]);
    const generate = draftIsEmpty();
    try {
      if (generate) {
        const res = await fetch('/api/authoring/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'scenario', topic: instruction, visibility, effort: copilotEffort }),
        });
        const data = await res.json();
        const draft = data.draft;
        if (!res.ok || !draft?.ok) {
          const msg = draft?.errors ?? data.error ?? `Error ${res.status}`;
          setCopilotTurns((t) => [...t, { role: 'copilot', text: `Couldn't generate a valid draft: ${msg}`, ok: false }]);
        } else {
          const rec = draft.record;
          applyFields({
            name: rec.name ?? '',
            description: rec.description ?? '',
            userInstructions: '',
            aiDescription: '',
            persona: rec.aiInstructions ?? '',
            rubric: (rec.rubric ?? []).map((r: RubricRow) => ({ topic: r.topic, weight: r.weight, note: r.note ?? '' })),
          });
          setCopilotTurns((t) => [...t, { role: 'copilot', text: `Drafted “${rec.name}” — review and refine any field, or tell me what to change.`, ok: true }]);
        }
      } else {
        const fields = {
          name, description, userInstructions, aiDescription, persona,
          rubric: rubric.filter((r) => r.topic.trim()),
        };
        const res = await fetch('/api/authoring/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft: fields, instruction, effort: copilotEffort }),
        });
        const data = await res.json();
        const draft = data.draft;
        if (!draft) {
          setCopilotTurns((t) => [...t, { role: 'copilot', text: data.error ?? `Error ${res.status}`, ok: false }]);
        } else {
          // Apply the proposed patch either way; flag validation problems so the
          // author can hand-fix (the copilot never blocks the form).
          applyFields({
            name: draft.fields.name, description: draft.fields.description,
            userInstructions: draft.fields.userInstructions, aiDescription: draft.fields.aiDescription,
            persona: draft.fields.persona,
            rubric: (draft.fields.rubric ?? []).map((r: RubricRow) => ({ topic: r.topic, weight: r.weight, note: r.note ?? '' })),
          });
          const text = draft.ok ? draft.summary : `${draft.summary} ⚠ Needs a fix before publishing: ${draft.errors}`;
          setCopilotTurns((t) => [...t, { role: 'copilot', text, ok: draft.ok }]);
        }
      }
    } catch (e) {
      setCopilotTurns((t) => [...t, { role: 'copilot', text: (e as Error).message, ok: false }]);
    } finally {
      setCopilotBusy(false);
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

  // ── Super Agent sub-agent row mutations (SAU-307) ──────────────────────────
  function addSubAgent() { setSubAgents((s) => [...s, newSubAgent()]); }
  function removeSubAgent(id: string) { setSubAgents((s) => s.filter((r) => r.id !== id)); }
  function updateSubAgent(id: string, patch: Partial<SubAgentRow>) {
    setSubAgents((s) => s.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function toggleSubAgentTool(id: string, tool: string) {
    setSubAgents((s) => s.map((r) =>
      r.id === id ? { ...r, tools: r.tools.includes(tool) ? r.tools.filter((t) => t !== tool) : [...r.tools, tool] } : r,
    ));
  }

  // ── Snapshot import of an existing Default agent (SAU-327) ─────────────────
  // Fetch the author's scenarios (lazily, on first open) and keep only the
  // Default agents they can import (excludes Super Agents + the scenario being
  // remixed, to avoid self-nesting). Pure selection lives in the import service.
  async function toggleImport() {
    const next = !importOpen;
    setImportOpen(next);
    if (next && importAgents.length === 0 && !importLoading) {
      setImportLoading(true);
      setImportError(null);
      try {
        const res = await fetch('/api/scenarios');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
        setImportAgents(selectImportableAgents<ImportableAgent>(data.scenarios ?? [], remixFrom));
      } catch (e) {
        setImportError((e as Error).message);
      } finally {
        setImportLoading(false);
      }
    }
  }

  /** Copy the picked agent into a new, fully-editable sub-agent row (snapshot). */
  function importSelected() {
    const agent = importAgents.find((a) => a.slug === importPickId);
    if (!agent) return;
    const snapshot = buildSubAgentFromScenario(agent);
    setSubAgents((s) => [...s, {
      ...newSubAgent(),
      name: snapshot.name,
      instructions: snapshot.instructions,
      tools: snapshot.tools,
      model: snapshot.model,
      ...(snapshot.droppedTools.length ? { droppedTools: snapshot.droppedTools } : {}),
    }]);
    setImportPickId('');
    setImportOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) { setTab('basics'); setError('ID / Slug is required.'); return; }
    if (agentType === 'super') {
      // Super Agent (SAU-307): the supervisor + ≥1 fully-specified sub-agent is
      // required; the single-agent "AI Instructions" field is not used here.
      if (!superRole.trim() || !superGoal.trim() || !superInstructions.trim()) {
        setTab('agent'); setError('Super Agent needs a supervisor Role, Goal, and Instructions.'); return;
      }
      const clean = subAgents.filter((s) => s.name.trim() && s.instructions.trim());
      if (clean.length === 0) {
        setTab('agent'); setError('Super Agent needs at least one sub-agent with a name and instructions.'); return;
      }
    } else if (!persona) {
      setTab('agent'); setError('AI Instructions are required.'); return;
    }
    setSubmitting(true);
    setError(null);
    // Super Agent (SAU-307): build the structured config and a persona fallback.
    // The scenario row still needs a non-empty `persona`/aiInstructions (schema
    // invariant); for a supervisor we seed it from the supervisor role/goal so the
    // row is valid, while the REAL prompt is compiled server-side from _superAgent.
    const superCfg = agentType === 'super'
      ? {
          supervisor: {
            role: superRole.trim(),
            goal: superGoal.trim(),
            instructions: superInstructions.trim(),
            commonInstructions: superCommon.trim(),
          },
          subAgents: subAgents
            .filter((s) => s.name.trim() && s.instructions.trim())
            .map((s) => ({
              id: s.id,
              name: s.name.trim(),
              instructions: s.instructions.trim(),
              tools: s.tools,
              ...(s.model ? { model: s.model } : {}),
            })),
        }
      : null;
    const personaToSend = agentType === 'super'
      ? (persona.trim() || `Supervisor: ${superRole.trim()} — ${superGoal.trim()}`)
      : persona;
    try {
      const res = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: slug,
          name: name || slug,
          description: description || undefined,
          persona: personaToSend,
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
            // Strip any carried agent-type keys (SAU-307) so a remix that flips
            // back to Default can't persist a stale supervisor config; the live
            // `superCfg` spread below is the single source of truth when 'super'.
            ...(() => {
              const base: Record<string, unknown> = { ...(carriedMetadata ?? { _source: 'user' }) };
              delete base._agentType; delete base._superAgent;
              return base;
            })(),
            ...(avatarUrl.trim() ? { _avatarUrl: avatarUrl.trim() } : {}),
            ...(rubricText.trim() ? { _rubricText: rubricText.trim() } : {}),
            // SAU-238: human brief (UI only) + AI description (folded into the model prompt).
            ...(userInstructions.trim() ? { _userInstructions: userInstructions.trim() } : {}),
            ...(aiDescription.trim() ? { _aiDescription: aiDescription.trim() } : {}),
            _model: aiModel,
            ...(aiContext.trim() ? { _aiContext: aiContext.trim() } : {}),
            ...(contextSource.trim() ? { _aiContextSource: contextSource.trim() } : {}),
            // Super Agent (SAU-307): the type discriminator + structured config.
            ...(superCfg ? { _agentType: 'super', _superAgent: superCfg } : {}),
          },
          // Knowledge Base links (SAU-243) — linked server-side after create.
          knowledgeBaseIds: linkedKbs.map((k) => k.id),
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
    <div className="studio-shell">
      <nav className="studio-nav">
        <Link href="/library" className="back-link">← Scenarios</Link>
        {/* Mode toggle (SAU-244): Classic ⇄ AI Studio. Form state is shared, so
            it persists across the switch — no data loss either direction. */}
        <div className="studio-modetoggle" role="tablist" aria-label="Authoring mode">
          <button
            type="button" role="tab" aria-selected={studioMode === 'ai'}
            className={`studio-modebtn ${studioMode === 'ai' ? 'active' : ''}`}
            onClick={() => setStudioMode('ai')}
          ><span aria-hidden="true">✦</span> AI Studio</button>
          <button
            type="button" role="tab" aria-selected={studioMode === 'classic'}
            className={`studio-modebtn ${studioMode === 'classic' ? 'active' : ''}`}
            onClick={() => setStudioMode('classic')}
          >Classic</button>
        </div>
        {remixFrom && <span className="studio-mode-badge">Remix</span>}
      </nav>
      <h1 className="studio-title">{remixFrom ? 'Remix Scenario' : 'Scenario Studio'}</h1>

      {remixedName && (
        <div className="notice" role="status">
          Remixing <strong>{remixedName}</strong> — edit anything below and save it as your own
          private draft. It won&apos;t touch the original.
        </div>
      )}

      <div className={studioMode === 'ai' ? 'aistudio-layout' : 'studio-layout'}>
        {/* ── AI Studio copilot pane (left) ── */}
        {studioMode === 'ai' && (
          <section className="copilot-pane" aria-label="AI authoring copilot">
            <div className="copilot-head">
              <p className="copilot-title">Ask me to draft or edit your scenario…</p>
              <p className="copilot-sub">I fill the form on the right. You stay in control — nothing is published until you click Save.</p>
            </div>

            <div className="copilot-log" aria-live="polite">
              {copilotTurns.length === 0 ? (
                <div className="copilot-empty">
                  <p>Try:</p>
                  <ul>
                    <li>“A skeptical enterprise CFO who stalls on price”</li>
                    <li>“Make the persona more aggressive on objections”</li>
                    <li>“Add a rubric criterion for active listening”</li>
                  </ul>
                </div>
              ) : (
                copilotTurns.map((turn, i) => (
                  <div key={i} className={`copilot-turn ${turn.role}${turn.ok === false ? ' err' : ''}`}>
                    {turn.role === 'copilot' && <span className="copilot-tag">{turn.ok === false ? '⚠' : '✦'} what changed</span>}
                    <p>{turn.text}</p>
                  </div>
                ))
              )}
              {copilotBusy && <div className="copilot-turn copilot"><p className="copilot-thinking">Working…</p></div>}
            </div>

            <div className="copilot-inputbar">
              <textarea
                className="form-textarea"
                rows={3}
                placeholder={draftIsEmpty() ? 'Describe the scenario you want to practice…' : 'Describe how you’d like to edit your scenario…'}
                value={copilotInput}
                onChange={(e) => setCopilotInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runCopilot(); } }}
                disabled={copilotBusy}
              />
              <div className="copilot-controls">
                <div className="copilot-effort" role="group" aria-label="Model effort">
                  <button
                    type="button"
                    className={`effort-chip ${copilotEffort === 'flash' ? 'active' : ''}`}
                    aria-pressed={copilotEffort === 'flash'}
                    title="Fast, low-cost model"
                    onClick={() => setCopilotEffort('flash')}
                  ><span aria-hidden="true">⚡</span> Flash</button>
                  <button
                    type="button"
                    className={`effort-chip ${copilotEffort === 'deep' ? 'active' : ''}`}
                    aria-pressed={copilotEffort === 'deep'}
                    title="Higher-effort model with extended reasoning. Live web retrieval arrives in Phase 2."
                    onClick={() => setCopilotEffort('deep')}
                  ><span aria-hidden="true">🔬</span> Deep Research</button>
                </div>
                <button type="button" className="btn copilot-send" onClick={runCopilot} disabled={copilotBusy || !copilotInput.trim()}>
                  {copilotBusy ? '…' : '↑ Send'}
                </button>
              </div>
              <p className="form-hint" style={{ marginLeft: 0 }}>⌘/Ctrl + Enter to send{copilotEffort === 'deep' ? ' · Deep = high-effort model (no live web in this build)' : ''}</p>
            </div>
          </section>
        )}

        {/* ── Form pane (right in AI Studio, sole pane in Classic) ── */}
        <div className="studio-form">
          {studioMode === 'ai' && (
            <div className="aistudio-subtabs" role="tablist" aria-label="Editor view">
              <button type="button" role="tab" aria-selected={rightTab === 'form'} className={`tab ${rightTab === 'form' ? 'active' : ''}`} onClick={() => setRightTab('form')}><span aria-hidden="true">📝</span> Form</button>
              <button type="button" role="tab" aria-selected={rightTab === 'preview'} className={`tab ${rightTab === 'preview' ? 'active' : ''}`} onClick={() => setRightTab('preview')}><span aria-hidden="true">👁</span> Preview</button>
              <button type="button" className="tab" disabled title="Raw Markdown export — coming in Phase 2"><span aria-hidden="true">⧉</span> Copy</button>
            </div>
          )}

          {(studioMode === 'classic' || rightTab === 'form') && (
          <>
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
          {/* Settings tab nav (SAU-238 redesign) — group fields by intent. */}
          <div className="studio-tabnav" role="tablist" aria-label="Scenario settings">
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`studio-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span aria-hidden="true">{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          <p className="studio-tab-blurb">{SETTINGS_TABS.find((t) => t.id === tab)?.blurb}</p>

          {/* ── Basics ─────────────────────────────────────────────── */}
          {tab === 'basics' && (
          <div className="studio-pane">
          {/* Name */}
          <div className="form-group">
            <label htmlFor={`${uid}-name`} className="form-label">Name <span className="form-required">*</span></label>
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
              ID / Slug <span className="form-required">*</span> <span className="form-hint">kebab-case, auto-generated from name</span>
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
            <label htmlFor={`${uid}-desc`} className="form-label">Public Description <span className="form-optional">(Optional)</span></label>
            <textarea
              id={`${uid}-desc`}
              className="form-textarea"
              rows={3}
              placeholder="What participants see before starting — describe the scenario's purpose and what they'll practice."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          </div>
          )}

          {/* ── AI Agent ───────────────────────────────────────────── */}
          {tab === 'agent' && (
          <div className="studio-pane">
          {/* Agent Type (SAU-307) — Default | Super Agent | Composite/Meeting (soon). */}
          <div className="form-group">
            <label className="form-label">Type</label>
            <p className="form-hint-block">A <strong>Default</strong> agent is one persona with one set of tools and voice. A <strong>Super Agent</strong> is a supervisor that orchestrates several inline sub-agents and switches between them per a strategy you describe.</p>
            <div className="radio-group" role="radiogroup" aria-label="Agent type">
              {AGENT_TYPE_OPTIONS.map((opt) => (
                <label key={opt.id} className="radio-label" title={opt.blurb} style={!opt.available ? { opacity: 0.5 } : undefined}>
                  <input
                    type="radio" name="agentType" value={opt.id}
                    disabled={!opt.available}
                    checked={agentType === opt.id}
                    onChange={() => { if (opt.id === 'default' || opt.id === 'super') setAgentType(opt.id); }}
                  />
                  {opt.label}{!opt.available ? ' (soon)' : ''}
                </label>
              ))}
            </div>
          </div>

          {agentType === 'default' && (<>
          {/* Description for AI (SAU-238) — persona identity, prepended to the model prompt */}
          <div className="form-group">
            <label htmlFor={`${uid}-aidesc`} className="form-label">Description for AI <span className="form-optional">(Optional)</span></label>
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
            />
          </div>
          </>)}

          {agentType === 'super' && (<>
          {/* ── Supervisor (SAU-307) ── */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '1.05em' }}>🧭 Supervisor</label>
            <p className="form-hint-block">The supervisor coordinates the sub-agents below — it decides which one handles each part of the conversation and switches between them.</p>
          </div>
          <div className="form-group">
            <label htmlFor={`${uid}-sup-role`} className="form-label">Role <span className="form-required">*</span></label>
            <textarea id={`${uid}-sup-role`} className="form-textarea" rows={2}
              placeholder="A front-desk coordinator for a medical clinic." value={superRole}
              onChange={(e) => setSuperRole(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor={`${uid}-sup-goal`} className="form-label">Goal <span className="form-required">*</span></label>
            <textarea id={`${uid}-sup-goal`} className="form-textarea" rows={2}
              placeholder="Get every caller to the right specialist and a booked outcome." value={superGoal}
              onChange={(e) => setSuperGoal(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor={`${uid}-sup-instr`} className="form-label">Instructions <span className="form-required">*</span></label>
            <p className="form-hint-block">The switching strategy — when to hand off to which sub-agent.</p>
            <textarea id={`${uid}-sup-instr`} className="form-textarea form-textarea-tall" rows={5}
              placeholder="Start with Intake to gather the reason for the visit. If it's billing, switch to Billing. Once a service is chosen, switch to Scheduler to book." value={superInstructions}
              onChange={(e) => setSuperInstructions(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor={`${uid}-sup-common`} className="form-label">Common Instructions <span className="form-optional">(Optional)</span></label>
            <p className="form-hint-block">Applied to every sub-agent, always (tone, guardrails, escalation rules).</p>
            <textarea id={`${uid}-sup-common`} className="form-textarea" rows={3}
              placeholder="Be warm and concise. Never give medical advice. If the caller is in distress, offer to connect a human." value={superCommon}
              onChange={(e) => setSuperCommon(e.target.value)} />
          </div>

          {/* ── Sub-Agents (SAU-307) ── */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '1.05em' }}>🤝 Sub-Agents <span className="form-required">*</span></label>
            <p className="form-hint-block">Add the specialists the supervisor switches between. Each has its own instructions, tools, and preferred model.</p>
            {subAgents.length === 0 && (
              <div className="report-panel"><p className="form-hint" style={{ margin: 0 }}>No sub-agents yet — add at least one.</p></div>
            )}
            {subAgents.map((sa, i) => (
              <div key={sa.id} className="report-panel" style={{ marginBottom: 12 }}>
                <div className="rubric-row" style={{ alignItems: 'center' }}>
                  <input className="form-input rubric-topic" placeholder={`Sub-agent ${i + 1} name (e.g. Intake)`}
                    value={sa.name} onChange={(e) => updateSubAgent(sa.id, { name: e.target.value })} aria-label={`Sub-agent ${i + 1} name`} />
                  <button type="button" className="btn-remove" onClick={() => removeSubAgent(sa.id)} aria-label={`Remove sub-agent ${i + 1}`}>×</button>
                </div>
                <textarea className="form-textarea" rows={3} style={{ marginTop: 8 }}
                  placeholder="What this sub-agent does and how it behaves." value={sa.instructions}
                  onChange={(e) => updateSubAgent(sa.id, { instructions: e.target.value })} aria-label={`Sub-agent ${i + 1} instructions`} />
                <div style={{ marginTop: 8 }}>
                  <span className="studio-section-label">Tools</span>
                  <div className="radio-group" style={{ flexWrap: 'wrap' }}>
                    {TOOL_NAMES.map((t) => (
                      <label key={t} className="radio-label">
                        <input type="checkbox" checked={sa.tools.includes(t)} onChange={() => toggleSubAgentTool(sa.id, t)} />
                        {t}
                      </label>
                    ))}
                  </div>
                  {/* SAU-327: tools the imported agent had that a sub-agent can't carry. */}
                  {sa.droppedTools && sa.droppedTools.length > 0 && (
                    <p className="form-hint" style={{ marginTop: 4, color: 'var(--accent, #0aa)' }}>
                      Imported from an existing agent — {sa.droppedTools.length} unsupported tool{sa.droppedTools.length === 1 ? ' was' : 's were'} dropped: {sa.droppedTools.join(', ')}.
                    </p>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  <label className="studio-section-label" htmlFor={`${uid}-${sa.id}-model`}>Model</label>
                  <select id={`${uid}-${sa.id}-model`} className="form-input" value={sa.model}
                    onChange={(e) => updateSubAgent(sa.id, { model: e.target.value })}>
                    <option value="">Use the scenario model</option>
                    {AI_MODELS.filter((m) => m.available).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  {/* CTO guardrail #1 (SAU-307): a Super Agent runs in ONE realtime
                      session on one engine in v1, so a per-sub-agent model can't be
                      honored at runtime yet. We capture it (forward-compatible for
                      multi-session orchestration) but say so plainly — no silent control. */}
                  <p className="form-hint" style={{ marginTop: 4 }}>
                    Saved for later — v1 runs all sub-agents on the scenario&apos;s model in one session. A per-sub-agent model applies once multi-session orchestration ships.
                  </p>
                </div>
              </div>
            ))}
            <div className="kb-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn-sm" onClick={addSubAgent}>＋ Add sub-agent</button>
              {/* SAU-327: snapshot-import one of the author's existing Default agents. */}
              <button type="button" className="btn-sm" aria-expanded={importOpen} onClick={toggleImport}>↧ Add from existing agent…</button>
            </div>
            {importOpen && (
              <div className="report-panel" style={{ marginTop: 8 }}>
                <p className="form-hint-block" style={{ marginTop: 0 }}>
                  Copy one of your existing agents in as a sub-agent. It&apos;s imported as a <strong>snapshot</strong> — editing it here won&apos;t change the original, and editing the original later won&apos;t change this sub-agent.
                </p>
                {importLoading ? (
                  <p className="form-hint" style={{ margin: 0 }}>Loading your agents…</p>
                ) : importAgents.length === 0 ? (
                  <p className="form-hint" style={{ margin: 0 }}>{importError ? '' : 'You have no other Default agents to import.'}</p>
                ) : (
                  <div className="rubric-row">
                    <select className="form-input rubric-topic" value={importPickId} onChange={(e) => setImportPickId(e.target.value)} aria-label="Choose an agent to import">
                      <option value="">Choose an agent…</option>
                      {importAgents.map((a) => (
                        <option key={a.slug} value={a.slug}>{a.name || a.slug}</option>
                      ))}
                    </select>
                    <button type="button" className="btn-sm" onClick={importSelected} disabled={!importPickId}>Import</button>
                  </div>
                )}
                {importError && <div className="notice" role="alert">{importError}</div>}
              </div>
            )}
          </div>
          </>)}

          {/* AI Model (SAU-238 ask #6 → SAU-258 multi-vendor picker) */}
          <div className="form-group">
            <label htmlFor={`${uid}-model`} className="form-label">AI Model <span className="form-optional">(Optional)</span></label>
            <p className="form-hint-block">The voice provider that powers this scenario. Pick a vendor — <strong>Google Gemini 2.5 Flash Live</strong> (fastest, lowest cost) or <strong>OpenAI Realtime</strong> — and the viewer&apos;s plan sets the quality tier automatically (free → standard, paid → premium).</p>
            <select
              id={`${uid}-model`}
              className="form-input"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
            >
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}{m.badge ? ` — ${m.available ? m.badge : 'coming soon'}` : (!m.available ? ' — coming soon' : '')}
                </option>
              ))}
            </select>
            {/* Speed/cost/quality hint + tier note for the selected engine. */}
            {aiModelById(aiModel).hint && (
              <p className="form-hint-block" style={{ marginTop: 6, opacity: 0.85 }}>{aiModelById(aiModel).hint}</p>
            )}
            {engineUpgradeAvailable && aiModelById(aiModel).engineClass === 'tiered' && (
              <p className="form-hint-block" style={{ marginTop: 4, color: 'var(--accent, #0aa)' }}>
                On the free plan this runs at standard quality — <a href="/billing">upgrade for premium quality</a>.
              </p>
            )}
          </div>

          {/* Additional Context for AI (SAU-238 ask #7) — grounding folded into the prompt */}
          <div className="form-group">
            <label className="form-label">Additional Context for AI <span className="form-optional">(Optional)</span></label>
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

          {/* Knowledge Base (SAU-243) — reusable multi-doc corpus, link once, reuse everywhere */}
          <div className="form-group">
            <button type="button" className="kb-section-head" aria-expanded={kbOpen} onClick={toggleKb}>
              <span aria-hidden="true">{kbOpen ? '▾' : '▸'}</span> 📚 Knowledge Base <span className="form-optional">(Optional)</span>
            </button>
            {kbOpen && (
              <div className="tab-body">
                <p className="form-hint-block">Link knowledge bases to provide additional context and information to the AI during conversations. Unlike Additional Context, a knowledge base is reusable — build it once and link it to many scenarios.</p>

                <p className="studio-section-label" style={{ marginTop: 4 }}>Linked Knowledge Bases</p>
                {linkedKbs.length === 0 ? (
                  <div className="report-panel"><p className="form-hint" style={{ margin: 0 }}>No knowledge bases linked yet.</p></div>
                ) : (
                  <ul className="kb-linked-list">
                    {linkedKbs.map((kb) => (
                      <li key={kb.id} className="kb-linked-item">
                        <span>
                          <strong>{kb.title}</strong>{' '}
                          <span className="form-hint">{kb.docCount} doc{kb.docCount === 1 ? '' : 's'}{kb.description ? ` · ${kb.description}` : ''}</span>
                        </span>
                        <button type="button" className="btn-remove" onClick={() => unlinkKb(kb.id)} aria-label={`Unlink ${kb.title}`}>×</button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="kb-actions">
                  {/* Link an existing KB */}
                  {availableKbs.filter((k) => !linkedKbs.some((l) => l.id === k.id)).length > 0 ? (
                    <div className="rubric-row">
                      <select className="form-input rubric-topic" value={kbPickId} onChange={(e) => setKbPickId(e.target.value)}>
                        <option value="">Add knowledge base…</option>
                        {availableKbs.filter((k) => !linkedKbs.some((l) => l.id === k.id)).map((k) => (
                          <option key={k.id} value={k.id}>{k.title} ({k.docCount} doc{k.docCount === 1 ? '' : 's'})</option>
                        ))}
                      </select>
                      <button type="button" className="btn-sm" onClick={linkExisting} disabled={!kbPickId}>+ Add</button>
                    </div>
                  ) : (
                    <p className="form-hint">{kbLoading ? 'Loading…' : 'No other knowledge bases available.'}</p>
                  )}
                  <button type="button" className="btn-sm" onClick={() => { setKbError(null); setShowKbModal(true); }}>＋ Create Knowledge Base</button>
                </div>
                {kbError && <div className="notice" role="alert">{kbError}</div>}
              </div>
            )}
          </div>
          </div>
          )}

          {/* ── Session & Scoring ──────────────────────────────────── */}
          {tab === 'session' && (
          <div className="studio-pane">
          {/* User Instruction (SAU-238) — shown to the human learner, NOT sent to the agent */}
          <div className="form-group">
            <label htmlFor={`${uid}-userinstr`} className="form-label">User Instruction <span className="form-optional">(Optional)</span></label>
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

          {/* Rubrik (SAU-238): Edit (free text) + Processed (AI-parsed structure) */}
          <div className="form-group">
            <label className="form-label">📋 Rubrik <span className="form-optional">(Optional)</span></label>
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
          </div>
          </div>
          )}

          {/* ── Voice & Look ───────────────────────────────────────── */}
          {tab === 'appearance' && (
          <div className="studio-pane">
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
          )}

          {error && <div className="notice" role="alert">{error}</div>}

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting || !slug || !persona}>
              {submitting ? 'Creating…' : remixFrom ? 'Save Remix' : 'Create Scenario'}
            </button>
            <Link href="/library" className="btn-ghost">Cancel</Link>
          </div>
        </form>
          </>
          )}

          {/* AI Studio: the Preview subtab renders the same live card inline. */}
          {studioMode === 'ai' && rightTab === 'preview' && (
            <div className="aistudio-previewpane">
              {preview ? (
                <div className="preview-card">
                  <div className="preview-avatar" style={{ background: 'linear-gradient(135deg, #06b6d4, #0891b2)' }} />
                  <h3 className="preview-name">{preview.name}</h3>
                  <p className="preview-desc">{preview.description}</p>
                  <div className="badges">
                    <span className="badge">{visibility === 'public' ? 'Public' : 'Private'}</span>
                    <span className="badge sales">Practice</span>
                  </div>
                </div>
              ) : (
                <div className="preview-empty">Ask the copilot or fill the Form to see a preview.</div>
              )}
            </div>
          )}
        </div>

        {/* Classic: Live Preview aside (right column). */}
        {studioMode === 'classic' && (
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
        )}
      </div>

      {/* Create Knowledge Base modal (SAU-243) */}
      {showKbModal && (
        <div className="kb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Create Knowledge Base" onClick={() => !kbCreating && setShowKbModal(false)}>
          <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="kb-modal-head">
              <h2 className="studio-title" style={{ fontSize: 20, margin: 0 }}>Create Knowledge Base</h2>
              <button type="button" className="btn-remove" onClick={() => setShowKbModal(false)} disabled={kbCreating} aria-label="Close">×</button>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${uid}-kbtitle`}>Title <span className="form-required">*</span></label>
              <input id={`${uid}-kbtitle`} type="text" className="form-input" placeholder="e.g., Product Docs, Sales Playbook" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${uid}-kbdesc`}>Description <span className="form-optional">(Optional)</span></label>
              <textarea id={`${uid}-kbdesc`} className="form-textarea" rows={2} placeholder="What this knowledge base contains." value={kbDesc} onChange={(e) => setKbDesc(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Documents <span className="form-hint">.pdf / .docx / .txt · max 25MB each</span></label>
              <label
                className={`kb-dropzone ${kbDragOver ? 'over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setKbDragOver(true); }}
                onDragLeave={() => setKbDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setKbDragOver(false); if (e.dataTransfer.files?.length) addKbFiles(e.dataTransfer.files); }}
              >
                <span>⬆ Drag &amp; drop files here, or click to browse</span>
                <input type="file" multiple accept={KB_ACCEPT} style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files?.length) addKbFiles(e.target.files); e.target.value = ''; }} />
              </label>
              {kbFiles.length > 0 && (
                <ul className="kb-linked-list">
                  {kbFiles.map((f, i) => (
                    <li key={i} className="kb-linked-item">
                      <span>{f.name} <span className="form-hint">{(f.size / 1024).toFixed(0)} KB</span></span>
                      <button type="button" className="btn-remove" onClick={() => setKbFiles((p) => p.filter((_, idx) => idx !== i))} aria-label="Remove">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {kbError && <div className="notice" role="alert">{kbError}</div>}
            <div className="form-actions">
              <button type="button" className="btn" onClick={createKb} disabled={kbCreating || !kbTitle.trim()}>
                {kbCreating ? 'Creating…' : 'Create'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowKbModal(false)} disabled={kbCreating}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
