/** Browser-safe public env. Set in `.env`. */

export function getSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
}

export function getSupabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
}

/** Edge Function slug for staff invite + Auth email (default matches Dashboard name). */
export function getSupabaseInviteFunctionName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_INVITE_FUNCTION_NAME?.trim() || "email-invite";
}

/** Optional `redirect_to` for `auth.admin.inviteUserByEmail` (Auth Site URL / redirect allowlist). */
export function getClinicInviteRedirectUrl(): string {
  return process.env.NEXT_PUBLIC_CLINIC_INVITE_REDIRECT_URL?.trim() ?? "";
}

export function getAgnenticBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_AGNENTIC_BASE_URL?.trim() || "http://127.0.0.1:8001"
  );
}

/** Optional override so local tester can return to a non-local dashboard callback. */
export function getGoogleOauthReturnUrl(currentOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_RETURN_URL?.trim();
  if (configured) return configured;
  return `${currentOrigin.replace(/\/$/, "")}/oauth/callback`;
}

/** Mirrors agent-dashboard ``VITE_WHATSAPP_SERVICE_URL`` (nextjs-whatsapp-service). */
export function getWhatsAppServiceUrl(): string {
  return (
    process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL?.trim().replace(/\/$/, "") ||
    "http://localhost:3002"
  );
}

export const AG_PREFIX = "/api/v1/conversational-agent";
