'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BulkImport } from './BulkImport';
import type { PendingChange } from '@/lib/approvals';
import { CaloMark } from './CaloMark';
import { PlateScanner, type PlateReading } from './PlateScanner';
import type {
  Area,
  CheckAction,
  CheckCause,
  CheckItem,
  Driver,
  InspectionStatus,
  Van,
} from '@/lib/types';

type Tab = 'reports' | 'training' | 'areas' | 'vans' | 'drivers' | 'options' | 'approvals';

type ReportRow = {
  id: string;
  performedAt: string;
  plate: string;
  areaName: string;
  driverName: string;
  helperName: string | null;
  inspectorName: string;
  status: InspectionStatus;
  dispatchBlocked: boolean;
  failedCount: number;
  tempReadingC: number | null;
  notes: string | null;
};

type FailureDetail = {
  label: string;
  critical: boolean;
  numericValue: number | null;
  note: string | null;
  causeLabel: string | null;
  actionLabel: string | null;
  photoUrls: string[];
};

type Detail = {
  id: string;
  plate: string;
  driverName: string;
  helperName: string | null;
  inspectorName: string;
  notes: string | null;
  failures: FailureDetail[];
  passedCount: number;
};

const STATUS_META: Record<InspectionStatus, { label: string; text: string; bg: string }> = {
  compliant: { label: 'Cleared', text: 'text-pass', bg: 'bg-pass-soft' },
  noncompliant: { label: 'Non-compliant', text: 'text-fail', bg: 'bg-fail-soft' },
  // Retired. Kept so historic records still render.
  action_required: { label: 'Non-compliant', text: 'text-fail', bg: 'bg-fail-soft' },
};

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

type Props = {
  areas: Area[];
  vans: Van[];
  drivers: Driver[];
  causes: CheckCause[];
  actions: CheckAction[];
  checkItems: CheckItem[];
  pending: PendingChange[];
  isApprover: boolean;
  isAdmin: boolean;
};

