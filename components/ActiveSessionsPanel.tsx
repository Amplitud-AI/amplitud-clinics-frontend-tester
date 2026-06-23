"use client";

import {
  formatDeviceLabel,
  resolveLocalDeviceLabel,
} from "@/lib/sessions/formatDeviceLabel";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

export type ActiveSessionsPanelProps = {
  supabase: SupabaseClient | null;
  bearer: string | null;
  onLog: (title: string, body: string) => void;
};

type AuthSessionRow = {
  id: string;
  created_at: string;
  refreshed_at: string | null;
  updated_at: string | null;
  user_agent: string | null;
  ip: string | null;
  is_current: boolean;
  city: string | null;
  country: string | null;
  country_code: string | null;
};

type SessionGeoUpdate = {
  session_id?: string;
  city?: string | null;
  country?: string | null;
  country_code?: string | null;
};

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function isAuthSessionRow(value: unknown): value is AuthSessionRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.is_current === "boolean";
}

function parseSessionList(data: unknown): AuthSessionRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isAuthSessionRow);
}

function formatCountryLabel(row: AuthSessionRow): string {
  if (row.country?.trim()) return row.country.trim();
  if (row.country_code?.trim()) return row.country_code.trim();
  return "—";
}

function formatLocation(row: AuthSessionRow): string {
  const city = row.city?.trim();
  const country = formatCountryLabel(row);
  if (city && country !== "—") return `${city}, ${country}`;
  if (city) return city;
  if (country !== "—") return country;
  return "—";
}

function rowNeedsGeo(row: AuthSessionRow): boolean {
  return Boolean(row.ip?.trim()) && formatLocation(row) === "—";
}

function formatLocationDisplay(row: AuthSessionRow, awaitingGeo: boolean): string {
  const location = formatLocation(row);
  if (location !== "—") return location;
  if (awaitingGeo && row.ip?.trim()) return "Resolving…";
  return "—";
}

