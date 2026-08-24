import { serviceClient } from './supabaseClients';
import { listAreas, listDrivers, listVans } from './fleetRepository';
import type { Profile } from './types';

/**
 * Fleet import: one row is a van, its driver, and optionally its helper.
 *
 * Importing vans and staff separately meant a helper had to name a
 * driver who had to name a van, across two files, in the right order.
 * A van, its driver and its helper are one fact in the yard, so they are
 * one row here.
 *
 * Nothing is written until the preview has been seen.
 */

export type RowIssue = { line: number; input: string; reason: string };

export type FleetDraft = {
  line: number;
  plate: string;
  areaId: string;
  areaName: string;
  /** Set when the van already exists and is being reused. */
  existingVanId: string | null;
  driverName: string;
  helperName: string;
  vehicleType: 'van' | 'truck';
};

export type Preview = { valid: FleetDraft[]; issues: RowIssue[] };

const normalise = (value: string): string => value.trim().toLowerCase();

/**
 * Handles comma and tab delimiters, quoted fields, CRLF, and the BOM a
 * spreadsheet writes. Pasting from Google Sheets gives tabs; an export
 * gives commas.
 */
export const parseDelimited = (text: string): { cells: string[]; line: number }[] => {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows: { cells: string[]; line: number }[] = [];

  let cell = '';
  let cells: string[] = [];
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  const pushCell = (): void => {
    cells.push(cell.trim());
    cell = '';
  };

  const pushRow = (): void => {
    pushCell();
    if (cells.some((value) => value !== '')) {
      rows.push({ cells, line: startLine });
    }
    cells = [];
    startLine = line + 1;
  };

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === '\t') {
      pushCell();
    } else if (char === '\n') {
      pushRow();
      line += 1;
    } else {
      cell += char;
    }
  }

  if (cell !== '' || cells.length > 0) {
    pushRow();
  }

  return rows;
};

/**
 * Maps a header row onto known fields so column order does not matter.
 * Reading purely by position meant a sheet with columns swapped imported
 * plates into the area field without complaint.
 */
const ALIASES: Record<string, string[]> = {
  plate: ['plate', 'van', 'van plate', 'plate no', 'plate number', 'registration', 'vehicle'],
  area: ['area', 'emirate', 'location', 'city'],
  driver: ['driver', 'driver name', 'name', 'full name'],
  helper: ['helper', 'helper name', 'assistant', 'rides with', 'partner'],
  type: ['type', 'vehicle', 'vehicle type', 'van or truck'],
};

const FIELDS = ['plate', 'area', 'driver', 'helper', 'type'];

type ColumnMap = Record<string, number>;

const buildColumnMap = (headerCells: string[]): ColumnMap | null => {
  const map: ColumnMap = {};

  headerCells.forEach((cell, index) => {
    const cleaned = normalise(cell);
    for (const field of FIELDS) {
      if (map[field] === undefined && (ALIASES[field] ?? []).includes(cleaned)) {
        map[field] = index;
        break;
      }
    }
  });

  // One match is more likely a data row that happens to read "Dubai".
  return Object.keys(map).length >= 2 ? map : null;
};

const POSITIONAL: ColumnMap = { plate: 0, area: 1, driver: 2, helper: 3, type: 4 };

const cellAt = (cells: string[], columns: ColumnMap, field: string): string => {
  const index = columns[field];
  return index === undefined ? '' : (cells[index] ?? '').trim();
};

const listOf = (values: string[]): string =>
  values.length === 0 ? 'none configured' : values.join(', ');

