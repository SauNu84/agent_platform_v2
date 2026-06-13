/**
 * Calendar adapter seam (SAU-267, Phase 0) — vendor-neutral booking I/O.
 *
 * Same swap-ability pattern as the realtime voice vendors (ADR-003), the chat
 * `ChatResponder`, and the analyst `Scorer`: ONE interface, swappable impls. The
 * clinic booking tools depend only on this interface, so moving from the sandbox
 * mock to a real Google/Outlook/CalDAV calendar never touches the rules engine.
 *
 * Reuses the SAU-253 Integrations "Calendar connection" provider choice; the live
 * Google adapter is key-gated and the factory FAILS SOFT to the deterministic mock
 * when no credentials are present (AC #3: no key ⇒ graceful, clearly-labeled
 * simulated path, never a crash).
 */

/** A calendar event the adapter can create. Times are epoch-ms (UTC). */
export interface CalendarEventInput {
  /** Maps to a clinic doctor; used to scope busy lookups + as event metadata. */
  doctorId: string;
  summary: string;
  description?: string;
  startMs: number;
  endMs: number;
}

export interface CalendarEvent {
  id: string;
  doctorId: string;
  summary: string;
  startMs: number;
  endMs: number;
  /** A link to view the event when the vendor provides one (Google does). */
  htmlLink?: string;
}

export interface CalendarAdapter {
  /** A human label for the resolved backend, e.g. "Google Calendar (sandbox)" / "Simulated calendar". */
  readonly label: string;
  /** True when this is the fail-soft mock (no real vendor credentials). */
  readonly simulated: boolean;
  /** Busy intervals for a doctor (or all) within [fromMs, toMs). */
  listBusy(range: { fromMs: number; toMs: number }, doctorId?: string): Promise<{ doctorId: string; startMs: number; endMs: number }[]>;
  /** Create the event and return it (with the vendor-assigned id = proof of booking). */
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
}