function mergeGeoUpdate(row: AuthSessionRow, geo: SessionGeoUpdate): AuthSessionRow {
  if (geo.session_id !== row.id) return row;
  return {
    ...row,
    city: geo.city ?? row.city,
    country: geo.country ?? row.country,
    country_code: geo.country_code ?? row.country_code,
  };
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso?.trim()) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function ActiveSessionsPanel({
  supabase,
  bearer,
  onLog,
}: ActiveSessionsPanelProps) {
  const [rows, setRows] = useState<AuthSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeToast, setRevokeToast] = useState<string | null>(null);
  const [localDeviceLabel, setLocalDeviceLabel] = useState<string | null>(null);
  const [awaitingGeo, setAwaitingGeo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveLocalDeviceLabel().then((label) => {
      if (!cancelled) setLocalDeviceLabel(label);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSessions = useCallback(async () => {
    if (!supabase) {
      setError("Configure NEXT_PUBLIC_SUPABASE_* in `.env`");
      return;
    }
    if (!bearer?.trim()) {
      setError("Sign in (Phase 0) to list sessions");
      setRows([]);
      setAwaitingGeo(false);
      return;
    }

    setLoading(true);
    setError(null);
    setRevokeToast(null);

    const { data, error: rpcError } = await supabase
      .schema("clinic")
      .rpc("list_my_auth_sessions");

    setLoading(false);

    if (rpcError) {
      const msg = rpcError.message || "list_my_auth_sessions failed";
      setError(msg);
      onLog("list_my_auth_sessions", pretty(rpcError));
      return;
    }

    const parsed = parseSessionList(data);
    setRows(parsed);
    setAwaitingGeo(parsed.some(rowNeedsGeo));
    onLog("list_my_auth_sessions", pretty(parsed));
  }, [bearer, onLog, supabase]);

  useEffect(() => {
    if (!bearer || !supabase) return;
    const id = window.setTimeout(() => {
      void loadSessions();
    }, 0);
    return () => window.clearTimeout(id);
  }, [bearer, loadSessions, supabase]);

  useEffect(() => {
    if (!supabase || !bearer) return;

    const channel = supabase
      .channel("session-geo-updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "clinic",
          table: "session_geo",
        },
        (payload) => {
          const geo = payload.new as SessionGeoUpdate;
          if (!geo.session_id) return;
          setRows((prev) => {
            const next = prev.map((row) => mergeGeoUpdate(row, geo));
            if (!next.some(rowNeedsGeo)) setAwaitingGeo(false);
            return next;
          });
          onLog("session_geo realtime", pretty(geo));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [bearer, onLog, supabase]);

  useEffect(() => {
    if (!awaitingGeo) return;
    const id = window.setTimeout(() => setAwaitingGeo(false), 30_000);
    return () => window.clearTimeout(id);
  }, [awaitingGeo]);

  const visibleRows = bearer ? rows : [];

  const revokeSession = useCallback(
    async (sessionId: string) => {
      if (!supabase || revokingId) return;
      setRevokeToast(null);
      setRevokingId(sessionId);

      const { error: rpcError } = await supabase
        .schema("clinic")
        .rpc("revoke_my_auth_session", { p_session_id: sessionId });

      setRevokingId(null);

      if (rpcError) {
        onLog("revoke_my_auth_session", pretty(rpcError));
        setError(rpcError.message || "Revoke failed");
        return;
      }

      setError(null);
      setRevokeToast("Session revoked. Remote device may stay signed in until its access token expires.");
      onLog("revoke_my_auth_session", `ok — revoked ${sessionId}`);
      await loadSessions();
    },
    [loadSessions, onLog, revokingId, supabase],
  );

  return (
    <section className="border border-zinc-300 dark:border-zinc-600 rounded p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Active sessions</h2>
          <p className="text-xs text-zinc-500">
            Lists your <code className="text-xs">auth.sessions</code> rows via{" "}
            <code className="text-xs">clinic.list_my_auth_sessions</code>. Revoke ends refresh on
            that device; use <strong>Log out here</strong> for this browser.
          </p>
        </div>
        <button
          type="button"
          className="border px-3 py-1 rounded"
          onClick={() => void loadSessions()}
          disabled={loading || !bearer}
        >
          {loading ? "Loading…" : "Refresh list"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-800 dark:text-red-200 flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            className="border border-red-400 px-2 py-0.5 rounded text-xs"
            onClick={() => void loadSessions()}
          >
            Retry
          </button>
        </div>
      )}

      {revokeToast && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">{revokeToast}</p>
      )}

      {!loading && !error && visibleRows.length === 0 && bearer && (
        <p className="text-xs text-zinc-500">No sessions returned (empty array).</p>
      )}

      {visibleRows.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b">
                <th className="py-1 pr-2">Device</th>
                <th className="py-1 pr-2">IP</th>
                <th className="py-1 pr-2">Location</th>
                <th className="py-1 pr-2">Signed in</th>
                <th className="py-1 pr-2">Last token refresh</th>
                <th className="py-1 pr-2"> </th>
                <th className="py-1 pr-2"> </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-2 align-top">
                    {row.is_current && localDeviceLabel
                      ? localDeviceLabel
                      : formatDeviceLabel(row.user_agent)}
                  </td>
                  <td className="py-2 pr-2 align-top font-mono">{row.ip ?? "—"}</td>
                  <td className="py-2 pr-2 align-top">
                    <span className={awaitingGeo && rowNeedsGeo(row) ? "text-zinc-400 italic" : undefined}>
                      {formatLocationDisplay(row, awaitingGeo)}
                    </span>
                  </td>
                  <td className="py-2 pr-2 align-top">{formatWhen(row.created_at)}</td>
                  <td className="py-2 pr-2 align-top">{formatWhen(row.refreshed_at)}</td>
                  <td className="py-2 pr-2 align-top">
                    {row.is_current ? (
                      <span className="inline-block rounded bg-sky-100 dark:bg-sky-900/40 px-2 py-0.5 text-sky-900 dark:text-sky-100">
                        This device
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 align-top">
                    {!row.is_current ? (
                      <button
                        type="button"
                        className="border border-amber-700 px-2 py-0.5 rounded text-amber-900 dark:text-amber-200"
                        disabled={revokingId === row.id}
                        onClick={() => void revokeSession(row.id)}
                      >
                        {revokingId === row.id ? "Revoking…" : "Revoke"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-zinc-500">
        Location is resolved by the auth hook via Edge Function after sign-in. This panel listens
        for updates automatically — no manual refresh needed. Approximate; VPNs and mobile carriers
        may show a different city or country.
      </p>
      <p className="text-xs text-zinc-500">
        Device labels for <strong>This device</strong> use User-Agent Client Hints when the browser
        supports them (Chrome/Edge on Windows 11, etc.). Other rows use the stored{" "}
        <code className="text-xs">user_agent</code> from sign-in, which may report Windows 10 for
        both Windows 10 and 11.
      </p>
      <p className="text-xs text-zinc-500">
        After revoke, the remote device may keep working until its access JWT expires; refresh is
        blocked immediately. Next navigation or <code className="text-xs">getUser()</code> on that
        device should fail.
      </p>
    </section>
  );
}
