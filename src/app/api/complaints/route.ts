import { NextResponse } from 'next/server';
import {
  addComplaint,
  importComplaints,
  listComplaints,
  previewComplaints,
  removeComplaint,
} from '@/lib/complaints';
import { fetchSheetCsv, SheetError } from '@/lib/googleSheet';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

const fail = (cause: unknown): NextResponse => {
  if (cause instanceof UnauthorizedError) {
    return NextResponse.json({ error: cause.message }, { status: 401 });
  }
  if (cause instanceof ForbiddenError) {
    return NextResponse.json({ error: cause.message }, { status: 403 });
  }
  if (cause instanceof SheetError || cause instanceof ValidationError) {
    return NextResponse.json({ error: cause.message }, { status: 422 });
  }
  const message = cause instanceof Error ? cause.message : 'Unexpected error';
  return NextResponse.json({ error: message }, { status: 500 });
};

export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const { searchParams } = new URL(request.url);
    return NextResponse.json(
      await listComplaints(
        searchParams.get('from') ?? undefined,
        searchParams.get('to') ?? undefined,
      ),
    );
  } catch (cause: unknown) {
    return fail(cause);
  }
};

export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;

    // A month of complaints arrives as a list, not one at a time.
    // Always previewed first, then committed, so a misspelled name is
    // caught before it lands on the wrong person.
    const sheetUrl = typeof payload.sheetUrl === 'string' ? payload.sheetUrl.trim() : '';
    const pasted = typeof payload.text === 'string' ? payload.text : '';

    if (sheetUrl !== '' || pasted.trim() !== '') {
      const text = sheetUrl === '' ? pasted : await fetchSheetCsv(sheetUrl);
      const defaultDate =
        typeof payload.occurredOn === 'string' && payload.occurredOn !== ''
          ? payload.occurredOn
          : new Date().toISOString().slice(0, 10);

      const preview = await previewComplaints(text, defaultDate);

      if (payload.commit !== true) {
        return NextResponse.json(preview);
      }

      const imported = await importComplaints(preview.valid, profile);
      return NextResponse.json({ ...preview, imported });
    }

    const driverId = payload.driverId;

    if (typeof driverId !== 'string' || driverId === '') {
      throw new ValidationError('Choose who the complaint is about');
    }

    await addComplaint(
      {
        driverId,
        occurredOn:
          typeof payload.occurredOn === 'string' && payload.occurredOn !== ''
            ? payload.occurredOn
            : new Date().toISOString().slice(0, 10),
        source: typeof payload.source === 'string' ? payload.source.trim() : '',
        note: typeof payload.note === 'string' ? payload.note.trim() : '',
      },
      profile,
    );

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (cause: unknown) {
    return fail(cause);
  }
};

export const DELETE = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const id = new URL(request.url).searchParams.get('id');
    if (id === null || id === '') {
      throw new ValidationError('id is required');
    }

    await removeComplaint(id);
    return NextResponse.json({ ok: true });
  } catch (cause: unknown) {
    return fail(cause);
  }
};
