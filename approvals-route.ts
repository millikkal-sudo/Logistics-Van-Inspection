import { NextResponse } from 'next/server';
import { isApprover, listPending, reviewChange } from '@/lib/approvals';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

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

export const GET = async (): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);
    return NextResponse.json(await listPending());
  } catch (cause: unknown) {
    return errorResponse(cause);
  }
};

export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    if (!(isApprover(profile))) {
      throw new ForbiddenError('Only an approver can review changes');
    }

    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;
    const id = payload.id;
    const decision = payload.decision;

    if (typeof id !== 'string' || id === '') {
      throw new ValidationError('id is required');
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ValidationError('decision must be approved or rejected');
    }

    const result = await reviewChange(
      id,
      decision,
      profile,
      typeof payload.note === 'string' && payload.note.trim() !== '' ? payload.note.trim() : null,
    );

    return NextResponse.json({ ok: true, note: result.note });
  } catch (cause: unknown) {
    return errorResponse(cause);
  }
};
