 "use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/config";

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

type PatientRow = {
  pt_id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  status?: string | null;
  preferred_provider_display_name?: string | null;
};

type StaffRow = {
  st_id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  status?: string | null;
};

function patientLabel(p: PatientRow): string {
  const d = (p.display_name ?? "").trim();
  if (d) return `${d} (${p.pt_id})`;
  const n = `${(p.first_name ?? "").trim()} ${(p.last_name ?? "").trim()}`.trim();
  return n || p.pt_id;
}

function staffLabel(s: StaffRow): string {
  const display = (s.display_name ?? "").trim();
  if (display) return `${display} (${s.st_id})`;
  const n = `${(s.first_name ?? "").trim()} ${(s.last_name ?? "").trim()}`.trim();
  return (n || s.email || s.st_id).trim();
}

function staffPreferredLabel(s: StaffRow): string {
  return (s.display_name ?? (s.first_name ?? "") + " " + (s.last_name ?? "")).trim() || (s.email ?? "");
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

function parsePatientRow(raw: unknown): PatientRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.pt_id === "string" ? o.pt_id : "";
  if (!id) return null;
  return {
    pt_id: id,
    display_name: typeof o.display_name === "string" ? o.display_name : null,
    first_name: typeof o.first_name === "string" ? o.first_name : null,
    last_name: typeof o.last_name === "string" ? o.last_name : null,
    status: typeof o.status === "string" ? o.status : null,
    preferred_provider_display_name:
      typeof o.preferred_provider_display_name === "string"
        ? o.preferred_provider_display_name
        : null,
  };
}

function parseStaffRow(raw: unknown): StaffRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.st_id === "string" ? o.st_id : "";
  if (!id) return null;
  return {
    st_id: id,
    display_name: typeof o.display_name === "string" ? o.display_name : null,
    first_name: typeof o.first_name === "string" ? o.first_name : null,
    last_name: typeof o.last_name === "string" ? o.last_name : null,
    email: typeof o.email === "string" ? o.email : null,
    status: typeof o.status === "string" ? o.status : null,
  };
}

export type PatientPreferredDoctorPanelProps = {
  bearer: string | null;
  effectiveClId: string;
  onLog: (title: string, body: string) => void;
};

