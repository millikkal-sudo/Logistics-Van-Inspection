'use client';

import { useMemo, useRef, useState } from 'react';
import { CaloMark } from './CaloMark';
import { uploadPhoto } from '@/lib/supabaseBrowser';
import type { FleetEntry } from '@/lib/fleetRepository';
import {
  resolveStatus,
  type Area,
  type AreaRotation,
  type CheckAnswer,
  type CheckAction,
  type CheckCause,
  type CheckItem,
  type InspectionStatus,
  type InspectionSummary,
  type Profile,
  type TrainingFlag,
} from '@/lib/types';

type Answer = {
  passed?: boolean;
  numericValue?: number;
  note?: string;
  causeId?: string;
  actionId?: string;
  photoKey?: string;
  photoPreview?: string;
  uploading?: boolean;
};

type Outcome = {
  status: InspectionStatus;
  plate: string;
  failedItems: string[];
  time: string;
};

type Screen = 'areas' | 'vans' | 'check' | 'outcome' | 'report';

const STATUS_META: Record<InspectionStatus, { label: string; text: string; bg: string; solid: string }> = {
  compliant: { label: 'Cleared', text: 'text-pass', bg: 'bg-pass-soft', solid: 'bg-pass' },
  noncompliant: { label: 'Non-compliant', text: 'text-fail', bg: 'bg-fail-soft', solid: 'bg-fail' },
  action_required: { label: 'Dispatch held', text: 'text-hold', bg: 'bg-hold-soft', solid: 'bg-hold' },
};

const TRAINING_CHOICES: { value: TrainingFlag; label: string }[] = [
  { value: 'none', label: 'No, all fine' },
  { value: 'driver', label: 'Driver' },
  { value: 'helper', label: 'Helper' },
  { value: 'both', label: 'Both' },
];

const clockTime = (): string =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

type Props = {
  profile: Profile;
  areas: Area[];
  fleet: FleetEntry[];
  checkItems: CheckItem[];
  causes: CheckCause[];
  actions: CheckAction[];
  initialToday: InspectionSummary[];
  /** "Morning", "Evening", "Early morning". Resolved from the clock. */
  shiftLabel: string;
  shiftSlot: string;
  rotation: AreaRotation[];
  canManage: boolean;
};

