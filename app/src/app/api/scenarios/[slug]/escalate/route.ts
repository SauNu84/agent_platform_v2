/**
 * /api/scenarios/[slug]/escalate — human handoff for a live call (SAU-273, WS4).
 *
 * The browser/telephony bridge POSTs here when the caller asks for a human, the
 * model can't resolve the request, or a mid-call model/telephony error occurs
 * (`forced: "system_failure"`). We decide the path via the pure escalation rules
 * (warm transfer in open hours, voicemail/callback after hours), execute it
 * through the fail-soft handoff seam, notify the clinic, and return the telephony
 * instruction the bridge should play — so a live caller is never dropped (AC #2/#3).
 *
 * Server-side so the clinic's hours/rules can't be prompt-injected, mirroring the
 * tools route. Synthetic/test only until the HIPAA gate (SAU-272).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { withActor } from '@/services/current-user';
import { handleEscalation } from '@/services/clinic-escalation';
import { maskRecipient } from '@/services/clinic-notify';

export const dynamic = 'force-dynamic';

type Turn = { role: 'user' | 'agent'; text: string; at: number };

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  return withActor(async (actor) => {
    const store = getStore();
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const scenario = await getScenario(store, params.slug);
    if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

    let body: {
      sessionId?: string;
      turns?: Turn[];
      forced?: 'system_failure' | null;
      callerNumber?: string | null;
    } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body → treat as an explicit, reasonless escalation */
    }

    const turns = Array.isArray(body.turns) ? body.turns : [];
    // With no transcript signal and no forced trigger, default to an explicit
    // human request so the endpoint always yields a handoff path (never a no-op).
    const forced = body.forced === 'system_failure' ? 'system_failure' : null;
    const reference = body.sessionId?.trim() || `live-${scenario.id}`;

    const esc = await handleEscalation({
      turns: forced || turns.length ? turns : [{ role: 'user', text: 'talk to a human', at: 0 }],
      outcome: 'escalated',
      reference,
      callerNumber: body.callerNumber ?? null,
      forced,
      clinicName: scenario.name,
    });

    // Record the delivery log for the clinic notice (no PHI). Tagged to the session
    // when one is supplied, so it shows up in that session's notification history.
    for (const d of esc.notifications) {
      await store.recordClinicNotification({
        sessionId: body.sessionId?.trim() || null,
        userId: actor.userId,
        clinicId: actor.clinicId,
        reference,
        channel: d.channel,
        audience: d.audience,
        recipientMasked: d.recipientMasked,
        status: d.status,
        providerId: d.providerId ?? null,
        simulated: d.simulated,
        error: d.error ?? null,
      });
    }

    return NextResponse.json(
      {
        escalated: esc.escalated,
        reason: esc.reason,
        action: esc.action,
        afterHours: esc.afterHours,
        // The TwiML/telephony instruction the bridge plays to the live caller.
        instruction: esc.handoff?.instruction ?? null,
        handoffSimulated: esc.handoff?.simulated ?? true,
        caller: body.callerNumber ? maskRecipient(body.callerNumber) : null,
      },
      { status: 200 },
    );
  });
}
