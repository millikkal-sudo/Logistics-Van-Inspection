import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabaseClients';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, UnauthorizedError } from '@/lib/session';

/**
 * Corrects a plate or a person's name from the check screen.
 *
 * Any signed-in inspector can do this, unlike the admin routes. The yard
 * is where you discover a plate was typed wrong, and making someone
 * finish a round against a record they know is wrong is how bad data
 * gets entrenched.
 *
 * Deliberately narrow: names only. Area, van assignment, pairing and
 * vehicle type stay with managers, because those change who is due for
 * inspection and what the coverage figures mean.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    const body: unknown = await request.json();

    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;
    const target = payload.target;
    const id = payload.id;
    const value = payload.value;

    if (target !== 'van' && target !== 'driver') {
      throw new ValidationError('target must be van or driver');
    }
    if (typeof id !== 'string' || id === '') {
      throw new ValidationError('id is required');
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError(
        target === 'van' ? 'Enter the plate' : 'Enter the name',
      );
    }

    const db = serviceClient();
    const clean = value.trim();

    const { data: before } = await db
      .from(target === 'van' ? 'vans' : 'drivers')
      .select(target === 'van' ? 'plate' : 'full_name')
      .eq('id', id)
      .maybeSingle();

    const { error } =
      target === 'van'
        ? await db.from('vans').update({ plate: clean.toUpperCase() }).eq('id', id)
        : await db.from('drivers').update({ full_name: clean }).eq('id', id);

    if (error !== null) {
      if (error.code === '23505') {
        throw new ValidationError('Another vehicle already has that plate');
      }
      throw new Error(error.message);
    }

    // Corrections to live records are worth a trail: this is the one
    // place a non-manager can change fleet data.
    await db.from('audit_log').insert({
      actor_id: profile.id,
      action: `${target}.corrected_by_inspector`,
      entity: target === 'van' ? 'vans' : 'drivers',
      entity_id: id,
      before,
      after: target === 'van' ? { plate: clean.toUpperCase() } : { full_name: clean },
    });

    return NextResponse.json({ ok: true, value: target === 'van' ? clean.toUpperCase() : clean });
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