export const VanCheckApp = ({
  profile,
  areas,
  fleet,
  checkItems,
  causes,
  actions,
  initialToday,
  shiftLabel,
  shiftSlot,
  rotation,
  canManage,
}: Props) => {
  const [screen, setScreen] = useState<Screen>('areas');
  const [area, setArea] = useState<Area | null>(null);
  const [today, setToday] = useState<InspectionSummary[]>(initialToday);
  const [van, setVan] = useState<FleetEntry | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [temp, setTemp] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState('');
  const [training, setTraining] = useState<TrainingFlag>('none');

  // Only the checks that apply to this vehicle. A truck has no plastic
  // curtains or floor mats, so showing them would make it unsubmittable.
  const applicable = useMemo(
    () =>
      van === null
        ? checkItems
        : checkItems.filter((item) => item.vehicleTypes.includes(van.vehicleType)),
    [checkItems, van],
  );

  const tempItem = applicable.find((item) => item.inputType === 'temperature');
  const tempMin = van?.tempMinC ?? 0;
  const tempMax = van?.tempMaxC ?? 5;

  const tempValue = useMemo(() => {
    const parsed = Number.parseFloat(temp);
    return temp === '' || Number.isNaN(parsed) ? null : parsed;
  }, [temp]);

  const tempOk = tempValue !== null && tempValue >= tempMin && tempValue <= tempMax;

  const merged = useMemo((): Record<string, Answer> => {
    const next = { ...answers };
    if (tempItem !== undefined && tempValue !== null) {
      next[tempItem.code] = { ...next[tempItem.code], passed: tempOk, numericValue: tempValue };
    }
    return next;
  }, [answers, tempItem, tempValue, tempOk]);

  const answeredCount = applicable.filter((item) => merged[item.code]?.passed !== undefined).length;
  const failures = applicable.filter((item) => merged[item.code]?.passed === false);
  // Only the cause blocks a submission, and only where the check has
  // options configured. Photo, action and note are optional.
  const incomplete = failures.filter((item) => {
    const answer = merged[item.code];
    const causeNeeded = causes.some((cause) => cause.checkItemId === item.id);
    return causeNeeded && answer?.causeId === undefined;
  });
  // Against `applicable`, not `checkItems`. Comparing to the full list
  // meant a truck could never be ready: five answers can never equal the
  // seven checks a van has.
  const uploading = applicable.some((item) => merged[item.code]?.uploading === true);
  const ready = answeredCount === applicable.length && incomplete.length === 0 && !uploading;

  // A disabled button with no explanation is unusable at 06:30. Whatever
  // is blocking the submission is spelled out under it.
  const blockers: string[] = [];
  if (answeredCount < applicable.length) {
    const remaining = applicable.filter((item) => merged[item.code]?.passed === undefined);
    blockers.push(`Not checked yet: ${remaining.map((item) => item.label).join(', ')}`);
  }
  for (const item of incomplete) {
    blockers.push(`${item.label}: pick what caused it`);
  }
  if (uploading) {
    blockers.push('A photo is still uploading');
  }

  const patch = (code: string, values: Answer): void => {
    setAnswers((current) => ({ ...current, [code]: { ...current[code], ...values } }));
  };

  const startVan = (entry: FleetEntry): void => {
    setVan(entry);
    setAnswers({});
    setTemp('');
    setNotes('');
    setTraining('none');
    setError(null);
    setScreen('check');
  };

  const pressKey = (key: string): void => {
    if (key === 'del') {
      setTemp((value) => value.slice(0, -1));
      return;
    }
    if (key === '.' && temp.includes('.')) {
      return;
    }
    if (temp.replace('.', '').length >= 4) {
      return;
    }
    setTemp((value) => value + key);
  };

  const submit = async (): Promise<void> => {
    if (van === null) {
      return;
    }
    setSaving(true);
    setError(null);

    const payload: CheckAnswer[] = applicable.map((item) => {
      const answer = merged[item.code] ?? {};
      return {
        checkItemCode: item.code,
        passed: answer.passed === true,
        numericValue: answer.numericValue,
        note: answer.note,
        causeId: answer.causeId,
        actionId: answer.actionId,
        photoKey: answer.photoKey,
      };
    });

    try {
      const response = await fetch('/api/inspections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vanId: van.vanId,
          driverId: van.driverId,
          helperId: van.helperId ?? undefined,
          areaId: area?.id,
          notes: notes.trim() === '' ? undefined : notes.trim(),
          trainingFlag: training,
          answers: payload,
        }),
      });

      if (!response.ok) {
        const body: unknown = await response.json();
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : 'Could not save the check';
        throw new Error(message);
      }

      const status = resolveStatus(payload, applicable);
      const time = clockTime();

      setOutcome({
        status,
        plate: van.plate,
        failedItems: failures.map((item) => item.label),
        time,
      });
      setToday((current) => [
        ...current,
        {
          id: `${van.vanId}-${time}`,
          performedAt: new Date().toISOString(),
          plate: van.plate,
          areaName: area?.name ?? 'Unassigned',
          driverName: van.driverName,
          helperName: van.helperName,
          inspectorName: profile.fullName,
          status,
          dispatchBlocked: status === 'action_required',
          failedCount: failures.length,
          tempReadingC: tempValue,
          notes: notes.trim() === '' ? null : notes.trim(),
          driverId: van.driverId,
          helperId: van.helperId,
          trainingFlag: training,
        },
      ]);
      setScreen('outcome');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not save the check');
    } finally {
      setSaving(false);
    }
  };

  const checkedPlates = new Map(today.map((record) => [record.plate, record.status]));

  return (
    <div className="flex min-h-screen items-start justify-center px-3 py-6">
      <div className="w-full max-w-md overflow-hidden rounded-lg bg-surface-page shadow-3">
        {screen === 'areas' && (
          <AreaList
            profile={profile}
            shiftLabel={shiftLabel}
            shiftSlot={shiftSlot}
            rotation={rotation}
            areas={areas}
            fleet={fleet}
            today={today}
            canManage={canManage}
            onPick={(picked) => {
              setArea(picked);
              setScreen('vans');
            }}
          />
        )}

        {screen === 'vans' && area !== null && (
          <VanList
            profile={profile}
            area={area}
            fleet={fleet.filter((entry) => entry.areaId === area.id)}
            shiftSlot={shiftSlot}
            checkedPlates={checkedPlates}
            query={query}
            onQuery={setQuery}
            onPick={startVan}
            onReport={() => setScreen('report')}
            onBack={() => {
              setArea(null);
              setScreen('areas');
            }}
          />
        )}

        {screen === 'check' && van !== null && (
          <Checklist
            van={van}
            checkItems={applicable}
            answers={merged}
            temp={temp}
            tempOk={tempOk}
            tempValue={tempValue}
            tempMin={tempMin}
            tempMax={tempMax}
            shiftLabel={shiftLabel}
            causes={causes}
            actions={actions}
            notes={notes}
            onNotes={setNotes}
            training={training}
            onTraining={setTraining}
            hasHelper={van.helperName !== null}
            error={error}
            saving={saving}
            ready={ready}
            blockers={blockers}
            answeredCount={answeredCount}
            incompleteCount={incomplete.length}
            uploading={uploading}
            onKey={pressKey}
            onPatch={patch}
            onBack={() => setScreen('vans')}
            onSubmit={() => void submit()}
            onError={setError}
          />
        )}

        {screen === 'outcome' && outcome !== null && (
          <OutcomeView
            outcome={outcome}
            inspectorName={profile.fullName}
            onNext={() => {
              setVan(null);
              setScreen('vans');
            }}
          />
        )}

        {screen === 'report' && (
          <Report
            today={today}
            area={area}
            shiftLabel={shiftLabel}
            tempMin={tempMin}
            tempMax={tempMax}
            onBack={() => setScreen(area === null ? 'areas' : 'vans')}
          />
        )}
      </div>
    </div>
  );
};

