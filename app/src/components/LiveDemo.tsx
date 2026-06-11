'use client';

/**
 * Live demo flow (SAU-238, board mockups 2026-06-11).
 *
 * Replaces the old "Live demo" button that jumped straight to a mock transcript.
 * Two screens, matching the board's design:
 *   1. VERIFY  — a real camera/mic pre-flight check (browser getUserMedia + a live
 *                mic-level meter) plus "Get Ready" guidance, then "Join Now".
 *   2. LIVE    — the interaction window: timer, the scenario's avatar, an
 *                expandable "Your Instructions", call controls, and the transcript
 *                streaming down the right-hand side.
 *
 * Voice: "Start" prefers REAL live voice — the browser opens a WebRTC session to
 * OpenAI Realtime using a short-lived ephemeral client secret minted by
 * /api/realtime/token (the platform API key never reaches the client). Mic audio
 * streams up, the model's audio plays back, and finalized transcript turns stream
 * into the right-hand panel; on End session the transcript is persisted + metered
 * via the same client-driven path as the bench. When no vendor key is configured
 * the token route answers 501 and we fall back to the deterministic **mock**
 * provider (labeled "Simulated"), revealing turns progressively. The camera/mic
 * verification is genuinely real in both modes (browser media APIs).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import type { SessionSummary } from './DetailShell';

type Turn = SessionSummary['turns'][number];
type Phase = 'verify' | 'live';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function LiveDemo({
  name,
  instructions,
  category,
  slug,
  avatarUrl,
  sessionsEndpoint,
  onClose,
  onSession,
}: {
  name: string;
  instructions: string;
  category: string;
  slug: string;
  avatarUrl?: string;
  sessionsEndpoint: string;
  onClose: () => void;
  onSession: (summary: SessionSummary) => void;
}) {
  const [phase, setPhase] = useState<Phase>('verify');
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0); // 0..1 smoothed RMS
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [showInstructions, setShowInstructions] = useState(false);
  const [vendor, setVendor] = useState<string>('mock');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const revealRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Real live voice (browser WebRTC → OpenAI Realtime) — set when a vendor key is present.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveTurnsRef = useRef<Turn[]>([]);
  const liveStartedAtRef = useRef<number>(0);

  // ── Media teardown (release the camera/mic light) ──────────────────────────
  const stopMedia = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  // ── Acquire camera + mic, wire a live level meter ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        // Mic level meter via Web Audio analyser (RMS of the time-domain buffer).
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          setMicLevel((prev) => prev * 0.6 + Math.min(1, rms * 3) * 0.4); // smooth + gain
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (!cancelled) setMediaError((e as Error).message || 'Camera/microphone unavailable or permission denied.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Reflect the camera on/off toggle onto the live video track.
  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((t) => { t.enabled = camOn; });
  }, [camOn]);

  // Full teardown on unmount.
  useEffect(() => () => {
    stopMedia();
    if (timerRef.current) clearInterval(timerRef.current);
    if (revealRef.current) clearTimeout(revealRef.current);
  }, [stopMedia]);

  function joinNow() {
    setPhase('live');
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  async function endSession() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (revealRef.current) clearTimeout(revealRef.current);
    // Real live session: tear down WebRTC and persist the captured transcript so it
    // shows under Sessions and gets metered (same client-driven path as the bench).
    const livePc = pcRef.current;
    if (livePc) {
      const turnsToSave = liveTurnsRef.current;
      try { dcRef.current?.close(); } catch { /* noop */ }
      try { livePc.close(); } catch { /* noop */ }
      dcRef.current = null;
      pcRef.current = null;
      if (turnsToSave.length) {
        const startedAt = liveStartedAtRef.current || Date.now();
        const endedAt = Date.now();
        try {
          const res = await fetch(sessionsEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vendor: 'openai',
              transcript: { sessionId: `live-${slug}-${startedAt}`, turns: turnsToSave, toolCalls: [], startedAt, endedAt },
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            onSession({
              id: data.sessionId ?? `live-${slug}-${startedAt}`,
              status: 'completed',
              startedAt: new Date(startedAt).toISOString(),
              endedAt: new Date(endedAt).toISOString(),
              turns: turnsToSave,
            });
          }
        } catch { /* best-effort persistence; the call already happened */ }
      }
    }
    stopMedia();
    onClose();
  }

  // Append a finalized transcript turn to both the live view and the save buffer.
  const appendLiveTurn = useCallback((turn: Turn) => {
    liveTurnsRef.current = [...liveTurnsRef.current, turn];
    setTurns((t) => [...t, turn]);
  }, []);

  // Real live voice: browser WebRTC ↔ OpenAI Realtime via an ephemeral client secret
  // (the platform API key never reaches the browser). Mirrors the server adapter's GA
  // session config + event names (src/voice/adapters/openai.ts).
  async function startLive(tok: { clientSecret: string; model: string; scenario?: { instructions?: string; voice?: unknown } }) {
    setVendor('openai');
    liveTurnsRef.current = [];
    liveStartedAtRef.current = Date.now();
    // OpenAI's `voice` must be a plain string; coerce defensively (the route already
    // sends a string, but a scenario voice object would otherwise be rejected).
    const v = tok.scenario?.voice;
    const voice = typeof v === 'string' ? v : (v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : 'alloy');

    const stream = streamRef.current ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
    streamRef.current = stream;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    // Play the model's audio.
    pc.ontrack = (e) => {
      if (audioRef.current) { audioRef.current.srcObject = e.streams[0]; audioRef.current.play().catch(() => {}); }
    };
    // Send the mic uplink.
    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
    pc.oniceconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState) && pcRef.current === pc) {
        setError((prev) => prev ?? 'Live connection dropped — your transcript is saved on End session.');
      }
    };

    // Data channel: configure the session and receive transcript events.
    const dc = pc.createDataChannel('oai-events');
    dcRef.current = dc;
    dc.onopen = () => {
      dc.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: tok.scenario?.instructions ?? instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
            },
            output: { voice },
          },
        },
      }));
    };
    dc.onmessage = (e) => {
      let ev: { type?: string; transcript?: string; error?: { message?: string } };
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.type) {
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript) appendLiveTurn({ role: 'user', text: ev.transcript, at: Date.now() });
          break;
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done': // legacy beta name, kept defensively
          if (ev.transcript) appendLiveTurn({ role: 'agent', text: ev.transcript, at: Date.now() });
          break;
        case 'error':
          setError(ev.error?.message ?? 'Realtime session error');
          break;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(tok.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${tok.clientSecret}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) {
      const detail = await sdpRes.text().catch(() => '');
      throw new Error(`live connect failed (${sdpRes.status})${detail ? `: ${detail.slice(0, 120)}` : ''}`);
    }
    const answer = await sdpRes.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    setConnected(true); // open-ended call — user talks, ends with "End session"
  }

  // Simulated fallback: run the server session (mock vendor) and reveal turns
  // progressively so the right-hand transcript reads like a live conversation.
  async function startSimulated() {
    const res = await fetch(sessionsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    const allTurns: Turn[] = (data.transcript?.turns ?? []).filter(Boolean);
    setVendor(data.usage?.vendor ?? 'mock');
    setConnected(true);

    // Persist into the Sessions list immediately (full transcript).
    onSession({
      id: data.sessionId,
      status: 'completed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      turns: allTurns,
    });

    // Reveal turn-by-turn for the live feel.
    let i = 0;
    const revealNext = () => {
      if (i >= allTurns.length) { setRunning(false); setFinished(true); return; }
      setTurns((t) => [...t, allTurns[i]]);
      i += 1;
      revealRef.current = setTimeout(revealNext, 900);
    };
    revealNext();
  }

  // "Start" — prefer real live voice; fall back to the simulated session when no
  // vendor key is configured (the token route answers 501).
  async function start() {
    setRunning(true);
    setError(null);
    setTurns([]);
    setConnected(false);
    setFinished(false);
    try {
      const tokenRes = await fetch('/api/realtime/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (tokenRes.status === 501) {
        await startSimulated(); // no vendor key → simulated path
        return;
      }
      const tok = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tok.error ?? `token mint failed (${tokenRes.status})`);
      await startLive(tok);
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
      setConnected(false);
    }
  }

  const level = Math.round(micLevel * 5); // 0..5 dots

  // ── VERIFY screen ──────────────────────────────────────────────────────────
  if (phase === 'verify') {
    return (
      <div className="live-demo">
        <div className="ld-verify-head">
          <button className="back-link" onClick={endSession} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>← {name}</button>
        </div>
        <h1 className="ld-title">{name}</h1>
        <div className="ld-verify">
          <div className="ld-preview-col">
            <div className="ld-video-box">
              <video ref={videoRef} className="ld-video" muted playsInline />
              {(!camOn || mediaError) && (
                <div className="ld-video-off">{mediaError ? '📷 Camera unavailable' : '📷 Camera off'}</div>
              )}
            </div>
            <div className="ld-devices">
              <button className={`btn-sm ${camOn ? 'ld-on' : ''}`} onClick={() => setCamOn((c) => !c)}>
                📹 {camOn ? '✓ Camera' : 'Camera off'}
              </button>
              <span className="ld-mic-test">
                🎙 Test Mic
                <span className="ld-mic-dots" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((i) => <span key={i} className={`ld-dot ${i < level ? 'on' : ''}`} />)}
                </span>
              </span>
            </div>
            <p className="ld-hint">Say &ldquo;Hi&rdquo; to test your mic 🎤</p>
          </div>

          <div className="ld-ready-col">
            <span className="ld-waiting">● AI Agent is waiting… Join now!</span>
            <p className="ld-ready-label"><strong>Get Ready:</strong></p>
            <ul className="ld-ready-list">
              <li>🎧 Use headphones or be in a quiet space</li>
              <li>🎙 Allow natural pauses for the agent to respond</li>
            </ul>
            <p className="ld-trouble">Having issues? <a href="/history">Troubleshoot</a> or talk to us</p>
            <p className="ld-record">This meeting will be recorded.</p>
            <button className="btn join ld-join" onClick={joinNow}>Join Now →</button>
            {mediaError
              ? <p className="ld-warn">Mic/camera not detected — you can still join, but please verify your microphone.</p>
              : <p className="ld-warn">Please verify the volume from your microphone.</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── LIVE interaction window ─────────────────────────────────────────────────
  return (
    <div className="live-demo">
      <div className="ld-live">
        <div className="ld-stage">
          <div className="ld-timer">⏱ {fmt(elapsed)}</div>
          <div className="ld-avatar-wrap">
            <div className="live-avatar" style={{ borderColor: micLevel > 0.15 ? 'var(--accent)' : 'var(--border)' }}>
              {avatarUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={avatarUrl} alt="" width={180} height={180} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                : <Avatar name={name} category={category} slug={slug} size={180} />}
            </div>
          </div>
          <h1 className="ld-stage-name">{name}</h1>
          <button className="ld-instr-toggle" onClick={() => setShowInstructions((v) => !v)}>
            🎙 Your Instructions {showInstructions ? '▾' : '▸'}
          </button>
          {showInstructions && <div className="ld-instructions">{instructions}</div>}

          <div className="ld-controls">
            <button
              className={`ld-mic ${micLevel > 0.15 ? 'live' : ''}`}
              title="Microphone"
              aria-label="Microphone"
            >🎙</button>
            <button className="ld-more" title="More" aria-label="More">⋮</button>
            {!running && !finished && (
              <button className="btn join ld-start" onClick={start}>Start ▶</button>
            )}
            {running && !connected && <span className="ld-listening">● Connecting…</span>}
            {running && connected && (
              <span className="ld-listening">{vendor === 'openai' ? '● Live — speak now' : '● Listening…'}</span>
            )}
            {(finished || (running && connected && vendor === 'openai')) && (
              <button className="btn ld-end" onClick={endSession}>End session</button>
            )}
          </div>
          {/* Hidden sink for the model's audio downlink (live path). */}
          <audio ref={audioRef} autoPlay hidden />
          {vendor === 'mock' && (running || finished) && (
            <p className="ld-sim">Simulated session — no voice-vendor key is configured for this environment.</p>
          )}
          {error && <div className="notice" role="alert">{error}</div>}
        </div>

        {/* Transcript — right-hand side */}
        <aside className="ld-transcript">
          <div className="ld-transcript-head">Transcript</div>
          {turns.filter(Boolean).length === 0 ? (
            <p className="empty">{running ? 'Connecting…' : 'Press Start to begin the conversation.'}</p>
          ) : (
            <div className="conversation">
              {turns.filter(Boolean).map((turn, i) => (
                <div key={i} className={`turn turn-${turn.role}`}>
                  <div className="turn-role">{turn.role === 'agent' ? 'AI' : 'You'}</div>
                  <div className="turn-text">{turn.text}</div>
                </div>
              ))}
            </div>
          )}
          <button className="back-link ld-leave" onClick={endSession} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            ← Leave & save
          </button>
        </aside>
      </div>
    </div>
  );
}
