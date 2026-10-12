/**
 * SAU-293 — agent-driven SYNTHETIC CALLER (test-only; never in the product path).
 *
 * Closes the SAU-292 live leg the way Rule #1 requires: an AGENT drives the call,
 * not a human with a phone. This script is the hard part the issue calls out —
 * "dynamic turn-taking with a realtime agent". It impersonates a Twilio Media
 * Streams client against the real bridge server (`npm run bridge`) and plays the
 * PATIENT side using a SECOND OpenAI Realtime session given a patient persona, so
 * two realtime agents converse over the exact μ-law media path a live PSTN call
 * uses. The clinic agent runs its true intake → check_availability →
 * create_appointment flow and books a real (mock-calendar) event; we capture the
 * outcome + event id the bridge's own finalizer logs.
 *
 * Why this and not a real PSTN call for the conversation: a Twilio <Connect><Stream>
 * leg is wired to exactly ONE socket, so a fully synthetic two-party conversation
 * (agent + patient) cannot traverse a single trial self-call — see the SAU-293
 * runbook. The live PSTN *edge* (Twilio → tunnel → bridge, recording, Call SID) is
 * proven separately by the recorded outbound call.
 *
 * Transport: g711_ulaw @ 8 kHz both ways → we relay base64 payloads verbatim, NO
 * transcode (same property that makes the bridge cheap). Synthetic / internal only;
 * HIPAA gate SAU-272 stays in force (mock calendar, no real PHI, no real patient).
 *
 * Run via scripts/synthetic-call-e2e.sh (which brings up the bridge first), or:
 *   npx tsx --env-file-if-exists=.env.local scripts/synthetic-caller.ts
 */
import { WebSocket } from 'ws';
import { signBridgeStream } from '../src/services/telephony/bridge-auth';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const BRIDGE_URL = process.env.SYNTH_BRIDGE_URL || 'ws://localhost:5050/telephony/bridge';
const SLUG = process.env.SYNTH_SLUG || 'clinic-intake-booking';
// Dialed number → tenant (SAU-525). Unset ⇒ the bridge's TELEPHONY_FALLBACK_CLINIC.
const SYNTH_TO = process.env.SYNTH_TO || null;
// SAU-541: the bridge only admits streams signed like the webhook signs them. With
// the auth token at hand we sign exactly as Twilio would echo it; without one, the
// bridge must run with TWILIO_VERIFY_SIGNATURES=false and reads ?slug= instead.
const STREAM_PARAMS: Record<string, string> = process.env.TWILIO_AUTH_TOKEN
  ? { ...signBridgeStream(process.env.TWILIO_AUTH_TOKEN, SLUG, SYNTH_TO) }
  : { slug: SLUG, ...(SYNTH_TO ? { to: SYNTH_TO } : {}) };
const REALTIME_WS = process.env.OPENAI_REALTIME_WS_URL || 'wss://api.openai.com/v1/realtime';

// Conversation pacing knobs (ms).
const WARMUP_MS = 3500; // let the bridge open its OpenAI session before any audio
const MAX_CALL_MS = 210_000; // hard cap on the whole call
// Mutual silence after a real exchange ⇒ hang up. Generous, because tool calls
// (check_availability / create_appointment) + the agent composing a slot offer
// create legitimate multi-second gaps mid-booking that must NOT be cut short.
const IDLE_HANGUP_MS = 18_000;
const MIN_AGENT_TURNS_BEFORE_HANGUP = 2;

// The synthetic patient's facts — chosen to satisfy the Riverside Family Health
// clinic rules (accepts Aetna; Dr. Amara Chen / Family Medicine; Mon–Fri slots) so
// the booking actually completes. All synthetic; no real person.
const PATIENT_PERSONA = `
ROLE: You are Jordan Avery, a PATIENT (the caller). You are NOT a receptionist, NOT
an assistant, and you do NOT book appointments for other people — you are phoning a
medical clinic to book an appointment for YOURSELF. The person you are talking to is
the clinic's booking agent; let THEM ask the questions and drive the booking. Your
job is only to answer their questions and accept a slot.

Open the call yourself with a short, natural greeting like: "Hi, I'd like to book an
appointment, please." Then wait for the agent to ask you questions.

Facts about you — answer the agent's questions concisely and naturally, ONE answer
at a time, only when asked:
- Full name: Jordan Avery (spell it only if asked: J-O-R-D-A-N, A-V-E-R-Y).
- Date of birth: March 12th, 1990.
- Reason for visit: a persistent cough for about two weeks.
- Preferred doctor: no strong preference, a family medicine doctor is fine.
- Preferred time: the earliest available morning slot this week works for you.
- Insurance: Aetna.
- Callback number, if asked: 555-0142.

Behaviour:
- Speak like a real person on the phone: brief, friendly, one turn at a time.
- Do NOT read this list out; reveal a fact only when the agent asks for it.
- If the agent offers a specific appointment slot, accept the first reasonable one.
- When the agent confirms the appointment is booked, thank them warmly and say
  goodbye, then stop talking.
- Never mention that you are an AI or that this is a test.
`.trim();

