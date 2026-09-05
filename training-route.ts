import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabaseClients';
import { ValidationError } from '@/lib/inspectionRepository';
import { getTrainingInsight } from '@/lib/trainingInsight';
import { dubaiDayRange } from '@/lib/shift';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

/**
 * The training queue.
 *
 * Split out of the reports endpoint so a filter change on the Reports
 * tab no longer computes a queue nobody is looking at.
 */
export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const { searchParams } = new URL(request.url);
    const areaParam = searchParams.get('areaId');
    const days = Number(searchParams.get('days') ?? '30');

    const dubaiToday = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const to = dubaiToday.toISOString().slice(0, 10);
    const from = new Date(dubaiToday.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const range = dubaiDayRange(from, to);

    return NextResponse.json(
      await getTrainingInsight(
        range.from,
        range.to,
        areaParam === null || areaParam === '' ? undefined : areaParam,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof UnauthorizedError) {
      return NextResponse.json({ error: cause.message }, { status: 401 });
    }
    if (cause instanceof ForbiddenError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    const message = cause instanceof Error ? cause.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
};

/**
 * Records that training was delivered.
 *
 * Accepts one person or a whole list, because clearing an area one row
 * at a time after a group briefing is the kind of friction that stops
 * people logging it at all.
 *
 * Dated, not a flag: failures after this moment still count, so someone
 * who slips again returns to the queue on their own.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;
    const ids = Array.isArray(payload.personIds)
      ? payload.personIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];

    if (ids.length === 0) {
      throw new ValidationError('Choose at least one person');
    }

    const db = serviceClient();

    const { data: people, error: lookupError } = await db
      .from('drivers')
      .select('id, full_name')
      .in('id', ids);

    if (lookupError !== null) {
      throw new Error(lookupError.message);
    }

    const found = (people ?? []) as { id: string; full_name: string }[];
    if (found.length === 0) {
      throw new ValidationError('Those people no longer exist');
    }

    const topic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';

    const { error } = await db.from('training_sessions').insert(
      found.map((person) => ({
        person_id: person.id,
        // Stored as text so the record survives the person being deleted.
        person_name: person.full_name,
        topic: topic === '' ? null : topic,
        note: note === '' ? null : note,
        completed_by: profile.id,
      })),
    );

    if (error !== null) {
      throw new Error(`Could not record the training: ${error.message}`);
    }

    await db.from('audit_log').insert({
      actor_id: profile.id,
      action: 'training.recorded',
      entity: 'training_sessions',
      after: { people: found.map((person) => person.full_name), topic },
    });

    return NextResponse.json({ ok: true, recorded: found.length });
  } catch (cause: unknown) {
    if (cause instanceof UnauthorizedError) {
      return NextResponse.json({ error: cause.message }, { status: 401 });
    }
    if (cause instanceof ForbiddenError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof ValidationError) {
      return NextResponse.json({ error: cause.message }, { status: 422 });
    }
    const message = cause instanceof Error ? cause.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
};
