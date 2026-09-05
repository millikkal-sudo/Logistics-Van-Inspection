import { sessionClient } from './supabaseClients';
import type { Profile, UserRole } from './types';

/**
 * PORT BOUNDARY — auth.
 *
 * Under password auth the access boundary is account creation, not the
 * email domain: only accounts created in Supabase exist, and public
 * signup is disabled. The active flag below is what removes someone who
 * has left, since there is no central directory to do it for us.
 */

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

type ProfileRow = {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  depot: string;
  active: boolean;
};

export const currentProfile = async (): Promise<Profile> => {
  const client = await sessionClient();
  const { data: auth } = await client.auth.getUser();
  const user = auth.user;

  if (user === null) {
    throw new UnauthorizedError('Sign in to continue');
  }

  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name, role, depot, active')
    .eq('id', user.id)
    .single<ProfileRow>();

  if (error !== null || data === null) {
    throw new UnauthorizedError('No profile found for this account');
  }
  if (!data.active) {
    throw new ForbiddenError('This account has been deactivated');
  }

  return {
    id: data.id,
    email: data.email,
    fullName: data.full_name,
    role: data.role,
    depot: data.depot,
  };
};

export const requireRole = (profile: Profile, allowed: UserRole[]): void => {
  if (!allowed.includes(profile.role)) {
    throw new ForbiddenError(`This needs ${allowed.join(' or ')} access`);
  }
};
