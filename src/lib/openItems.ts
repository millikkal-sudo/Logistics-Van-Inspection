import { serviceClient } from './supabaseClients';

/**
 * A failure that has not since been passed.
 *
 * Derived from the inspection history rather than tracked in a table:
 * an item closes when the vehicle actually passes the check again, not
 * when someone remembers to mark it done.
 */

export type OpenItem = {
  vanId: string;
  plate: string;
  driverName: string;
  areaId: string | null;
  areaName: string;
  checkItemId: string;
  checkCode: string;
  checkLabel: string;
  causeLabel: string | null;
  actionLabel: string | null;
  failedAt: string;
  /** Whole days since the failure. */
  daysOpen: number;
};

type Row = {
  van_id: string;
  plate: string;
  driver_name: string;
  area_id: string | null;
  area_name: string;
  check_item_id: string;
  check_code: string;
  check_label: string;
  cause_label: string | null;
  action_label: string | null;
  failed_at: string;
};

export const listOpenItems = async (): Promise<OpenItem[]> => {
  const { data, error } = await serviceClient()
    .from('v_open_items')
    .select('*')
    .order('failed_at', { ascending: true });

  if (error !== null) {
    throw new Error(`Could not load open items: ${error.message}`);
  }

  const now = Date.now();

  return (data ?? []).map((row: Row) => ({
    vanId: row.van_id,
    plate: row.plate,
    driverName: row.driver_name,
    areaId: row.area_id,
    areaName: row.area_name,
    checkItemId: row.check_item_id,
    checkCode: row.check_code,
    checkLabel: row.check_label,
    causeLabel: row.cause_label,
    actionLabel: row.action_label,
    failedAt: row.failed_at,
    daysOpen: Math.floor((now - new Date(row.failed_at).getTime()) / 86_400_000),
  }));
};
