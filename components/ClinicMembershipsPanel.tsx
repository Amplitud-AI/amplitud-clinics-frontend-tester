"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { agnenticFetch } from "@/lib/agnentic";

type ClinicMembershipStaff = {
  st_id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  position_title: string | null;
};

type ClinicMembership = {
  cl_id: string;
  display_name: string;
  role: string;
  capabilities: string[];
  staff?: ClinicMembershipStaff;
};

type ClinicMembershipsPanelProps = {
  bearer: string | null;
  jwtPayload: Record<string, unknown> | null;
  activeClId: string;
  onSwitchClinic: (clId: string) => Promise<void>;
  onLog: (title: string, body: string) => void;
};

const MEMBERSHIPS_PATH = "/api/v1/clinic/memberships";

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function jwtSubject(payload: Record<string, unknown> | null): string {
  const sub = payload?.sub;
  return typeof sub === "string" && sub.trim() ? sub.trim() : "anonymous";
}

function cacheKey(subject: string): string {
  return `clinic_memberships:${subject}`;
}

function isMembershipList(value: unknown): value is ClinicMembership[] {
  return Array.isArray(value) && value.every(isMembership);
}

function isMembership(value: unknown): value is ClinicMembership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.cl_id === "string" &&
    typeof row.display_name === "string" &&
    typeof row.role === "string" &&
    Array.isArray(row.capabilities) &&
    (row.staff === undefined || isMembershipStaff(row.staff))
  );
}

function isMembershipStaff(value: unknown): value is ClinicMembershipStaff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const staff = value as Record<string, unknown>;
  return (
    typeof staff.st_id === "string" &&
    typeof staff.display_name === "string" &&
    nullableString(staff.first_name) &&
    nullableString(staff.last_name) &&
    nullableString(staff.position_title)
  );
}

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function readCachedMemberships(subject: string): ClinicMembership[] {
  try {
    const raw = localStorage.getItem(cacheKey(subject));
    const parsed = raw ? JSON.parse(raw) : null;
    return isMembershipList(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cacheMemberships(subject: string, rows: ClinicMembership[]): void {
  try {
    localStorage.setItem(cacheKey(subject), JSON.stringify(rows));
  } catch {
    /* cache is best-effort display polish */
  }
}

function membershipStaff(row: ClinicMembership): ClinicMembershipStaff | null {
  return isMembershipStaff(row.staff) ? row.staff : null;
}

function staffTooltip(row: ClinicMembership): string {
  const staff = membershipStaff(row);
  if (!staff) return `staff unavailable\n${row.role}`;
  const title = staff.position_title ? `\n${staff.position_title}` : "";
  return `${staff.display_name}\n${row.role}${title}`;
}

export default function ClinicMembershipsPanel({
  bearer,
  jwtPayload,
  activeClId,
  onSwitchClinic,
  onLog,
}: ClinicMembershipsPanelProps) {
  const subject = useMemo(() => jwtSubject(jwtPayload), [jwtPayload]);
  const cachedRows = useMemo(() => readCachedMemberships(subject), [subject]);
  const [rows, setRows] = useState<ClinicMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [switchingClId, setSwitchingClId] = useState<string | null>(null);
  const visibleRows = rows.length ? rows : cachedRows;

  const loadMemberships = useCallback(async () => {
    if (!bearer) {
      onLog("clinic memberships", "Need clinic JWT");
      return;
    }
    setLoading(true);
    const result = await agnenticFetch(MEMBERSHIPS_PATH, {
      method: "GET",
      bearer,
    });
    setLoading(false);
    onLog(
      `GET clinic/memberships (${result.status})`,
      result.json != null ? pretty(result.json) : result.text,
    );
    if (result.ok && isMembershipList(result.json)) {
      setRows(result.json);
      cacheMemberships(subject, result.json);
    }
  }, [bearer, onLog, subject]);

  useEffect(() => {
    if (!bearer) return;
    const id = window.setTimeout(() => {
      void loadMemberships();
    }, 0);
    return () => window.clearTimeout(id);
  }, [bearer, loadMemberships]);

  const switchClinic = useCallback(
    async (clId: string) => {
      if (clId === activeClId || switchingClId) return;
      setSwitchingClId(clId);
      try {
        await onSwitchClinic(clId);
      } finally {
        setSwitchingClId(null);
      }
    },
    [activeClId, onSwitchClinic, switchingClId],
  );

  return (
    <section className="border border-zinc-300 rounded p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Clinic memberships</h2>
          <p className="text-xs text-zinc-500">
            Fetches display names for JWT-scoped clinic memberships. Cached rows
            are display-only; auth still comes from the active JWT.
          </p>
        </div>
        <button
          type="button"
          className="border px-3 py-1 rounded"
          onClick={() => void loadMemberships()}
          disabled={loading}
        >
          {loading ? "Loading..." : "GET memberships"}
        </button>
      </div>
      {visibleRows.length === 0 ? (
        <p className="text-xs text-zinc-500">No cached or fetched memberships.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b">
                <th className="py-1 pr-2">active</th>
                <th className="py-1 pr-2">display_name</th>
                <th className="py-1 pr-2">staff</th>
                <th className="py-1 pr-2">cl_id</th>
                <th className="py-1 pr-2">role</th>
                <th className="py-1 pr-2">capabilities</th>
                <th className="py-1 pr-2">switch</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const isActive = row.cl_id === activeClId;
                const isSwitching = switchingClId === row.cl_id;
                const staff = membershipStaff(row);
                return (
                  <tr key={row.cl_id} className="border-b last:border-b-0">
                    <td className="py-1 pr-2">{isActive ? "yes" : ""}</td>
                    <td className="py-1 pr-2 font-medium">{row.display_name}</td>
                    <td className="py-1 pr-2" title={staffTooltip(row)}>
                      <div className="font-medium">
                        {staff?.display_name ?? "staff unavailable"}
                      </div>
                      <div className="text-zinc-500">
                        {staff?.position_title ?? row.role}
                      </div>
                    </td>
                    <td className="py-1 pr-2 font-mono">{row.cl_id}</td>
                    <td className="py-1 pr-2">{row.role}</td>
                    <td className="py-1 pr-2 font-mono">
                      {row.capabilities.length ? row.capabilities.join(", ") : "[]"}
                    </td>
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        className="border px-2 py-0.5 rounded disabled:opacity-50"
                        onClick={() => void switchClinic(row.cl_id)}
                        disabled={isActive || switchingClId !== null}
                      >
                        {isSwitching ? "Switching..." : isActive ? "Active" : "Switch"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
