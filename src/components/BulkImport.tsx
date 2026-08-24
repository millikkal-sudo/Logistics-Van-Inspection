'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One row is a van, its driver, and optionally its helper: the same fact
 * as it exists in the yard. Paste it, or point at a Google Sheet.
 *
 * Preview runs on its own. Requiring a Preview click before the Import
 * button appeared meant that after loading a sheet nothing actionable
 * was on screen, which read as the button being missing.
 */

type Issue = { line: number; input: string; reason: string };

type Draft = {
  line: number;
  plate: string;
  areaName: string;
  existingVanId: string | null;
  driverName: string;
  helperName: string;
};

type PreviewResult = { valid: Draft[]; issues: Issue[]; imported?: number };

const COLUMNS: { key: string; note: string }[] = [
  { key: 'plate', note: 'DXB-12345' },
  { key: 'area', note: 'the emirate' },
  { key: 'driver', note: 'full name' },
  { key: 'helper', note: 'optional, leave blank if none' },
];

export const BulkImport = ({
  areaNames,
  samplePlate,
  onImported,
}: {
  areaNames: string[];
  samplePlate: string;
  onImported: () => void;
}) => {
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'sheet' | 'paste'>('sheet');
  const [sheetUrl, setSheetUrl] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstArea = areaNames[0] ?? 'Dubai';
  const template =
    `plate,area,driver,helper\n` +
    `${samplePlate},${firstArea},Rashid Al Mansoori,Joseph Fernandes\n` +
    `DXB-99001,${areaNames[1] ?? firstArea},Anil Kumar,\n`;

  const downloadTemplate = (): void => {
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'calo-fleet-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const call = useCallback(
    async (commit: boolean, source: string, url: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        // Deliberately not under /api/admin: a dynamic [entity] segment
        // sits there and shadows any sibling path it does not know about.
        const response = await fetch('/api/fleet-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: source, sheetUrl: url, commit }),
        });

        const body: unknown = await response.json();

        if (!response.ok) {
          setError(
            typeof body === 'object' && body !== null && 'error' in body
              ? String((body as { error: unknown }).error)
              : 'Import failed',
          );
          return;
        }

        setResult(body as PreviewResult);

        if (commit) {
          setText('');
          setSheetUrl('');
          onImported();
        }
      } catch {
        setError('Could not reach the server');
      } finally {
        setBusy(false);
      }
    },
    [onImported],
  );

  useEffect(() => {
    if (mode !== 'paste' || text.trim() === '') {
      return;
    }
    const timer = setTimeout(() => {
      void call(false, text, '');
    }, 500);
    return () => clearTimeout(timer);
  }, [mode, text, call]);

  const readFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.readAsText(file);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm border border-line bg-surface-card px-4 py-2.5 text-sm font-bold text-brand"
      >
        Bulk import fleet
      </button>
    );
  }

  return (
    <div className="rounded-md border border-line bg-surface-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-content">Bulk import fleet</h2>
          <p className="mt-0.5 text-xs text-content-secondary">
            One row per van, with its driver and helper. Keep the header row and the column order
            does not matter.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
            setError(null);
          }}
          className="text-xs font-bold text-content-secondary"
        >
          Close
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-sm border border-line">
        <div className="bg-surface-page px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-content-secondary">
          Columns
        </div>
        {COLUMNS.map((column) => (
          <div
            key={column.key}
            className="flex items-baseline gap-3 border-t border-line px-3 py-1.5 text-xs"
          >
            <span className="w-16 shrink-0 font-mono font-bold text-content">{column.key}</span>
            <span className="text-content-secondary">{column.note}</span>
          </div>
        ))}
        <div className="border-t border-line bg-surface-page px-3 py-2 text-[11px] text-content-secondary">
          Areas must match exactly:{' '}
          {areaNames.length === 0 ? 'none set up yet' : areaNames.join(', ')}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {(['sheet', 'paste'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setMode(option);
              setResult(null);
              setError(null);
            }}
            className={`rounded-full px-4 py-2 text-xs font-bold ${
              mode === option
                ? 'bg-brand-action text-content-invert'
                : 'border border-line bg-surface-page text-content-secondary'
            }`}
          >
            {option === 'sheet' ? 'Google Sheet link' : 'Paste rows'}
          </button>
        ))}
      </div>

      {mode === 'sheet' ? (
        <div className="mt-3 space-y-2">
          <input
            value={sheetUrl}
            onChange={(event) => {
              setSheetUrl(event.target.value);
              setResult(null);
            }}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            className="w-full rounded-sm border border-line bg-surface-page p-3 font-mono text-xs text-content outline-none"
          />
          <p className="text-xs text-content-secondary">
            In Google Sheets open Share, set General access to &ldquo;Anyone with the link&rdquo;,
            then paste the link here. Set it back to Restricted once the import is done: while it
            is open, anyone holding the link can read the sheet.
          </p>
          <button
            type="button"
            onClick={() => void call(false, '', sheetUrl)}
            disabled={busy || sheetUrl.trim() === ''}
            className="rounded-sm bg-brand-action px-5 py-2 text-xs font-bold text-content-invert disabled:bg-disabled disabled:text-content-secondary"
          >
            {busy ? 'Reading the sheet…' : 'Read the sheet'}
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(null);
            }}
            rows={6}
            placeholder={template}
            className="mt-3 w-full resize-y rounded-sm border border-line bg-surface-page p-3 font-mono text-xs text-content outline-none"
          />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                readFile(file);
              }
            }}
          />
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={downloadTemplate}
          className="rounded-sm border border-line px-4 py-2 text-xs font-bold text-brand"
        >
          Download template
        </button>

        {mode === 'paste' && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-sm border border-line px-4 py-2 text-xs font-bold text-content"
          >
            Choose a file
          </button>
        )}

        {result !== null && result.valid.length > 0 && result.imported === undefined && (
          <button
            type="button"
            onClick={() => void call(true, text, mode === 'sheet' ? sheetUrl : '')}
            disabled={busy}
            className="rounded-sm bg-pass px-6 py-2 text-xs font-bold text-content-invert"
          >
            Import {result.valid.length} van{result.valid.length === 1 ? '' : 's'}
          </button>
        )}

        {busy && <span className="text-xs text-content-secondary">Checking…</span>}

        {!busy && result !== null && result.valid.length === 0 && result.imported === undefined && (
          <span className="text-xs font-bold text-fail">Nothing to import yet</span>
        )}
      </div>

      {error !== null && (
        <div className="mt-3 rounded-sm bg-fail-soft p-3 text-sm font-medium text-fail">{error}</div>
      )}

      {result !== null && (
        <div className="mt-4 space-y-3">
          {result.imported !== undefined && (
            <div className="rounded-sm bg-pass-soft p-3 text-sm font-bold text-pass">
              Imported {result.imported} van{result.imported === 1 ? '' : 's'} with their crews.
            </div>
          )}

          {result.valid.length > 0 && result.imported === undefined && (
            <div className="overflow-hidden rounded-sm border border-line">
              <div className="bg-pass-soft px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-pass">
                {result.valid.length} ready to import
              </div>
              <div className="max-h-52 overflow-y-auto">
                {result.valid.map((draft) => (
                  <div
                    key={draft.line}
                    className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs last:border-b-0"
                  >
                    <span className="w-8 shrink-0 text-content-secondary">{draft.line}</span>
                    <span className="min-w-0 text-content">
                      <span className="font-bold">{draft.plate}</span>{' '}
                      <span className="text-content-secondary">
                        {draft.areaName} · {draft.driverName}
                        {draft.helperName === '' ? '' : ` + ${draft.helperName}`}
                        {draft.existingVanId !== null && ' · existing van'}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.issues.length > 0 && (
            <div className="overflow-hidden rounded-sm border border-line">
              <div className="bg-fail-soft px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-fail">
                {result.issues.length} row{result.issues.length === 1 ? '' : 's'} skipped
              </div>
              <div className="max-h-52 overflow-y-auto">
                {result.issues.map((issue) => (
                  <div
                    key={`${issue.line}-${issue.reason}`}
                    className="border-b border-line px-3 py-2 text-xs last:border-b-0"
                  >
                    <span className="mr-2 text-content-secondary">Line {issue.line}</span>
                    <span className="font-bold text-fail">{issue.reason}</span>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-content-secondary">
                      {issue.input}
                    </div>
                  </div>
                ))}
              </div>
              <p className="border-t border-line px-3 py-2 text-[11px] text-content-secondary">
                Skipped rows are not imported. Fix them and load again.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
