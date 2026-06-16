/**
 * /api/scenarios/[slug]/tools — execute a SERVER-SIDE agent tool (SAU-267).
 *
 * The realtime voice session runs in the browser, but the action-taking tools
 * (`check_availability`, `create_appointment`) must run on the server so the
 * clinic's rules are enforced where they can't be prompt-injected and the calendar
 * credentials never touch the client (AC #2). When the model emits a function
 * call, the browser POSTs `{ tool, args }` here; we validate the tool is a
 * server-side tool declared on the scenario, dispatch it to the clinic booking
 * service, and return the structured result for the browser to feed back into the
 * session as the function_call_output.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { getActor } from '@/services/current-user';
import { runClinicTool, CLINIC_TOOL_NAMES } from '@/services/clinic-booking';
import { resolveCalendarAdapter } from '@/services/calendar';
import { getClinicConfig } from '@/services/clinic-config';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: { tool?: string; args?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* fall through to validation */
  }
  const tool = typeof body.tool === 'string' ? body.tool : '';

  // The tool must be a server-side tool actually declared on THIS scenario — no
  // executing arbitrary tools, and UI-only tools have no server executor.
  const decl = scenario.tools.find((t) => t.name === tool);
  if (!decl) return NextResponse.json({ error: `tool "${tool}" is not declared on this scenario` }, { status: 400 });
  if (decl.sideEffect === 'ui') return NextResponse.json({ error: `tool "${tool}" has no server-side executor` }, { status: 400 });
  if (!(CLINIC_TOOL_NAMES as readonly string[]).includes(tool)) {
    return NextResponse.json({ error: `no executor registered for "${tool}"` }, { status: 400 });
  }

  try {
    // Point the booking adapter at THIS clinic's calendar (SAU-271 WS2): the
    // actor's per-clinic Google OAuth connection if connected, else the Phase-0
    // sandbox token, else the simulated mock — resolved fail-soft.
    const calendar = await resolveCalendarAdapter({ store, userId: actor.userId });
    // Load THIS operator's authored clinic definition (SAU-300, WS-A): hours,
    // doctors, services, insurance and booking rules. The pure rules engine still
    // enforces them in the tool — never the prompt (AC #2). Falls back to the
    // Phase-0 DEFAULT_CLINIC when nothing has been authored yet.
    const clinic = await getClinicConfig(store, actor.userId, actor.clinicId);
    const result = await runClinicTool(tool, body.args, { clinic, calendar });
    return NextResponse.json({ tool, result }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
