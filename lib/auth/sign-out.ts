import type { AuthError, SupabaseClient } from '@supabase/supabase-js';

export type SignOutScope = 'local' | 'global';

export const LOGIN_PATH = '/login' as const;

export async function signOutWithScope(
  supabase: SupabaseClient,
  scope: SignOutScope,
): Promise<{ error: AuthError | null }> {
  const { error } = await supabase.auth.signOut({ scope });
  return { error };
}