/* ------------------------------ header ------------------------------ */

const Header = ({
  eyebrow,
  title,
  sub,
  onBack,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  onBack?: () => void;
}) => (
  <header className="bg-brand-bold px-5 pb-5 pt-5">
    <div className="mb-4 flex items-center justify-between">
      <CaloMark invert />
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-content-invert-tertiary">
        Van check
      </span>
    </div>
    <div className="flex items-start gap-3">
      {onBack !== undefined && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Go back"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-invert-subtle text-lg text-content-invert"
        >
          ←
        </button>
      )}
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-content-invert-secondary">
          {eyebrow}
        </div>
        <h1 className="truncate text-xl font-bold leading-tight text-content-invert">{title}</h1>
        <div className="truncate text-xs text-content-invert-secondary">{sub}</div>
      </div>
    </div>
  </header>
);

const Chip = ({ status }: { status: InspectionStatus }) => {
  const meta = STATUS_META[status];
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.bg} ${meta.text}`}>
      {meta.label}
    </span>
  );
};

/* ----------------------------- area list ----------------------------- */

const AreaList = ({
  profile,
  shiftLabel,
  shiftSlot,
  rotation,
  areas,
  fleet,
  today,
  canManage,
  onPick,
}: {
  profile: Profile;
  shiftLabel: string;
  shiftSlot: string;
  rotation: AreaRotation[];
  areas: Area[];
  fleet: FleetEntry[];
  today: InspectionSummary[];
  canManage: boolean;
  onPick: (area: Area) => void;
}) => (
  <div>
    <Header
      eyebrow={`${shiftLabel} shift · ${profile.fullName}`}
      title="Which area?"
      sub={`${today.length} checked across the UAE this shift`}
    />
    <div className="space-y-3 p-4">
      {[...areas]
        .sort((a, b) => {
          // Most overdue first. With one inspector covering one area a
          // day, where to go next is the only question this screen has
          // to answer.
          const left = rotation.find((entry) => entry.areaId === a.id);
          const right = rotation.find((entry) => entry.areaId === b.id);
          const score = (entry: AreaRotation | undefined): number =>
            entry === undefined ? 0 : (entry.daysSince ?? 999) - entry.visitIntervalDays;
          return score(right) - score(left);
        })
        .map((area) => {
        const dueHere = fleet.filter(
          (entry) => entry.areaId === area.id && entry.shiftSlots.includes(shiftSlot),
        ).length;
        const doneHere = today.filter((record) => record.areaName === area.name).length;
        const allDone = dueHere > 0 && doneHere >= dueHere;
        const status = rotation.find((entry) => entry.areaId === area.id);
        const vansHere = dueHere;

        return (
          <button
            key={area.id}
            type="button"
            onClick={() => onPick(area)}
            disabled={vansHere === 0}
            className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-card p-4 text-left active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-content-invert ${
                allDone ? 'bg-pass' : 'bg-brand'
              }`}
            >
              {area.code}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-content">{area.name}</div>
              <div className="text-xs text-content-secondary">
                {vansHere === 0
                  ? 'No vans due this shift'
                  : `${doneHere} of ${vansHere} due this shift`}
              </div>
              {status !== undefined && (
                <div
                  className={`text-xs ${status.overdue ? 'font-bold text-hold' : 'text-content-secondary'}`}
                >
                  {status.daysSince === null
                    ? 'Never inspected'
                    : status.daysSince === 0
                      ? 'Visited today'
                      : `Last visited ${status.daysSince} day${status.daysSince === 1 ? '' : 's'} ago${
                          status.overdue ? ', overdue' : ''
                        }`}
                </div>
              )}
            </div>
            {vansHere > 0 && <span className="text-lg text-brand">›</span>}
          </button>
        );
      })}

      {canManage && (
        <a
          href="/admin"
          className="block w-full rounded-xl border border-line bg-surface-card py-3.5 text-center text-sm font-bold text-brand"
        >
          Manager dashboard
        </a>
      )}
    </div>
  </div>
);