export const AdminDashboard = ({
  areas,
  vans,
  drivers,
  causes,
  actions,
  checkItems,
  pending,
  isApprover,
  isAdmin,
}: Props) => {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('reports');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = async (path: string, method: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'Something went wrong';
        setError(message);
        return false;
      }
      // A delete can report side effects, such as a helper being
      // unpaired. Silently doing that would be worse than saying so.
      const payload: unknown = await response.json().catch(() => null);
      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        if (record.queued === true) {
          setNotice(
            `Sent for review: ${String(record.summary ?? 'your change')}. It takes effect once approved.`,
          );
        } else if (typeof record.note === 'string') {
          setNotice(record.note);
        }
      }

      router.refresh();
      return true;
    } catch {
      setError('Could not reach the server');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const areaName = (id: string | null): string =>
    areas.find((area) => area.id === id)?.name ?? 'Unassigned';

  return (
    <div className="mx-auto min-h-screen max-w-5xl bg-surface-page">
      <header className="bg-brand-bold px-6 pb-4 pt-6">
        <div className="mb-5">
          <CaloMark invert />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-content-invert-secondary">
              UAE · Manager view
            </div>
            <h1 className="text-2xl font-black text-content-invert">Van check admin</h1>
          </div>
          <a
            href="/"
            className="rounded-lg bg-invert-subtle px-3 py-2 text-xs font-bold text-content-invert"
          >
            Back to checks
          </a>
        </div>

        <nav className="mt-4 flex gap-1 overflow-x-auto">
          {(
            [
              'reports',
              'training',
              'areas',
              'vans',
              'drivers',
              'options',
              ...(isApprover ? (['approvals'] as Tab[]) : []),
            ] as Tab[]
          ).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-bold capitalize ${
                tab === key ? 'bg-content-invert text-brand-bold' : 'text-content-invert-secondary'
              }`}
            >
              {key}
              {key === 'approvals' && pending.length > 0 && (
                <span className="ml-1.5 rounded-full bg-fail px-1.5 py-0.5 text-[10px] text-content-invert">
                  {pending.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="p-4 sm:p-6">
        {notice !== null && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-hold-soft p-4">
            <p className="text-sm font-medium leading-relaxed text-hold">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="shrink-0 text-hold"
            >
              ✕
            </button>
          </div>
        )}

        {error !== null && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-fail-soft p-4">
            <p className="text-sm font-medium leading-relaxed text-fail">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss"
              className="shrink-0 text-fail"
            >
              ✕
            </button>
          </div>
        )}

        {tab === 'reports' && <Reports areas={areas} />}

        {tab === 'approvals' && <ApprovalsTab pending={pending} busy={busy} onCall={call} />}

        {tab === 'training' && <TrainingTab areas={areas} />}

        {tab === 'options' && (
          <OptionsTab
            causes={causes}
            actions={actions}
            checkItems={checkItems}
            busy={busy}
            onCall={call}
          />
        )}

        {tab === 'areas' && (
          <AreasTab areas={areas} busy={busy} isAdmin={isAdmin} onCall={call} />
        )}

        {tab === 'vans' && (
          <VansTab
            vans={vans}
            areas={areas}
            busy={busy}
            areaName={areaName}
            onCall={call}
            onRefresh={() => router.refresh()}
          />
        )}

        {tab === 'drivers' && (
          <DriversTab
            drivers={drivers}
            vans={vans}
            areas={areas}
            busy={busy}
            areaName={areaName}
            onCall={call}
            onRefresh={() => router.refresh()}
          />
        )}
      </div>
    </div>
  );
};

/* ------------------------------ reports ------------------------------ */

type Stats = {
  checks: number;
  cleared: number;
  nonCompliant: number;
  compliancePct: number;
  vansCovered: number;
  worstTempC: number | null;
};

type DefectCount = { checkLabel: string; causeLabel: string; category: string; count: number };
type QueueEntry = {
  personId: string;
  personName: string;
  role: 'driver' | 'helper';
  trainableCount: number;
  nonTrainableCount: number;
  flaggedCount: number;
  causes: string[];
  priority: 'session' | 'watch';
  reason: string;
};
type SystemicIssue = {
  checkLabel: string;
  causeLabel: string;
  peopleAffected: number;
  count: number;
  reason: string;
};
type Insight = { defects: DefectCount[]; queue: QueueEntry[]; systemic: SystemicIssue[] };

type ReportPayload = {
  records: ReportRow[];
  stats: Stats;
  previous: Stats;
  insight: Insight;
};

type PresetKey = 'today' | 'week' | 'last7' | 'month' | 'lastMonth' | 'custom';

const iso = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * Presets rather than two typed date fields. Picking a range was friction
 * on every single visit, and the page opened on zeros because nothing was
 * selected. This week is the default so it is useful on load.
 */
const resolvePreset = (key: PresetKey): { from: string; to: string } | null => {
  const now = new Date();

  if (key === 'today') {
    return { from: iso(now), to: iso(now) };
  }
  if (key === 'week') {
    const monday = new Date(now);
    // getDay() is 0 on Sunday, which belongs to the week just ended.
    const offset = (now.getDay() + 6) % 7;
    monday.setDate(now.getDate() - offset);
    return { from: iso(monday), to: iso(now) };
  }
  if (key === 'last7') {
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    return { from: iso(start), to: iso(now) };
  }
  if (key === 'month') {
    return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  }
  if (key === 'lastMonth') {
    return {
      from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return null;
};

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'custom', label: 'Custom' },
];

const Reports = ({ areas }: { areas: Area[] }) => {
  const initial = resolvePreset('week') ?? { from: iso(new Date()), to: iso(new Date()) };

  const [preset, setPreset] = useState<PresetKey>('week');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [areaId, setAreaId] = useState('');
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'compliant' | 'noncompliant'>('all');
  const [areaFilter, setAreaFilter] = useState('');

  /** Vaguer than the data, but readable. "vs previous" told nobody what. */
  const periodLabel =
    preset === 'today'
      ? 'yesterday'
      : preset === 'week' || preset === 'last7'
        ? 'last week'
        : preset === 'month' || preset === 'lastMonth'
          ? 'last month'
          : 'the period before';

  const params = (): string => {
    const search = new URLSearchParams({ from, to });
    if (areaId !== '') {
      search.set('areaId', areaId);
    }
    return search.toString();
  };

  const load = useCallback(
    async (nextFrom: string, nextTo: string, nextArea: string): Promise<void> => {
      setLoading(true);
      try {
        const search = new URLSearchParams({ from: nextFrom, to: nextTo });
        if (nextArea !== '') {
          search.set('areaId', nextArea);
        }
        const response = await fetch(`/api/reports?${search.toString()}`);
        setData(response.ok ? ((await response.json()) as ReportPayload) : null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Load on mount and whenever the window changes, so the page is never
  // sitting on stale zeros waiting for a button press.
  useEffect(() => {
    void load(from, to, areaId);
  }, [from, to, areaId, load]);

  const choosePreset = (key: PresetKey): void => {
    setPreset(key);
    const range = resolvePreset(key);
    if (range !== null) {
      setFrom(range.from);
      setTo(range.to);
    }
  };



  return (
    <div className="space-y-4">
      <div className="rounded-md border border-line bg-surface-card p-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => choosePreset(option.key)}
              className={`rounded-full px-4 py-2 text-sm font-bold ${
                preset === option.key
                  ? 'bg-brand-action text-content-invert'
                  : 'bg-surface-page text-content-secondary'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          {preset === 'custom' && (
            <>
              <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
                From
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-1 block rounded-sm border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content"
                />
              </label>
              <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
                To
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-1 block rounded-sm border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content"
                />
              </label>
            </>
          )}

          <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
            Area
            <select
              value={areaId}
              onChange={(event) => setAreaId(event.target.value)}
              className="mt-1 block rounded-sm border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content"
            >
              <option value="">All areas</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </label>

          <a
            href={`/api/reports/pdf?${params()}`}
            className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert"
          >
            Download PDF
          </a>

          <span className="text-xs text-content-secondary">
            {loading ? 'Loading…' : `${from} to ${to}`}
          </span>
        </div>
      </div>

      {data !== null && (() => {
        // Filters the table only. The tiles keep reporting the whole
        // range, so a search cannot quietly change what the numbers mean.
        // Historic records may carry the retired action_required
        // status, so anything not compliant counts as non-compliant.
        const visible = data.records.filter((row) => {
          const failed = row.status !== 'compliant';
          if (statusFilter === 'compliant' && failed) {
            return false;
          }
          if (statusFilter === 'noncompliant' && !failed) {
            return false;
          }
          if (areaFilter !== '' && row.areaName !== areaFilter) {
            return false;
          }
          return matches(
            search,
            row.plate,
            row.driverName,
            row.helperName,
            row.areaName,
            row.inspectorName,
          );
        });

        const areasInRange: string[] = [
          ...new Set<string>(data.records.map((row) => row.areaName)),
        ].sort();
        const failedCount = data.records.filter((row) => row.status !== 'compliant').length;

        return (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Vehicles checked"
              value={String(data.stats.vansCovered)}
              caption={`${data.stats.checks} check${data.stats.checks === 1 ? '' : 's'} on ${data.stats.vansCovered} vehicle${data.stats.vansCovered === 1 ? '' : 's'}`}
              change={{
                amount: data.stats.vansCovered - data.previous.vansCovered,
                unit: 'vehicles',
                riseIsGood: true,
                period: periodLabel,
              }}
              tone="plain"
            />
            <Tile
              label="Compliance"
              value={`${data.stats.compliancePct}%`}
              caption={`${data.stats.cleared} of ${data.stats.checks} checks passed`}
              change={{
                amount: data.stats.compliancePct - data.previous.compliancePct,
                unit: 'points',
                riseIsGood: true,
                period: periodLabel,
              }}
              tone={
                data.stats.compliancePct >= 90
                  ? 'pass'
                  : data.stats.compliancePct >= 70
                    ? 'hold'
                    : 'fail'
              }
            />
            <Tile
              label="Non-compliant"
              value={String(data.stats.nonCompliant)}
              caption={`check${data.stats.nonCompliant === 1 ? '' : 's'} failed`}
              change={{
                amount: data.stats.nonCompliant - data.previous.nonCompliant,
                unit: 'failures',
                // Fewer failures is the good direction. Treating a rise
                // as positive is what made the arrow read backwards.
                riseIsGood: false,
                period: periodLabel,
              }}
              tone={data.stats.nonCompliant === 0 ? 'pass' : 'fail'}
            />
            <Tile
              label="Highest temperature"
              value={
                data.stats.worstTempC === null ? '—' : `${data.stats.worstTempC.toFixed(1)}°C`
              }
              caption={
                data.stats.worstTempC === null
                  ? 'no readings in this period'
                  : data.stats.worstTempC > 5
                    ? `${(data.stats.worstTempC - 5).toFixed(1)}°C above the 5°C limit`
                    : 'within the 0 to 5°C limit'
              }
              tone={
                data.stats.worstTempC === null || data.stats.worstTempC <= 5 ? 'pass' : 'fail'
              }
            />
          </div>

          <div className="space-y-3">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search by plate, driver, helper, area or inspector"
              count={visible.length}
              total={data.records.length}
            />

            <div className="flex flex-wrap items-center gap-2">
              <FilterChip
                label="All"
                count={data.records.length}
                active={statusFilter === 'all'}
                onClick={() => setStatusFilter('all')}
              />
              <FilterChip
                label="Cleared"
                count={data.records.length - failedCount}
                active={statusFilter === 'compliant'}
                tone="pass"
                onClick={() => setStatusFilter('compliant')}
              />
              <FilterChip
                label="Non-compliant"
                count={failedCount}
                active={statusFilter === 'noncompliant'}
                tone="fail"
                onClick={() => setStatusFilter('noncompliant')}
              />

              {areasInRange.length > 1 && (
                <>
                  <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
                  <FilterChip
                    label="All areas"
                    active={areaFilter === ''}
                    onClick={() => setAreaFilter('')}
                  />
                  {areasInRange.map((name) => (
                    <FilterChip
                      key={name}
                      label={name}
                      count={data.records.filter((row) => row.areaName === name).length}
                      active={areaFilter === name}
                      onClick={() => setAreaFilter(name)}
                    />
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border border-line bg-surface-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-content-secondary">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Van</th>
                  <th className="px-4 py-3">Driver</th>
                  <th className="px-4 py-3">Temp</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <InspectionRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>

            {visible.length === 0 && (
              <p className="p-8 text-center text-sm text-content-secondary">
                {data.records.length === 0
                  ? 'No checks in that range.'
                  : 'Nothing matches the current filters. The tiles above still cover the whole range.'}
              </p>
            )}
          </div>
        </>
        );
      })()}
    </div>
  );
};

/**
 * A row that expands to show the evidence. Only failed checks have
 * anything to show, so a fully compliant inspection does not expand:
 * an empty panel is a worse answer than no panel.
 */
const InspectionRow = ({ row }: { row: ReportRow }) => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const hasDetail = row.failedCount > 0 || (row.notes !== null && row.notes !== '');

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);

    if (detail === null) {
      setLoading(true);
      try {
        const response = await fetch(`/api/inspections/${row.id}`);
        if (response.ok) {
          setDetail((await response.json()) as Detail);
        }
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <tr
        className={`border-b border-line last:border-b-0 ${hasDetail ? 'cursor-pointer hover:bg-surface-page' : ''}`}
        onClick={hasDetail ? () => void toggle() : undefined}
      >
        <td className="px-4 py-3 text-xs text-content-secondary">
          {new Date(row.performedAt).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </td>
        <td className="px-4 py-3">{row.areaName}</td>
        <td className="px-4 py-3 font-bold text-content">
          {row.plate}
          {hasDetail && (
            <span className="ml-2 text-xs font-normal text-brand">
              {open ? '\u25be' : '\u25b8'}{' '}
              {row.failedCount > 0
                ? `${row.failedCount} issue${row.failedCount > 1 ? 's' : ''}`
                : 'note'}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          {row.driverName}
          {row.helperName !== null && (
            <span className="text-xs text-content-secondary"> + {row.helperName}</span>
          )}
        </td>
        <td
          className={`px-4 py-3 tabular-nums ${row.tempReadingC === null ? 'text-content-secondary' : ''}`}
        >
          {row.tempReadingC === null ? '\u2014' : `${row.tempReadingC.toFixed(1)}\u00b0C`}
        </td>
        <td className="px-4 py-3">
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_META[row.status].bg} ${STATUS_META[row.status].text}`}
          >
            {STATUS_META[row.status].label}
          </span>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-line bg-surface-page">
          <td colSpan={6} className="px-4 py-4">
            {loading && <p className="text-sm text-content-secondary">Loading evidence\u2026</p>}

            {detail !== null && (
              <div className="space-y-4">
                {detail.failures.map((failure) => (
                  <div key={failure.label} className="rounded-md border border-line bg-surface-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-content">
                        {failure.label}
                        {failure.causeLabel !== null && `: ${failure.causeLabel}`}
                      </span>
                      {failure.actionLabel !== null && (
                        <span className="rounded-full bg-pass-soft px-2 py-0.5 text-[10px] font-bold text-pass">
                          {failure.actionLabel}
                        </span>
                      )}
                      {failure.critical && (
                        <span className="rounded bg-hold-soft px-1.5 py-0.5 text-[9px] font-bold text-hold">
                          BLOCKED DISPATCH
                        </span>
                      )}
                      {failure.numericValue !== null && (
                        <span className="text-xs font-bold text-fail">
                          {failure.numericValue.toFixed(1)}\u00b0C
                        </span>
                      )}
                    </div>

                    {failure.note !== null && failure.note !== '' && (
                      <p className="mt-1 text-sm text-content-secondary">{failure.note}</p>
                    )}

                    {failure.photoUrls.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-3">
                        {failure.photoUrls.map((url) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={`Evidence for ${failure.label}`}
                              className="h-40 w-40 rounded-sm border border-line object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-hold">No photo attached.</p>
                    )}
                  </div>
                ))}

                {detail.notes !== null && detail.notes !== '' && (
                  <div className="rounded-md border border-line bg-surface-card p-4">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-content-secondary">
                      Inspector&rsquo;s notes
                    </div>
                    <p className="mt-1 text-sm text-content">{detail.notes}</p>
                  </div>
                )}

                <p className="text-xs text-content-secondary">
                  {detail.passedCount} check{detail.passedCount === 1 ? '' : 's'} passed, recorded
                  by {detail.inspectorName}. Photo links expire after an hour.
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

const TONES = {
  pass: { text: 'text-pass', bg: 'bg-pass-soft' },
  hold: { text: 'text-hold', bg: 'bg-hold-soft' },
  fail: { text: 'text-fail', bg: 'bg-fail-soft' },
  plain: { text: 'text-content', bg: 'bg-surface-card' },
} as const;

/**
 * A figure with no baseline is decoration, so every tile carries the
 * same figure for the previous period.
 *
 * The change is spelled out rather than shown as an arrow. An arrow
 * alone cannot say whether a move was good: failures rising from 5 to 14
 * was drawing a downward arrow, which read as an improvement.
 */
const Tile = ({
  label,
  value,
  caption,
  change,
  tone,
}: {
  label: string;
  value: string;
  caption: string;
  change?: {
    /** Signed. Positive means the figure went up, good or not. */
    amount: number;
    /** "points", "vehicles", "failures". */
    unit: string;
    /** Whether a rise is good news here. */
    riseIsGood: boolean;
    /** "last week", "yesterday". */
    period: string;
  };
  tone: keyof typeof TONES;
}) => {
  const meta = TONES[tone];
  const rounded = change === undefined ? 0 : Math.round(change.amount);
  const better = change === undefined ? false : rounded > 0 === change.riseIsGood;

  return (
    <div className={`rounded-md border border-line p-4 ${meta.bg}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-content-secondary">
        {label}
      </div>

      <div className={`mt-1 text-4xl font-black ${meta.text}`}>{value}</div>

      <div className="mt-1 text-xs text-content-secondary">{caption}</div>

      {change !== undefined && (
        <div
          className={`mt-2 text-xs font-bold ${
            rounded === 0 ? 'text-content-secondary' : better ? 'text-pass' : 'text-fail'
          }`}
        >
          {rounded === 0
            ? `Same as ${change.period}`
            : `${Math.abs(rounded)} ${change.unit} ${rounded > 0 ? 'more' : 'fewer'} than ${change.period}`}
        </div>
      )}
    </div>
  );
};


/* ------------------------------- shared ------------------------------- */

type CallFn = (path: string, method: string, body: unknown) => Promise<boolean>;

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
    {label}
    {children}
  </label>
);

/**
 * Filters a list in place. Lists reach a few hundred rows once the whole
 * fleet is loaded, and scrolling to find one plate is the slow part of
 * every edit.
 */
/**
 * The review queue.
 *
 * Only an approver sees this tab. Everyone else's edits land here rather
 * than being applied, so a wrong plate or a deleted driver is caught
 * before it reaches the people doing checks at 06:30.
 */
const ApprovalsTab = ({
  pending,
  busy,
  onCall,
}: {
  pending: PendingChange[];
  busy: boolean;
  onCall: CallFn;
}) => {
  const [open, setOpen] = useState<string | null>(null);

  if (pending.length === 0) {
    return (
      <div className="rounded-md border border-line bg-surface-card p-8 text-center">
        <p className="text-sm font-bold text-content">Nothing waiting for review</p>
        <p className="mt-1 text-xs text-content-secondary">
          Edits made by anyone other than an approver appear here.
        </p>
      </div>
    );
  }

  const review = (id: string, decision: 'approved' | 'rejected'): void => {
    void onCall('/api/approvals', 'POST', { id, decision });
  };

  return (
    <div className="space-y-3">
      {pending.map((change) => (
        <div key={change.id} className="rounded-md border border-line bg-surface-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-bold text-content">{change.summary}</div>
              <div className="mt-0.5 text-xs text-content-secondary">
                {change.requestedByName} · {change.requestedByEmail} ·{' '}
                {new Date(change.requestedAt).toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(open === change.id ? null : change.id)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-content-secondary"
              >
                {open === change.id ? 'Hide' : 'Detail'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => review(change.id, 'rejected')}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-fail"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => review(change.id, 'approved')}
                className="rounded-lg bg-pass px-4 py-1.5 text-xs font-bold text-content-invert"
              >
                Approve
              </button>
            </div>
          </div>

          {open === change.id && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {change.before !== null && (
                <div className="rounded-sm border border-line bg-surface-page p-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-content-secondary">
                    Now
                  </div>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-content-secondary">
                    {JSON.stringify(change.before, null, 2)}
                  </pre>
                </div>
              )}
              <div className="rounded-sm border border-line bg-surface-page p-3">
                <div className="text-[11px] font-bold uppercase tracking-wide text-brand">
                  Proposed
                </div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-content">
                  {JSON.stringify(change.payload, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/**
 * Filters the table only, the same as the search box. The tiles keep
 * reporting the whole range, so narrowing the list cannot quietly change
 * what the percentages mean.
 */
const FilterChip = ({
  label,
  count,
  active,
  tone = 'plain',
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  tone?: 'plain' | 'pass' | 'fail';
  onClick: () => void;
}) => {
  const activeStyle =
    tone === 'pass'
      ? 'bg-pass text-content-invert'
      : tone === 'fail'
        ? 'bg-fail text-content-invert'
        : 'bg-brand-action text-content-invert';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3.5 py-1.5 text-xs font-bold ${
        active ? activeStyle : 'border border-line bg-surface-card text-content-secondary'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={active ? 'ml-1.5 opacity-80' : 'ml-1.5 text-content-tertiary'}>
          {count}
        </span>
      )}
    </button>
  );
};

const SearchBox = ({
  value,
  onChange,
  placeholder,
  count,
  total,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  count: number;
  total: number;
}) => (
  <div className="flex flex-wrap items-center gap-3">
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="min-w-[220px] flex-1 rounded-sm border border-line bg-surface-card px-3 py-2.5 text-sm text-content outline-none focus:border-brand"
    />
    <span className="text-xs text-content-secondary">
      {value.trim() === '' ? `${total} total` : `${count} of ${total}`}
    </span>
    {value.trim() !== '' && (
      <button
        type="button"
        onClick={() => onChange('')}
        className="text-xs font-bold text-brand"
      >
        Clear
      </button>
    )}
  </div>
);

const matches = (needle: string, ...haystack: (string | null | undefined)[]): boolean => {
  const term = needle.trim().toLowerCase();
  if (term === '') {
    return true;
  }
  return haystack.some((value) => (value ?? '').toLowerCase().includes(term));
};

const inputClass =
  'mt-1 block w-full rounded-lg border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content outline-none focus:border-brand';

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xl border border-line bg-surface-card p-4">
    <h2 className="mb-3 text-sm font-bold text-content">{title}</h2>
    {children}
  </div>
);

/**
 * Deactivate is always available. Delete is offered too, but the server
 * refuses it for anything named on a filed inspection — deleting that
 * would take the audit trail with it.
 */
const ActiveToggle = ({
  entity,
  id,
  label,
  active,
  busy,
  onCall,
}: {
  entity: string;
  id: string;
  label: string;
  active: boolean;
  busy: boolean;
  onCall: CallFn;
}) => {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-content-secondary">Delete permanently?</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            void onCall(`/api/admin/${entity}?id=${id}`, 'DELETE', undefined);
          }}
          className="rounded-lg bg-fail px-3 py-1.5 text-xs font-bold text-content-invert"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-lg bg-surface-page px-3 py-1.5 text-xs font-bold text-content-secondary"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void onCall(`/api/admin/${entity}`, 'PATCH', { id, active: !active })}
        className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
          active ? 'bg-hold-soft text-hold' : 'bg-pass-soft text-pass'
        }`}
      >
        {active ? 'Deactivate' : 'Reactivate'}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Delete ${label}`}
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-fail"
      >
        Delete
      </button>
    </div>
  );
};

/* ------------------------------ training ------------------------------ */

const CATEGORY_LABELS: Record<string, string> = {
  supply: 'Supply',
  standards: 'Standards',
  wear: 'Wear',
  equipment: 'Equipment',
  behaviour: 'Behaviour',
  other: 'Other',
};

/**
 * The training view. Ranked by why things failed, not how often, because
 * seven uniform failures that are all missing shoes is a purchase order,
 * not a training session.
 */
const TrainingTab = ({ areas }: { areas: Area[] }) => {
  const [days, setDays] = useState(30);
  const [areaId, setAreaId] = useState('');
  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(Date.now() - days * 86_400_000);
      const search = new URLSearchParams({
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      if (areaId !== '') {
        search.set('areaId', areaId);
      }
      const response = await fetch(`/api/reports?${search.toString()}`);
      if (response.ok) {
        const payload = (await response.json()) as ReportPayload;
        setInsight(payload.insight);
      }
    } finally {
      setLoading(false);
    }
  }, [days, areaId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface-card p-4">
        <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
          Window
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="mt-1 block rounded-sm border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>

        <label className="text-xs font-bold uppercase tracking-wide text-content-secondary">
          Area
          <select
            value={areaId}
            onChange={(event) => setAreaId(event.target.value)}
            className="mt-1 block rounded-sm border border-line bg-surface-page px-3 py-2 text-sm font-normal text-content"
          >
            <option value="">All areas</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
        </label>

        <span className="text-xs text-content-secondary">{loading ? 'Loading…' : ''}</span>
      </div>

      {insight !== null && insight.systemic.length > 0 && (
        <div className="rounded-md border border-line bg-hold-soft p-4">
          <div className="text-sm font-bold text-hold">Not a training problem</div>
          <p className="mt-0.5 text-xs text-content-secondary">
            These affect several people and share a cause training cannot change.
          </p>
          <div className="mt-3 space-y-2">
            {insight.systemic.map((issue) => (
              <div
                key={`${issue.checkLabel}-${issue.causeLabel}`}
                className="rounded-sm bg-surface-card p-3"
              >
                <div className="text-sm font-bold text-content">
                  {issue.checkLabel}: {issue.causeLabel}
                </div>
                <div className="mt-0.5 text-xs text-content-secondary">
                  {issue.count} time{issue.count === 1 ? '' : 's'} across {issue.peopleAffected}{' '}
                  people. {issue.reason}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-line bg-surface-card">
        <div className="border-b border-line px-4 py-3">
          <div className="text-sm font-bold text-content">Training queue</div>
          <p className="mt-0.5 text-xs text-content-secondary">
            Only failures a session could actually change.
          </p>
        </div>

        {insight === null || insight.queue.length === 0 ? (
          <p className="p-8 text-center text-sm text-content-secondary">
            Nobody needs a session in this window.
          </p>
        ) : (
          insight.queue.map((entry) => (
            <div
              key={entry.personId}
              className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
            >
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  entry.priority === 'session' ? 'bg-fail-soft text-fail' : 'bg-hold-soft text-hold'
                }`}
              >
                {entry.priority === 'session' ? 'Session' : 'Watch'}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-content">
                  {entry.personName}{' '}
                  <span className="text-xs font-normal text-content-secondary">{entry.role}</span>
                </div>
                <div className="mt-0.5 text-xs text-content-secondary">{entry.reason}</div>
                <div className="mt-1 text-xs text-content-secondary">
                  {entry.causes.join(', ')}
                  {entry.nonTrainableCount > 0 &&
                    ` · ${entry.nonTrainableCount} supply or equipment failure${entry.nonTrainableCount === 1 ? '' : 's'} excluded`}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-surface-card">
        <div className="border-b border-line px-4 py-3 text-sm font-bold text-content">
          Defects by cause
        </div>
        {insight === null || insight.defects.length === 0 ? (
          <p className="p-8 text-center text-sm text-content-secondary">No failures recorded.</p>
        ) : (
          insight.defects.map((defect) => (
            <div
              key={`${defect.checkLabel}-${defect.causeLabel}`}
              className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 text-sm">
                <span className="font-bold text-content">{defect.causeLabel}</span>{' '}
                <span className="text-xs text-content-secondary">{defect.checkLabel}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full bg-surface-page px-2.5 py-1 text-[11px] font-bold text-content-secondary">
                  {CATEGORY_LABELS[defect.category] ?? defect.category}
                </span>
                <span className="w-6 text-right text-sm font-bold text-content">
                  {defect.count}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/* ------------------------------- causes ------------------------------- */

const CATEGORY_OPTIONS = ['supply', 'standards', 'wear', 'equipment', 'behaviour', 'other'];

/**
 * "What was done" options. Optional for the inspector, but this is the
 * field that tells a held van from a fixed one, so the list is worth
 * keeping short and unambiguous.
 */
const ActionsPanel = ({
  actions,
  busy,
  onCall,
}: {
  actions: CheckAction[];
  busy: boolean;
  onCall: CallFn;
}) => {
  const [label, setLabel] = useState('');

  const add = async (): Promise<void> => {
    const ok = await onCall('/api/admin/actions', 'POST', {
      label,
      sortOrder: actions.length + 1,
    });
    if (ok) {
      setLabel('');
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface-card p-4">
      <h2 className="text-sm font-bold text-content">What was done</h2>
      <p className="mt-0.5 text-xs text-content-secondary">
        One list for every check. Optional for the inspector, but it is what separates a van
        that was fixed from one that was only reported.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Action">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Escalated to fleet manager"
            className={inputClass}
          />
        </Field>
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy}
          className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert disabled:bg-disabled disabled:text-content-secondary"
        >
          Add
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-sm border border-line">
        {actions.map((action) => (
          <div
            key={action.id}
            className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
          >
            <span className="text-sm font-bold text-content">
              {action.label}
              {!action.active && (
                <span className="ml-2 rounded bg-line px-2 py-0.5 text-[10px] font-bold text-content-secondary">
                  INACTIVE
                </span>
              )}
            </span>
            <ActiveToggle
              entity="actions"
              id={action.id}
              label={action.label}
              active={action.active}
              busy={busy}
              onCall={onCall}
            />
          </div>
        ))}
        {actions.length === 0 && (
          <p className="p-4 text-center text-sm text-content-secondary">
            No actions configured. The question will not appear to inspectors.
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * The two option lists an inspector taps when a check fails. Causes are
 * per check; actions are global, because "reported to workshop" means
 * the same thing whichever check failed.
 */
/**
 * Actions are global, so they sit above the per check cause lists.
 * Deleting one is refused once it has been recorded on a failure, the
 * same rule as everywhere else: it would take history with it.
 */
const OptionsTab = ({
  causes,
  actions,
  checkItems,
  busy,
  onCall,
}: {
  causes: CheckCause[];
  actions: CheckAction[];
  checkItems: CheckItem[];
  busy: boolean;
  onCall: CallFn;
}) => {
  const [checkItemId, setCheckItemId] = useState(checkItems[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('standards');
  const [search, setSearch] = useState('');

  const add = async (): Promise<void> => {
    const siblings = causes.filter((cause) => cause.checkItemId === checkItemId);
    const ok = await onCall('/api/admin/causes', 'POST', {
      checkItemId,
      label,
      category,
      sortOrder: siblings.length + 1,
    });
    if (ok) {
      setLabel('');
    }
  };

  return (
    <div className="space-y-4">
      <ActionsPanel actions={actions} busy={busy} onCall={onCall} />

      <Panel title="Add a cause">
        <p className="mb-3 text-xs text-content-secondary">
          These are the options an inspector taps when a check fails. The category is never shown
          to them: it is what lets a report tell a stores problem from a training one.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Check">
            <select
              value={checkItemId}
              onChange={(event) => setCheckItemId(event.target.value)}
              className={inputClass}
            >
              {checkItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cause">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Missing gloves"
              className={inputClass}
            />
          </Field>
          <Field label="Category">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={inputClass}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {CATEGORY_LABELS[option] ?? option}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert disabled:bg-disabled disabled:text-content-secondary"
          >
            Add
          </button>
        </div>
      </Panel>

      <SearchBox
        value={search}
        onChange={setSearch}
        placeholder="Search causes"
        count={causes.filter((cause) => matches(search, cause.label, cause.category)).length}
        total={causes.length}
      />

      {checkItems.map((item) => {
        const forItem = causes.filter(
          (cause) =>
            cause.checkItemId === item.id && matches(search, cause.label, cause.category, item.label),
        );
        if (forItem.length === 0) {
          return null;
        }
        return (
          <div key={item.id} className="overflow-hidden rounded-md border border-line bg-surface-card">
            <div className="border-b border-line px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-content-secondary">
              {item.label}
            </div>
            {forItem.map((cause) => (
              <div
                key={cause.id}
                className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <span className="text-sm font-bold text-content">{cause.label}</span>
                  <span className="ml-2 rounded-full bg-surface-page px-2 py-0.5 text-[10px] font-bold text-content-secondary">
                    {CATEGORY_LABELS[cause.category] ?? cause.category}
                  </span>
                  {!cause.active && (
                    <span className="ml-2 rounded bg-line px-2 py-0.5 text-[10px] font-bold text-content-secondary">
                      INACTIVE
                    </span>
                  )}
                </div>
                <ActiveToggle
                  entity="causes"
                  id={cause.id}
                  label={cause.label}
                  active={cause.active}
                  busy={busy}
                  onCall={onCall}
                />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/* -------------------------------- areas -------------------------------- */

const AreasTab = ({
  areas,
  busy,
  isAdmin,
  onCall,
}: {
  areas: Area[];
  busy: boolean;
  isAdmin: boolean;
  onCall: CallFn;
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');

  const add = async (): Promise<void> => {
    const ok = await onCall('/api/admin/areas', 'POST', {
      name,
      code,
      sortOrder: areas.length + 1,
    });
    if (ok) {
      setName('');
      setCode('');
    }
  };

  return (
    <div className="space-y-4">
      {isAdmin && (
        <Panel title="Add an area">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ras Al Khaimah"
                className={inputClass}
              />
            </Field>
            <Field label="Code">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="RAK"
                maxLength={4}
                className={`${inputClass} w-24`}
              />
            </Field>
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy}
              className="rounded-lg bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert disabled:bg-line disabled:text-content-secondary"
            >
              Add
            </button>
          </div>
        </Panel>
      )}

      <SearchBox
        value={search}
        onChange={setSearch}
        placeholder="Search areas"
        count={areas.filter((area) => matches(search, area.name, area.code)).length}
        total={areas.length}
      />

      <div className="overflow-hidden rounded-xl border border-line bg-surface-card">
        {areas
          .filter((area) => matches(search, area.name, area.code))
          .map((area) => (
          <div
            key={area.id}
            className="flex items-center justify-between border-b border-line px-4 py-3 last:border-b-0"
          >
            <div>
              <span className="font-bold text-content">{area.name}</span>
              <span className="ml-2 text-xs text-content-secondary">
{area.code}</span>
              {!area.active && (
                <span className="ml-2 rounded bg-line px-2 py-0.5 text-[10px] font-bold text-content-secondary">
                  INACTIVE
                </span>
              )}
            </div>
            <ActiveToggle
              entity="areas"
              id={area.id}
              label={area.name}
              active={area.active}
              busy={busy}
              onCall={onCall}
            />
          </div>
          ))}
      </div>
    </div>
  );
};

/* -------------------------------- vans -------------------------------- */

const VansTab = ({
  vans,
  areas,
  busy,
  areaName,
  onCall,
  onRefresh,
}: {
  vans: Van[];
  areas: Area[];
  busy: boolean;
  areaName: (id: string | null) => string;
  onCall: CallFn;
  onRefresh: () => void;
}) => {
  const [plate, setPlate] = useState('');
  const [areaId, setAreaId] = useState(areas[0]?.id ?? '');
  const [vehicleType, setVehicleType] = useState<'van' | 'truck'>('van');
  const [search, setSearch] = useState('');

  const add = async (): Promise<void> => {
    const ok = await onCall('/api/admin/vans', 'POST', { plate, areaId, vehicleType });
    if (ok) {
      setPlate('');
    }
  };

  return (
    <div className="space-y-4">
      <BulkImport
        areaNames={areas.filter((area) => area.active).map((area) => area.name)}
        samplePlate={vans[0]?.plate ?? 'DXB-12345'}
        onImported={onRefresh}
      />

      <Panel title="Add a vehicle">
        <p className="mb-3 text-xs text-content-secondary">
          All vehicles run 0 to 5 &deg;C. Transfer trucks skip the plastic curtain and floor mat
          checks. Scanning fills the plate in for you, check it before saving.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Plate">
            <input
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              placeholder="DXB-4025"
              className={inputClass}
            />
          </Field>
          <Field label="Area">
            <select
              value={areaId}
              onChange={(event) => setAreaId(event.target.value)}
              className={inputClass}
            >
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              value={vehicleType}
              onChange={(event) => setVehicleType(event.target.value === 'truck' ? 'truck' : 'van')}
              className={inputClass}
            >
              <option value="van">Delivery van</option>
              <option value="truck">Transfer truck</option>
            </select>
          </Field>
          <div className="self-end">
            <PlateScanner
              onDetected={(reading: PlateReading) => {
                setPlate(reading.best);
                const match = areas.find((area) => area.code === reading.emirateCode);
                if (match !== undefined) {
                  setAreaId(match.id);
                }
              }}
              onPick={setPlate}
            />
          </div>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert disabled:bg-disabled disabled:text-content-secondary"
          >
            Add
          </button>
        </div>
      </Panel>

      <SearchBox
        value={search}
        onChange={setSearch}
        placeholder="Search by plate or area"
        count={vans.filter((van) => matches(search, van.plate, areaName(van.areaId))).length}
        total={vans.length}
      />

      <div className="overflow-hidden rounded-md border border-line bg-surface-card">
        {vans
          .filter((van) => matches(search, van.plate, areaName(van.areaId)))
          .map((van) => (
          <VanRow
            key={van.id}
            van={van}
            areas={areas}
            areaName={areaName}
            busy={busy}
            onCall={onCall}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * A van row that opens into an edit form in place.
 *
 * Correcting a plate by deleting and re-adding would detach the van from
 * its own history, so a typo needs a real edit path.
 */
const VanRow = ({
  van,
  areas,
  areaName,
  busy,
  onCall,
}: {
  van: Van;
  areas: Area[];
  areaName: (id: string | null) => string;
  busy: boolean;
  onCall: CallFn;
}) => {
  const [editing, setEditing] = useState(false);
  const [plate, setPlate] = useState(van.plate);
  const [areaId, setAreaId] = useState(van.areaId ?? areas[0]?.id ?? '');
  const [vehicleType, setVehicleType] = useState<'van' | 'truck'>(van.vehicleType);

  const save = async (): Promise<void> => {
    const ok = await onCall('/api/admin/vans', 'PATCH', {
      id: van.id,
      plate,
      areaId,
      vehicleType,
    });
    if (ok) {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="border-b border-line bg-surface-page px-4 py-3 last:border-b-0">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Plate">
            <input
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              className={inputClass}
            />
          </Field>
          <Field label="Area">
            <select
              value={areaId}
              onChange={(event) => setAreaId(event.target.value)}
              className={inputClass}
            >
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              value={vehicleType}
              onChange={(event) => setVehicleType(event.target.value === 'truck' ? 'truck' : 'van')}
              className={inputClass}
            >
              <option value="van">Delivery van</option>
              <option value="truck">Transfer truck</option>
            </select>
          </Field>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setPlate(van.plate);
              setAreaId(van.areaId ?? '');
              setVehicleType(van.vehicleType);
              setEditing(false);
            }}
            className="rounded-sm border border-line px-4 py-2.5 text-sm font-bold text-content-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <span className="font-bold text-content">{van.plate}</span>
        <span
          className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            van.vehicleType === 'truck' ? 'bg-hold-soft text-hold' : 'bg-brand-light text-brand'
          }`}
        >
          {van.vehicleType === 'truck' ? 'TRUCK' : 'VAN'}
        </span>
        <span className="ml-2 text-xs text-content-secondary">{areaName(van.areaId)}</span>
        {!van.active && (
          <span className="ml-2 rounded bg-line px-2 py-0.5 text-[10px] font-bold text-content-secondary">
            INACTIVE
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-brand"
        >
          Edit
        </button>
        <ActiveToggle
          entity="vans"
          id={van.id}
          label={van.plate}
          active={van.active}
          busy={busy}
          onCall={onCall}
        />
      </div>
    </div>
  );
};

/* ------------------------------- drivers ------------------------------- */

const DriversTab = ({
  drivers,
  vans,
  areas,
  busy,
  areaName,
  onCall,
  onRefresh,
}: {
  drivers: Driver[];
  vans: Van[];
  areas: Area[];
  busy: boolean;
  areaName: (id: string | null) => string;
  onCall: CallFn;
  onRefresh: () => void;
}) => {
  const [staffRole, setStaffRole] = useState<'driver' | 'helper'>('driver');
  const [fullName, setFullName] = useState('');
  const [areaId, setAreaId] = useState(areas[0]?.id ?? '');
  const [vanId, setVanId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [search, setSearch] = useState('');

  const vansInArea = vans.filter((van) => van.areaId === areaId && van.active);
  const activeDrivers = drivers.filter(
    (person) => person.staffRole === 'driver' && person.active,
  );

  // A driver who already has a helper cannot take another.
  const pairedDriverIds = new Set(
    drivers
      .filter((person) => person.staffRole === 'helper' && person.active)
      .map((person) => person.partnerId),
  );
  const availableDrivers = activeDrivers.filter((person) => !pairedDriverIds.has(person.id));

  const partner = drivers.find((person) => person.id === partnerId);

  const add = async (): Promise<void> => {
    const payload =
      staffRole === 'helper'
        ? {
            staffRole,
            fullName,
            partnerId,
            // Inherited so the pair can never end up on different vans.
            areaId: partner?.areaId ?? null,
            defaultVanId: partner?.defaultVanId ?? null,
          }
        : { staffRole, fullName, areaId, defaultVanId: vanId };

    const ok = await onCall('/api/admin/drivers', 'POST', payload);
    if (ok) {
      setFullName('');
      setVanId('');
      setPartnerId('');
    }
  };

  return (
    <div className="space-y-4">
      <BulkImport
        areaNames={areas.filter((area) => area.active).map((area) => area.name)}
        samplePlate={vans[0]?.plate ?? 'DXB-12345'}
        onImported={onRefresh}
      />

      <Panel title="Add a driver or helper">
        <div className="mb-3 flex gap-2">
          {(['driver', 'helper'] as const).map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => setStaffRole(role)}
              className={`rounded-lg px-4 py-2 text-sm font-bold capitalize ${
                staffRole === role ? 'bg-brand-action text-content-invert' : 'bg-surface-page text-content-secondary'
              }`}
            >
              {role}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Rashid Al Mansoori"
              className={inputClass}
            />
          </Field>

          {staffRole === 'driver' ? (
            <>
              <Field label="Area">
                <select
                  value={areaId}
                  onChange={(event) => {
                    setAreaId(event.target.value);
                    setVanId('');
                  }}
                  className={inputClass}
                >
                  {areas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Van">
                <select
                  value={vanId}
                  onChange={(event) => setVanId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">No van yet</option>
                  {vansInArea.map((van) => (
                    <option key={van.id} value={van.id}>
                      {van.plate}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <Field label="Rides with">
              <select
                value={partnerId}
                onChange={(event) => setPartnerId(event.target.value)}
                className={inputClass}
              >
                <option value="">Choose a driver</option>
                {availableDrivers.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName} · {areaName(person.areaId)}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || (staffRole === 'helper' && partnerId === '')}
            className="rounded-lg bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert disabled:bg-line disabled:text-content-secondary"
          >
            Add
          </button>
        </div>

        {staffRole === 'helper' && (
          <p className="mt-3 text-xs text-content-secondary">
            {availableDrivers.length === 0
              ? 'Every active driver already has a helper. Add a driver first.'
              : 'The helper takes the same van and area as their driver.'}
          </p>
        )}

        {staffRole === 'driver' && vansInArea.length === 0 && (
          <p className="mt-3 text-xs text-content-secondary">
            No active vans in {areaName(areaId)} yet. Add the van first, or leave the driver
            unassigned &mdash; an unassigned driver will not appear in the supervisor&rsquo;s list.
          </p>
        )}
      </Panel>

      <SearchBox
        value={search}
        onChange={setSearch}
        placeholder="Search by name, area or plate"
        count={
          drivers.filter((person) =>
            matches(
              search,
              person.fullName,
              areaName(person.areaId),
              vans.find((van) => van.id === person.defaultVanId)?.plate,
            ),
          ).length
        }
        total={drivers.length}
      />

      <div className="overflow-hidden rounded-xl border border-line bg-surface-card">
        {drivers
          .filter((person) =>
            matches(
              search,
              person.fullName,
              areaName(person.areaId),
              vans.find((van) => van.id === person.defaultVanId)?.plate,
            ),
          )
          .map((person) => (
          <StaffRow
            key={person.id}
            person={person}
            drivers={drivers}
            vans={vans}
            areas={areas}
            areaName={areaName}
            busy={busy}
            onCall={onCall}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * A driver or helper row that opens into an edit form in place.
 *
 * A helper's van and area follow their driver, so those fields are not
 * offered: two places recording the same fact is two places for it to
 * drift.
 */
const StaffRow = ({
  person,
  drivers,
  vans,
  areas,
  areaName,
  busy,
  onCall,
}: {
  person: Driver;
  drivers: Driver[];
  vans: Van[];
  areas: Area[];
  areaName: (id: string | null) => string;
  busy: boolean;
  onCall: CallFn;
}) => {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(person.fullName);
  const [areaId, setAreaId] = useState(person.areaId ?? areas[0]?.id ?? '');
  const [vanId, setVanId] = useState(person.defaultVanId ?? '');
  const [partnerId, setPartnerId] = useState(person.partnerId ?? '');

  const van = vans.find((candidate) => candidate.id === person.defaultVanId);
  const pairedWith = drivers.find((candidate) => candidate.id === person.partnerId);
  const vansInArea = vans.filter((candidate) => candidate.areaId === areaId && candidate.active);
  const availableDrivers = drivers.filter(
    (candidate) => candidate.staffRole === 'driver' && candidate.active,
  );

  const save = async () => {
    const partner = drivers.find((candidate) => candidate.id === partnerId);

    const payload =
      person.staffRole === 'helper'
        ? {
            id: person.id,
            staffRole: 'helper',
            fullName,
            partnerId,
            areaId: partner?.areaId ?? null,
            defaultVanId: partner?.defaultVanId ?? null,
          }
        : {
            id: person.id,
            staffRole: 'driver',
            fullName,
            areaId,
            defaultVanId: vanId === '' ? null : vanId,
          };

    const ok = await onCall('/api/admin/drivers', 'PATCH', payload);
    if (ok) {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="border-b border-line bg-surface-page px-4 py-3 last:border-b-0">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={inputClass}
            />
          </Field>

          {person.staffRole === 'helper' ? (
            <Field label="Rides with">
              <select
                value={partnerId}
                onChange={(event) => setPartnerId(event.target.value)}
                className={inputClass}
              >
                {availableDrivers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.fullName}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Field label="Area">
                <select
                  value={areaId}
                  onChange={(event) => {
                    setAreaId(event.target.value);
                    setVanId('');
                  }}
                  className={inputClass}
                >
                  {areas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Van">
                <select
                  value={vanId}
                  onChange={(event) => setVanId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">No van</option>
                  {vansInArea.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.plate}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-sm bg-brand-action px-5 py-2.5 text-sm font-bold text-content-invert"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setFullName(person.fullName);
              setAreaId(person.areaId ?? '');
              setVanId(person.defaultVanId ?? '');
              setPartnerId(person.partnerId ?? '');
              setEditing(false);
            }}
            className="rounded-sm border border-line px-4 py-2.5 text-sm font-bold text-content-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <span className="font-bold text-content">{person.fullName}</span>
        <span
          className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
            person.staffRole === 'helper'
              ? 'bg-surface-page text-content-secondary'
              : 'bg-brand-light text-brand'
          }`}
        >
          {person.staffRole}
        </span>
        <span className="ml-2 text-xs text-content-secondary">
          {areaName(person.areaId)} ·{' '}
          {van === undefined ? <span className="text-hold">no van assigned</span> : van.plate}
          {pairedWith !== undefined && ` · with ${pairedWith.fullName}`}
        </span>
        {!person.active && (
          <span className="ml-2 rounded bg-line px-2 py-0.5 text-[10px] font-bold text-content-secondary">
            INACTIVE
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-brand"
        >
          Edit
        </button>
        <ActiveToggle
          entity="drivers"
          id={person.id}
          label={person.fullName}
          active={person.active}
          busy={busy}
          onCall={onCall}
        />
      </div>
    </div>
  );
};
