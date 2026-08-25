import { redirect } from 'next/navigation';
import { VanCheckApp } from '@/components/VanCheckApp';
import {
  listActions,
  listAreaRotation,
  listAreas,
  listCauses,
  listFleet,
} from '@/lib/fleetRepository';
import { listCheckItems, listInspectionsSince } from '@/lib/inspectionRepository';
import { currentProfile, ForbiddenError, UnauthorizedError } from '@/lib/session';
import { resolveShift } from '@/lib/shift';

/**
 * Everything the phone needs, fetched in one server render. The
 * supervisor opens this at 06:30 on warehouse wifi — a waterfall of
 * client fetches would be felt.
 */
const HomePage = async () => {
  try {
    const profile = await currentProfile();
    // The current despatch shift, not the calendar day. A van that ran
    // this morning is due another check before the evening round, and a
    // shift starting at 19:00 finishes after midnight.
    const shift = resolveShift();

    const [areas, fleet, checkItems, causes, actions, rotation, today] = await Promise.all([
      listAreas(),
      listFleet(),
      listCheckItems(),
      listCauses(),
      listActions(),
      listAreaRotation(),
      listInspectionsSince(shift.from, { until: shift.to }),
    ]);

    return (
      <VanCheckApp
        profile={profile}
        areas={areas}
        fleet={fleet}
        checkItems={checkItems}
        causes={causes}
        actions={actions}
        initialToday={today}
        shiftLabel={shift.label}
        shiftSlot={shift.slot}
        rotation={rotation}
        canManage={profile.role === 'manager' || profile.role === 'admin'}
      />
    );
  } catch (cause: unknown) {
    if (cause instanceof UnauthorizedError) {
      redirect('/login');
    }
    if (cause instanceof ForbiddenError) {
      redirect('/login?error=inactive');
    }
    throw cause;
  }
};

export const dynamic = 'force-dynamic';

export default HomePage;
