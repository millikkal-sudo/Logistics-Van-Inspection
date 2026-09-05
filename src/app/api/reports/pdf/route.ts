import { NextResponse } from 'next/server';
import { buildInspectionPdf } from '@/lib/inspectionPdf';
import { dubaiDayRange } from '@/lib/shift';
import { getReportStats, listInspectionsSince } from '@/lib/inspectionRepository';
import { listAreas } from '@/lib/fleetRepository';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

/**
 * The audit pack: summary, inspection table, and every evidence photo.
 *
 * Embedding images makes this slower than the JSON report, so it runs on
 * the Node runtime with a raised limit rather than the edge default.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const { searchParams } = new URL(request.url);
    const areaParam = searchParams.get('areaId');
    const areaId = areaParam === null || areaParam === '' ? undefined : areaParam;

    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    // Same Dubai-day handling as the JSON report, so the PDF and the
    // dashboard cannot disagree about what a date range covers.
    const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() + 4 * 60 * 60 * 1000 - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { from, to } = dubaiDayRange(fromParam ?? weekAgo, toParam ?? today);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 422 });
    }

    const [records, stats, areas] = await Promise.all([
      listInspectionsSince(from, { until: to, ...(areaId === undefined ? {} : { areaId }) }),
      getReportStats(from, to, areaId),
      listAreas(true),
    ]);

    const areaName =
      areaId === undefined
        ? 'All areas'
        : (areas.find((area) => area.id === areaId)?.name ?? 'Area');

    const bytes = await buildInspectionPdf({
      from,
      to,
      areaName,
      stats,
      records,
      generatedBy: profile.fullName,
    });

    const slug = areaName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `calo-van-checks-${slug}-${from.toISOString().slice(0, 10)}.pdf`;

    return new NextResponse(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
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
