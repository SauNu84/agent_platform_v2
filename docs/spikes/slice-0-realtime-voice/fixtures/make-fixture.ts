/**
 * Generates the fixed benchmark fixture: `manifest.json` (committed, reproducible)
 * + `driver.wav`.
 *
 *   tsx fixtures/make-fixture.ts [--turns 50] [--rate 24000] [--speech] [--voice Samantha]
 *
 * Default (no --speech): a deterministic low tone with silence gaps — fine for the
 * offline `mock` self-test (the mock is driven by the manifest, not the audio).
 *
 * `--speech` (macOS only, ZERO spend — uses the built-in `say` TTS): synthesizes a
 * REAL spoken conversation that elicits the scripted behavior on live vendors —
 * a normal turn, a turn that asks for PRO pricing (→ forces the `lookupPrice` tool
 * call), and a barge-in turn with a short cut-in utterance. Writes per-turn byte
 * offsets into the manifest so the harness streams the exact region per turn. This
 * removes the "real speech fixture" prerequisite for the live run with no credentials.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTurns, readWavPcm, type FixtureManifest, type FixtureTurn } from './fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function strArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1]) : def;
}

const turnsN = arg('turns', 50);
const sampleRate = arg('rate', 24000);
const frameMs = 20;
const speech = flag('speech');
const voice = strArg('voice', 'Samantha');

// ── PCM16 mono WAV writer ─────────────────────────────────────────────────────
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

function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const msOf = (pcm: Int16Array): number => Math.round((pcm.length / sampleRate) * 1000);

// ── speech synthesis via macOS `say` ─────────────────────────────────────────
function synth(tmp: string, text: string, idx: number): Int16Array {
  const out = join(tmp, `clip-${idx}.wav`);
  execFileSync('say', ['-v', voice, '-o', out, '--data-format', `LEI16@${sampleRate}`, text]);
  const { sampleRate: r, pcm } = readWavPcm(out);
  if (r !== sampleRate) throw new Error(`say produced ${r}Hz, expected ${sampleRate}`);
  return pcm;
}

// Utterance bank — the user is the salesperson; the agent is the skeptical buyer
// who must call lookupPrice when asked for pricing (see SCENARIO in bench.ts).
// Terse utterances keep the live run inside one heartbeat (~5-6 min for N=50 at
// 1x) and bound spend, while still triggering each behavior (a pricing ask forces
// lookupPrice; the cut-in tests barge-in). Latency/TTFA is unaffected by brevity.
const TXT = {
  normal: [
    'Tell me how teams adopt your platform.',
    'How long until we see value?',
    'Walk me through onboarding.',
  ],
  tool: 'What is the price for the PRO plan?',
  bargein: 'How does onboarding usually work for new teams?',
  bargeCutIn: 'Wait — how much per seat?',
};

const turns: FixtureTurn[] = buildTurns(turnsN);

let manifest: FixtureManifest;

if (speech) {
  const tmp = mkdtempSync(join(tmpdir(), 'slice0-fixture-'));
  try {
    // Pre-synthesize the small clip bank once, reuse across turns.
    const normalClips = TXT.normal.map((t, i) => synth(tmp, t, 100 + i));
    const toolClip = synth(tmp, TXT.tool, 200);
    const bargeClip = synth(tmp, TXT.bargein, 300);
    const cutInClip = synth(tmp, TXT.bargeCutIn, 301);

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

    for (const turn of turns) {
      if (turn.kind === 'tool') {
        const r = push(toolClip);
        turn.transcript = TXT.tool; turn.audioStartMs = r.startMs; turn.audioDurationMs = r.durationMs;
        turn.userMs = r.durationMs;
      } else if (turn.kind === 'bargein') {
        const r = push(bargeClip);
        turn.transcript = TXT.bargein; turn.audioStartMs = r.startMs; turn.audioDurationMs = r.durationMs;
        turn.userMs = r.durationMs;
        const c = push(cutInClip);
        turn.bargeTranscript = TXT.bargeCutIn; turn.bargeStartMs = c.startMs; turn.bargeDurationMs = c.durationMs;
        // cut in partway through the agent's reply
        turn.bargeInAfterMs = 500;
      } else {
        const clip = normalClips[turn.index % normalClips.length];
        const r = push(clip);
        turn.transcript = TXT.normal[turn.index % TXT.normal.length];
        turn.audioStartMs = r.startMs; turn.audioDurationMs = r.durationMs;
        turn.userMs = r.durationMs;
      }
      // inter-turn gap (kept in the WAV but outside any turn's region)
      parts.push(gap); cursorMs += msOf(gap);
    }

    const full = concat(parts);
    writeWav(join(HERE, 'driver.wav'), full, sampleRate);
    manifest = { wav: 'driver.wav', sampleRate, frameMs, audioKind: 'speech', turns };
    console.log(
      `[fixture] SPEECH fixture: driver.wav ${(full.length * 2 / 1024 / 1024).toFixed(1)} MiB ` +
      `(${(full.length / sampleRate).toFixed(1)}s @ ${sampleRate}Hz, voice=${voice}); ` +
      `${turns.length} turns with per-turn offsets + transcripts.`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  // placeholder tone (offline mock path)
  const totalMs = turns.reduce((a, t) => a + t.userMs + 600, 0);
  const samples = Math.floor((sampleRate * totalMs) / 1000);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 3000);
  writeWav(join(HERE, 'driver.wav'), pcm, sampleRate);
  manifest = { wav: 'driver.wav', sampleRate, frameMs, audioKind: 'tone', turns };
  console.log(
    `[fixture] TONE placeholder: driver.wav ${(pcm.length * 2 / 1024 / 1024).toFixed(1)} MiB. ` +
    `Run with --speech (macOS, no spend) to synthesize a real speech fixture for live runs.`,
  );
}

writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `[fixture] wrote manifest.json — ${manifest.turns.length} turns ` +
  `(${manifest.turns.filter((t) => t.kind === 'tool').length} tool, ` +
  `${manifest.turns.filter((t) => t.kind === 'bargein').length} barge-in), audioKind=${manifest.audioKind}.`,
);