export default function PatientPreferredDoctorPanel({
  bearer,
  effectiveClId,
  onLog,
}: PatientPreferredDoctorPanelProps) {
  const anon = getSupabaseAnonKey();
  const token = bearer?.trim() ?? "";
  const cid = effectiveClId.trim();

  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedPtId, setSelectedPtId] = useState("");
  const [selectedStId, setSelectedStId] = useState("");
  const [result, setResult] = useState("");

  const canClinicWrite = Boolean(token && anon);

  const activePatients = useMemo(
    () => patients.filter((p) => String(p.pt_id ?? "").trim()),
    [patients],
  );
  const activeStaff = useMemo(() => staff.filter((s) => String(s.st_id ?? "").trim()), [staff]);
  const selectedPatient = useMemo(
    () => patients.find((p) => p.pt_id === selectedPtId),
    [patients, selectedPtId],
  );
  const selectedStaff = useMemo(
    () => staff.find((s) => s.st_id === selectedStId),
    [staff, selectedStId],
  );

  const hasSelections = Boolean(selectedPtId && selectedStId);

  const refresh = useCallback(async () => {
    if (!canClinicWrite || !cid) {
      onLog("patient preferred doctor", "Need phase 0 session + anon key + tenant cl_id.");
      return;
    }
    setBusy(true);
    setResult("loading...");
    try {
      const pQuery =
        "select=pt_id,display_name,first_name,last_name,status,preferred_provider_display_name"
        + `&cl_id=eq.${encodeURIComponent(cid)}&order=created_at.desc&limit=200`;
      const patientsResp = await clinicRest("GET", `rest/v1/patients?${pQuery}`, {
        bearer: token,
        anon,
      });
      if (!patientsResp.ok) {
        onLog("GET patients", pretty(patientsResp.json));
        setResult(`patients read failed (${patientsResp.status})`);
        return;
      }
      const patientRows = Array.isArray(patientsResp.json)
        ? patientsResp.json.map(parsePatientRow).filter((r): r is PatientRow => r != null)
        : [];
      setPatients(patientRows);

      const staffQuery =
        "select=st_id,display_name,first_name,last_name,email,status"
        + `&cl_id=eq.${encodeURIComponent(cid)}&order=created_at.desc&limit=200`;
      const staffResp = await clinicRest("GET", `rest/v1/staff?${staffQuery}`, {
        bearer: token,
        anon,
      });
      if (!staffResp.ok) {
        onLog("GET staff", pretty(staffResp.json));
        setResult(`staff read failed (${staffResp.status})`);
        return;
      }
      const staffRows = Array.isArray(staffResp.json)
        ? staffResp.json.map(parseStaffRow).filter((r): r is StaffRow => r != null)
        : [];
      setStaff(staffRows);
      setResult(`loaded ${patientRows.length} patients, ${staffRows.length} staff`);
      onLog("patient preferred doctor lists", `${patientRows.length} patients, ${staffRows.length} staff`);
    } finally {
      setBusy(false);
    }
  }, [anon, canClinicWrite, cid, onLog, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const setPreferred = useCallback(async () => {
    if (!hasSelections || !selectedPtId || !selectedStId || !selectedStaff) return;
    if (!canClinicWrite) {
      onLog("PATCH patients", "Need phase 0 session + anon key.");
      return;
    }

    const value = staffPreferredLabel(selectedStaff);
    if (!value.trim()) {
      onLog("PATCH patients", "Selected staff has no stable display text.");
      return;
    }

    const preferred = JSON.stringify({
      preferred_provider_display_name: value.trim(),
    });
    const r = await clinicRest(
      "PATCH",
      `rest/v1/patients?pt_id=eq.${encodeURIComponent(selectedPtId)}&cl_id=eq.${encodeURIComponent(cid)}`,
      { bearer: token, anon, body: preferred, prefer: "return=representation" },
    );
    onLog(`PATCH patient preferred doctor (${r.status})`, pretty(r.json));
    if (!r.ok) {
      setResult(`save failed (${r.status})`);
      return;
    }
    const updated = Array.isArray(r.json)
      ? (r.json[0] as Record<string, unknown>)
      : (r.json as Record<string, unknown>);
    const nextRow = parsePatientRow(updated);
    if (nextRow) {
      setPatients((curr) => curr.map((p) => (p.pt_id === nextRow.pt_id ? nextRow : p)));
      setResult(`saved ${patientLabel(nextRow)} → ${nextRow.preferred_provider_display_name || value}`);
    } else {
      setResult("saved");
      await refresh();
    }
  }, [cid, canClinicWrite, hasSelections, onLog, refresh, selectedPtId, selectedStaff, selectedStId, anon, token]);

  const clearPreferred = useCallback(async () => {
    if (!selectedPtId) return;
    if (!canClinicWrite) {
      onLog("PATCH patients", "Need phase 0 session + anon key.");
      return;
    }
    const clear = JSON.stringify({
      preferred_provider_display_name: null,
    });
    const r = await clinicRest(
      "PATCH",
      `rest/v1/patients?pt_id=eq.${encodeURIComponent(selectedPtId)}&cl_id=eq.${encodeURIComponent(cid)}`,
      { bearer: token, anon, body: clear, prefer: "return=representation" },
    );
    onLog(`PATCH clear preferred doctor (${r.status})`, pretty(r.json));
    if (!r.ok) {
      setResult(`clear failed (${r.status})`);
      return;
    }
    setResult("cleared");
    await refresh();
  }, [canClinicWrite, selectedPtId, onLog, anon, token, cid, refresh]);

  return (
    <section className="border border-zinc-300 rounded p-4 space-y-3">
      <h2 className="font-medium">Preferred doctor for patient (clinic-level)</h2>
      <p className="text-xs text-zinc-500">
        Updates <code>clinic.patients.preferred_provider_display_name</code> for the chosen patient.
      </p>

      <button type="button" className="border px-3 py-1 rounded" onClick={() => void refresh()} disabled={busy}>
        {busy ? "Loading..." : "Load patients & staff"}
      </button>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs text-zinc-600">Patient</span>
          <select
            className="border px-2 py-1 w-full"
            value={selectedPtId}
            onChange={(e) => setSelectedPtId(e.target.value)}
          >
            <option value="">Select patient</option>
            {activePatients.map((p) => (
              <option key={p.pt_id} value={p.pt_id}>
                {patientLabel(p)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-zinc-600">Preferred doctor (from staff)</span>
          <select
            className="border px-2 py-1 w-full"
            value={selectedStId}
            onChange={(e) => setSelectedStId(e.target.value)}
          >
            <option value="">Select staff</option>
            {activeStaff.map((s) => (
              <option key={s.st_id} value={s.st_id}>
                {staffLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="text-xs">
        <div>
          Current preferred:{" "}
          <strong>{selectedPatient?.preferred_provider_display_name?.trim() || "(not set)"}</strong>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="border px-3 py-1 rounded disabled:opacity-50"
          onClick={() => void setPreferred()}
          disabled={!hasSelections}
        >
          Assign preferred doctor
        </button>
        <button
          type="button"
          className="border px-3 py-1 rounded disabled:opacity-50"
          onClick={() => void clearPreferred()}
          disabled={!selectedPtId}
        >
          Clear preferred doctor
        </button>
      </div>

      <div className="text-xs text-zinc-500">{result}</div>
    </section>
  );
}