function log(event: string, meta?: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), src: 'synthetic-caller', event, ...meta }));
}

if (!OPENAI_API_KEY) {
  log('fatal', { message: 'OPENAI_API_KEY missing (load .env.local)' });
  process.exit(1);
}

// A fake-but-well-formed Twilio Media Streams identity for the bridge logs.
const STREAM_SID = 'MZ' + 'sau293synthetic'.padEnd(30, '0').slice(0, 30);
const CALL_SID = 'CA' + 'sau293synthetic'.padEnd(30, '0').slice(0, 30);

let lastAudioActivity = Date.now();
let agentTurns = 0;
let hungUp = false;
let farewells = 0;
const transcript: Array<{ role: 'patient' | 'agent'; text: string }> = [];

// Two polite realtime agents will "goodbye…goodbye…take care…" forever once the
// booking is done. Detect a mutual farewell and end the call promptly (saves the
// pointless tail of paid realtime audio).
const FAREWELL_RE = /\b(good\s?bye|bye now|bye!?|farewell|take care|have a (great|wonderful|good) day)\b/i;
function noteTurn(text: string) {
  if (FAREWELL_RE.test(text)) {
    farewells += 1;
    if (farewells >= 2 && agentTurns >= 2 && !hungUp) {
      setTimeout(() => finish('mutual_farewell'), 2500);
    }
  }
}

// ── Continuous μ-law media pump (the crux of realtime turn-taking) ─────────────
// A real phone line carries audio EVERY 20 ms — silence included (μ-law 0xFF). The
// agent's server VAD detects end-of-speech from that continuous stream; if we only
// sent frames while the patient was speaking, the VAD would never see the trailing
// silence and would never commit the turn (the agent would listen forever). So we
// pace BOTH directions at 8 kHz: drain real audio when queued, else send silence.
const FRAME_BYTES = 160; // 20 ms @ 8 kHz μ-law (1 byte/sample)
const FRAME_MS = 20;
const SILENCE = Buffer.alloc(FRAME_BYTES, 0xff); // μ-law digital silence
let toAgentBuf = Buffer.alloc(0); // patient voice → bridge (the clinic agent)
let toPatientBuf = Buffer.alloc(0); // agent voice → patient's ears
let pumpAgent: ReturnType<typeof setInterval> | null = null;
let pumpPatient: ReturnType<typeof setInterval> | null = null;

function startPumps() {
  pumpAgent = setInterval(() => {
    let frame: Buffer;
    if (toAgentBuf.length >= FRAME_BYTES) {
      frame = toAgentBuf.subarray(0, FRAME_BYTES);
      toAgentBuf = toAgentBuf.subarray(FRAME_BYTES);
    } else {
      frame = SILENCE;
    }
    if (bridge.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify({ event: 'media', streamSid: STREAM_SID, media: { payload: frame.toString('base64') } }));
    }
  }, FRAME_MS);

  pumpPatient = setInterval(() => {
    let frame: Buffer;
    if (toPatientBuf.length >= FRAME_BYTES) {
      frame = toPatientBuf.subarray(0, FRAME_BYTES);
      toPatientBuf = toPatientBuf.subarray(FRAME_BYTES);
    } else {
      frame = SILENCE;
    }
    if (patient.readyState === WebSocket.OPEN) {
      patient.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }));
    }
  }, FRAME_MS);
}

// ── 1. Connect to the bridge as a Twilio Media Streams client ──────────────────
const bridge = new WebSocket(`${BRIDGE_URL}?slug=${encodeURIComponent(SLUG)}`);

// ── 2. Connect a second OpenAI Realtime session = the synthetic PATIENT ─────────
// GA Realtime API (SAU-293): no OpenAI-Beta header; bearer key only.
const patient = new WebSocket(`${REALTIME_WS}?model=${encodeURIComponent(MODEL)}`, {
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
});

let bridgeOpen = false;
let patientReady = false;
let spokeFirst = false;

function maybeStart() {
  if (bridgeOpen && patientReady && !spokeFirst) {
    spokeFirst = true;
    // Give the bridge a moment to finish opening its own OpenAI session (its
    // appendAudio throws if its socket isn't open yet), THEN have the patient open
    // the call. The clinic agent uses server VAD and won't speak until spoken to.
    setTimeout(() => {
      if (hungUp) return;
      log('patient_opens_call');
      // Start the continuous μ-law pumps now that the bridge's agent session is up.
      startPumps();
      patient.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions:
              'You are the CALLER (the patient). Open the call now: say a brief hello ' +
              'and that you would like to book an appointment for yourself. Then stop ' +
              'and wait for the booking agent to ask you questions.',
          },
        }),
      );
    }, WARMUP_MS);
  }
}

