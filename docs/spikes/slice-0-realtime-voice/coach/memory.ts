/**
 * CoachMemory — the MINIMAL persistence stub for the Slice-0 foundation (SAU-194).
 *
 * Non-goal for this slice (per the issue): the full Coach memory model. That is
 * ADR-004, a later slice. This stub exists only so the foundation's tools have a
 * real backing store and so transcripts land *somewhere* — proving the end-to-end
 * write path without committing to a schema.
 *
 * It is deliberately a flat JSON file per user under `coach/.sessions/`. Swap this
 * class for a DB-backed implementation when ADR-004 lands; the `VoiceAgent` and the
 * tool handlers only depend on the small method surface below, not on the storage.
 *
 * PRIVACY (ADR-003 gate): the foundation is driven by SYNTHETIC audio only until the
 * OpenAI DPA / no-train / retention gate closes. Treat anything written here as
 * synthetic for now; do not point this at real-user audio yet. `.sessions/` is
 * gitignored.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Transcript } from '../realtime-interface.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(HERE, '.sessions');

export interface Reflection {
  insight: string;
  tag?: string;
  at: number;
}

interface UserRecord {
  userId: string;
  reflections: Reflection[];
  transcripts: Transcript[];
}

export class CoachMemory {
  private record: UserRecord;
  private readonly file: string;

  constructor(private readonly userId = 'synthetic-user', private readonly persist = true) {
    this.file = join(STORE_DIR, `${userId}.json`);
    this.record = this.load();
  }

  /** Tool-backed write: remember an insight the user surfaced. */
  saveReflection(insight: string, tag?: string, now = Date.now()): Reflection {
    const r: Reflection = { insight, tag, at: now };
    this.record.reflections.push(r);
    this.flush();
    return r;
  }

  /** Tool-backed read: the most recent reflections, newest first. */
  recallReflections(limit = 3): Reflection[] {
    return [...this.record.reflections].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
  }

  /** Persist a finished session transcript (the end-to-end durability proof). */
  saveTranscript(t: Transcript): void {
    this.record.transcripts.push(t);
    this.flush();
  }

  private load(): UserRecord {
    if (this.persist && existsSync(this.file)) {
      try { return JSON.parse(readFileSync(this.file, 'utf8')) as UserRecord; } catch { /* fall through */ }
    }
    return { userId: this.userId, reflections: [], transcripts: [] };
  }

  private flush(): void {
    if (!this.persist) return;
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.record, null, 2) + '\n');
  }
}
