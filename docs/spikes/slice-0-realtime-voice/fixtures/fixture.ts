/**
 * Fixed benchmark fixture (ADR-003 methodology).
 *
 * The fixture is two artifacts that travel together:
 *   - `manifest.json` — the ordered list of TURNS the harness drives, with the
 *     timing markers the bench needs (utterance length, where the barge-in lands).
 *     This is the *comparable, reproducible* part — every vendor is driven by the
 *     identical script.
 *   - `driver.wav` — the actual PCM16 mic audio replayed into `sendAudio`. For the
 *     mock adapter the audio content is irrelevant (the mock is driven by the
 *     manifest). For LIVE vendor runs this MUST be a real speech recording that
 *     elicits the scripted behavior (a normal answer, a turn that asks for a price
 *     so the model calls `lookupPrice`, and a barge-in). `make-fixture.ts --speech`
 *     generates this real fixture locally via macOS `say` (zero spend); the default
 *     (no --speech) produces a deterministic placeholder tone for the offline mock.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type TurnKind = 'normal' | 'tool' | 'bargein';

export interface FixtureTurn {
  /** index in the script */
  index: number;
  kind: TurnKind;
  /** how long the user "speaks" this turn (ms of mic audio replayed) */
  userMs: number;
  /** for barge-in turns: how long after the agent starts talking the user cuts in (ms) */
  bargeInAfterMs?: number;
  /** what the user actually says this turn (only set for the real-speech fixture) */
  transcript?: string;
  /** byte-accurate region of driver.wav for this turn's user utterance (real-speech fixture) */
  audioStartMs?: number;
  audioDurationMs?: number;
  /** for barge-in turns: the short "cut-in" utterance region streamed over the agent */
  bargeTranscript?: string;
  bargeStartMs?: number;
  bargeDurationMs?: number;
}

export interface FixtureManifest {
  wav: string;
  sampleRate: number;
  /** PCM16 mono frame size the harness streams per tick */
  frameMs: number;
  /** 'tone' = offline placeholder; 'speech' = real TTS audio with per-turn offsets */
  audioKind?: 'tone' | 'speech';
  turns: FixtureTurn[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadManifest(path = join(HERE, 'manifest.json')): FixtureManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

// ── WAV (PCM16 mono) read + slice helpers ────────────────────────────────────

/** Parse a canonical PCM16 mono WAV into samples. Throws on unexpected format. */
export function readWavPcm(path: string): { sampleRate: number; pcm: Int16Array } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  // Walk chunks to find fmt + data (don't assume a 44-byte header).
  let off = 12, sampleRate = 0, bits = 16, channels = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOff = body; dataLen = size;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error(`no data chunk in ${path}`);
  if (bits !== 16 || channels !== 1) throw new Error(`expected PCM16 mono, got ${bits}-bit ${channels}ch in ${path}`);
  const n = Math.floor(dataLen / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(dataOff + i * 2);
  return { sampleRate, pcm };
}

/** Slice a [startMs, startMs+durationMs) region from PCM samples. */
export function sliceMs(pcm: Int16Array, sampleRate: number, startMs: number, durationMs: number): Int16Array {
  const s = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const e = Math.min(pcm.length, Math.floor(((startMs + durationMs) / 1000) * sampleRate));
  return pcm.subarray(s, Math.max(s, e));
}

/** True when the manifest references a real-speech WAV that exists on disk. */
export function hasRealAudio(manifest: FixtureManifest, wavPath: string): boolean {
  return manifest.audioKind === 'speech' && existsSync(wavPath) &&
    manifest.turns.some((t) => t.audioDurationMs != null);
}

/**
 * Deterministic turn script for N turns. Pattern repeats so every run is identical
 * across vendors and reproducible across runs (no RNG): every 5th turn forces a
 * tool call, every 7th is a barge-in, the rest are normal turns. With N>=50 this
 * yields ~10 tool turns and ~7 barge-in turns — enough to read p95s meaningfully.
 */
export function buildTurns(n: number): FixtureTurn[] {
  const turns: FixtureTurn[] = [];
  for (let i = 0; i < n; i++) {
    let kind: TurnKind = 'normal';
    if (i > 0 && i % 7 === 0) kind = 'bargein';
    else if (i > 0 && i % 5 === 0) kind = 'tool';
    turns.push({
      index: i,
      kind,
      userMs: kind === 'tool' ? 1500 : kind === 'bargein' ? 1000 : 1200,
      ...(kind === 'bargein' ? { bargeInAfterMs: 400 } : {}),
    });
  }
  return turns;
}
