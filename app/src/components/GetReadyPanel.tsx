'use client';

/**
 * Pre-join "Get Ready" panel (SAU-344) — the NON-GATED half of the live-voice
 * session UX (parent SAU-218).
 *
 * This screen sends **no user audio to any vendor**, so it does not touch the
 * 7-criteria voice-privacy gate (Gate-2 DPA, SAU-221) and is safe to ship now.
 * It is avatar-led and matches the ToughTongue reference pre-join layout: a big
 * scenario/coach avatar, a persona one-liner, headphones/quiet-space guidance,
 * and a prominent "Join Now".
 *
 * Honesty constraints (hard — see SAU-344):
 *   - We do NOT call getUserMedia here. Requesting camera/mic permission and then
 *     running a self-scripted demo would be misleading; the real mic prompt lives
 *     in the in-session live dock (SAU-218), gated on SAU-208 + Gate-2 (SAU-221).
 *   - No dead / "coming soon" controls. "Join Now" routes into the honestly
 *     labelled *simulated* recap shipped in SAU-217 — nothing here implies live
 *     voice is active.
 *
 * It consumes the P1 light/cyan design tokens (globals.css :root) — no new design
 * system — reusing the same chrome as the rest of the detail surface.
 */
import { Avatar } from './Avatar';

export default function GetReadyPanel({
  name,
  category,
  slug,
  avatarUrl,
  personaLine,
  joining,
  onJoin,
  onClose,
}: {
  name: string;
  category: string;
  slug: string;
  avatarUrl?: string;
  /** A short in-character persona one-liner shown under the name, if available. */
  personaLine?: string;
  joining: boolean;
  onJoin: () => void;
  onClose: () => void;
}) {
  return (
    <div className="session-view get-ready">
      <div className="gr-head">
        <button
          className="back-link"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          ← {name}
        </button>
      </div>

      <div className="gr-hero">
        <div className="gr-avatar">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" width={140} height={140} style={{ borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            <Avatar name={name} category={category} slug={slug} size={140} />
          )}
        </div>

        <h1 className="gr-name">{name}</h1>
        {personaLine ? <p className="gr-persona">{personaLine}</p> : null}

        <p className="gr-ready-label"><strong>Get ready</strong></p>
        <ul className="gr-tips">
          <li>🎧 Use headphones or find a quiet space</li>
          <li>🗣 Speak naturally and allow short pauses for replies</li>
          <li>⏱ The session is short — focus on one good run</li>
        </ul>

        {/* Honest framing: this is a self-scripted simulated walkthrough, not live
            mic-based voice. Live audio is the gated next increment (SAU-218). */}
        <p className="gr-sim-note">
          This is a <strong>simulated demo</strong> — a self-scripted walkthrough so you can see how a
          session reads. Live mic-based voice is the next increment and isn&apos;t active here, so we
          don&apos;t ask for microphone access yet.
        </p>

        <button className="btn join gr-join" onClick={onJoin} disabled={joining}>
          {joining ? 'Starting…' : 'Join Now →'}
        </button>
      </div>
    </div>
  );
}
