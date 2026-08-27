import { NextResponse } from 'next/server';
import { buildAreaReport, postAreaReport } from '@/lib/areaReport';
import { ValidationError } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, UnauthorizedError } from '@/lib/session';

/**
 * Sends the end-of-round area report to Slack.
 *
 * preview=true builds the text without posting, so the supervisor can
 * read what the channel will see before committing to it.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    const body: unknown = await request.json();

    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Expected a JSON object');
    }

    const payload = body as Record<string, unknown>;
    // Both optional: with neither, the report covers every area the
    // inspector visited this shift.
    const areaId = typeof payload.areaId === 'string' ? payload.areaId : undefined;
    const areaName = typeof payload.areaName === 'string' ? payload.areaName : undefined;

    const report = await buildAreaReport(
      {
        ...(areaId === undefined ? {} : { areaId }),
        ...(areaName === undefined ? {} : { areaName }),
        ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
        // Taken from the request rather than an env var, so the link is
        // right on preview deployments as well as production.
        origin: new URL(request.url).origin,
      },
      profile,
    );

    if (payload.preview === true) {
      return NextResponse.json({ text: report.text, photoCount: report.photoCount, sent: false });
    }

    await postAreaReport(report, areaId ?? null);
    return NextResponse.json({
      text: report.text,
      photoCount: report.photoCount,
      sent: true,
    });
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