/* ----------------------------- van list ----------------------------- */

const VanList = ({
  profile,
  area,
  fleet,
  shiftSlot,
  checkedPlates,
  query,
  onQuery,
  onPick,
  onReport,
  onBack,
}: {
  profile: Profile;
  area: Area;
  fleet: FleetEntry[];
  shiftSlot: string;
  checkedPlates: Map<string, InspectionStatus>;
  query: string;
  onQuery: (value: string) => void;
  onPick: (entry: FleetEntry) => void;
  onReport: () => void;
  onBack: () => void;
}) => {
  const term = query.toLowerCase();
  const visible = fleet.filter(
    (entry) =>
      entry.plate.toLowerCase().includes(term) || entry.driverName.toLowerCase().includes(term),
  );

  return (
    <div>
      <Header
        eyebrow={`${area.name} · ${profile.fullName}`}
        title="Which van?"
        sub={`${fleet.length} van${fleet.length === 1 ? '' : 's'} in this area`}
        onBack={onBack}
      />
      <div className="space-y-3 p-4">
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Plate or driver"
          aria-label="Search vans"
          className="w-full rounded-xl border border-line bg-surface-card px-3 py-2.5 text-sm text-content outline-none"
        />

        {(['van', 'truck'] as const).map((type) => {
          const group = visible.filter(
            (entry) => entry.vehicleType === type && entry.shiftSlots.includes(shiftSlot),
          );
          if (group.length === 0) {
            return null;
          }
          return (
            <div key={type} className="space-y-3">
              <div className="pt-1 text-[11px] font-bold uppercase tracking-wide text-content-secondary">
                {type === 'van' ? 'Delivery vans' : 'Transfer trucks'} ·{' '}
                {group.filter((entry) => checkedPlates.has(entry.plate)).length} of {group.length}{' '}
                checked
              </div>
              {group.map((entry) => {
                const done = checkedPlates.get(entry.plate);
                return (
            <button
              key={entry.vanId}
              type="button"
              onClick={() => onPick(entry)}
              disabled={done !== undefined}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-card p-4 text-left active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100"
            >
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-content-invert ${
                  done === undefined ? 'bg-brand' : 'bg-sub'
                }`}
              >
                {entry.plate.slice(-4)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-content">{entry.plate}</div>
                <div className="truncate text-xs text-content-secondary">
                  {entry.driverName}
                  {entry.helperName === null ? '' : ` + ${entry.helperName}`}
                </div>
              </div>
              {done === undefined ? (
                      <span className="text-lg text-brand">›</span>
                    ) : (
                      <Chip status={done} />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}

        {(() => {
          // Still listed and still tappable. A van that turns up when it
          // was not expected should be checkable, and that check counts.
          const notDue = visible.filter((entry) => !entry.shiftSlots.includes(shiftSlot));
          if (notDue.length === 0) {
            return null;
          }
          return (
            <div className="space-y-3">
              <div className="pt-1 text-[11px] font-bold uppercase tracking-wide text-content-secondary">
                Not due this shift · {notDue.length}
              </div>
              {notDue.map((entry) => (
                <button
                  key={entry.vanId}
                  type="button"
                  onClick={() => onPick(entry)}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-card p-4 text-left opacity-60 active:scale-[0.98]"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-content-secondary text-xs font-bold text-content-invert">
                    {entry.plate.slice(-4)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-content">{entry.plate}</div>
                    <div className="truncate text-xs text-content-secondary">
                      {entry.driverName}
                      {entry.helperName === null ? '' : ` + ${entry.helperName}`}
                    </div>
                  </div>
                  <span className="text-lg text-brand">›</span>
                </button>
              ))}
            </div>
          );
        })()}

        {visible.length === 0 && (
          <p className="py-8 text-center text-sm text-content-secondary">
            {fleet.length === 0
              ? `No vans with an assigned driver in ${area.name}. Add them in the manager dashboard.`
              : 'No van matches that. Check the plate and try again.'}
          </p>
        )}

        <button
          type="button"
          onClick={onReport}
          className="w-full rounded-xl border border-line bg-surface-card py-3.5 text-sm font-bold text-brand"
        >
          View morning report
        </button>
      </div>
    </div>
  );
};

/* ----------------------------- checklist ----------------------------- */

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];

const Checklist = ({
  van,
  checkItems,
  answers,
  temp,
  tempOk,
  tempValue,
  tempMin,
  tempMax,
  shiftLabel,
  causes,
  actions,
  notes,
  onNotes,
  training,
  onTraining,
  hasHelper,
  error,
  saving,
  ready,
  blockers,
  answeredCount,
  incompleteCount,
  uploading,
  onKey,
  onPatch,
  onBack,
  onSubmit,
  onError,
}: {
  van: FleetEntry;
  checkItems: CheckItem[];
  answers: Record<string, Answer>;
  temp: string;
  tempOk: boolean;
  tempValue: number | null;
  tempMin: number;
  tempMax: number;
  shiftLabel: string;
  causes: CheckCause[];
  actions: CheckAction[];
  notes: string;
  onNotes: (value: string) => void;
  training: TrainingFlag;
  onTraining: (value: TrainingFlag) => void;
  hasHelper: boolean;
  error: string | null;
  saving: boolean;
  ready: boolean;
  blockers: string[];
  answeredCount: number;
  incompleteCount: number;
  uploading: boolean;
  onKey: (key: string) => void;
  onPatch: (code: string, values: Answer) => void;
  onBack: () => void;
  onSubmit: () => void;
  onError: (message: string) => void;
}) => {
  let label = 'Submit check';
  if (saving) {
    label = 'Saving…';
  } else if (uploading) {
    label = 'Uploading photo…';
  } else if (answeredCount < checkItems.length) {
    label = `${checkItems.length - answeredCount} left to check`;
  } else if (incompleteCount > 0) {
    label = `Pick a cause for ${incompleteCount} failed item${incompleteCount > 1 ? 's' : ''}`;
  }

  return (
    <div>
      <Header
        eyebrow={`${shiftLabel} pre-departure`}
        title={van.plate}
        sub={van.helperName === null ? van.driverName : `${van.driverName} + ${van.helperName}`}
        onBack={onBack}
      />

      <div className="px-5 pt-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div
            className="h-full bg-brand-hero transition-all duration-300"
            style={{ width: `${(answeredCount / checkItems.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="space-y-3 p-4">
        {error !== null && (
          <div className="rounded-lg bg-fail-soft p-3 text-sm font-medium text-fail">
            Not saved: {error}
          </div>
        )}

        {checkItems.map((item) => {
          const answer = answers[item.code] ?? {};
          const border =
            answer.passed === true
              ? 'border-pass'
              : answer.passed === false
                ? 'border-fail'
                : 'border-line';

          return (
            <div key={item.code} className={`rounded-xl border-2 bg-surface-card p-4 ${border}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-content">
                {item.label}
                {item.critical && (
                  <span className="rounded bg-hold-soft px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-hold">
                    BLOCKS DISPATCH
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-content-secondary">{item.helpText}</div>

              {item.inputType === 'temperature' ? (
                <div className="mt-3">
                  <div
                    className={`rounded-lg py-4 text-center transition-colors ${
                      tempValue === null ? 'bg-surface-page' : tempOk ? 'bg-pass-soft' : 'bg-fail-soft'
                    }`}
                  >
                    <div
                      className={`text-4xl font-bold tabular-nums ${
                        tempValue === null ? 'text-content-secondary' : tempOk ? 'text-pass' : 'text-fail'
                      }`}
                    >
                      {temp === '' ? '––' : temp}
                      <span className="ml-1 text-xl">°C</span>
                    </div>
                    <div
                      className={`mt-1 text-[11px] font-bold ${
                        tempValue === null ? 'text-content-secondary' : tempOk ? 'text-pass' : 'text-fail'
                      }`}
                    >
                      {tempValue === null
                        ? 'Enter the reading'
                        : tempOk
                          ? 'Within range'
                          : `Outside ${tempMin} to ${tempMax} °C`}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => onKey(key)}
                        aria-label={key === 'del' ? 'Delete last digit' : key}
                        className="rounded-lg bg-surface-page py-3.5 text-lg font-bold text-content"
                      >
                        {key === 'del' ? '⌫' : key}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onPatch(item.code, {
                        passed: true,
                        note: '',
                        causeId: undefined,
                        actionId: undefined,
                        photoKey: undefined,
                        photoPreview: undefined,
                        // Switching to pass mid upload would otherwise
                        // leave this true and block the whole check.
                        uploading: false,
                      })
                    }
                    className={`flex-1 rounded-lg py-3 text-sm font-bold ${
                      answer.passed === true ? 'bg-pass text-content-invert' : 'bg-pass-soft text-pass'
                    }`}
                  >
                    ✓ Pass
                  </button>
                  <button
                    type="button"
                    onClick={() => onPatch(item.code, { passed: false })}
                    className={`flex-1 rounded-lg py-3 text-sm font-bold ${
                      answer.passed === false ? 'bg-fail text-content-invert' : 'bg-fail-soft text-fail'
                    }`}
                  >
                    ✗ Fail
                  </button>
                </div>
              )}

              {answer.passed === false && (
                <Evidence
                  plate={van.plate}
                  code={item.code}
                  answer={answer}
                  causes={causes.filter((cause) => cause.checkItemId === item.id)}
                  actions={actions}
                  onPatch={onPatch}
                  onError={onError}
                />
              )}
            </div>
          );
        })}

        <div className="rounded-xl border border-line bg-surface-card p-4">
          <div className="text-sm font-bold text-content">Anything else to note?</div>
          <div className="mt-0.5 text-xs text-content-secondary">
            Optional. Anything worth recording that the checks above do not cover.
          </div>
          <textarea
            value={notes}
            onChange={(event) => onNotes(event.target.value)}
            rows={3}
            placeholder="Observations, follow-ups, things to watch"
            className="mt-3 w-full resize-none rounded-lg border border-line bg-surface-page p-3 text-sm text-content outline-none"
          />

          <div className="mt-4 border-t border-line pt-4">
            <div className="text-sm font-bold text-content">Does anyone need training?</div>
            <div className="mt-0.5 text-xs text-content-secondary">
              Your call. It goes on the training queue, not on their record as a penalty.
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {TRAINING_CHOICES.filter(
                (choice) => hasHelper || (choice.value !== 'helper' && choice.value !== 'both'),
              ).map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => onTraining(choice.value)}
                  className={`rounded-lg px-3 py-2.5 text-sm font-bold ${
                    training === choice.value
                      ? 'bg-brand-action text-content-invert'
                      : 'border border-line bg-surface-page text-content-secondary'
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={!ready || saving}
          className="w-full rounded-xl bg-brand-action py-4 text-base font-bold text-content-invert disabled:cursor-not-allowed disabled:bg-line disabled:text-content-secondary"
        >
          {label}
        </button>

        {!ready && blockers.length > 0 && (
          <ul className="space-y-1 px-1 pb-2">
            {blockers.map((blocker) => (
              <li key={blocker} className="text-xs text-content-secondary">
                {blocker}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/* ------------------------------ evidence ------------------------------ */

const Evidence = ({
  plate,
  code,
  answer,
  causes,
  actions,
  onPatch,
  onError,
}: {
  plate: string;
  code: string;
  answer: Answer;
  causes: CheckCause[];
  actions: CheckAction[];
  onPatch: (code: string, values: Answer) => void;
  onError: (message: string) => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [noteOpen, setNoteOpen] = useState(answer.note !== undefined && answer.note !== '');

  const handleFile = async (file: File): Promise<void> => {
    onPatch(code, { uploading: true, photoPreview: URL.createObjectURL(file) });
    try {
      const key = await uploadPhoto(plate, code, file);
      onPatch(code, { photoKey: key, uploading: false });
    } catch (cause: unknown) {
      onPatch(code, { uploading: false, photoPreview: undefined });
      onError(cause instanceof Error ? cause.message : 'Photo did not upload');
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-dashed border-line pt-3">
      {/* The one required field. Everything below is optional, so this
          comes first rather than last. */}
      {causes.length > 0 && (
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-fail">
            What caused this?
          </div>
          <div className="mt-2 grid gap-1.5">
            {causes.map((cause) => (
              <button
                key={cause.id}
                type="button"
                onClick={() => onPatch(code, { causeId: cause.id })}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-bold ${
                  answer.causeId === cause.id
                    ? 'bg-brand-action text-content-invert'
                    : 'border border-line bg-surface-page text-content-secondary'
                }`}
              >
                {cause.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tells a held van from a fixed one. Without it the two look
          identical in the record. */}
      {actions.length > 0 && (
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-content-secondary">
            What was done? <span className="font-normal normal-case">Optional</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() =>
                  onPatch(code, {
                    actionId: answer.actionId === action.id ? undefined : action.id,
                  })
                }
                className={`rounded-full px-3 py-2 text-xs font-bold ${
                  answer.actionId === action.id
                    ? 'bg-brand-action text-content-invert'
                    : 'border border-line bg-surface-page text-content-secondary'
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            void handleFile(file);
          }
        }}
      />

      {answer.photoPreview === undefined ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex-1 rounded-lg border border-line bg-surface-page py-2.5 text-sm font-bold text-content-secondary"
          >
            Add photo
          </button>
          {!noteOpen && (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="flex-1 rounded-lg border border-line bg-surface-page py-2.5 text-sm font-bold text-content-secondary"
            >
              Add a note
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={answer.photoPreview}
              alt="Evidence"
              className="h-36 w-full rounded-lg object-cover"
            />
            {answer.uploading === true && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-scrim text-sm font-bold text-content-invert">
                Uploading…
              </div>
            )}
            {answer.uploading !== true && (
              <button
                type="button"
                onClick={() => onPatch(code, { photoKey: undefined, photoPreview: undefined })}
                aria-label="Remove photo"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-scrim-strong text-content-invert"
              >
                ✗
              </button>
            )}
          </div>
          {!noteOpen && (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="w-full rounded-lg border border-line bg-surface-page py-2.5 text-sm font-bold text-content-secondary"
            >
              Add a note
            </button>
          )}
        </div>
      )}

      {/* Kept reachable rather than removed: options cannot capture
          "compressor grinding since Tuesday", and that sentence is often
          the most useful thing in the record. */}
      {noteOpen && (
        <textarea
          value={answer.note ?? ''}
          onChange={(event) => onPatch(code, { note: event.target.value })}
          placeholder="Anything the options above do not cover"
          rows={2}
          autoFocus
          className="w-full resize-none rounded-lg border border-line bg-surface-page p-3 text-sm text-content outline-none"
        />
      )}
    </div>
  );
};

/* ------------------------------ outcome ------------------------------ */

const OutcomeView = ({
  outcome,
  inspectorName,
  onNext,
}: {
  outcome: Outcome;
  inspectorName: string;
  onNext: () => void;
}) => {
  const blocked = outcome.status === 'action_required';
  const meta = STATUS_META[outcome.status];

  const title = blocked
    ? 'Dispatch held'
    : outcome.status === 'compliant'
      ? 'Cleared for dispatch'
      : 'Non-compliant';

  const line = blocked
    ? `${outcome.plate} must not leave the yard until the failed items are fixed and re-checked.`
    : outcome.status === 'compliant'
      ? `${outcome.plate} passed every check at ${outcome.time}.`
      : `${outcome.plate} can dispatch, but the failures need closing today.`;

  return (
    <div>
      <div className={`px-6 pb-8 pt-10 text-center ${meta.solid}`}>
        <h1 className="text-2xl font-bold text-content-invert">{title}</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-content-invert-strong">{line}</p>
      </div>

      <div className="space-y-3 p-4">
        {blocked && (
          <div className="rounded-xl bg-hold-soft p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-hold">
              Alert sent
            </div>
            <div className="mt-1 text-sm text-content">#uae-fleet-ops on Slack</div>
          </div>
        )}

        {outcome.failedItems.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line bg-surface-card">
            <div className="border-b border-line px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-content-secondary">
              Failed items
            </div>
            {outcome.failedItems.map((item) => (
              <div key={item} className="border-b border-line px-4 py-3 text-sm font-bold text-content last:border-b-0">
                {item}
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-line bg-surface-card p-4 text-xs text-content-secondary">
          Recorded {outcome.time} by {inspectorName}. Record locked — corrections need a new check.
        </div>

        <button
          type="button"
          onClick={onNext}
          className="w-full rounded-xl bg-brand-action py-4 text-base font-bold text-content-invert"
        >
          Next van
        </button>
      </div>
    </div>
  );
};

/* ------------------------------- report ------------------------------- */

const Report = ({
  today,
  area,
  shiftLabel,
  tempMin,
  tempMax,
  onBack,
}: {
  today: InspectionSummary[];
  area: Area | null;
  shiftLabel: string;
  tempMin: number;
  tempMax: number;
  onBack: () => void;
}) => {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);

  const sendToSlack = async (): Promise<void> => {
    if (area === null) {
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch('/api/reports/slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ areaId: area.id, areaName: area.name, note }),
      });
      const body: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : 'Could not send the report';
        setSendError(message);
        return;
      }

      const photos =
        typeof body === 'object' && body !== null && 'photoCount' in body
          ? Number((body as { photoCount: unknown }).photoCount)
          : 0;
      setPhotoCount(photos);
      setSent(true);
    } catch {
      setSendError('Could not reach the server');
    } finally {
      setSending(false);
    }
  };

  const records = area === null ? today : today.filter((r) => r.areaName === area.name);

  const counts: Record<InspectionStatus, number> = {
    compliant: 0,
    noncompliant: 0,
    action_required: 0,
  };
  for (const record of records) {
    counts[record.status] += 1;
  }

  const total = records.length === 0 ? 1 : records.length;
  const pct = Math.round((counts.compliant / total) * 100);

  return (
    <div>
      <Header
        eyebrow={`${shiftLabel} · pre-departure`}
        title={`${shiftLabel} report`}
        sub={area === null ? 'All areas' : area.name}
        onBack={onBack}
      />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(counts) as InspectionStatus[]).map((key) => (
            <div key={key} className={`rounded-xl p-3 text-center ${STATUS_META[key].bg}`}>
              <div className={`text-3xl font-bold ${STATUS_META[key].text}`}>{counts[key]}</div>
              <div className={`mt-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_META[key].text}`}>
                {STATUS_META[key].label}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-line bg-surface-card p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-content-secondary">
              Cleared first time
            </span>
            <span
              className={`text-2xl font-bold ${
                pct >= 80 ? 'text-pass' : pct >= 50 ? 'text-hold' : 'text-fail'
              }`}
            >
              {pct}%
            </span>
          </div>
        </div>

        {records.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-secondary">No checks recorded yet this shift.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface-card">
            <div className="border-b border-line px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-content-secondary">
              Vans checked
            </div>
            {records.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between gap-2 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-bold text-content">
                    {record.plate}
                    {record.tempReadingC !== null && (
                      <span
                        className={`text-xs tabular-nums ${
                          record.tempReadingC >= tempMin && record.tempReadingC <= tempMax
                            ? 'text-pass'
                            : 'text-fail'
                        }`}
                      >
                        {record.tempReadingC.toFixed(1)}°C
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-content-secondary">
                    {record.areaName} · {record.driverName}
                  </div>
                </div>
                <Chip status={record.status} />
              </div>
            ))}
          </div>
        )}

        {area !== null && records.length > 0 && (
          <div className="rounded-xl border border-line bg-surface-card p-4">
            <div className="text-sm font-bold text-content">
              Send {area.name} {shiftLabel.toLowerCase()} report to Slack
            </div>
            <div className="mt-0.5 text-xs text-content-secondary">
              Compliance, gaps, and deviations by driver for the whole round.
            </div>

            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="How did the round go? (optional)"
              disabled={sent}
              className="mt-3 w-full resize-none rounded-lg border border-line bg-surface-page p-3 text-sm text-content outline-none disabled:opacity-60"
            />

            {sendError !== null && (
              <div className="mt-2 rounded-lg bg-fail-soft p-3 text-sm font-medium text-fail">
                {sendError}
              </div>
            )}

            <button
              type="button"
              onClick={() => void sendToSlack()}
              disabled={sending || sent}
              className="mt-3 w-full rounded-xl bg-brand-action py-3.5 text-sm font-bold text-content-invert disabled:bg-pass-soft disabled:text-pass"
            >
              {sent ? 'Report sent' : sending ? 'Sending…' : 'Send report to Slack'}
            </button>

            {sent && (
              <p className="mt-2 text-center text-xs text-content-secondary">
                Posted to Slack with {photoCount} photo{photoCount === 1 ? '' : 's'}.
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onBack}
          className="w-full rounded-xl bg-brand-action py-4 text-base font-bold text-content-invert"
        >
          Back to vans
        </button>
      </div>
    </div>
  );
};
