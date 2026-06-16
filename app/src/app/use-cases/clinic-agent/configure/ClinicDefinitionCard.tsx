'use client';

/**
 * ClinicDefinitionCard (SAU-300, Phase 2 · WS-A) — the no-code clinic definition.
 *
 * A non-developer defines EVERYTHING the agent needs to run a clinic, with no YAML
 * or code: profile + timezone, operating hours / after-hours behavior, doctors and
 * which services each offers, appointment types + durations, accepted insurance,
 * booking rules (slot length, buffer, lead time, max/day), and the agent greeting.
 *
 * On save it PUTs to /api/use-cases/clinic-agent/config; the booking tools then read
 * this config per-clinic (RLS-isolated) and enforce the rules in the tool, not the
 * prompt. The form seeds from the effective config (the saved definition, or the
 * Phase-0 default when nothing is authored yet).
 */
import { useState } from 'react';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface DayHoursForm {
  open: string;
  close: string;
}
interface ServiceForm {
  id: string;
  name: string;
  durationMinutes: number;
}
interface DoctorForm {
  id: string;
  name: string;
  specialty: string;
  serviceIds: string[];
}
interface AfterHoursForm {
  mode: 'voicemail' | 'callback' | 'message';
  message?: string;
}
export interface ClinicConfigForm {
  name: string;
  timezone: string;
  hours: Array<DayHoursForm | null>;
  slotMinutes: number;
  doctors: DoctorForm[];
  services: ServiceForm[];
  insuranceAccepted: string[];
  afterHours: AfterHoursForm;
  bufferMinutes: number;
  leadTimeMinutes: number;
  maxPerDay: number;
  greeting: string;
}

function newId(prefix: string): string {
  // Stable local id for referential integrity (doctors ↔ services). Browser-only.
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : `${Math.floor(Math.random() * 1e8)}`;
  return `${prefix}-${rand}`;
}

