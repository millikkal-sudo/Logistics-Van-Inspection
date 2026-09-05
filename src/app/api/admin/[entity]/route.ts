import { NextResponse } from 'next/server';
import {
  createRecord,
  deleteRecord,
  setActive,
  updateRecord,
  type Entity,
} from '@/lib/adminRepository';
import { isApprover, proposeChange } from '@/lib/approvals';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

const ENTITIES: Entity[] = ['areas', 'vans', 'drivers', 'causes', 'actions'];

const isEntity = (value: string): value is Entity => ENTITIES.includes(value as Entity);

const errorResponse = (cause: unknown): NextResponse => {
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
};

type Context = { params: Promise<{ entity: string }> };

/** Only managers and admins may change reference data. */
const authorize = async (entity: string): Promise<{ profile: Awaited<ReturnType<typeof currentProfile>>; entity: Entity }> => {
  if (!isEntity(entity)) {
    throw new ValidationError(`Unknown record type: ${entity}`);
  }
  const profile = await currentProfile();
  requireRole(profile, ['manager', 'admin']);
  return { profile, entity };
};

export const POST = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { entity } = await context.params;
    const auth = await authorize(entity);
    const body: unknown = await request.json();

    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;

    // Anyone but an approver proposes; only an approver applies.
    if (!(isApprover(auth.profile))) {
      const { summary } = await proposeChange(
        auth.entity,
        'create',
        null,
        payload,
        auth.profile,
      );
      return NextResponse.json({ queued: true, summary }, { status: 202 });
    }

    const result = await createRecord(auth.entity, payload, auth.profile);
    return NextResponse.json(result, { status: 201 });
  } catch (cause: unknown) {
    return errorResponse(cause);
  }
};

export const PATCH = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { entity } = await context.params;
    const auth = await authorize(entity);
    const body: unknown = await request.json();

    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;
    const id = payload.id;

    if (typeof id !== 'string' || id === '') {
      throw new ValidationError('id is required');
    }

    // A bare { id, active } is a deactivation, not a full edit.
    const isToggle = typeof payload.active === 'boolean' && Object.keys(payload).length === 2;

    if (!(isApprover(auth.profile))) {
      const { summary } = await proposeChange(
        auth.entity,
        isToggle ? 'setActive' : 'update',
        id,
        payload,
        auth.profile,
      );
      return NextResponse.json({ queued: true, summary }, { status: 202 });
    }

    if (isToggle) {
      await setActive(auth.entity, id, payload.active === true, auth.profile);
      return NextResponse.json({ ok: true });
    }

    await updateRecord(auth.entity, id, payload, auth.profile);
    return NextResponse.json({ ok: true });
  } catch (cause: unknown) {
    return errorResponse(cause);
  }
};

export const DELETE = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { entity } = await context.params;
    const auth = await authorize(entity);

    const id = new URL(request.url).searchParams.get('id');
    if (id === null || id === '') {
      throw new ValidationError('id is required');
    }

    if (!(isApprover(auth.profile))) {
      const { summary } = await proposeChange(auth.entity, 'delete', id, {}, auth.profile);
      return NextResponse.json({ queued: true, summary }, { status: 202 });
    }

    const result = await deleteRecord(auth.entity, id, auth.profile);
    return NextResponse.json({ ok: true, note: result.note });
  } catch (cause: unknown) {
    return errorResponse(cause);
  }
};
