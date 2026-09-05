import { redirect } from 'next/navigation';
import { AdminDashboard } from '@/components/AdminDashboard';
import {
  listActions,
  listAreas,
  listCauses,
  listDrivers,
  listVans,
} from '@/lib/fleetRepository';
import { listCheckItems } from '@/lib/inspectionRepository';
import { isApprover, listPending } from '@/lib/approvals';
import { currentProfile, ForbiddenError, UnauthorizedError } from '@/lib/session';

const AdminPage = async () => {
  try {
    const profile = await currentProfile();

    if (profile.role !== 'manager' && profile.role !== 'admin') {
      redirect('/');
    }

    // Inactive records are included here — this is the only screen where
    // you can bring one back.
    const [areas, vans, drivers, causes, actions, checkItems, pending] = await Promise.all([
      listAreas(true),
      listVans(true),
      listDrivers(true),
      listCauses(true),
      listActions(true),
      listCheckItems(),
      listPending(),
    ]);

    return (
      <AdminDashboard
        areas={areas}
        vans={vans}
        drivers={drivers}
        causes={causes}
        actions={actions}
        checkItems={checkItems}
        pending={pending}
        isApprover={isApprover(profile)}
        isAdmin={profile.role === 'admin'}
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

export default AdminPage;