export const previewFleet = async (text: string): Promise<Preview> => {
  const [areas, vans, staff] = await Promise.all([
    listAreas(true),
    listVans(true),
    listDrivers(true),
  ]);

  const parsed = parseDelimited(text);
  const first = parsed[0];
  const headerMap = first === undefined ? null : buildColumnMap(first.cells);
  const rows = headerMap === null ? parsed : parsed.slice(1);
  const columns = headerMap ?? POSITIONAL;

  const valid: FleetDraft[] = [];
  const issues: RowIssue[] = [];

  const areaNames = areas.map((area) => area.name);
  const seenPlates = new Set<string>();
  const seenNames = new Set<string>();

  const takenVans = new Set(
    staff.filter((person) => person.defaultVanId !== null).map((person) => person.defaultVanId),
  );
  const existingNames = new Set(staff.map((person) => normalise(person.fullName)));

  for (const row of rows) {
    const raw = row.cells.join(', ');
    const plate = cellAt(row.cells, columns, 'plate').toUpperCase();
    const areaText = cellAt(row.cells, columns, 'area');
    const driverName = cellAt(row.cells, columns, 'driver');
    const helperName = cellAt(row.cells, columns, 'helper');
    // Anything that is not clearly a truck is a van, so an empty or
    // missing type column keeps working.
    const vehicleType = normalise(cellAt(row.cells, columns, 'type')) === 'truck' ? 'truck' : 'van';

    if (plate === '') {
      issues.push({ line: row.line, input: raw, reason: 'No plate' });
      continue;
    }
    if (driverName === '') {
      issues.push({ line: row.line, input: raw, reason: 'No driver name' });
      continue;
    }

    const area = areas.find(
      (candidate) =>
        normalise(candidate.name) === normalise(areaText) ||
        normalise(candidate.code) === normalise(areaText),
    );
    if (area === undefined) {
      issues.push({
        line: row.line,
        input: raw,
        reason:
          areaText === ''
            ? `No area given. Use one of: ${listOf(areaNames)}`
            : `Unknown area "${areaText}". Use one of: ${listOf(areaNames)}`,
      });
      continue;
    }

    if (seenPlates.has(plate)) {
      issues.push({ line: row.line, input: raw, reason: 'This plate appears twice in the file' });
      continue;
    }

    // An existing van is reused rather than rejected, so a row can add a
    // driver to a van that is already on the system.
    const existing = vans.find((van) => van.plate === plate);
    if (existing !== undefined) {
      if (existing.areaId !== area.id) {
        issues.push({
          line: row.line,
          input: raw,
          reason: `${plate} already exists in a different area`,
        });
        continue;
      }
      if (takenVans.has(existing.id)) {
        issues.push({ line: row.line, input: raw, reason: `${plate} already has a driver` });
        continue;
      }
    }

    const clash = [driverName, helperName]
      .filter((name) => name !== '')
      .find((name) => existingNames.has(normalise(name)) || seenNames.has(normalise(name)));

    if (clash !== undefined) {
      issues.push({
        line: row.line,
        input: raw,
        reason: `${clash} is already on the system. Use a different name, or add them from the Drivers tab.`,
      });
      continue;
    }

    seenPlates.add(plate);
    seenNames.add(normalise(driverName));
    if (helperName !== '') {
      seenNames.add(normalise(helperName));
    }

    valid.push({
      line: row.line,
      plate,
      areaId: area.id,
      areaName: area.name,
      existingVanId: existing?.id ?? null,
      driverName,
      helperName,
      vehicleType,
    });
  }

  return { valid, issues };
};

export const importFleet = async (drafts: FleetDraft[], actor: Profile): Promise<number> => {
  if (drafts.length === 0) {
    return 0;
  }

  const db = serviceClient();

  // 1. New vans. Rows reusing an existing van are skipped here.
  const newVans = drafts.filter((draft) => draft.existingVanId === null);
  const plateToId = new Map<string, string>();

  if (newVans.length > 0) {
    const { data, error } = await db
      .from('vans')
      .insert(
        newVans.map((draft) => ({
          plate: draft.plate,
          vehicle_type: draft.vehicleType,
          area_id: draft.areaId,
          temp_min_c: 0,
          temp_max_c: 5,
        })),
      )
      .select('id, plate');

    if (error !== null || data === null) {
      throw new Error(`Van import failed: ${error?.message ?? 'unknown'}`);
    }
    for (const row of data as { id: string; plate: string }[]) {
      plateToId.set(row.plate, row.id);
    }
  }

  for (const draft of drafts) {
    if (draft.existingVanId !== null) {
      plateToId.set(draft.plate, draft.existingVanId);
    }
  }

  // 2. Drivers, each attached to their van.
  const { data: driverRows, error: driverError } = await db
    .from('drivers')
    .insert(
      drafts.map((draft) => ({
        full_name: draft.driverName,
        staff_role: 'driver',
        partner_id: null,
        area_id: draft.areaId,
        default_van: plateToId.get(draft.plate) ?? null,
      })),
    )
    .select('id, full_name');

  if (driverError !== null || driverRows === null) {
    throw new Error(`Driver import failed: ${driverError?.message ?? 'unknown'}`);
  }

  const nameToId = new Map(
    (driverRows as { id: string; full_name: string }[]).map((row) => [
      normalise(row.full_name),
      row.id,
    ]),
  );

  // 3. Helpers, paired to the driver from the same row and sharing the
  //    same van, so a pair cannot drift onto different vehicles.
  const helperRows = drafts
    .filter((draft) => draft.helperName !== '')
    .flatMap((draft) => {
      const partnerId = nameToId.get(normalise(draft.driverName));
      if (partnerId === undefined) {
        return [];
      }
      return [
        {
          full_name: draft.helperName,
          staff_role: 'helper',
          partner_id: partnerId,
          area_id: draft.areaId,
          default_van: plateToId.get(draft.plate) ?? null,
        },
      ];
    });

  if (helperRows.length > 0) {
    const { error } = await db.from('drivers').insert(helperRows);
    if (error !== null) {
      throw new Error(`Helper import failed: ${error.message}`);
    }
  }

  await db.from('audit_log').insert({
    actor_id: actor.id,
    action: 'fleet.bulk_imported',
    entity: 'bulk_import',
    after: {
      rows: drafts.length,
      vans: newVans.length,
      drivers: drafts.length,
      helpers: helperRows.length,
    },
  });

  return drafts.length;
};
