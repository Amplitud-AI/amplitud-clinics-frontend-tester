"use client";

import { useCallback, useEffect, useState } from "react";
import { agnenticFetch, agPath } from "@/lib/agnentic";

const LS_PROVISION = "clinic_flow_clinic_provisioning_secret";

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

export type ProvisionSuccessPayload = {
  cl_id: string;
  slug: string;
  st_id: string;
};

export type OperatorClinicProvisionPanelProps = {
  /** Prefill admin email (e.g. logged-in Supabase user). */
  suggestedAdminEmail: string | null;
  onLog: (title: string, body: string) => void;
  /** After HTTP 201; parent can prefill Phase B and run smoke (may await refreshSession). */
  onProvisionSuccess?: (payload: ProvisionSuccessPayload) => void | Promise<void>;
};

/**
 * Calls Agnentic ``POST /admin/clinics`` (`provision_new_clinic`): derives ``cl_id`` from clinic
 * display name + creates org + first ``clinic_admin`` staff as ``pending_invite`` for ``admin_email``.
 *
 * Auth is **CLINIC_PROVISIONING_SECRET** (operator), not staff JWT — matches
 * `services/agents/conversational_agent/api/clinic_admin_api.py`.
 */
export default function OperatorClinicProvisionPanel({
  suggestedAdminEmail,
  onLog,
  onProvisionSuccess,
}: OperatorClinicProvisionPanelProps) {
  const [displayName, setDisplayName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [provisioningSecret, setProvisioningSecret] = useState("");
  const [lastProvisionClId, setLastProvisionClId] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      if (suggestedAdminEmail?.trim() && !adminEmail.trim()) {
        setAdminEmail(suggestedAdminEmail.trim());
      }
    });
  }, [suggestedAdminEmail, adminEmail]);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const s = localStorage.getItem(LS_PROVISION);
        if (s) setProvisioningSecret(s);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const saveSecretLocal = useCallback(() => {
    try {
      localStorage.setItem(LS_PROVISION, provisioningSecret);
      onLog("Provisioning secret", "Stored in localStorage — dev only; rotate if this machine is shared.");
    } catch (e) {
      onLog("Provisioning secret save failed", String(e));
    }
  }, [provisioningSecret, onLog]);

  const provisionClinic = async () => {
    const name = displayName.trim();
    const email = adminEmail.trim();
    const secret = provisioningSecret.trim();
    if (!name) {
      onLog("provision clinic", "Enter clinic display_name (drives slug → cl_id).");
      return;
    }
    if (!email) {
      onLog("provision clinic", "Enter admin_email — must match the email you used in Phase 0.");
      return;
    }
    if (!secret) {
      onLog("provision clinic", "Paste CLINIC_PROVISIONING_SECRET (same value as Agnentic server env).");
      return;
    }
    const path = agPath("/admin/clinics");
    onLog("POST /admin/clinics", `display_name=${JSON.stringify(name)} admin_email=${JSON.stringify(email)}`);
    const r = await agnenticFetch(path, {
      method: "POST",
      bearer: secret,
      body: JSON.stringify({ display_name: name, admin_email: email }),
    });
    onLog(`provision clinic (${r.status})`, r.json != null ? pretty(r.json) : r.text);
    if (r.ok && r.json && typeof r.json === "object") {
      const row = r.json as Record<string, unknown>;
      const cid = row.cl_id;
      const slug = row.slug;
      const st_id = row.st_id;
      if (typeof cid === "string" && typeof slug === "string" && typeof st_id === "string") {
        setLastProvisionClId(cid);
        void Promise.resolve(onProvisionSuccess?.({ cl_id: cid, slug, st_id }));
      } else {
        setLastProvisionClId(typeof cid === "string" ? cid : null);
      }
    } else {
      setLastProvisionClId(null);
    }
  };

  return (
    <section className="border border-amber-300 dark:border-amber-700 rounded p-4 space-y-3 bg-amber-50/40 dark:bg-amber-950/20">
      <h2 className="font-medium">Phase A — Create clinic tenant (operator provisioning)</h2>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Run after <strong>Phase 0</strong> so <code className="text-xs">admin_email</code> matches your signed-in
        user.{" "}
        <code className="text-xs">agnentic_platform.clinic_provisioning.provision_new_clinic</code>: allocates
        slug from <strong>display name</strong>, writes <code className="text-xs">cl_id</code>, org, and first
        staff row (<code className="text-xs">pending_invite</code>). Requires{" "}
        <code className="text-xs">Authorization: Bearer {"<CLINIC_PROVISIONING_SECRET>"}</code>
        — never put that in <code className="text-xs">NEXT_PUBLIC_*</code>; paste below for local testing only.
      </p>
      <p className="text-xs text-zinc-600">
        On success, <strong>Phase B</strong> is prefilled with <code className="text-xs">cl_id</code> and smoke runs if
        Phase 0 session exists. After the hook links <code className="text-xs">supabase_auth_user_id</code>, sign out
        and repeat <strong>Phase 0</strong> if you need <code className="text-xs">app_metadata.cl_id</code> on the JWT.
      </p>

      <input
        className="border px-2 py-1 w-full"
        placeholder='Clinic display name (e.g. "Acme Dental")'
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <input
        className="border px-2 py-1 w-full font-mono text-xs"
        type="email"
        placeholder="Admin email (same as Phase 0 sign-in)"
        value={adminEmail}
        onChange={(e) => setAdminEmail(e.target.value)}
      />
      <input
        type="password"
        autoComplete="off"
        className="border px-2 py-1 w-full font-mono text-xs"
        placeholder="CLINIC_PROVISIONING_SECRET (server env, not publishable)"
        value={provisioningSecret}
        onChange={(e) => setProvisioningSecret(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="border px-3 py-1 rounded" onClick={() => void provisionClinic()}>
          POST /admin/clinics
        </button>
        <button type="button" className="border px-2 py-1 text-xs rounded" onClick={saveSecretLocal}>
          Save secret locally
        </button>
      </div>
      {lastProvisionClId && (
        <p className="text-xs font-mono">
          Last <code className="text-xs">cl_id</code>: {lastProvisionClId}
        </p>
      )}
    </section>
  );
}