export default function ClinicDefinitionCard({
  initial,
  configured: initialConfigured,
}: {
  initial: ClinicConfigForm;
  configured: boolean;
}) {
  const [form, setForm] = useState<ClinicConfigForm>(initial);
  const [insuranceText, setInsuranceText] = useState(initial.insuranceAccepted.join(', '));
  const [configured, setConfigured] = useState(initialConfigured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<ClinicConfigForm>) {
    setForm((f) => ({ ...f, ...p }));
    setSaved(false);
  }

  // ── Hours ──
  function toggleDay(i: number, open: boolean) {
    const hours = form.hours.slice();
    hours[i] = open ? { open: '09:00', close: '17:00' } : null;
    patch({ hours });
  }
  function setDay(i: number, key: 'open' | 'close', value: string) {
    const hours = form.hours.slice();
    const cur = hours[i] ?? { open: '09:00', close: '17:00' };
    hours[i] = { ...cur, [key]: value };
    patch({ hours });
  }

  // ── Services ──
  function addService() {
    patch({ services: [...form.services, { id: newId('svc'), name: '', durationMinutes: 30 }] });
  }
  function setService(id: string, key: keyof ServiceForm, value: string | number) {
    patch({ services: form.services.map((s) => (s.id === id ? { ...s, [key]: value } : s)) });
  }
  function removeService(id: string) {
    patch({
      services: form.services.filter((s) => s.id !== id),
      doctors: form.doctors.map((d) => ({ ...d, serviceIds: d.serviceIds.filter((sid) => sid !== id) })),
    });
  }

  // ── Doctors ──
  function addDoctor() {
    patch({ doctors: [...form.doctors, { id: newId('dr'), name: '', specialty: '', serviceIds: [] }] });
  }
  function setDoctor(id: string, key: 'name' | 'specialty', value: string) {
    patch({ doctors: form.doctors.map((d) => (d.id === id ? { ...d, [key]: value } : d)) });
  }
  function toggleDoctorService(docId: string, svcId: string, on: boolean) {
    patch({
      doctors: form.doctors.map((d) =>
        d.id === docId
          ? { ...d, serviceIds: on ? [...new Set([...d.serviceIds, svcId])] : d.serviceIds.filter((s) => s !== svcId) }
          : d,
      ),
    });
  }
  function removeDoctor(id: string) {
    patch({ doctors: form.doctors.filter((d) => d.id !== id) });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const payload: ClinicConfigForm = {
      ...form,
      insuranceAccepted: insuranceText.split(',').map((s) => s.trim()).filter(Boolean),
      services: form.services.map((s) => ({ ...s, name: s.name.trim(), durationMinutes: Number(s.durationMinutes) || 30 })),
      doctors: form.doctors.map((d) => ({ ...d, name: d.name.trim(), specialty: d.specialty.trim() })),
    };
    try {
      const res = await fetch('/api/use-cases/clinic-agent/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save the clinic definition.');
      const next: ClinicConfigForm = json.config.config;
      setForm(next);
      setInsuranceText(next.insuranceAccepted.join(', '));
      setConfigured(json.config.configured);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/use-cases/clinic-agent/config', { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not reset the clinic definition.');
      const next: ClinicConfigForm = json.config.config;
      setForm(next);
      setInsuranceText(next.insuranceAccepted.join(', '));
      setConfigured(json.config.configured);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-integration">
      <div className="settings-integration-head">
        <div>
          <h3>4. Define the clinic</h3>
          <p className="billing-muted">
            Everything the agent needs to run this clinic — profile, hours, doctors, services, insurance and booking
            rules. No code. A call honors these: the agent refuses out-of-hours slots, respects durations, and won&apos;t
            double-book — the rules are enforced in the booking tool, not the prompt.
          </p>
        </div>
        <span className={`settings-badge ${configured ? 'connected' : ''}`}>{configured ? 'Defined' : 'Using default'}</span>
      </div>

      {/* Profile */}
      <fieldset className="settings-field">
        <legend><strong>Clinic profile</strong></legend>
        <label htmlFor="clinic-name">Clinic name</label>
        <input id="clinic-name" className="settings-input" value={form.name} onChange={(e) => patch({ name: e.target.value })} disabled={busy} />
        <label htmlFor="clinic-tz">Timezone (IANA)</label>
        <input id="clinic-tz" className="settings-input" placeholder="America/New_York" value={form.timezone} onChange={(e) => patch({ timezone: e.target.value })} disabled={busy} />
        <label htmlFor="slot-min">Default appointment length (minutes) — the booking grid</label>
        <input id="slot-min" type="number" min={5} max={240} className="settings-input" value={form.slotMinutes} onChange={(e) => patch({ slotMinutes: Number(e.target.value) })} disabled={busy} />
      </fieldset>

      {/* Hours */}
      <fieldset className="settings-field">
        <legend><strong>Operating hours</strong></legend>
        {WEEKDAYS.map((day, i) => {
          const dh = form.hours[i];
          return (
            <div key={day} className="settings-actions" style={{ alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ minWidth: '7rem' }}>
                <input type="checkbox" checked={Boolean(dh)} onChange={(e) => toggleDay(i, e.target.checked)} disabled={busy} /> {day}
              </label>
              {dh ? (
                <>
                  <input type="time" className="settings-input" style={{ width: 'auto' }} value={dh.open} onChange={(e) => setDay(i, 'open', e.target.value)} disabled={busy} aria-label={`${day} open`} />
                  <span aria-hidden="true">–</span>
                  <input type="time" className="settings-input" style={{ width: 'auto' }} value={dh.close} onChange={(e) => setDay(i, 'close', e.target.value)} disabled={busy} aria-label={`${day} close`} />
                </>
              ) : (
                <span className="billing-muted">Closed</span>
              )}
            </div>
          );
        })}
      </fieldset>

      {/* After hours */}
      <fieldset className="settings-field">
        <legend><strong>After-hours behavior</strong></legend>
        <label htmlFor="afterhours-mode">When a caller reaches the clinic outside hours</label>
        <select
          id="afterhours-mode"
          className="settings-input"
          value={form.afterHours.mode}
          onChange={(e) => patch({ afterHours: { ...form.afterHours, mode: e.target.value as AfterHoursForm['mode'] } })}
          disabled={busy}
        >
          <option value="voicemail">Take a voicemail</option>
          <option value="callback">Offer a callback</option>
          <option value="message">Play a message</option>
        </select>
        <label htmlFor="afterhours-msg">After-hours message (optional)</label>
        <input id="afterhours-msg" className="settings-input" value={form.afterHours.message ?? ''} onChange={(e) => patch({ afterHours: { ...form.afterHours, message: e.target.value } })} disabled={busy} />
      </fieldset>

      {/* Services */}
      <fieldset className="settings-field">
        <legend><strong>Services / appointment types</strong></legend>
        {form.services.length === 0 && <p className="billing-muted">No services yet — appointments use the default length above.</p>}
        {form.services.map((s) => (
          <div key={s.id} className="settings-actions" style={{ alignItems: 'center', gap: '0.5rem' }}>
            <input className="settings-input" placeholder="e.g. New patient visit" value={s.name} onChange={(e) => setService(s.id, 'name', e.target.value)} disabled={busy} aria-label="Service name" />
            <input type="number" min={5} max={480} className="settings-input" style={{ width: '6rem' }} value={s.durationMinutes} onChange={(e) => setService(s.id, 'durationMinutes', Number(e.target.value))} disabled={busy} aria-label="Duration minutes" />
            <span className="billing-muted">min</span>
            <button type="button" className="btn-remove-text" onClick={() => removeService(s.id)} disabled={busy}>Remove</button>
          </div>
        ))}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" onClick={addService} disabled={busy}>+ Add service</button>
        </div>
      </fieldset>

      {/* Doctors */}
      <fieldset className="settings-field">
        <legend><strong>Doctors / providers</strong></legend>
        {form.doctors.map((d) => (
          <div key={d.id} className="settings-integration" style={{ marginBottom: '0.75rem' }}>
            <div className="settings-actions" style={{ gap: '0.5rem' }}>
              <input className="settings-input" placeholder="Dr. Full Name" value={d.name} onChange={(e) => setDoctor(d.id, 'name', e.target.value)} disabled={busy} aria-label="Doctor name" />
              <input className="settings-input" placeholder="Specialty" value={d.specialty} onChange={(e) => setDoctor(d.id, 'specialty', e.target.value)} disabled={busy} aria-label="Specialty" />
              <button type="button" className="btn-remove-text" onClick={() => removeDoctor(d.id)} disabled={busy}>Remove</button>
            </div>
            {form.services.length > 0 && (
              <div className="billing-muted" style={{ marginTop: '0.4rem' }}>
                Offers:{' '}
                {form.services.map((s) => (
                  <label key={s.id} style={{ marginRight: '0.75rem', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={d.serviceIds.length === 0 || d.serviceIds.includes(s.id)}
                      onChange={(e) => toggleDoctorService(d.id, s.id, e.target.checked)}
                      disabled={busy}
                    />{' '}
                    {s.name || 'unnamed'}
                  </label>
                ))}
                <span style={{ display: 'block', fontSize: '0.85em' }}>(none checked = offers all services)</span>
              </div>
            )}
          </div>
        ))}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" onClick={addDoctor} disabled={busy}>+ Add doctor</button>
        </div>
      </fieldset>

      {/* Insurance */}
      <fieldset className="settings-field">
        <legend><strong>Insurance accepted</strong></legend>
        <label htmlFor="insurance">Comma-separated list</label>
        <input id="insurance" className="settings-input" placeholder="Aetna, Blue Cross Blue Shield, Self-pay" value={insuranceText} onChange={(e) => { setInsuranceText(e.target.value); setSaved(false); }} disabled={busy} />
      </fieldset>

      {/* Booking rules */}
      <fieldset className="settings-field">
        <legend><strong>Booking rules</strong></legend>
        <label htmlFor="buffer">Buffer between appointments (minutes)</label>
        <input id="buffer" type="number" min={0} max={240} className="settings-input" value={form.bufferMinutes} onChange={(e) => patch({ bufferMinutes: Number(e.target.value) })} disabled={busy} />
        <label htmlFor="lead">Minimum lead time / notice (minutes)</label>
        <input id="lead" type="number" min={0} max={10080} className="settings-input" value={form.leadTimeMinutes} onChange={(e) => patch({ leadTimeMinutes: Number(e.target.value) })} disabled={busy} />
        <label htmlFor="maxday">Max bookings per doctor per day (0 = unlimited)</label>
        <input id="maxday" type="number" min={0} max={200} className="settings-input" value={form.maxPerDay} onChange={(e) => patch({ maxPerDay: Number(e.target.value) })} disabled={busy} />
        <p className="billing-muted">Double-booking is always prevented — the booking tool re-checks the live calendar before it writes.</p>
      </fieldset>

      {/* Greeting */}
      <fieldset className="settings-field">
        <legend><strong>Agent greeting</strong></legend>
        <textarea className="settings-input" rows={3} placeholder="Thanks for calling Riverside Family Health, this is Robin…" value={form.greeting} onChange={(e) => patch({ greeting: e.target.value })} disabled={busy} />
      </fieldset>

      {saved && <p className="settings-pending-note">Clinic definition saved. Calls now honor this configuration.</p>}
      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save clinic definition'}</button>
        {configured && <button type="button" className="btn-remove-text" onClick={reset} disabled={busy}>Reset to default</button>}
      </div>
    </div>
  );
}
