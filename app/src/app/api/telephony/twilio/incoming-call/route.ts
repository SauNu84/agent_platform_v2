/**
 * POST /api/telephony/twilio/incoming-call (SAU-270) — Twilio inbound-call webhook.
 *
 * Configure this URL as the "A CALL COMES IN" webhook for the test number. Twilio
 * POSTs form-encoded call params; we answer with TwiML that bridges the call's
 * bidirectional audio to our media-stream server (`<Connect><Stream>`), which wires
 * it to the realtime clinic agent.
 *
 * Behind the swappable telephony seam (AC #2): no Twilio creds OR no public bridge
 * URL ⇒ the adapter returns fail-soft TwiML (a polite spoken notice + hangup), never
 * a crash. Signature verification is enforced when an auth token is configured
 * (skippable via `TWILIO_VERIFY_SIGNATURES=false` for local tunnels).
 *
 * The dialed number maps to a scenario via `?slug=` (set per-number in Twilio) or
 * `TELEPHONY_DEFAULT_SCENARIO` (defaults to the clinic agent).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTelephonyAdapter, getTwilioConfig, bridgeWsUrlFor } from '@/services/telephony';

export const dynamic = 'force-dynamic';

const DEFAULT_SCENARIO = process.env.TELEPHONY_DEFAULT_SCENARIO || 'clinic-intake-booking';

/** Public URL Twilio actually called (for signature verification behind a tunnel). */
function publicUrl(req: NextRequest): string {
  const override = process.env.TELEPHONY_PUBLIC_WEBHOOK_URL;
  if (override) return override;
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return host ? `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}` : req.url;
}

function xml(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: { 'Content-Type': 'text/xml' } });
}

export async function POST(req: NextRequest) {
  // Twilio sends application/x-www-form-urlencoded.
  const raw = await req.text().catch(() => '');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  const slug = req.nextUrl.searchParams.get('slug') || DEFAULT_SCENARIO;
  const adapter = getTelephonyAdapter();

  // Authenticate the webhook (live adapter only; mock trusts dev requests).
  const trusted = adapter.verifyWebhook({
    url: publicUrl(req),
    signature: req.headers.get('x-twilio-signature'),
    params,
  });
  if (!trusted) {
    return NextResponse.json({ error: 'invalid Twilio signature' }, { status: 403 });
  }

  const cfg = getTwilioConfig();
  // The dialed number is how the bridge finds the tenant + payer (SAU-525).
  const bridgeWsUrl = cfg ? bridgeWsUrlFor(cfg, slug, params.To) ?? '' : '';

  const answer = adapter.answerInbound({
    callId: params.CallSid,
    from: params.From,
    to: params.To,
    scenarioSlug: slug,
    bridgeWsUrl,
  });
  return xml(answer.body);
}
