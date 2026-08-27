import { NextResponse } from 'next/server';
import { getReportStats, listInspectionsSince } from '@/lib/inspectionRepository';
import { getTrainingInsight } from '@/lib/trainingInsight';
import { currentProfile, ForbiddenError, requireRole, UnauthorizedError } from '@/lib/session';

/**
 * Report data for the manager dashboard, as JSON or CSV.
 *
 * Every figure ships with the same figure for the preceding window of
 * equal length. A number with no baseline is decoration: 87% compliance
 * is only meaningful next to last week's 81%.
 */

const csvCell = (value: string | number | null): string => {
  if (value === null) {
    return '';
  }
  const text = String(value);
  // Guard against a leading =, +, - or @ being run as a formula when the
  // file is opened in Excel.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

const parseRange = (
  fromParam: string | null,
  toParam: string | null,
): { from: Date; to: Date } => {
  const from = fromParam === null ? new Date(Date.now() - 7 * 86_400_000) : new Date(fromParam);
  const to = toParam === null ? new Date() : new Date(`${toParam}T23:59:59.999`);
  from.setHours(0, 0, 0, 0);
  return { from, to };
};

export const GET = async (request: Request): Promise<NextResponse> => {
  try {
    const profile = await currentProfile();
    requireRole(profile, ['manager', 'admin']);

    const { searchParams } = new URL(request.url);
    const areaParam = searchParams.get('areaId');
    const areaId = areaParam === null || areaParam === '' ? undefined : areaParam;
    const format = searchParams.get('format');

    const { from, to } = parseRange(searchParams.get('from'), searchParams.get('to'));

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 422 });
    }

    const records = await listInspectionsSince(from, {
      until: to,
      ...(areaId === undefined ? {} : { areaId }),
    });

    if (format === 'csv') {
      const header = [
        'Date',
        'Time',
        'Area',
        'Van',
        'Driver',
        'Helper',
        'Inspector',
        'Status',
        'Temperature C',
        'Failed checks',
        'Notes',
      ];

      const rows = records.map((record) => {
        const when = new Date(record.performedAt);
        return [
          csvCell(when.toISOString().slice(0, 10)),
          csvCell(when.toTimeString().slice(0, 5)),
          csvCell(record.areaName),
          csvCell(record.plate),
          csvCell(record.driverName),
          csvCell(record.helperName),
          csvCell(record.inspectorName),
          csvCell(record.status === 'compliant' ? 'Cleared' : 'Non-compliant'),
          csvCell(record.tempReadingC),
          csvCell(record.failedCount),
          csvCell(record.notes),
        ].join(',');
      });

      const csv = [header.map(csvCell).join(','), ...rows].join('\r\n');
      const filename = `van-checks-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`;

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // The window immediately before this one, same length, so the deltas
    // compare like with like.
    const spanMs = to.getTime() - from.getTime();
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - spanMs);

    const [stats, previous, insight] = await Promise.all([
      getReportStats(from, to, areaId),
      getReportStats(previousFrom, previousTo, areaId),
      getTrainingInsight(from, to, areaId),
    ]);

    return NextResponse.json({ records, stats, previous, insight });
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
