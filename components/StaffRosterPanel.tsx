"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agnenticFetch, agPath } from "@/lib/agnentic";
import {
  CLINIC_CAPABILITIES,
  CLINIC_STAFF_ROLES,
  DEFAULT_INVITE_ROLE,
  canAssignClinicRole,
  capabilityChecksFromArray,
  emptyInviteCapabilityChecks,
  extractCapabilitiesFromJwtPayload,
  extractClinicRoleFromJwtPayload,
  formatCapabilitiesCompact,
  isClinicOwnerRole,
  normalizeStaffRole,
  selectedInviteCapabilities,
  sessionCanManageTeamRoster,
  type ClinicCapability,
} from "@/lib/clinicRbac";
import {
  getClinicInviteRedirectUrl,
  getSupabaseAnonKey,
  getSupabaseInviteFunctionName,
  getSupabaseUrl,
} from "@/lib/config";
import { decodeJwtPayload } from "@/lib/jwt";

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

type StaffChannelLinkRow = {
  channel?: string | null;
  contact_value?: string | null;
  verification_status?: string | null;
};

type StaffRow = {
  st_id?: string;
  display_name?: string | null;
  email?: string | null;
  role?: string | null;
  capabilities?: string[] | null;
  status?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position_title?: string | null;
  date_of_birth?: string | null;
  specialties?: string[] | null;
  /** PostgREST embed from ``staff_channel_links`` FK to ``staff`` (see ``11_*``). */
  staff_channel_links?: StaffChannelLinkRow[] | null;
};

function staffWhatsappLines(row: StaffRow): string[] {
  const raw = row.staff_channel_links;
  const links = Array.isArray(raw) ? raw : [];
  return links
    .filter(
      (l) =>
        String(l.channel ?? "").toLowerCase() === "whatsapp" &&
        (l.contact_value ?? "").trim().length > 0,
    )
    .map((l) => {
      const v = (l.contact_value ?? "").trim();
      const vs = String(l.verification_status ?? "").toLowerCase();
      return vs && vs !== "verified" ? `${v} (${l.verification_status})` : v;
    });
}

function staffRosterLabel(row: StaffRow): string {
  const base = (row.display_name || row.email || row.st_id || "").trim() || (row.st_id ?? "");
  const wa = staffWhatsappLines(row);
  if (wa.length === 0) return base;
  return `${base} · ${wa.join(", ")}`;
}

/** Matches ``staff_channel_links_whatsapp_contact_e164`` in ``11_staff_profile_and_staff_channel_links.sql``. */
function normalizeWhatsappContactE164(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, "").trim();
  if (!collapsed.startsWith("+")) return null;
  const rest = collapsed.slice(1).replace(/\D/g, "");
  if (!rest) return null;
  const value = `+${rest}`;
  return /^\+[1-9][0-9]{7,14}$/.test(value) ? value : null;
}

