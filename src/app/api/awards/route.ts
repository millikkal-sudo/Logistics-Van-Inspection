import { NextResponse } from 'next/server';
import { getDriverOfMonth } from '@/lib/driverOfMonth';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const { searchParams } = new URL(request.url);
    // Dubai's current month, not the server's.
    const dubaiNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const month = searchParams.get('month') ?? dubaiNow.toISOString().slice(0, 7);

    return NextResponse.json(await getDriverOfMonth(month));
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
