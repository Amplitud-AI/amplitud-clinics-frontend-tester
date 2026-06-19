/** Clinic staff RBAC — mirrors ``docs/specs/clinic_staff_rbac`` (Phase A). */

export const CLINIC_STAFF_ROLES = [
  "owner",
  "doctor",
  "nurse",
  "specialist",
  "staff",
] as const;

export type ClinicStaffRole = (typeof CLINIC_STAFF_ROLES)[number];

export const DEFAULT_INVITE_ROLE: ClinicStaffRole = "staff";

/** Closed capability set (SQL ``staff_capabilities_check``). */
export const CLINIC_CAPABILITIES = [
  {
    value: "can_manage_billing",
    label: "Can manage billing",
  },
  {
    value: "can_manage_calendar",
    label: "Can manage calendar",
  },
  {
    value: "can_manage_team",
    label: "Can manage team (invites, roster, WhatsApp settings)",
  },
  {
    value: "can_manage_clinic_rag",
    label: "Can manage clinic knowledge (RAG)",
  },
  {
    value: "can_manage_agent_control",
    label: "Can control agents (pause, silent mode, disconnect)",
  },
  {
    value: "can_manage_scheduling_preferences",
    label: "Can manage scheduling preferences (preferred doctor, scheduling prefs)",
  },
  {
    value: "can_manage_clinic_preferences",
    label: "Can manage clinic-wide preferences (global settings)",
  },
  {
    value: "can_manage_staff_profiles",
    label: "Can edit non-owner staff profiles",
  },
] as const;

export type ClinicCapability = (typeof CLINIC_CAPABILITIES)[number]["value"];

export function emptyInviteCapabilityChecks(): Record<ClinicCapability, boolean> {
  return Object.fromEntries(
    CLINIC_CAPABILITIES.map((c) => [c.value, false]),
  ) as Record<ClinicCapability, boolean>;
}

export function selectedInviteCapabilities(
  checks: Record<ClinicCapability, boolean>,
): string[] {
  return CLINIC_CAPABILITIES.filter((c) => checks[c.value]).map((c) => c.value);
}

/** Hydrate edit UI from ``clinic.staff.capabilities`` (PostgREST / A1). */
export function capabilityChecksFromArray(
  caps: string[] | null | undefined,
): Record<ClinicCapability, boolean> {
  const base = emptyInviteCapabilityChecks();
  if (!Array.isArray(caps)) return base;
  const allowed = new Set(CLINIC_CAPABILITIES.map((c) => c.value));
  for (const raw of caps) {
    const v = String(raw).trim();
    if (allowed.has(v as ClinicCapability)) base[v as ClinicCapability] = true;
  }
  return base;
}

export function extractClinicRoleFromJwtPayload(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const am = payload.app_metadata;
  if (typeof am !== "object" || am === null || Array.isArray(am)) return null;
  const role = (am as Record<string, unknown>).clinic_role;
  return typeof role === "string" && role.trim() ? role.trim().toLowerCase() : null;
}

/** Owner semantics (includes legacy hook values during migration). */
export function isClinicOwnerRole(role: string | null | undefined): boolean {
  const r = (role ?? "").toLowerCase();
  return r === "owner" || r === "clinic_admin" || r === "admin";
}

export function extractCapabilitiesFromJwtPayload(
  payload: Record<string, unknown> | null,
): string[] {
  if (!payload) return [];
  const am = payload.app_metadata;
  if (typeof am !== "object" || am === null || Array.isArray(am)) return [];
  const caps = (am as Record<string, unknown>).capabilities;
  if (!Array.isArray(caps)) return [];
  return caps.map((c) => String(c).trim()).filter(Boolean);
}

/** Roster writes: owner today; Phase B RLS also allows ``can_manage_team``. */
export function sessionCanManageTeamRoster(
  sessionIsOwner: boolean,
  jwtCapabilities: string[],
): boolean {
  return sessionIsOwner || jwtCapabilities.includes("can_manage_team");
}

/** Only owner may assign or change someone to ``owner``. */
export function canAssignClinicRole(
  sessionIsOwner: boolean,
  sessionCanManageTeam: boolean,
  targetRole: string,
): boolean {
  if (targetRole === "owner") return sessionIsOwner;
  return sessionCanManageTeam;
}

export function normalizeStaffRole(role: string | null | undefined): ClinicStaffRole {
  const r = (role ?? "").trim().toLowerCase();
  if ((CLINIC_STAFF_ROLES as readonly string[]).includes(r)) return r as ClinicStaffRole;
  return DEFAULT_INVITE_ROLE;
}

export function formatCapabilitiesCompact(
  caps: string[] | null | undefined,
): string {
  if (!Array.isArray(caps) || caps.length === 0) return "—";
  return caps.join(", ");
}

export function sessionHasCapability(
  sessionIsOwner: boolean,
  jwtCapabilities: string[],
  capability: ClinicCapability,
): boolean {
  if (sessionIsOwner) return true;
  return jwtCapabilities.includes(capability);
}

export function sessionCanManageSchedulingPreferences(
  sessionIsOwner: boolean,
  jwtCapabilities: string[],
): boolean {
  return sessionHasCapability(
    sessionIsOwner,
    jwtCapabilities,
    "can_manage_scheduling_preferences",
  );
}

export function sessionCanManageClinicPreferences(
  sessionIsOwner: boolean,
  jwtCapabilities: string[],
): boolean {
  return sessionHasCapability(
    sessionIsOwner,
    jwtCapabilities,
    "can_manage_clinic_preferences",
  );
}

export function sessionCanManageStaffProfiles(
  sessionIsOwner: boolean,
  jwtCapabilities: string[],
): boolean {
  return sessionHasCapability(
    sessionIsOwner,
    jwtCapabilities,
    "can_manage_staff_profiles",
  );
}
