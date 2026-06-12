'use client';

/**
 * Course Studio — Create Course form (SAU-247), built to match the Scenario
 * Studio (/scenarios/create). A Course is a COMPOSITION over scenarios (ADR-001):
 * an ordered list of scenario slugs (the "Play All" sequence) + optional coach.
 *
 * Fields: Name → auto-slug, Public Description, Visibility, an ordered Scenario
 * picker (>=1 required — the publish-gate invariant from ADR-006/SAU-210), and an
 * optional Coach. Submits JSON to POST /api/courses; on success redirects to the
 * new course detail page. User-authored courses are tagged `metadata._source:'user'`
 * so they land under the "My Courses" tab, mirroring scenarios.
 */
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CourseCover } from '@/components/CourseCover';

interface ScenarioOpt { slug: string; name: string; }
interface CoachOpt { slug: string; name: string; }

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export default function CreateCoursePage() {
  const router = useRouter();
  const uid = useId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [coachSlug, setCoachSlug] = useState('');

  // Ordered scenario selection (the Play All sequence).
  const [selected, setSelected] = useState<ScenarioOpt[]>([]);
  const [available, setAvailable] = useState<ScenarioOpt[]>([]);
  const [coaches, setCoaches] = useState<CoachOpt[]>([]);
  const [pickSlug, setPickSlug] = useState('');
  const [loading, setLoading] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load scenarios (to compose) + coaches (optional binding) once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sRes, cRes] = await Promise.all([
          fetch('/api/scenarios'),
          fetch('/api/coaches'),
        ]);
        const sData = await sRes.json().catch(() => ({}));
        const cData = await cRes.json().catch(() => ({}));
        if (cancelled) return;
        const scenarios: ScenarioOpt[] = (sData.scenarios ?? []).map((s: { slug: string; name: string }) => ({ slug: s.slug, name: s.name }));
        setAvailable(scenarios);
        setCoaches((cData.coaches ?? []).map((c: { slug: string; name: string }) => ({ slug: c.slug, name: c.name })));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function handleNameChange(v: string) {
    setName(v);
    if (!slugEdited) setSlug(toSlug(v));
  }

  function handleSlugChange(v: string) {
    setSlugEdited(true);
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/--+/g, '-').slice(0, 60));
  }

  function addScenario() {
    const s = available.find((a) => a.slug === pickSlug);
    if (!s || selected.some((x) => x.slug === s.slug)) return;
    setSelected((l) => [...l, s]);
    setPickSlug('');
  }

  function removeScenario(slugToRemove: string) {
    setSelected((l) => l.filter((s) => s.slug !== slugToRemove));
  }

  function move(i: number, dir: -1 | 1) {
    setSelected((l) => {
      const j = i + dir;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const unpicked = available.filter((a) => !selected.some((s) => s.slug === a.slug));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) { setError('ID / Slug is required.'); return; }
    if (selected.length === 0) { setError('A course must include at least one scenario.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: slug,
          name: name || slug,
          description: description || undefined,
          cover_image_url: coverImageUrl.trim() || undefined,
          scenarios: selected.map((s) => s.slug),
          visibility,
          ...(coachSlug ? { coach_ref: coachSlug } : {}),
          metadata: { _source: 'user' },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      router.push(`/courses/${data.course.slug}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const preview = name || slug ? {
    name: name || slug,
    description: description || 'An ordered track of scenarios to practice in sequence.',
  } : null;

  return (
    <div className="studio-shell">
      <nav className="studio-nav">
        <Link href="/courses" className="back-link">← Courses</Link>
      </nav>
      <h1 className="studio-title">Create Course</h1>

      <div className="studio-layout">
        <div className="studio-form">
          <form onSubmit={handleSubmit}>
            {/* Name */}
            <div className="form-group">
              <label htmlFor={`${uid}-name`} className="form-label">Name <span className="form-required">*</span></label>
              <input
                id={`${uid}-name`}
                type="text"
                className="form-input"
                placeholder="e.g., Sales Fundamentals, Interview Prep Track"
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
                placeholder="my-course-slug"
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
                placeholder="What learners see before starting — what this track covers and who it's for."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Cover Image */}
            <div className="form-group">
              <label htmlFor={`${uid}-cover`} className="form-label">Cover Image URL <span className="form-optional">(Optional)</span></label>
              <p className="form-hint-block">A public HTTPS image shown as the course banner in the library. Leave blank to use an auto-generated gradient cover.</p>
              <input
                id={`${uid}-cover`}
                type="url"
                className="form-input form-input-mono"
                placeholder="https://…/course-cover.jpg"
                value={coverImageUrl}
                onChange={(e) => setCoverImageUrl(e.target.value)}
              />
            </div>

            {/* Scenarios (ordered) */}
            <div className="form-group">
              <label className="form-label">Scenarios <span className="form-required">*</span></label>
              <p className="form-hint-block">The ordered &ldquo;Play All&rdquo; sequence — add at least one scenario, then reorder them into the track you want learners to follow.</p>

              {selected.length === 0 ? (
                <div className="report-panel"><p className="form-hint" style={{ margin: 0 }}>No scenarios added yet.</p></div>
              ) : (
                <ul className="kb-linked-list">
                  {selected.map((s, i) => (
                    <li key={s.slug} className="kb-linked-item">
                      <span><strong>{i + 1}.</strong> {s.name} <span className="form-hint">{s.slug}</span></span>
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <button type="button" className="btn-ghost-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                        <button type="button" className="btn-ghost-sm" onClick={() => move(i, 1)} disabled={i === selected.length - 1} aria-label="Move down">↓</button>
                        <button type="button" className="btn-remove" onClick={() => removeScenario(s.slug)} aria-label={`Remove ${s.name}`}>×</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="rubric-row" style={{ marginTop: 8 }}>
                <select className="form-input rubric-topic" value={pickSlug} onChange={(e) => setPickSlug(e.target.value)} disabled={loading || unpicked.length === 0}>
                  <option value="">{loading ? 'Loading scenarios…' : unpicked.length === 0 ? 'No more scenarios to add' : 'Add a scenario…'}</option>
                  {unpicked.map((s) => (
                    <option key={s.slug} value={s.slug}>{s.name}</option>
                  ))}
                </select>
                <button type="button" className="btn-sm" onClick={addScenario} disabled={!pickSlug}>+ Add</button>
              </div>
            </div>

            {/* Coach (optional) */}
            <div className="form-group">
              <label htmlFor={`${uid}-coach`} className="form-label">Coach <span className="form-optional">(Optional)</span></label>
              <p className="form-hint-block">Bind a coach to debrief learners as they work through the track.</p>
              <select id={`${uid}-coach`} className="form-input" value={coachSlug} onChange={(e) => setCoachSlug(e.target.value)} disabled={loading}>
                <option value="">No coach</option>
                {coaches.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.name}</option>
                ))}
              </select>
            </div>

            {error && <div className="notice" role="alert">{error}</div>}

            <div className="form-actions">
              <button type="submit" className="btn" disabled={submitting || !slug || selected.length === 0}>
                {submitting ? 'Creating…' : 'Create Course'}
              </button>
              <Link href="/courses" className="btn-ghost">Cancel</Link>
            </div>
          </form>
        </div>

        {/* Live Preview aside — mirrors the Scenario Studio. */}
        <aside className="studio-preview">
          <div className="preview-header">
            <span className="preview-dot red" /><span className="preview-dot amber" /><span className="preview-dot green" />
            <span className="preview-title">Live Preview</span>
          </div>
          <p className="preview-sub">Updates when you fill in the fields.</p>
          {preview ? (
            <div className="preview-card">
              <CourseCover name={preview.name} slug={slug || 'course'} coverImageUrl={coverImageUrl.trim() || null} height={120} />
              <h3 className="preview-name" style={{ marginTop: 10 }}>{preview.name}</h3>
              <p className="preview-desc">{preview.description}</p>
              <div className="badges">
                <span className="badge">{visibility === 'public' ? 'Public' : 'Private'}</span>
                <span className="badge">{selected.length} scenario{selected.length === 1 ? '' : 's'}</span>
                {coachSlug && <span className="badge">coached</span>}
              </div>
            </div>
          ) : (
            <div className="preview-empty">Fill in the Name to see a preview.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
