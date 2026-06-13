/**
 * POST /api/telephony/twilio/status (SAU-270) — Twilio call status callback.
 *
 * Optional webhook Twilio hits with call lifecycle events (ringing, in-progress,
 * completed). Phase-1 spike: we just log it for observability and 204. Wiring these
 * into call-duration metering / a calls table is a later workstream.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => '');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      src: 'telephony-status',
      callSid: params.CallSid,
      status: params.CallStatus,
      duration: params.CallDuration,
    }),
  );
  return new NextResponse(null, { status: 204 });
}
