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
 * Honesty: the camera/mic verification is genuinely real (browser media APIs, no
 * vendor). The conversation itself is driven by the existing server session seam,
 * which is the deterministic **mock** provider by default — real end-user audio to
 * a realtime voice vendor stays gated on voice provisioning (SAU-221/SAU-208), so
 * the live window labels itself "Simulated" when the session vendor is mock. The
 * turns are revealed progressively to read like a live call.
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
  sessionsEndpoint,
  onClose,
  onSession,
}: {
  name: string;
  instructions: string;
  category: string;
  slug: string;
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
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const revealRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Media teardown (release the camera/mic light) ──────────────────────────
  const stopMedia = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
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

  function endSession() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (revealRef.current) clearTimeout(revealRef.current);
    stopMedia();
    onClose();
  }

  // "Start" — run the server session (mock by default) and reveal the turns
  // progressively so the right-hand transcript reads like a live conversation.
  async function start() {
    setRunning(true);
    setError(null);
    setTurns([]);
    setFinished(false);
    try {
      const res = await fetch(sessionsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      const allTurns: Turn[] = data.transcript?.turns ?? [];
      const v = data.usage?.vendor ?? 'mock';
      setVendor(v);

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
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
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
              <Avatar name={name} category={category} slug={slug} size={180} />
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
            {running && <span className="ld-listening">● Listening…</span>}
            {finished && <button className="btn ld-end" onClick={endSession}>End session</button>}
          </div>
          {vendor === 'mock' && (
            <p className="ld-sim">Simulated session — live voice is pending voice-provider provisioning.</p>
          )}
          {error && <div className="notice" role="alert">{error}</div>}
        </div>

        {/* Transcript — right-hand side */}
        <aside className="ld-transcript">
          <div className="ld-transcript-head">Transcript</div>
          {turns.length === 0 ? (
            <p className="empty">{running ? 'Connecting…' : 'Press Start to begin the conversation.'}</p>
          ) : (
            <div className="conversation">
              {turns.map((turn, i) => (
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
