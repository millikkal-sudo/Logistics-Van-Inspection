import { NextResponse } from 'next/server';
import { importFleet, previewFleet } from '@/lib/bulkImport';
import { fetchSheetCsv, SheetError } from '@/lib/googleSheet';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

/**
 * Fleet import. Always previewed first: the client calls with
 * commit=false to see what would happen, then commit=true to write it.
 *
 * The preview is recomputed on commit rather than trusting what the
 * client sends back, so a van added by someone else in between, or a
 * sheet edited after previewing, is still validated.
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
    const commit = payload.commit === true;

    const sheetUrl = typeof payload.sheetUrl === 'string' ? payload.sheetUrl.trim() : '';
    const pasted = typeof payload.text === 'string' ? payload.text : '';
    const text = sheetUrl === '' ? pasted : await fetchSheetCsv(sheetUrl);

    if (text.trim() === '') {
      throw new ValidationError('Nothing to import');
    }

    const preview = await previewFleet(text);

    if (!commit) {
      return NextResponse.json(preview);
    }

    const imported = await importFleet(preview.valid, profile);
    return NextResponse.json({ ...preview, imported });
  } catch (cause: unknown) {
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
  }
};