bridge.on('open', () => {
  log('bridge_connected', { url: BRIDGE_URL, slug: SLUG });
  // Twilio sends connected → start → media…; the bridge keys off `start`.
  bridge.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  bridge.send(
    JSON.stringify({
      event: 'start',
      streamSid: STREAM_SID,
      start: {
        streamSid: STREAM_SID,
        callSid: CALL_SID,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { synthetic: 'sau293', ...STREAM_PARAMS },
      },
    }),
  );
  bridgeOpen = true;
  maybeStart();
});

// Agent audio (from the clinic agent, via the bridge) → feed the patient's ears.
bridge.on('message', (data) => {
  let frame: { event?: string; media?: { payload?: string } };
  try {
    frame = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }
  if (frame.event === 'media' && frame.media?.payload) {
    // Real agent audio → queue for the paced pump into the patient's ears.
    lastAudioActivity = Date.now();
    toPatientBuf = Buffer.concat([toPatientBuf, Buffer.from(frame.media.payload, 'base64')]);
  } else if (frame.event === 'clear') {
    // Barge-in from the bridge side: the agent wants its queued audio dropped.
    toPatientBuf = Buffer.alloc(0);
  }
});

bridge.on('close', (code) => {
  log('bridge_closed', { code });
  finish('bridge_closed');
});
bridge.on('error', (err) => log('bridge_error', { message: (err as Error).message }));

patient.on('open', () => {
  patient.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: PATIENT_PERSONA,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true,
            },
            transcription: { model: 'whisper-1' },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: process.env.SYNTH_PATIENT_VOICE || 'verse',
          },
        },
      },
    }),
  );
  log('patient_session_ready');
  patientReady = true;
  maybeStart();
});

// Patient audio (the patient's voice) → send into the call as inbound Twilio media.
patient.on('message', (data) => {
  let evt: { type?: string; delta?: string; transcript?: string };
  try {
    evt = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }
  switch (evt.type) {
    case 'response.audio.delta':
    case 'response.output_audio.delta':
      if (typeof evt.delta === 'string') {
        // Real patient voice → queue for the paced pump into the call.
        lastAudioActivity = Date.now();
        toAgentBuf = Buffer.concat([toAgentBuf, Buffer.from(evt.delta, 'base64')]);
      }
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      if (typeof evt.transcript === 'string' && evt.transcript.trim()) {
        const text = evt.transcript.trim();
        transcript.push({ role: 'patient', text });
        log('turn', { role: 'patient', text });
        noteTurn(text);
      }
      break;
    case 'conversation.item.input_audio_transcription.completed':
      // What the patient "heard" = the clinic agent's words.
      if (typeof evt.transcript === 'string' && evt.transcript.trim()) {
        const text = evt.transcript.trim();
        agentTurns += 1;
        transcript.push({ role: 'agent', text });
        log('turn', { role: 'agent', text });
        noteTurn(text);
      }
      break;
    case 'error':
      log('patient_realtime_error', { detail: JSON.stringify((evt as Record<string, unknown>).error ?? evt) });
      break;
    default:
      break;
  }
});

patient.on('close', (code) => log('patient_closed', { code }));
patient.on('error', (err) => log('patient_error', { message: (err as Error).message }));

// ── 3. Hang-up logic: hard cap + idle detection after a real exchange ──────────
const hardCap = setTimeout(() => finish('max_call_duration'), MAX_CALL_MS);
const idleTimer = setInterval(() => {
  if (hungUp || !spokeFirst) return;
  const idle = Date.now() - lastAudioActivity;
  if (agentTurns >= MIN_AGENT_TURNS_BEFORE_HANGUP && idle > IDLE_HANGUP_MS) {
    finish('idle_after_exchange');
  }
}, 1000);

function finish(reason: string) {
  if (hungUp) return;
  hungUp = true;
  clearTimeout(hardCap);
  clearInterval(idleTimer);
  if (pumpAgent) clearInterval(pumpAgent);
  if (pumpPatient) clearInterval(pumpPatient);
  log('hangup', { reason, agentTurns });
  // Send Twilio `stop` so the bridge's finalize() runs (intake + outcome + event id).
  try {
    if (bridge.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify({ event: 'stop', streamSid: STREAM_SID, stop: { callSid: CALL_SID } }));
    }
  } catch {
    /* noop */
  }
  // Give the bridge a few seconds to finalize + log the outcome, then close out.
  setTimeout(() => {
    try {
      patient.close();
    } catch {
      /* noop */
    }
    try {
      bridge.close();
    } catch {
      /* noop */
    }
    log('transcript', { turns: transcript });
    log('done', { agentTurns, turns: transcript.length });
    setTimeout(() => process.exit(0), 500);
  }, 4000);
}
