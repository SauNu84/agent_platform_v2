/**
 * Generates the Coach foundation's SYNTHETIC demo fixture (SAU-194):
 *   coach/coach-manifest.json (committed, reproducible)
 *   coach/coach-driver.wav    (synthetic macOS `say` audio — NEVER real-user PII)
 *
 *   tsx coach/make-coach-fixture.ts [--voice Samantha] [--rate 24000]
 *
 * This is the foundation analogue of fixtures/make-fixture.ts, but with a SHORT
 * coaching script chosen so the live OpenAI run actually exercises the foundation's
 * three required properties in one ~20s conversation:
 *   - normal turn (audio out),
 *   - an insight turn that elicits `saveReflection` (≥1 tool call),
 *   - a barge-in turn with a cut-in utterance.
 *
 * macOS-only (uses the built-in `say` TTS, zero spend). The synthetic audio keeps
 * us inside the ADR-003 privacy gate (no real-user audio until the OpenAI DPA closes).
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWavPcm, type FixtureManifest, type FixtureTurn } from '../fixtures/fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function strArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1]) : def;
}
function numArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const voice = strArg('voice', 'Samantha');
const sampleRate = numArg('rate', 24000);
const frameMs = 20;

// ── PCM16 mono WAV writer (same canonical format the adapters expect) ─────────
function writeWav(path: string, pcm: Int16Array, rate: number): void {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const silence = (ms: number): Int16Array => new Int16Array(Math.floor((sampleRate * ms) / 1000));
const msOf = (pcm: Int16Array): number => Math.round((pcm.length / sampleRate) * 1000);
function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function synth(tmp: string, text: string, idx: number): Int16Array {
  const out = join(tmp, `coach-${idx}.wav`);
  execFileSync('say', ['-v', voice, '-o', out, '--data-format', `LEI16@${sampleRate}`, text]);
  const { sampleRate: r, pcm } = readWavPcm(out);
  if (r !== sampleRate) throw new Error(`say produced ${r}Hz, expected ${sampleRate}`);
  return pcm;
}

// The short coaching script. The insight turn is phrased so a coach naturally
// reaches for `saveReflection`; the barge-in turn has a cut-in.
const SCRIPT: Array<
  { kind: FixtureTurn['kind']; text: string; bargeText?: string }
> = [
  { kind: 'normal', text: 'Hi Coach. I want to reflect on how my week went.' },
  { kind: 'tool', text: 'I realized I keep saying yes to meetings I should decline, and it is burning me out.' },
  {
    kind: 'bargein',
    text: 'Can you walk me through how I might set a boundary next week step by step?',
    bargeText: 'Actually — wait, let me rethink that.',
  },
  { kind: 'normal', text: 'What did I say I wanted to focus on earlier?' },
];

const tmp = mkdtempSync(join(tmpdir(), 'coach-fixture-'));
try {
  const gap = silence(600);
  const parts: Int16Array[] = [];
  let cursorMs = 0;
  const push = (pcm: Int16Array): { startMs: number; durationMs: number } => {
    const startMs = cursorMs;
    parts.push(pcm);
    const durationMs = msOf(pcm);
    cursorMs += durationMs;
    return { startMs, durationMs };
  };

  const turns: FixtureTurn[] = SCRIPT.map((s, index) => {
    const clip = synth(tmp, s.text, index);
    const r = push(clip);
    const turn: FixtureTurn = {
      index,
      kind: s.kind,
      userMs: r.durationMs,
      transcript: s.text,
      audioStartMs: r.startMs,
      audioDurationMs: r.durationMs,
    };
    if (s.kind === 'bargein' && s.bargeText) {
      const c = push(synth(tmp, s.bargeText, 100 + index));
      turn.bargeTranscript = s.bargeText;
      turn.bargeStartMs = c.startMs;
      turn.bargeDurationMs = c.durationMs;
      turn.bargeInAfterMs = 500;
    }
    parts.push(gap); cursorMs += msOf(gap);
    return turn;
  });

  const full = concat(parts);
  writeWav(join(HERE, 'coach-driver.wav'), full, sampleRate);
  const manifest: FixtureManifest = { wav: 'coach-driver.wav', sampleRate, frameMs, audioKind: 'speech', turns };
  writeFileSync(join(HERE, 'coach-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `[coach-fixture] wrote coach-driver.wav (${(full.length / sampleRate).toFixed(1)}s, voice=${voice}) ` +
    `+ coach-manifest.json — ${turns.length} turns ` +
    `(${turns.filter((t) => t.kind === 'tool').length} tool, ${turns.filter((t) => t.kind === 'bargein').length} barge-in).`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
