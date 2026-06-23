'use server'

import { LOGIN_PATH, type SignOutScope } from '@/lib/auth/sign-out'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signOut(scope: SignOutScope = 'local') {
  const supabase = await createClient()
  await supabase.auth.signOut({ scope })
  redirect(LOGIN_PATH)
}
