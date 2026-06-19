"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agPath } from "@/lib/agnentic";
import { getAgnenticBaseUrl, getSupabaseAnonKey, getSupabaseUrl } from "@/lib/config";
import {
  deriveEntityTypeSlugForClinicQueue,
  entityTypeFromProjectionMetadata,
  humanizeEntityTypeSlug,
} from "@/lib/knowledgeEntityTypeDisplay";
import { generatePublicPtId } from "@/lib/publicPtId";

const LS_INTERNAL_KEY = "clinic_flow_internal_service_key";
/** Rough guard: very large payloads can fail PostgREST / DB limits */
const MAX_INLINE_TEXT_CHARS = 1_400_000;

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
};

function patientPickerLabel(p: PatientRow): string {
  const d = (p.display_name ?? "").trim();
  if (d) return d;
  const fn = (p.first_name ?? "").trim();
  const ln = (p.last_name ?? "").trim();
  const n = `${fn} ${ln}`.trim();
  if (n) return n;
  return p.pt_id;
}

type KnowledgeProjectionListRow = {
  doc_id: string;
  title: string;
  status: string | null;
  source_uri: string | null;
  source_type: string | null;
  metadata: unknown;
  last_synced_at: string | null;
};

function firstInsertedRow(json: unknown): Record<string, unknown> | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const r = json[0];
  if (r && typeof r === "object" && !Array.isArray(r)) return r as Record<string, unknown>;
  return null;
}

function parsePayloadObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: true, value: {} };
  try {
    const v = JSON.parse(t) as unknown;
    if (v == null || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "Payload JSON must be a single object ({ … }), not an array or primitive." };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${String(e)}` };
  }
}

async function clinicPostgrest(
  method: string,
  path: string,
  opts: { bearer: string; anon: string; body?: string; prefer?: string },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const baseUrl = getSupabaseUrl().replace(/\/$/, "");
  const rel = path.replace(/^\//, "");
  const url = `${baseUrl}/${rel}`;
  const headers: Record<string, string> = {
    apikey: opts.anon,
    Authorization: `Bearer ${opts.bearer.trim()}`,
    Accept: "application/json",
    "Accept-Profile": "clinic",
    "Content-Profile": "clinic",
  };
  if (opts.body != null) headers["Content-Type"] = "application/json";
  if (opts.prefer?.trim()) headers.Prefer = opts.prefer.trim();
  const res = await fetch(url, { method, headers, body: opts.body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function agFormPost(
  path: string,
  form: FormData,
  bearer: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const base = getAgnenticBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  const headers = new Headers();
  const t = bearer.trim();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(url, { method: "POST", headers, body: form });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function agJsonPost(
  path: string,
  body: unknown,
  bearer: string | null,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const base = getAgnenticBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  const t = bearer?.trim();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v) headers.set(k, v);
    }
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function fetchKnowledgeTest(): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> {
  const path = agPath("/knowledge/test");
  const base = getAgnenticBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json, text };
}

export type KnowledgeRagPanelProps = {
  bearer: string | null;
  effectiveClId: string;
  onLog: (title: string, body: string) => void;
};

export default function KnowledgeRagPanel({
  bearer,
  effectiveClId,
  onLog,
}: KnowledgeRagPanelProps) {
  const token = bearer?.trim() ?? "";
  const cid = effectiveClId.trim();
  const anon = getSupabaseAnonKey();

  const [ptId, setPtId] = useState("default");
  const [fileType, setFileType] = useState("");
  const [skipGraph, setSkipGraph] = useState(true);
  const [ingestUrl, setIngestUrl] = useState("https://example.com/clinic-handbook.txt");
  const [urlTitle, setUrlTitle] = useState("Tester URL knowledge");
  const [internalKey, setInternalKey] = useState("");
  const [busy, setBusy] = useState(false);
  const clinicFileInputRef = useRef<HTMLInputElement>(null);
  const [clinicChosenFileName, setClinicChosenFileName] = useState<string | null>(null);

  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [projectionRows, setProjectionRows] = useState<KnowledgeProjectionListRow[]>([]);
  const [newPatientDisplay, setNewPatientDisplay] = useState("");
  const [newPatientFirst, setNewPatientFirst] = useState("");
  const [newPatientLast, setNewPatientLast] = useState("");
  /** Empty = clinic-wide knowledge (platform ``pt_id`` = default). Non-empty = ``target_pt_id`` on queue row. */
  const [queueTargetPtId, setQueueTargetPtId] = useState("");
  const [baselineQueueTargetPtId, setBaselineQueueTargetPtId] = useState("");

  /** Last clinic queue row for operator review (PATCH draft) before F3 consume. */
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [stagingSourceUri, setStagingSourceUri] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [payloadEditor, setPayloadEditor] = useState("");
  const [baselineTitle, setBaselineTitle] = useState("");
  const [baselinePayloadEditor, setBaselinePayloadEditor] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const k = localStorage.getItem(LS_INTERNAL_KEY);
        if (k) setInternalKey(k);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const persistInternalKey = (v: string) => {
    setInternalKey(v);
    try {
      if (v.trim()) localStorage.setItem(LS_INTERNAL_KEY, v.trim());
      else localStorage.removeItem(LS_INTERNAL_KEY);
    } catch {
      /* ignore */
    }
  };

  const canClinicQueue = Boolean(token && anon && cid);
  const canTenantIngest = Boolean(token && cid);
  const canConsumeQueue = Boolean(internalKey.trim() && cid);

  const loadStagingFromRow = useCallback((row: Record<string, unknown>) => {
    const id = typeof row.id === "string" && row.id ? row.id : null;
    if (!id) return;
    const title =
      typeof row.title === "string"
        ? row.title
        : row.title != null && String(row.title).trim()
          ? String(row.title)
          : "";
    const rawPayload = row.payload;
    const pObj =
      rawPayload != null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};
    const pText = pretty(pObj);
    const su = row.source_uri;
    const tpt = row.target_pt_id;
    const q =
      typeof tpt === "string" && tpt.trim()
        ? tpt.trim()
        : "";
    setStagingId(id);
    setStagingSourceUri(typeof su === "string" && su ? su : null);
    setEditTitle(title);
    setPayloadEditor(pText);
    setBaselineTitle(title);
    setBaselinePayloadEditor(pText);
    setQueueTargetPtId(q);
    setBaselineQueueTargetPtId(q);
  }, []);

  const clearStaging = useCallback(() => {
    setStagingId(null);
    setStagingSourceUri(null);
    setEditTitle("");
    setPayloadEditor("");
    setBaselineTitle("");
    setBaselinePayloadEditor("");
    setBaselineQueueTargetPtId("");
  }, []);

  const stagingDirty =
    stagingId != null &&
    (editTitle.trim() !== baselineTitle.trim() ||
      payloadEditor !== baselinePayloadEditor ||
      queueTargetPtId.trim() !== baselineQueueTargetPtId.trim());

  const parsedPayloadForSave = parsePayloadObject(payloadEditor);

  const postConsumeClinicKnowledge = useCallback(
    async (requestType: "upload" | "delete_request") => {
      if (!canConsumeQueue) return { ok: false as const, status: 0, json: null, text: "" };
      const path = agPath("/admin/clinic-requests/consume/knowledge");
      return agJsonPost(
        path,
        { cl_id: cid, request_type: requestType },
        null,
        {
          "X-Internal-Service-Key": internalKey.trim(),
        },
      );
    },
    [canConsumeQueue, cid, internalKey],
  );

  const refreshPatients = useCallback(async () => {
    if (!canClinicQueue) {
      onLog("Clinic patients — list", "Need Bearer + anon + cl_id.");
      return;
    }
    setBusy(true);
    try {
      const sel = encodeURIComponent("pt_id,display_name,first_name,last_name,status,created_at");
      const r = await clinicPostgrest(
        "GET",
        `rest/v1/patients?cl_id=eq.${encodeURIComponent(cid)}&select=${sel}&order=created_at.desc`,
        { bearer: token, anon },
      );
      if (!r.ok) {
        onLog(`Clinic GET patients (${r.status})`, pretty(r.json));
        return;
      }
      const rows = Array.isArray(r.json) ? r.json : [];
      const list: PatientRow[] = [];
      for (const x of rows) {
        if (x == null || typeof x !== "object" || Array.isArray(x)) continue;
        const o = x as Record<string, unknown>;
        const id = typeof o.pt_id === "string" ? o.pt_id : "";
        if (!id) continue;
        list.push({
          pt_id: id,
          display_name: typeof o.display_name === "string" ? o.display_name : null,
          first_name: typeof o.first_name === "string" ? o.first_name : null,
          last_name: typeof o.last_name === "string" ? o.last_name : null,
          status: typeof o.status === "string" ? o.status : null,
        });
      }
      setPatients(list);
      onLog(`Clinic GET patients (${r.status})`, `${list.length} row(s).`);
    } finally {
      setBusy(false);
    }
  }, [anon, canClinicQueue, cid, onLog, token]);

  const createPatient = useCallback(async () => {
    if (!canClinicQueue) {
      onLog("Clinic patients — create", "Need Bearer + anon + cl_id.");
      return false;
    }
    let pt_id: string;
    try {
      pt_id = generatePublicPtId(cid);
    } catch (e) {
      onLog("Clinic patients — create", String(e));
      return false;
    }
    const body: Record<string, unknown> = {
      pt_id,
      cl_id: cid,
      status: "active",
    };
    const dn = newPatientDisplay.trim();
    const fn = newPatientFirst.trim();
    const ln = newPatientLast.trim();
    if (dn) body.display_name = dn;
    if (fn) body.first_name = fn;
    if (ln) body.last_name = ln;
    setBusy(true);
    try {
      const r = await clinicPostgrest("POST", "rest/v1/patients", {
        bearer: token,
        anon,
        body: JSON.stringify(body),
        prefer: "return=representation",
      });
      if (r.ok) {
        onLog(`Clinic POST patients (${r.status})`, pretty(r.json));
        await refreshPatients();
        return true;
      }
      onLog(`Clinic POST patients (${r.status})`, pretty(r.json));
      return false;
    } finally {
      setBusy(false);
    }
  }, [
    anon,
    canClinicQueue,
    cid,
    newPatientDisplay,
    newPatientFirst,
    newPatientLast,
    onLog,
    refreshPatients,
    token,
  ]);

  /** Real clinic onboarding path: INSERT knowledge_change_requests (admin JWT + RLS). */
  const enqueueFileRequest = useCallback(async () => {
    if (!canClinicQueue) {
      onLog(
        "Clinic knowledge — enqueue",
        "Need Phase 0 Bearer + anon key + Phase B cl_id. Inserts require **clinic_admin** JWT (RLS `knowledge_change_requests_admin_insert`).",
      );
      return false;
    }
    const file = clinicFileInputRef.current?.files?.[0];
    if (!file) {
      onLog("Clinic knowledge — enqueue", "Choose a file first.");
      return false;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const textLike = ["txt", "md", "csv", "json", "html", "htm"].includes(ext);
    if (!textLike) {
      onLog(
        "Clinic knowledge — enqueue",
        `Inline queue path only reads text in-browser. For .${ext}, upload to Supabase Storage, put a public/signed **https** URL in the URL field below, or use **Advanced → F1** (dashboard JWT).`,
      );
      return false;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      onLog("Clinic knowledge — enqueue", `Could not read file as text: ${String(e)}`);
      return false;
    }
    if (text.length > MAX_INLINE_TEXT_CHARS) {
      onLog(
        "Clinic knowledge — enqueue",
        `File too large for inline payload (${text.length} chars). Use an https source_uri (Storage) or Advanced F1.`,
      );
      return false;
    }
    const row: Record<string, unknown> = {
      cl_id: cid,
      request_type: "upload",
      title: file.name.slice(0, 256) || "clinic_upload",
      source_type: "clinic_document",
      payload: { text, source_filename: file.name },
    };
    if (queueTargetPtId.trim()) row.target_pt_id = queueTargetPtId.trim();
    const r = await clinicPostgrest("POST", "rest/v1/knowledge_change_requests", {
      bearer: token,
      anon,
      body: JSON.stringify(row),
      prefer: "return=representation",
    });
    if (r.ok) {
      const ins = firstInsertedRow(r.json);
      if (ins) loadStagingFromRow(ins);
      onLog(
        `Clinic POST knowledge_change_requests (${r.status})`,
        `Pending row created — **review payload below**, **Save draft** if you edited, then **Confirm ingest (F3→F4)** when INTERNAL_SERVICE_KEY is set.\n${pretty(r.json)}`,
      );
    } else {
      onLog(`Clinic POST knowledge_change_requests (${r.status})`, pretty(r.json));
    }
    return r.ok;
  }, [anon, canClinicQueue, cid, loadStagingFromRow, onLog, queueTargetPtId, token]);

  const enqueueUrlRequest = useCallback(async () => {
    if (!canClinicQueue) {
      onLog("Clinic knowledge — URL enqueue", "Need Bearer + anon + cl_id.");
      return false;
    }
    const u = ingestUrl.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      onLog("Clinic knowledge — URL enqueue", "source_uri must be http(s).");
      return false;
    }
    const row: Record<string, unknown> = {
      cl_id: cid,
      request_type: "upload",
      title: urlTitle.trim() || "clinic_url_ingest",
      source_type: "clinic_document",
      source_uri: u,
      payload: {},
    };
    if (queueTargetPtId.trim()) row.target_pt_id = queueTargetPtId.trim();
    const r = await clinicPostgrest("POST", "rest/v1/knowledge_change_requests", {
      bearer: token,
      anon,
      body: JSON.stringify(row),
      prefer: "return=representation",
    });
    if (r.ok) {
      const ins = firstInsertedRow(r.json);
      if (ins) loadStagingFromRow(ins);
      onLog(
        `Clinic POST knowledge_change_requests URL (${r.status})`,
        `Pending URL row — edit **payload** (e.g. add \`"text"\` to override download) if needed, **Save draft**, then **Confirm ingest**.\n${pretty(r.json)}`,
      );
    } else {
      onLog(`Clinic POST knowledge_change_requests URL (${r.status})`, pretty(r.json));
    }
    return r.ok;
  }, [anon, canClinicQueue, cid, ingestUrl, loadStagingFromRow, onLog, queueTargetPtId, token, urlTitle]);

  const saveClinicDraft = useCallback(async () => {
    if (!canClinicQueue || !stagingId) {
      onLog("Clinic — save draft", "Enqueue a file or URL request first (staging row id required).");
      return;
    }
    const parsed = parsePayloadObject(payloadEditor);
    if (!parsed.ok) {
      onLog("Clinic — save draft", parsed.error);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        title: editTitle.trim() || null,
        payload: parsed.value,
        target_pt_id: queueTargetPtId.trim() || null,
      };
      const r = await clinicPostgrest(
        "PATCH",
        `rest/v1/knowledge_change_requests?id=eq.${encodeURIComponent(stagingId)}`,
        {
          bearer: token,
          anon,
          body: JSON.stringify(body),
          prefer: "return=representation",
        },
      );
      if (r.ok) {
        const row = firstInsertedRow(r.json);
        if (row) loadStagingFromRow(row);
        onLog(`Clinic PATCH knowledge_change_requests (${r.status})`, pretty(r.json));
      } else {
        onLog(
          `Clinic PATCH knowledge_change_requests (${r.status})`,
          `${pretty(r.json)}\n\nIf you see 401/403, the clinic DB may be missing **UPDATE** for admins on pending rows. Apply **agnentic_platform** migration \`23_knowledge_change_requests_admin_pending_update.sql\` (GRANT UPDATE + policy \`knowledge_change_requests_admin_update_pending\`).`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [
    anon,
    canClinicQueue,
    editTitle,
    loadStagingFromRow,
    onLog,
    payloadEditor,
    stagingId,
    token,
    queueTargetPtId,
  ]);

  const refreshStagingFromClinic = useCallback(async () => {
    if (!canClinicQueue || !stagingId) {
      onLog("Clinic — refresh staging", "No staged request id — enqueue first.");
      return;
    }
    setBusy(true);
    try {
      const r = await clinicPostgrest(
        "GET",
        `rest/v1/knowledge_change_requests?id=eq.${encodeURIComponent(stagingId)}&select=%2A`,
        { bearer: token, anon },
      );
      if (r.ok) {
        const row = firstInsertedRow(r.json);
        if (row) loadStagingFromRow(row);
        onLog(`Clinic GET knowledge_change_requests (${r.status})`, pretty(r.json));
      } else {
        onLog(`Clinic GET knowledge_change_requests (${r.status})`, pretty(r.json));
      }
    } finally {
      setBusy(false);
    }
  }, [anon, canClinicQueue, loadStagingFromRow, onLog, stagingId, token]);

  const refreshKnowledgeProjection = useCallback(async () => {
    if (!canClinicQueue) {
      onLog("Clinic knowledge — projection list", "Need Bearer + anon + cl_id.");
      return;
    }
    setBusy(true);
    try {
      const sel = encodeURIComponent(
        "doc_id,title,status,metadata,source_uri,source_type,last_synced_at,updated_at",
      );
      const r = await clinicPostgrest(
        "GET",
        `rest/v1/knowledge_documents_projection?cl_id=eq.${encodeURIComponent(cid)}&select=${sel}&order=updated_at.desc`,
        { bearer: token, anon },
      );
      if (!r.ok) {
        onLog(`Clinic GET knowledge_documents_projection (${r.status})`, pretty(r.json));
        return;
      }
      const rows = Array.isArray(r.json) ? r.json : [];
      const list: KnowledgeProjectionListRow[] = [];
      for (const x of rows) {
        if (x == null || typeof x !== "object" || Array.isArray(x)) continue;
        const o = x as Record<string, unknown>;
        const doc_id = typeof o.doc_id === "string" ? o.doc_id : "";
        if (!doc_id) continue;
        list.push({
          doc_id,
          title: typeof o.title === "string" ? o.title : "",
          status: typeof o.status === "string" ? o.status : null,
          source_uri: typeof o.source_uri === "string" ? o.source_uri : null,
          source_type: typeof o.source_type === "string" ? o.source_type : null,
          metadata: o.metadata,
          last_synced_at: typeof o.last_synced_at === "string" ? o.last_synced_at : null,
        });
      }
      setProjectionRows(list);
      onLog(`Clinic GET knowledge_documents_projection (${r.status})`, `${list.length} row(s).`);
    } finally {
      setBusy(false);
    }
  }, [anon, canClinicQueue, cid, onLog, token]);

  const enqueueDeleteForDoc = useCallback(
    async (docId: string, titleHint: string, entityTypeHint: string | null) => {
      if (!canClinicQueue) {
        onLog("Clinic knowledge — delete enqueue", "Need Bearer + anon + cl_id.");
        return false;
      }
      setBusy(true);
      try {
        const row: Record<string, unknown> = {
          cl_id: cid,
          request_type: "delete_request",
          title: `delete:${(titleHint || "doc").trim().slice(0, 220)}`,
          source_type: "clinic_document",
          payload: {
            target_doc_id: docId,
            target_entity_type: entityTypeHint ?? undefined,
          },
        };
        if (queueTargetPtId.trim()) {
          row.target_pt_id = queueTargetPtId.trim();
        }
        const r = await clinicPostgrest("POST", "rest/v1/knowledge_change_requests", {
          bearer: token,
          anon,
          body: JSON.stringify(row),
          prefer: "return=representation",
        });
        if (r.ok) {
          onLog(
            `Clinic POST delete_request (${r.status})`,
            `Pending delete queued for **${docId}**. Set **Knowledge scope** first if this doc was patient-scoped on ingest. Then use **Confirm delete (F3→F4)** in the projection header so the worker tears down main DB rows and archives this projection.\n${pretty(r.json)}`,
          );
          return true;
        }
        onLog(`Clinic POST delete_request (${r.status})`, pretty(r.json));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [anon, canClinicQueue, cid, onLog, queueTargetPtId, token],
  );

  const runKnowledgeVerificationAndLog = useCallback(async () => {
    const v = await fetchKnowledgeTest();
    onLog(
      `F4 Knowledge verification (${v.status})`,
      v.json != null ? pretty(v.json) : v.text,
    );
  }, [onLog]);

  const runConsumeUploadsOnly = useCallback(async () => {
    if (!canConsumeQueue) {
      onLog(
        "Clinic worker — ingest (F3)",
        "Set INTERNAL_SERVICE_KEY (matches Agnentic env). This applies **pending upload** rows only.",
      );
      return;
    }
    if (stagingId && stagingDirty) {
      onLog(
        "Clinic worker — ingest (F3)",
        "Staging has unsaved edits — **Save draft** first so Supabase matches what you approve before ingest.",
      );
      return;
    }
    setBusy(true);
    try {
      const r = await postConsumeClinicKnowledge("upload");
      onLog(
        `F3 ingest consume/knowledge (${r.status})`,
        `${r.json != null ? pretty(r.json) : r.text}\n\n(request_type=upload — pending **delete_request** rows are left for **Confirm delete**.)`,
      );
      if (r.ok) {
        await runKnowledgeVerificationAndLog();
        await refreshKnowledgeProjection();
      }
    } finally {
      setBusy(false);
    }
  }, [
    canConsumeQueue,
    onLog,
    postConsumeClinicKnowledge,
    refreshKnowledgeProjection,
    runKnowledgeVerificationAndLog,
    stagingDirty,
    stagingId,
  ]);

  const runConsumeDeletesOnly = useCallback(async () => {
    if (!canConsumeQueue) {
      onLog(
        "Clinic worker — delete (F3)",
        "Set INTERNAL_SERVICE_KEY (matches Agnentic env). This applies **pending delete_request** rows only.",
      );
      return;
    }
    setBusy(true);
    try {
      const r = await postConsumeClinicKnowledge("delete_request");
      onLog(
        `F3 delete consume/knowledge (${r.status})`,
        `${r.json != null ? pretty(r.json) : r.text}\n\n(request_type=delete_request — pending **upload** rows are left for **Confirm ingest**.)`,
      );
      if (r.ok) {
        await runKnowledgeVerificationAndLog();
        await refreshKnowledgeProjection();
      }
    } finally {
      setBusy(false);
    }
  }, [
    canConsumeQueue,
    onLog,
    postConsumeClinicKnowledge,
    refreshKnowledgeProjection,
    runKnowledgeVerificationAndLog,
  ]);

  const postTenantFile = useCallback(async () => {
    if (!canTenantIngest) {
      onLog(
        "Advanced F1",
        "Need Phase 0 Bearer + tenant cl_id. Requires dashboard JWT (**dashboard_role**) with world_state:write — not clinic hook only.",
      );
      return;
    }
    const input = document.getElementById(
      "knowledge-rag-advanced-file",
    ) as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      onLog("Advanced F1", "Choose a file first.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    if (fileType.trim()) form.append("file_type", fileType.trim());
    form.append("pt_id", ptId.trim() || "default");
    if (skipGraph) form.append("skip_graph", "true");
    const path = agPath(`/knowledge/organizations/${encodeURIComponent(cid)}/ingest-file`);
    onLog("F1 POST ingest-file", `${path}`);
    const r = await agFormPost(path, form, token);
    onLog(`F1 POST ingest-file (${r.status})`, r.json != null ? pretty(r.json) : r.text);
    if (r.ok) await runKnowledgeVerificationAndLog();
  }, [canTenantIngest, cid, fileType, onLog, ptId, runKnowledgeVerificationAndLog, skipGraph, token]);

  const postTenantUrl = useCallback(async () => {
    if (!canTenantIngest) {
      onLog("Advanced F2", "Need Bearer + tenant cl_id.");
      return;
    }
    const u = ingestUrl.trim();
    if (!u.startsWith("http")) {
      onLog("Advanced F2", "Enter a valid http(s) URL.");
      return;
    }
    const path = agPath(`/knowledge/organizations/${encodeURIComponent(cid)}/ingest-url`);
    const body = {
      url: u,
      description: urlTitle.trim() || null,
      pt_id: ptId.trim() || "default",
    };
    onLog("F2 POST ingest-url", `${path}\n${pretty(body)}`);
    const r = await agJsonPost(path, body, token);
    onLog(`F2 ingest-url (${r.status})`, r.json != null ? pretty(r.json) : r.text);
    if (r.ok) await runKnowledgeVerificationAndLog();
  }, [canTenantIngest, cid, ingestUrl, onLog, ptId, runKnowledgeVerificationAndLog, token, urlTitle]);

  const verifyOnly = useCallback(async () => {
    setBusy(true);
    try {
      await runKnowledgeVerificationAndLog();
    } finally {
      setBusy(false);
    }
  }, [runKnowledgeVerificationAndLog]);

  const parsedStaging = parsePayloadObject(payloadEditor);
  const hasInlineTextBody =
    parsedStaging.ok &&
    ((typeof parsedStaging.value.text === "string" && parsedStaging.value.text.trim().length > 0) ||
      (typeof parsedStaging.value.content === "string" && parsedStaging.value.content.trim().length > 0));
  const urlIngestHint =
    Boolean(stagingSourceUri) && parsedStaging.ok && !hasInlineTextBody
      ? "This row has source_uri — the worker downloads that URL unless you set payload.text (or content) with inline body text."
      : null;

  const stagingEntitySlug = useMemo(() => {
    const p = parsePayloadObject(payloadEditor);
    if (!p.ok) return null;
    return deriveEntityTypeSlugForClinicQueue({
      payload: p.value,
      title: editTitle,
      sourceUri: stagingSourceUri,
    });
  }, [payloadEditor, editTitle, stagingSourceUri]);

  return (
    <section className="border border-zinc-300 dark:border-zinc-600 rounded p-4 space-y-4">
      <h2 className="font-medium">Phase F — Knowledge / RAG</h2>
      <p className="text-xs text-zinc-500">
        <strong>Phase F wiring</strong>: <strong>F1</strong> file / <strong>F2</strong> URL enqueue into clinic{" "}
        <code className="text-xs">knowledge_change_requests</code>, optional <strong>staging</strong> (edit JSON + PATCH while{" "}
        <code className="text-xs">pending</code>), then <strong>F3</strong>{" "}
        <code className="text-xs">consume/knowledge</code> (<strong>Confirm ingest</strong> = uploads only;{" "}
        <strong>Confirm delete</strong> = deletes only) and{" "}
        <strong>F4</strong> <code className="text-xs">GET /knowledge/test</code>. <strong>Clinic path</strong> uses PostgREST + admin JWT for queue/draft; internal key for F3.{" "}
        <strong>Advanced</strong> bypasses the clinic queue (dashboard JWT). See <code className="text-xs">docs/clinic-knowledge-two-tier-flow.md</code> for the checklist.
      </p>

      <div className="rounded-lg border border-emerald-600/35 bg-emerald-50/40 dark:bg-emerald-950/25 p-3 space-y-3">
        <h3 className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
          Clinic onboarding (request → ingest)
        </h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <strong>Two-tier flow</strong>: <strong>F1</strong> enqueue creates a <code className="text-xs">pending</code> row and loads the <strong>staging editor</strong> below.
          Edit <code className="text-xs">payload</code> JSON (CSV/text in <code className="text-xs">payload.text</code>) and optional title, <strong>Save draft</strong> (PATCH), then <strong>Confirm ingest</strong> (F3→F4) once <code className="text-xs">INTERNAL_SERVICE_KEY</code> is set.
          Files: .txt .md .csv … URL rows usually start with empty <code className="text-xs">payload</code> — the worker fetches <code className="text-xs">source_uri</code> unless you add inline <code className="text-xs">text</code>.
        </p>

        <div className="rounded border border-emerald-800/20 bg-white/60 dark:bg-zinc-950/40 p-2 space-y-2">
          <h4 className="text-xs font-semibold text-emerald-900 dark:text-emerald-100">Patients</h4>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            Create roster rows on the clinic project, then optionally scope queued knowledge to a patient (
            <code className="text-xs">target_pt_id</code> — apply <code className="text-xs">24_knowledge_change_requests_target_pt_id.sql</code> first). Picker shows names; the worker still sends the id to main.
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <button
              type="button"
              className="border px-2 py-1 rounded text-[11px] bg-white dark:bg-zinc-950 disabled:opacity-50"
              disabled={!canClinicQueue || busy}
              onClick={() => void refreshPatients()}
            >
              Refresh patients
            </button>
            <input
              className="border px-2 py-1 text-[11px] w-36 rounded"
              placeholder="Display name"
              value={newPatientDisplay}
              onChange={(e) => setNewPatientDisplay(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-[11px] w-28 rounded"
              placeholder="First"
              value={newPatientFirst}
              onChange={(e) => setNewPatientFirst(e.target.value)}
            />
            <input
              className="border px-2 py-1 text-[11px] w-28 rounded"
              placeholder="Last"
              value={newPatientLast}
              onChange={(e) => setNewPatientLast(e.target.value)}
            />
            <button
              type="button"
              className="border px-2 py-1 rounded text-[11px] font-medium bg-emerald-800 text-white border-emerald-900 disabled:opacity-50"
              disabled={!canClinicQueue || busy}
              onClick={() => void createPatient()}
            >
              Create patient
            </button>
          </div>
          {patients.length > 0 ? (
            <p className="text-[11px] text-zinc-500">{patients.length} patient(s) loaded — use scope below.</p>
          ) : null}
        </div>

        <label className="block text-[11px] space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">Knowledge scope (main Supabase pt_id)</span>
          <select
            className="border px-2 py-1 rounded text-xs w-full max-w-lg bg-white dark:bg-zinc-950"
            value={queueTargetPtId}
            onChange={(e) => setQueueTargetPtId(e.target.value)}
            aria-label="Patient scope for queued knowledge"
          >
            <option value="">Clinic-wide / catalog (default)</option>
            {patients.map((p) => (
              <option key={p.pt_id} value={p.pt_id}>
                {patientPickerLabel(p)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={clinicFileInputRef}
            id="knowledge-rag-panel-onboarding-file"
            type="file"
            accept=".txt,.md,.csv,.json,.html,.htm,text/plain"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              setClinicChosenFileName(f?.name ?? null);
            }}
          />
          <button
            type="button"
            className="border border-zinc-400 dark:border-zinc-500 px-3 py-1.5 rounded text-xs font-medium bg-white dark:bg-zinc-950 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
            disabled={busy}
            aria-label="Choose a text file for clinic knowledge (.txt, .md, …)"
            onClick={() => clinicFileInputRef.current?.click()}
          >
            Choose file…
          </button>
          <span
            className="text-xs text-zinc-700 dark:text-zinc-300 truncate max-w-[min(100%,20rem)] font-mono"
            title={clinicChosenFileName ?? undefined}
          >
            {clinicChosenFileName ? clinicChosenFileName : "No file chosen"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="border px-3 py-1.5 rounded text-xs font-medium bg-white dark:bg-zinc-950"
            disabled={!canClinicQueue || busy}
            onClick={() => void enqueueFileRequest()}
          >
            Enqueue file (F1)
          </button>
          <button
            type="button"
            className="border px-3 py-1.5 rounded text-xs font-medium bg-emerald-700 text-white border-emerald-800 disabled:opacity-50"
            disabled={!canConsumeQueue || busy || Boolean(stagingId && stagingDirty)}
            title={
              stagingId && stagingDirty
                ? "Save draft first — unsaved staging edits would not match what the worker reads."
                : "Applies pending upload rows only (request_type=upload). Use Confirm delete in the projection section for delete_request rows."
            }
            onClick={() => void runConsumeUploadsOnly()}
          >
            Confirm ingest (F3→F4)
          </button>
        </div>

        <div className="border-t border-emerald-200/80 dark:border-emerald-900/50 pt-2 space-y-2">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Or enqueue by HTTPS URL</p>
          <input
            className="border px-2 py-1 w-full font-mono text-xs"
            value={ingestUrl}
            onChange={(e) => setIngestUrl(e.target.value)}
            placeholder="https://… (worker downloads)"
          />
          <input
            className="border px-2 py-1 w-full text-xs"
            placeholder="Title"
            value={urlTitle}
            onChange={(e) => setUrlTitle(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="border px-3 py-1 rounded text-xs"
              disabled={!canClinicQueue || busy}
              onClick={() => void enqueueUrlRequest()}
            >
              Enqueue URL (F2)
            </button>
          </div>
        </div>

        <div className="rounded border border-amber-700/30 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-amber-950 dark:text-amber-100">Staging — review before ingest</h4>
            {stagingId ? (
              <span className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400">id: {stagingId}</span>
            ) : null}
          </div>
          {!stagingId ? (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              After <strong>Enqueue file</strong> or <strong>Enqueue URL</strong>, the new row&apos;s payload and title load here for edits. Nothing is sent to the platform worker until you run <strong>Confirm ingest</strong>.
            </p>
          ) : (
            <>
              {stagingEntitySlug != null ? (
                <p className="text-[11px] text-zinc-700 dark:text-zinc-300 rounded border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/50 px-2 py-1.5">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200">RAG entity type </span>
                  <span className="text-zinc-500">
                    (basename → slug on main; same rules as the ingest worker):
                  </span>{" "}
                  <code className="text-[10px] text-emerald-900 dark:text-emerald-200">{stagingEntitySlug}</code>
                  <span className="text-zinc-500"> — </span>
                  <span>{humanizeEntityTypeSlug(stagingEntitySlug)}</span>
                </p>
              ) : parsedStaging.ok ? (
                <p className="text-[11px] text-amber-800 dark:text-amber-200 rounded border border-amber-200/80 dark:border-amber-900/40 px-2 py-1.5">
                  Could not derive entity type from this row — set a <strong>title</strong>, an HTTPS{" "}
                  <code className="text-[10px]">source_uri</code>, or{" "}
                  <code className="text-[10px]">payload.source_filename</code> /{" "}
                  <code className="text-[10px]">entity_type</code> so staff and the worker agree on the key.
                </p>
              ) : null}
              <label className="block text-[11px] space-y-1">
                <span className="text-zinc-600 dark:text-zinc-400">Title (optional)</span>
                <input
                  className="border px-2 py-1 w-full text-xs rounded"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Row title"
                />
              </label>
              <label className="block text-[11px] space-y-1">
                <span className="text-zinc-600 dark:text-zinc-400">Payload (JSON object)</span>
                <textarea
                  className={`border px-2 py-1 w-full min-h-[10rem] font-mono text-[11px] rounded ${
                    parsedStaging.ok ? "" : "border-red-500 dark:border-red-600"
                  }`}
                  spellCheck={false}
                  value={payloadEditor}
                  onChange={(e) => setPayloadEditor(e.target.value)}
                  aria-invalid={!parsedStaging.ok}
                />
              </label>
              {!parsedStaging.ok ? (
                <p className="text-[11px] text-red-700 dark:text-red-300">{parsedStaging.error}</p>
              ) : null}
              {urlIngestHint ? (
                <p className="text-[11px] text-amber-800 dark:text-amber-200">{urlIngestHint}</p>
              ) : null}
              {payloadEditor.length > 800_000 ? (
                <p className="text-[11px] text-amber-800 dark:text-amber-200">
                  Very large payload ({payloadEditor.length.toLocaleString()} chars) — PostgREST or DB limits may apply.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className="border px-3 py-1 rounded text-xs font-medium bg-white dark:bg-zinc-950 disabled:opacity-50"
                  disabled={!canClinicQueue || busy || !stagingDirty || !parsedStaging.ok}
                  onClick={() => void saveClinicDraft()}
                >
                  Save draft (PATCH)
                </button>
                <button
                  type="button"
                  className="border px-3 py-1 rounded text-xs"
                  disabled={!canClinicQueue || busy || !stagingId}
                  onClick={() => void refreshStagingFromClinic()}
                >
                  Reload from clinic
                </button>
                <button
                  type="button"
                  className="border px-3 py-1 rounded text-xs text-zinc-600 dark:text-zinc-400"
                  disabled={busy}
                  onClick={() => clearStaging()}
                >
                  Clear staging (UI only)
                </button>
              </div>
            </>
          )}
        </div>

        <div className="rounded border border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-950/40 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              Synced knowledge (clinic projection)
            </h4>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className="border px-2 py-1 rounded text-[11px] bg-white dark:bg-zinc-950 disabled:opacity-50"
                disabled={!canClinicQueue || busy}
                onClick={() => void refreshKnowledgeProjection()}
              >
                Refresh list
              </button>
              <button
                type="button"
                className="border px-2 py-1 rounded text-[11px] font-medium bg-rose-700 text-white border-rose-800 disabled:opacity-50"
                disabled={!canConsumeQueue || busy}
                title="Applies pending delete_request rows only (request_type=delete_request). Does not ingest new uploads."
                onClick={() => void runConsumeDeletesOnly()}
              >
                Confirm delete (F3→F4)
              </button>
            </div>
          </div>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            <strong>Entity type</strong> is the ingest slug (usually the upload filename stem). After ingest F3 it is stored on
            each row as <code className="text-[10px]">metadata.ingest.entity_type</code>. Per row: <strong>Enqueue delete</strong>{" "}
            then use <strong>Confirm delete</strong> above (not the green Confirm ingest button). Match <strong>Knowledge scope</strong>{" "}
            to the doc&apos;s ingest scope for patient-scoped <code className="text-[10px]">target_pt_id</code>.
          </p>
          {projectionRows.length === 0 ? (
            <p className="text-[11px] text-zinc-500">
              No rows loaded — run <strong>Refresh list</strong> after ingest, or open this panel post–F3.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-60 overflow-y-auto border border-zinc-200 dark:border-zinc-700 rounded">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-zinc-100/90 dark:bg-zinc-900/80 text-left border-b border-zinc-200 dark:border-zinc-700">
                    <th className="p-1.5 font-medium">Status</th>
                    <th className="p-1.5 font-medium">Title</th>
                    <th className="p-1.5 font-medium">Entity type</th>
                    <th className="p-1.5 font-medium">Staff label</th>
                    <th className="p-1.5 font-medium">doc_id</th>
                    <th className="p-1.5 font-medium w-[7rem]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projectionRows.map((row) => {
                    const slug =
                      entityTypeFromProjectionMetadata(row.metadata) ??
                      deriveEntityTypeSlugForClinicQueue({
                        payload: {},
                        title: row.title,
                        sourceUri: row.source_uri,
                      }) ??
                      "—";
                    const label = slug === "—" ? "—" : humanizeEntityTypeSlug(slug);
                    const st = (row.status ?? "").toLowerCase();
                    const canQueueDelete = st === "active" || st === "pending" || st === "processing";
                    return (
                      <tr
                        key={row.doc_id}
                        className="border-b border-zinc-100 dark:border-zinc-800 align-top"
                      >
                        <td className="p-1.5 whitespace-nowrap">{row.status ?? "—"}</td>
                        <td className="p-1.5 max-w-[10rem] break-words">{row.title}</td>
                        <td className="p-1.5 font-mono text-[10px] break-all max-w-[8rem]">{slug}</td>
                        <td className="p-1.5 max-w-[8rem] break-words">{label}</td>
                        <td className="p-1.5 font-mono text-[10px] break-all">{row.doc_id}</td>
                        <td className="p-1.5 align-middle">
                          <button
                            type="button"
                            className="border px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-100 dark:border-rose-900 disabled:opacity-40"
                            disabled={!canClinicQueue || busy || !canQueueDelete}
                            title={
                              canQueueDelete
                                ? "Creates a pending delete_request; use Confirm delete (F3→F4) in the header to apply on platform."
                                : "Projection is not active — nothing to queue for delete."
                            }
                            onClick={() =>
                              void enqueueDeleteForDoc(
                                row.doc_id,
                                row.title,
                                slug === "—" ? null : slug,
                              )
                            }
                          >
                            Enqueue delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <label className="block text-xs space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">
            INTERNAL_SERVICE_KEY (for ingest / consume — localhost dev simulates backend)
          </span>
          <input
            className="border px-2 py-1 w-full max-w-xl font-mono text-xs block"
            type="password"
            autoComplete="off"
            placeholder="Same as Agnentic INTERNAL_SERVICE_KEY"
            value={internalKey}
            onChange={(e) => persistInternalKey(e.target.value)}
          />
          {!internalKey.trim() && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300 block">
              Required for <strong>Confirm ingest</strong> and <strong>Confirm delete</strong>. Without it you can still enqueue and save drafts on the clinic project.
            </span>
          )}
        </label>
      </div>

      <details className="rounded border border-zinc-300 dark:border-zinc-600 p-3 bg-zinc-50/80 dark:bg-zinc-900/40">
        <summary className="text-sm cursor-pointer font-medium">
          Advanced — direct Agnentic F1/F2 (dashboard JWT, bypasses clinic queue)
        </summary>
        <p className="text-xs text-zinc-500 mt-2">
          Same <strong>F1→F4</strong> / <strong>F2→F4</strong> flow: after each POST succeeds, <strong>F4</strong> runs automatically.
          Requires <code className="text-xs">app_metadata.dashboard_role</code> with <code className="text-xs">world_state:write</code>.
        </p>
        <div className="flex flex-wrap gap-2 items-end mt-2">
          <label className="text-xs flex flex-col gap-1">
            pt_id
            <input
              className="border px-2 py-1 font-mono text-xs w-28"
              value={ptId}
              onChange={(e) => setPtId(e.target.value)}
            />
          </label>
          <label className="text-xs flex flex-col gap-1">
            file_type
            <input
              className="border px-2 py-1 font-mono text-xs w-28"
              value={fileType}
              onChange={(e) => setFileType(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={skipGraph} onChange={(e) => setSkipGraph(e.target.checked)} />
            skip_graph
          </label>
        </div>
        <div className="mt-3 space-y-2">
          <input id="knowledge-rag-advanced-file" type="file" className="text-xs block" />
          <button
            type="button"
            className="border px-3 py-1 rounded text-xs"
            disabled={!canTenantIngest || busy}
            onClick={() => void postTenantFile()}
          >
            F1 ingest-file + verify
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="border px-3 py-1 rounded text-xs"
            disabled={!canTenantIngest || busy}
            onClick={() => void postTenantUrl()}
          >
            F2 ingest-url + verify
          </button>
          <button
            type="button"
            className="border px-3 py-1 rounded text-xs"
            disabled={busy}
            onClick={() => void verifyOnly()}
          >
            F4 verify only
          </button>
        </div>
      </details>
    </section>
  );
}
