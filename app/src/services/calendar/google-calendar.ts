/**
 * GoogleCalendarAdapter (SAU-267) — real Google Calendar v3 against a SANDBOX
 * calendar. Key-gated; the factory only selects this when credentials exist, and
 * any runtime error is caught upstream so a misconfig degrades to the mock rather
 * than crashing a live booking (AC #3).
 *
 * Phase-0 auth model (deliberately the simplest thing that writes real events):
 *   - GOOGLE_CALENDAR_ACCESS_TOKEN — a short-lived OAuth bearer with calendar
 *     scope (a Google API *key* cannot create events; writes require OAuth).
 *   - GOOGLE_CALENDAR_ID — the sandbox/test calendar id (defaults to 'primary').
 * Full OAuth refresh + per-clinic connection is Phase 1 (mirrors the SAU-253
 * Integrations Calendar seam, which stores the provider choice today).
 *
 * Doctors map to colored events on the one sandbox calendar (Phase-0); per-doctor
 * resource calendars are a Phase-1 refinement. Busy lookups filter by a
 * `[doctor:<id>]` tag we write into the event description.
 */
import type { CalendarAdapter, CalendarEvent, CalendarEventInput } from './calendar-adapter';

const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarConfig {
  accessToken: string;
  calendarId: string;
  /** How the token was sourced — drives the human label. Phase-0 env token is a
   *  'sandbox'; a per-clinic OAuth connection (SAU-271 WS2) is 'oauth'. */
  source?: 'sandbox' | 'oauth';
}

export function readGoogleCalendarConfig(): GoogleCalendarConfig | null {
  const accessToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  if (!accessToken) return null;
  return { accessToken, calendarId: process.env.GOOGLE_CALENDAR_ID ?? 'primary', source: 'sandbox' };
}

const DOCTOR_TAG = (id: string) => `[doctor:${id}]`;

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly label: string;
  readonly simulated = false;
  private cfg: GoogleCalendarConfig;

  constructor(cfg: GoogleCalendarConfig) {
    this.cfg = cfg;
    const kind = cfg.source === 'oauth' ? 'connected' : 'sandbox';
    this.label = `Google Calendar (${kind}: ${cfg.calendarId})`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' };
  }

  async listBusy(range: { fromMs: number; toMs: number }, doctorId?: string) {
    const url = `${API}/calendars/${encodeURIComponent(this.cfg.calendarId)}/events`
      + `?timeMin=${encodeURIComponent(new Date(range.fromMs).toISOString())}`
      + `&timeMax=${encodeURIComponent(new Date(range.toMs).toISOString())}`
      + `&singleEvents=true&maxResults=250&orderBy=startTime`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`google calendar list failed (${res.status})`);
    const data = await res.json();
    const items: Array<{ start?: { dateTime?: string }; end?: { dateTime?: string }; description?: string }> = data.items ?? [];
    return items
      .map((it) => {
        const startMs = it.start?.dateTime ? Date.parse(it.start.dateTime) : NaN;
        const endMs = it.end?.dateTime ? Date.parse(it.end.dateTime) : NaN;
        const tagged = (it.description ?? '').match(/\[doctor:([^\]]+)\]/);
        return { doctorId: tagged?.[1] ?? 'unknown', startMs, endMs };
      })
      .filter((e) => Number.isFinite(e.startMs) && Number.isFinite(e.endMs) && (!doctorId || e.doctorId === doctorId));
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const url = `${API}/calendars/${encodeURIComponent(this.cfg.calendarId)}/events`;
    const body = {
      summary: input.summary,
      description: `${input.description ?? ''}\n${DOCTOR_TAG(input.doctorId)}`.trim(),
      start: { dateTime: new Date(input.startMs).toISOString() },
      end: { dateTime: new Date(input.endMs).toISOString() },
    };
    const res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`google calendar create failed (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    const evt = await res.json();
    return {
      id: evt.id,
      doctorId: input.doctorId,
      summary: input.summary,
      startMs: input.startMs,
      endMs: input.endMs,
      htmlLink: evt.htmlLink,
    };
  }
}