async function clinicRest(
  method: string,
  path: string,
  opts: { bearer: string; anon: string; body?: string; prefer?: string },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = getSupabaseUrl().replace(/\/$/, "");
  const rel = path.replace(/^\//, "");
  const url = `${base}/${rel}`;
  const headers: Record<string, string> = {
    apikey: opts.anon,
    Authorization: `Bearer ${opts.bearer.trim()}`,
    Accept: "application/json",
    "Accept-Profile": "clinic",
    "Content-Profile": "clinic",
  };
  if (opts.prefer != null && opts.prefer.trim()) headers.Prefer = opts.prefer.trim();
  if (opts.body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: opts.body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json };
}

export type StaffRosterPanelProps = {
  /** Same client as Phase 0 so ``functions.invoke`` sends the logged-in user JWT. */
  supabase: SupabaseClient | null;
  bearer: string | null;
  effectiveClId: string;
  onLog: (title: string, body: string) => void;
};

export default function StaffRosterPanel({
  supabase,
  bearer,
  effectiveClId,
  onLog,
}: StaffRosterPanelProps) {
  const anon = getSupabaseAnonKey();
  const token = bearer?.trim() ?? "";
  const cid = effectiveClId.trim();

  const [roster, setRoster] = useState<StaffRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<string>(DEFAULT_INVITE_ROLE);
  const [inviteCaps, setInviteCaps] = useState(emptyInviteCapabilityChecks);
  const [pickStId, setPickStId] = useState("");
  const [waE164, setWaE164] = useState("");
  const [verifiedNumbers, setVerifiedNumbers] = useState<string[]>([]);
  const [silentPick, setSilentPick] = useState<Record<string, boolean>>({});
  const [inviteRedirectTo, setInviteRedirectTo] = useState("");
  const [profileStId, setProfileStId] = useState("");
  const [profFirstName, setProfFirstName] = useState("");
  const [profLastName, setProfLastName] = useState("");
  const [profDisplayName, setProfDisplayName] = useState("");
  const [profPositionTitle, setProfPositionTitle] = useState("");
  const [profDob, setProfDob] = useState("");
  const [profSpecialties, setProfSpecialties] = useState("");
  const [editCaps, setEditCaps] = useState(emptyInviteCapabilityChecks);
  const [editRole, setEditRole] = useState<string>(DEFAULT_INVITE_ROLE);

  const activeStaff = useMemo(
    () =>
      roster.filter(
        (r) => String(r.status ?? "").toLowerCase() === "active" && (r.st_id ?? "").trim(),
      ),
    [roster],
  );

  const pendingStaff = useMemo(
    () =>
      roster.filter(
        (r) =>
          String(r.status ?? "").toLowerCase() === "pending_invite" && (r.st_id ?? "").trim(),
      ),
    [roster],
  );

  const rosterSummary = useMemo(() => {
    const n = roster.length;
    const a = activeStaff.length;
    const p = pendingStaff.length;
    return { n, a, p };
  }, [roster, activeStaff, pendingStaff]);

  const rosterForProfile = useMemo(
    () => roster.filter((r) => (r.st_id ?? "").trim()),
    [roster],
  );

  const canPostgrestSession = Boolean(token && anon);
  /** Writes that embed ``cl_id`` in the JSON body (Lane B2) need a known tenant in UI. */
  const canPostgrestTenant = Boolean(token && anon && cid);

  const jwtPayload = useMemo(
    () => (token ? decodeJwtPayload(token) : null),
    [token],
  );
  const sessionClinicRole = useMemo(
    () => extractClinicRoleFromJwtPayload(jwtPayload),
    [jwtPayload],
  );
  const sessionIsOwner = isClinicOwnerRole(sessionClinicRole);
  const sessionJwtCapabilities = useMemo(
    () => extractCapabilitiesFromJwtPayload(jwtPayload),
    [jwtPayload],
  );
  const sessionCanManageTeam = useMemo(
    () => sessionCanManageTeamRoster(sessionIsOwner, sessionJwtCapabilities),
    [sessionIsOwner, sessionJwtCapabilities],
  );

  const inviteCapabilitiesPayload = useMemo(
    () => (sessionIsOwner ? selectedInviteCapabilities(inviteCaps) : []),
    [inviteCaps, sessionIsOwner],
  );

  const editCapabilitiesPayload = useMemo(
    () => selectedInviteCapabilities(editCaps),
    [editCaps],
  );

  const a1List = useCallback(async () => {
    if (!canPostgrestSession) {
      onLog(
        "Lane A1",
        "Need Phase 0 session (Bearer) + NEXT_PUBLIC_SUPABASE_ANON_KEY — RLS uses JWT ``app_metadata.cl_id``; UI ``cl_id`` is optional for GET.",
      );
      return;
    }
    const q =
      "select=st_id,display_name,email,role,capabilities,status,first_name,last_name,position_title,date_of_birth,specialties," +
      "staff_channel_links(channel,contact_value,verification_status)" +
      "&order=created_at.desc&limit=50" +
      (cid ? `&cl_id=eq.${encodeURIComponent(cid)}` : "");
    const path = `rest/v1/staff?${q}`;
    const r = await clinicRest("GET", path, { bearer: token, anon });
    onLog(`Lane A1 GET staff (${r.status})`, pretty(r.json));
    if (Array.isArray(r.json)) setRoster(r.json as StaffRow[]);
  }, [anon, canPostgrestSession, cid, onLog, token]);

  useEffect(() => {
    if (!canPostgrestSession) return;
    const id = window.setTimeout(() => {
      void a1List();
    }, 0);
    return () => window.clearTimeout(id);
  }, [a1List, canPostgrestSession]);

  const a2Invite = useCallback(async () => {
    if (!canPostgrestSession) {
      onLog("Lane A2", "Need Phase 0 session + anon key.");
      return;
    }
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      onLog("Lane A2", "Enter a valid invite email.");
      return;
    }
    const body = JSON.stringify({
      p_email: email,
      p_role: inviteRole.trim(),
      p_display_name: inviteName.trim() || null,
      p_capabilities: inviteCapabilitiesPayload,
    });
    const r = await clinicRest("POST", "rest/v1/rpc/invite_staff", {
      bearer: token,
      anon,
      body,
    });
    onLog(`Lane A2 POST rpc/invite_staff (${r.status})`, pretty(r.json));
    if (r.ok) await a1List();
  }, [
    a1List,
    anon,
    canPostgrestSession,
    inviteCapabilitiesPayload,
    inviteEmail,
    inviteName,
    inviteRole,
    onLog,
    token,
  ]);

  const a2bEdgeInvite = useCallback(async () => {
    if (!supabase) {
      onLog("Lane A2b", "No Supabase client — configure NEXT_PUBLIC_SUPABASE_URL + ANON_KEY and sign in (Phase 0).");
      return;
    }
    if (!token) {
      onLog("Lane A2b", "Need logged-in session (Phase 0) so invoke sends your access token.");
      return;
    }
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      onLog("Lane A2b", "Enter a valid invite email.");
      return;
    }
    const fn = getSupabaseInviteFunctionName();
    const redirect =
      inviteRedirectTo.trim() || getClinicInviteRedirectUrl().trim() || undefined;
    const body: Record<string, unknown> = {
      p_email: email,
      p_role: inviteRole.trim(),
      p_display_name: inviteName.trim() ? inviteName.trim() : null,
      p_capabilities: inviteCapabilitiesPayload,
    };
    if (redirect) body.redirect_to = redirect;

    const base = getSupabaseUrl().replace(/\/$/, "");
    const url = `${base}/functions/v1/${encodeURIComponent(fn)}`;
    onLog(`Lane A2b POST ${url}`, `body=${pretty(body)}`);

    // Raw fetch so the Log panel always shows the response body on 4xx/5xx.
    // ``functions.invoke`` often hides the JSON error payload behind a generic message.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anon,
        "Content-Type": "application/json",
        "x-client-info": "clinic-onboarding-flow-tester",
      },
      body: JSON.stringify(body),
    });
    const rawText = await res.text();
    let parsed: unknown = rawText;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = { _non_json: rawText };
    }
    if (!res.ok) {
      onLog(`Lane A2b Edge Function HTTP ${res.status}`, pretty(parsed));
      return;
    }
    onLog("Lane A2b ok", pretty(parsed));
    await a1List();
  }, [
    a1List,
    anon,
    inviteCapabilitiesPayload,
    inviteEmail,
    inviteName,
    inviteRedirectTo,
    inviteRole,
    onLog,
    supabase,
    token,
  ]);

  const b3Snapshot = useCallback(async () => {
    if (!token) {
      onLog("Lane B3", "Need clinic JWT.");
      return;
    }
    let path = agPath("/clinic/whatsapp/transport-runtime-settings");
    if (cid) path += `?cl_id=${encodeURIComponent(cid)}`;
    const r = await agnenticFetch(path, { method: "GET", bearer: token });
    onLog(`Lane B3 GET transport-runtime-settings (${r.status})`, r.json != null ? pretty(r.json) : r.text);
    if (r.ok && r.json && typeof r.json === "object") {
      const arr = (r.json as Record<string, unknown>).staff_whatsapp_verified_e164;
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        setVerifiedNumbers(arr as string[]);
      }
    }
  }, [cid, onLog, token]);

  const b2LinkWa = useCallback(async () => {
    if (!canPostgrestTenant) {
      onLog(
        "Lane B2",
        "Need session + tenant cl_id in UI (Phase B override or JWT app_metadata.cl_id) for POST body.",
      );
      return;
    }
    const st = pickStId.trim();
    const contactNormalized = normalizeWhatsappContactE164(waE164);
    if (!st || !contactNormalized) {
      onLog(
        "Lane B2",
        "Select staff and enter WhatsApp E.164: optional spaces when typing — they are stripped — must match /^\\+[1-9][0-9]{7,14}$/ (e.g. +5215581311340).",
      );
      return;
    }
    const row = {
      cl_id: cid,
      st_id: st,
      channel: "whatsapp",
      contact_value: contactNormalized,
      verification_status: "verified",
    };
    const r = await clinicRest("POST", "rest/v1/staff_channel_links", {
      bearer: token,
      anon,
      body: JSON.stringify(row),
    });
    onLog(
      `Lane B2 POST staff_channel_links (${r.status}) contact_value=${contactNormalized}`,
      pretty(r.json),
    );
    if (r.ok) {
      await a1List();
      await b3Snapshot();
      onLog("Lane B2 follow-up", "Roster refreshed (A1) and transport snapshot (B3) so verified numbers stay in sync.");
    }
  }, [a1List, anon, b3Snapshot, canPostgrestTenant, cid, onLog, pickStId, token, waE164]);

  const hydrateProfileFromRoster = useCallback((stId: string) => {
    const st = stId.trim();
    if (!st) return;
    const row = roster.find((r) => (r.st_id ?? "").trim() === st);
    if (!row) return;
    setProfFirstName(row.first_name ?? "");
    setProfLastName(row.last_name ?? "");
    setProfDisplayName(row.display_name ?? "");
    setProfPositionTitle(row.position_title ?? "");
    setProfDob((row.date_of_birth ?? "").slice(0, 10));
    const specs = row.specialties;
    setProfSpecialties(
      Array.isArray(specs) ? specs.map((x) => String(x).trim()).filter(Boolean).join(", ") : "",
    );
    setEditCaps(capabilityChecksFromArray(row.capabilities));
    setEditRole(normalizeStaffRole(row.role));
  }, [roster]);

  const a3cPatchRole = useCallback(async () => {
    if (!canPostgrestTenant) {
      onLog("Lane A3c", "Need session + tenant cl_id in UI for PATCH filter (cl_id=eq…&st_id=eq…).");
      return;
    }
    const st = profileStId.trim();
    if (!st) {
      onLog("Lane A3c", "Pick a staff row in A3 (or Lane B pick → Load same staff).");
      return;
    }
    const nextRole = normalizeStaffRole(editRole);
    if (!canAssignClinicRole(sessionIsOwner, sessionCanManageTeam, nextRole)) {
      onLog(
        "Lane A3c",
        nextRole === "owner"
          ? "Only owner may assign role owner."
          : "Need owner JWT or can_manage_team to change role.",
      );
      return;
    }
    const row = roster.find((r) => (r.st_id ?? "").trim() === st);
    const prevRole = normalizeStaffRole(row?.role);
    if (prevRole === nextRole) {
      onLog("Lane A3c", `Role unchanged (${nextRole}). Pick a different role or another staff member.`);
      return;
    }
    if (isClinicOwnerRole(row?.role) && nextRole !== "owner") {
      onLog(
        "Lane A3c",
        "Warning: demoting an owner — ensure the clinic still has at least one owner row.",
      );
    }
    const path = `rest/v1/staff?cl_id=eq.${encodeURIComponent(cid)}&st_id=eq.${encodeURIComponent(st)}`;
    const body = { role: nextRole };
    const r = await clinicRest("PATCH", path, {
      bearer: token,
      anon,
      body: JSON.stringify(body),
      prefer: "return=representation",
    });
    onLog(`Lane A3c PATCH staff.role (${r.status}) ${prevRole} → ${nextRole}`, pretty(r.json));
    if (r.ok) {
      onLog(
        "Lane A3c follow-up",
        "Affected user should Refresh JWT so app_metadata.clinic_role / clinic_roles map updates.",
      );
      await a1List();
    }
  }, [
    a1List,
    anon,
    canPostgrestTenant,
    cid,
    editRole,
    onLog,
    profileStId,
    roster,
    sessionCanManageTeam,
    sessionIsOwner,
    token,
  ]);

  const a3bPatchCapabilities = useCallback(async () => {
    if (!canPostgrestTenant) {
      onLog("Lane A3b", "Need session + tenant cl_id in UI for PATCH filter (cl_id=eq…&st_id=eq…).");
      return;
    }
    if (!sessionIsOwner) {
      onLog(
        "Lane A3b",
        `Owner JWT required (RLS staff_clinic_staff_update_admin / jwt_is_clinic_admin). Your clinic_role: ${sessionClinicRole ?? "?"}`,
      );
      return;
    }
    const st = profileStId.trim();
    if (!st) {
      onLog("Lane A3b", "Pick a staff row in A3 (or Lane B pick → Load same staff).");
      return;
    }
    const row = roster.find((r) => (r.st_id ?? "").trim() === st);
    if (row && isClinicOwnerRole(row.role)) {
      onLog(
        "Lane A3b",
        "Target has role owner — hook already grants all five caps in JWT; PATCH is optional for owners.",
      );
    }
    const path = `rest/v1/staff?cl_id=eq.${encodeURIComponent(cid)}&st_id=eq.${encodeURIComponent(st)}`;
    const body = { capabilities: editCapabilitiesPayload };
    const r = await clinicRest("PATCH", path, {
      bearer: token,
      anon,
      body: JSON.stringify(body),
      prefer: "return=representation",
    });
    onLog(`Lane A3b PATCH staff.capabilities (${r.status})`, pretty(r.json));
    if (r.ok) {
      onLog(
        "Lane A3b follow-up",
        "Invited user must Refresh JWT after accept/login for new caps in app_metadata.capabilities.",
      );
      await a1List();
    }
  }, [
    a1List,
    anon,
    canPostgrestTenant,
    cid,
    editCapabilitiesPayload,
    onLog,
    profileStId,
    roster,
    sessionClinicRole,
    sessionIsOwner,
    token,
  ]);

  const a3PatchProfile = useCallback(async () => {
    if (!canPostgrestTenant) {
      onLog("Lane A3", "Need session + tenant cl_id in UI for PATCH filter (cl_id=eq…&st_id=eq…).");
      return;
    }
    const st = profileStId.trim();
    if (!st) {
      onLog("Lane A3", "Pick a staff row (any status with st_id).");
      return;
    }
    const body: Record<string, unknown> = {};
    if (profFirstName.trim()) body.first_name = profFirstName.trim();
    if (profLastName.trim()) body.last_name = profLastName.trim();
    if (profDisplayName.trim()) body.display_name = profDisplayName.trim();
    if (profPositionTitle.trim()) body.position_title = profPositionTitle.trim();
    if (profDob.trim()) body.date_of_birth = profDob.trim();
    const specParts = profSpecialties
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (specParts.length) body.specialties = specParts;
    if (Object.keys(body).length === 0) {
      onLog("Lane A3", "Fill at least one field to PATCH (or clear specialties with empty not supported here).");
      return;
    }
    const path = `rest/v1/staff?cl_id=eq.${encodeURIComponent(cid)}&st_id=eq.${encodeURIComponent(st)}`;
    const r = await clinicRest("PATCH", path, {
      bearer: token,
      anon,
      body: JSON.stringify(body),
      prefer: "return=minimal",
    });
    onLog(`Lane A3 PATCH staff (${r.status})`, pretty(r.json));
    if (r.ok) await a1List();
  }, [
    a1List,
    anon,
    canPostgrestTenant,
    cid,
    onLog,
    profDisplayName,
    profDob,
    profFirstName,
    profLastName,
    profPositionTitle,
    profSpecialties,
    profileStId,
    token,
  ]);

  const c2SaveSilent = useCallback(async () => {
    if (!token) {
      onLog("Lane C2", "Need clinic JWT (owner or can_manage_agent_control for PATCH).");
      return;
    }
    const selected = verifiedNumbers.filter((n) => silentPick[n]);
    // Keep relational policy row in sync: ``staff_ignore_e164`` alone leaves ``sender_filter_mode`` at DB default legacy_allowlist (``14_*`` trigger).
    const body: Record<string, unknown> = {
      staff_ignore_e164: selected,
      sender_filter_mode: "staff_ignore",
    };
    const path = agPath("/clinic/whatsapp/transport-policy");
    const r = await agnenticFetch(path, {
      method: "PATCH",
      bearer: token,
      body: JSON.stringify(body),
    });
    onLog(`Lane C2 PATCH transport-policy (${r.status})`, r.json != null ? pretty(r.json) : r.text);
  }, [onLog, silentPick, token, verifiedNumbers]);

  const c3VerifyDb = useCallback(async () => {
    if (!canPostgrestSession) {
      onLog("Lane C3", "Need Phase 0 session + anon key.");
      return;
    }
    const p1 =
      "rest/v1/whatsapp_transport_extra_ignore_e164?select=id,whatsapp_agent_session_id,contact_e164,created_at&limit=50";
    const p2 =
      "rest/v1/whatsapp_agent_transport_policy?select=whatsapp_agent_session_id,sender_filter_mode,reply_mode,use_verified_staff_whatsapp_directory,pause_skip_agent_execution&limit=20";
    const r1 = await clinicRest("GET", p1, { bearer: token, anon });
    const r2 = await clinicRest("GET", p2, { bearer: token, anon });
    onLog(`Lane C3 GET whatsapp_transport_extra_ignore_e164 (${r1.status})`, pretty(r1.json));
    onLog(`Lane C3 GET whatsapp_agent_transport_policy (${r2.status})`, pretty(r2.json));
  }, [anon, canPostgrestSession, onLog, token]);

  return (
    <section className="border border-zinc-300 dark:border-zinc-600 rounded p-4 space-y-4">
      <h2 className="font-medium">Phase E — Staff roster (PostgREST + transport)</h2>
      <p className="text-xs text-zinc-500">
        PRD Lanes A–C. Uses <code className="text-xs">Accept-Profile: clinic</code>.{" "}
        <code className="text-xs">cl_id</code> for inserts comes from session state only (
        <span className="font-mono">{cid || "—"}</span>). <strong>A2b</strong> calls your Edge Function (
        <code className="text-xs">{getSupabaseInviteFunctionName()}</code>) with the Phase 0 session — same
        project as <code className="text-xs">NEXT_PUBLIC_SUPABASE_URL</code>. Optional{" "}
        <code className="text-xs">NEXT_PUBLIC_CLINIC_INVITE_REDIRECT_URL</code> or the redirect field below for
        Auth invite links.
      </p>

      <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3 space-y-2">
        <h3 className="text-sm font-medium">Lane A — Invite</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void a1List()}>
            A1 List roster (GET staff)
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          A1 embeds <code className="text-xs">staff_channel_links</code> (PostgREST) so WhatsApp E.164 shows here
          without denormalizing a column onto <code className="text-xs">clinic.staff</code>.
        </p>
        {roster.length > 0 && (
          <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-700 rounded text-xs">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-zinc-100 dark:bg-zinc-800 text-left">
                  <th className="p-2 font-medium">status</th>
                  <th className="p-2 font-medium">role</th>
                  <th className="p-2 font-medium">capabilities</th>
                  <th className="p-2 font-medium">name / email</th>
                  <th className="p-2 font-medium">WhatsApp (staff_channel_links)</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((s) => {
                  const wa = staffWhatsappLines(s);
                  return (
                  <tr key={s.st_id ?? "?"} className="border-t border-zinc-200 dark:border-zinc-700">
                    <td className="p-2 align-top whitespace-nowrap">{s.status ?? "—"}</td>
                    <td className="p-2 align-top whitespace-nowrap font-mono text-[11px]">
                      {s.role ?? "—"}
                    </td>
                    <td
                      className="p-2 align-top font-mono text-[10px] max-w-[200px] break-all"
                      title={formatCapabilitiesCompact(s.capabilities)}
                    >
                      {formatCapabilitiesCompact(s.capabilities)}
                    </td>
                    <td className="p-2 align-top">
                      <div>{(s.display_name || s.email || s.st_id || "").trim() || "—"}</div>
                      {s.email && (s.display_name ?? "").trim() ? (
                        <div className="text-zinc-500 font-mono text-[11px]">{s.email}</div>
                      ) : null}
                      <div className="text-zinc-500 font-mono text-[11px]">{s.st_id}</div>
                    </td>
                    <td className="p-2 align-top font-mono">{wa.length ? wa.join(", ") : "—"}</td>
                  </tr>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <input
            className="border px-2 py-1 min-w-[200px] text-xs"
            placeholder="invite email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <input
            className="border px-2 py-1 min-w-[160px] text-xs"
            placeholder="display name (optional)"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
          />
          <select
            className="border px-2 py-1 text-xs"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            aria-label="invite role"
          >
            {CLINIC_STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void a2Invite()}>
            A2 Invite (POST rpc/invite_staff)
          </button>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void a2bEdgeInvite()}>
            A2b Invite + email (Edge Function)
          </button>
        </div>
        <fieldset className="border border-zinc-200 dark:border-zinc-700 rounded p-2 space-y-1 max-w-2xl">
          <legend className="text-xs px-1">Invite capabilities (optional)</legend>
          {!sessionIsOwner && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Only owner may grant capabilities at invite. Invites still work with{" "}
              <code className="text-xs">p_capabilities: []</code>
              {sessionClinicRole ? (
                <>
                  {" "}
                  (your JWT <code className="text-xs">clinic_role</code>:{" "}
                  <span className="font-mono">{sessionClinicRole}</span>)
                </>
              ) : (
                <> — refresh JWT after SQL 27</>
              )}
              .
            </p>
          )}
          <ul className="space-y-1 text-xs">
            {CLINIC_CAPABILITIES.map((cap) => (
              <li key={cap.value} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!sessionIsOwner}
                  checked={!!inviteCaps[cap.value as ClinicCapability]}
                  onChange={(e) =>
                    setInviteCaps((prev) => ({
                      ...prev,
                      [cap.value]: e.target.checked,
                    }))
                  }
                  aria-label={cap.label}
                />
                <span>
                  <span className="font-mono text-[10px] text-zinc-500">{cap.value}</span>
                  <span className="block">{cap.label}</span>
                </span>
              </li>
            ))}
          </ul>
          {inviteCapabilitiesPayload.length > 0 && (
            <p className="text-xs text-zinc-500 font-mono">
              p_capabilities: [{inviteCapabilitiesPayload.join(", ")}]
            </p>
          )}
        </fieldset>
        <input
          className="border px-2 py-1 w-full max-w-xl font-mono text-xs"
          placeholder={`redirect_to (optional; env: NEXT_PUBLIC_CLINIC_INVITE_REDIRECT_URL)`}
          value={inviteRedirectTo}
          onChange={(e) => setInviteRedirectTo(e.target.value)}
        />
        <p className="text-xs text-zinc-500">
          <strong>RLS</strong> (<code className="text-xs">16_staff_rls_clinic_admin_writes</code>): SELECT uses{" "}
          <code className="text-xs">clinic.jwt_cl_id() = staff.cl_id</code>,{" "}
          <code className="text-xs">jwt_is_clinic_staff()</code>, and an <strong>active</strong> org — not a manual
          table in <code className="text-xs">public</code>. Request includes{" "}
          <code className="text-xs">cl_id=eq.…</code> when session <code className="text-xs">cl_id</code> is set; rows
          still must pass JWT claims. Run <strong>A1</strong> after invites / <strong>Refresh JWT</strong>.
        </p>

        <div className="border border-zinc-200 dark:border-zinc-700 rounded p-3 space-y-2 bg-zinc-50 dark:bg-zinc-900/40">
          <h3 className="text-sm font-medium">Lane A3 — Staff profile (PATCH)</h3>
          <p className="text-xs text-zinc-500">
            Columns aligned with <code className="text-xs">11_staff_profile_and_staff_channel_links</code>. Pick any
            roster row (including <code className="text-xs">pending_invite</code>). Requires <strong>owner</strong>{" "}
            JWT (<code className="text-xs">clinic_role: owner</code>; shim{" "}
            <code className="text-xs">jwt_is_clinic_admin</code> = owner). Filter:{" "}
            <code className="text-xs">cl_id=eq…&amp;st_id=eq…</code>.
          </p>
          <select
            className="border px-2 py-1 w-full max-w-md text-xs"
            value={profileStId}
            onChange={(e) => {
              const v = e.target.value;
              setProfileStId(v);
              hydrateProfileFromRoster(v);
            }}
            aria-label="staff for profile edit"
          >
            <option value="">— pick staff (any status) —</option>
            {rosterForProfile.map((s) => (
              <option key={s.st_id} value={s.st_id ?? ""}>
                {(s.status ?? "?")} · {staffRosterLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="border px-2 py-1 rounded text-xs"
            disabled={!pickStId.trim()}
            onClick={() => {
              const st = pickStId.trim();
              setProfileStId(st);
              hydrateProfileFromRoster(st);
            }}
          >
            Load same staff as Lane B pick
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl">
            <input
              className="border px-2 py-1 text-xs"
              placeholder="first_name"
              value={profFirstName}
              onChange={(e) => setProfFirstName(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-xs"
              placeholder="last_name"
              value={profLastName}
              onChange={(e) => setProfLastName(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-xs sm:col-span-2"
              placeholder="display_name"
              value={profDisplayName}
              onChange={(e) => setProfDisplayName(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-xs sm:col-span-2"
              placeholder="position_title"
              value={profPositionTitle}
              onChange={(e) => setProfPositionTitle(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-xs"
              type="date"
              aria-label="date_of_birth"
              value={profDob}
              onChange={(e) => setProfDob(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-xs"
              placeholder="specialties (comma-separated)"
              value={profSpecialties}
              onChange={(e) => setProfSpecialties(e.target.value)}
            />
          </div>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void a3PatchProfile()}>
            A3 PATCH staff profile
          </button>

          <div className="border-t border-zinc-200 dark:border-zinc-700 pt-2 mt-2 space-y-2">
            <h4 className="text-xs font-medium">Lane A3b — Post-invite capabilities (PATCH)</h4>
            <p className="text-xs text-zinc-500">
              Genuine path: PostgREST <code className="text-xs">PATCH clinic.staff</code> as owner (RLS{" "}
              <code className="text-xs">16_staff_rls_clinic_admin_writes</code> +{" "}
              <code className="text-xs">staff_capabilities_check</code>). Matches production dashboard until Phase D
              RPC. Pick staff above — checkboxes load from A1 row.
            </p>
            {!sessionIsOwner && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Owner JWT required to PATCH another member&apos;s capabilities.
              </p>
            )}
            <ul className="space-y-1 text-xs">
              {CLINIC_CAPABILITIES.map((cap) => (
                <li key={`edit-${cap.value}`} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!sessionIsOwner || !profileStId.trim()}
                    checked={!!editCaps[cap.value as ClinicCapability]}
                    onChange={(e) =>
                      setEditCaps((prev) => ({
                        ...prev,
                        [cap.value]: e.target.checked,
                      }))
                    }
                  />
                  <span>{cap.label}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
              capabilities: [{editCapabilitiesPayload.join(", ") || "(empty)"}]
            </p>
            <button
              type="button"
              className="border px-3 py-1 rounded text-xs"
              disabled={!sessionIsOwner || !profileStId.trim()}
              onClick={() => void a3bPatchCapabilities()}
            >
              A3b PATCH capabilities
            </button>
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-700 pt-2 mt-2 space-y-2">
            <h4 className="text-xs font-medium">Lane A3c — Post-invite role (PATCH)</h4>
            <p className="text-xs text-zinc-500">
              Fix a wrong invite role via PostgREST <code className="text-xs">PATCH staff.role</code> (
              <code className="text-xs">staff_role_check</code>: owner, doctor, nurse, specialist, staff). Owner or{" "}
              <code className="text-xs">can_manage_team</code> may change non-owner roles; only{" "}
              <strong>owner</strong> may assign <code className="text-xs">owner</code>.
            </p>
            {!sessionCanManageTeam && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Need owner JWT or <code className="text-xs">can_manage_team</code> in JWT capabilities.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs flex items-center gap-2">
                <span className="text-zinc-600 dark:text-zinc-400">role</span>
                <select
                  className="border px-2 py-1 text-xs"
                  value={editRole}
                  disabled={!sessionCanManageTeam || !profileStId.trim()}
                  onChange={(e) => setEditRole(e.target.value)}
                  aria-label="post-invite staff role"
                >
                  {CLINIC_STAFF_ROLES.map((r) => (
                    <option key={`edit-role-${r}`} value={r} disabled={r === "owner" && !sessionIsOwner}>
                      {r}
                      {r === "owner" && !sessionIsOwner ? " (owner JWT only)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="border px-3 py-1 rounded text-xs"
                disabled={
                  !profileStId.trim() ||
                  !canAssignClinicRole(sessionIsOwner, sessionCanManageTeam, normalizeStaffRole(editRole))
                }
                onClick={() => void a3cPatchRole()}
              >
                A3c PATCH role
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3 space-y-2">
        <h3 className="text-sm font-medium">Lane B — Attach WhatsApp</h3>
        <p className="text-xs text-zinc-500">
          Dropdown lists only <strong>active</strong> staff (PRD Lane B). New invites stay{" "}
          <code className="text-xs">pending_invite</code> until the invitee confirms email (triggers 07/21) — they{" "}
          <strong>will not appear</strong> here until status is <code className="text-xs">active</code>. Roster auto-loads{" "}
          via A1 when Phase 0 session exists; cached snapshot:{" "}
          <span className="font-mono">{rosterSummary.n}</span> row(s),{" "}
          <span className="font-mono">{rosterSummary.a}</span> active,{" "}
          <span className="font-mono">{rosterSummary.p}</span> pending_invite — click{" "}
          <strong>A1</strong> to refresh. Table Editor uses <strong>postgres</strong> (bypasses RLS); tester uses your{" "}
          <strong>JWT</strong> — if this stays 0 while Table Editor shows rows, check Phase 0 JWT{" "}
          <code className="text-xs">app_metadata.clinic_role</code> and <strong>Refresh JWT</strong>.
        </p>
        {rosterSummary.p > 0 && rosterSummary.a === 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Pending only:{" "}
            {pendingStaff
              .map((s) => (s.email ?? s.display_name ?? s.st_id ?? "").trim())
              .filter(Boolean)
              .join(", ")}
            {" —"}
            invitee completes magic link / OTP, then re-run <strong>A1</strong>.
          </p>
        )}
        <select
          className="border px-2 py-1 w-full max-w-md text-xs"
          value={pickStId}
          onChange={(e) => setPickStId(e.target.value)}
          aria-label="active staff for WhatsApp link"
        >
          <option value="">— pick active staff —</option>
          {activeStaff.map((s) => (
            <option key={s.st_id} value={s.st_id ?? ""}>
              {staffRosterLabel(s)}
            </option>
          ))}
        </select>
        <input
          className="border px-2 py-1 w-full max-w-xs font-mono text-xs"
          placeholder="WhatsApp E.164 (spaces OK; stripped) e.g. +52 15581311340"
          value={waE164}
          onChange={(e) => setWaE164(e.target.value)}
        />
        <p className="text-xs text-zinc-500">
          INSERT requires <strong>owner</strong> or <code className="text-xs">can_manage_team</code> JWT (
          <code className="text-xs">17_organizations_and_staff_channel_links_rls</code>).{" "}
          403 = RLS; 400 =often E.164 <code className="text-xs">staff_channel_links_whatsapp_contact_e164</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void b2LinkWa()}>
            B2 POST staff_channel_links (owner / team JWT) — then auto A1 + B3
          </button>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void b3Snapshot()}>
            B3 GET transport-runtime-settings
          </button>
        </div>
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3 space-y-2">
        <h3 className="text-sm font-medium">Lane C — Silent list</h3>
        <p className="text-xs text-zinc-500">
          After B3, select numbers to ignore. PATCH omits <code className="text-xs">session_id</code> (server
          resolves active binding).
        </p>
        {verifiedNumbers.length === 0 ? (
          <p className="text-xs text-zinc-500">No verified staff WhatsApp numbers in last snapshot — run B3.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {verifiedNumbers.map((n) => (
              <li key={n} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!silentPick[n]}
                  onChange={(e) =>
                    setSilentPick((prev) => ({ ...prev, [n]: e.target.checked }))
                  }
                />
                <span className="font-mono">{n}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void c2SaveSilent()}>
            C2 PATCH transport-policy (staff_ignore_e164)
          </button>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void c3VerifyDb()}>
            C3 GET ignore rows + transport_policy
          </button>
        </div>
      </div>
    </section>
  );
}
