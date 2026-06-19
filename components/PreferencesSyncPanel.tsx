"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { agnenticFetch, agPath } from "@/lib/agnentic";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/config";

const LS_INTERNAL_KEY = "clinic_flow_internal_service_key";

const CATEGORY_ORDER = ["global", "scheduling"] as const;

type PrefRequestType = "merge_patch" | "replace" | "reset_default";

type Props = {
  bearer: string | null;
  effectiveClId: string;
  onLog: (title: string, body: string) => void;
};

type PreferenceApiResponse = {
  global_prefs?: Record<string, unknown>;
  scheduling_prefs?: Record<string, unknown>;
};

type PreferenceEntryRow = {
  category: string;
  preference_key: string;
  value_type: string;
  value_bool?: boolean | null;
  value_int?: number | string | null;
  value_float?: number | string | null;
  value_text?: string | null;
};

type PreferenceListValueRow = {
  category: string;
  preference_key: string;
  item_index: number | string;
  item_type: string;
  item_bool?: boolean | null;
  item_int?: number | string | null;
  item_float?: number | string | null;
  item_text?: string | null;
};

type PreferenceObjectListValueRow = {
  category: string;
  preference_key: string;
  item_index: number | string;
  object_key: string;
  value_type: string;
  value_bool?: boolean | null;
  value_int?: number | string | null;
  value_float?: number | string | null;
  value_text?: string | null;
};

const RELATIONAL_LIST_TYPES: Record<string, "text" | "int"> = {
  "global.work_days": "text",
  "scheduling.allowed_durations": "int",
};

const RELATIONAL_OBJECT_LIST_KEYS = new Set<string>([]);

/** Canonical keys set by onboarding / admins; clinics may view but cannot submit edits from this panel. */
const GLOBAL_CLINIC_MANAGED_KEYS = new Set<string>(["organization_name", "whatsapp_phone_number"]);

const GLOBAL_FIELD_LABELS: Record<string, string> = {
  organization_name: "Clinic name",
  whatsapp_phone_number: "WhatsApp phone",
};

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function stripGlobalClinicManagedKeysForSubmit(draft: Record<string, unknown>): Record<string, unknown> {
  const out = { ...draft };
  const g = draft.global;
  if (!isPlainObject(g)) return out;
  const nextGlobal = { ...g };
  for (const k of GLOBAL_CLINIC_MANAGED_KEYS) delete nextGlobal[k];
  out.global = nextGlobal;
  return out;
}

function toRequestedValuesShape(src: PreferenceApiResponse): Record<string, unknown> {
  return {
    global: src.global_prefs ?? {},
    scheduling: src.scheduling_prefs ?? {},
  };
}

function relationalKey(category: string, preferenceKey: string): string {
  return `${category}.${preferenceKey}`;
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function decodeEntryScalarValue(row: PreferenceEntryRow | PreferenceObjectListValueRow): unknown {
  if (row.value_type === "bool") return Boolean(row.value_bool);
  if (row.value_type === "int") {
    const n = toFiniteNumber(row.value_int);
    return n == null ? 0 : Math.trunc(n);
  }
  if (row.value_type === "float") {
    const n = toFiniteNumber(row.value_float);
    return n == null ? 0 : n;
  }
  if (row.value_type === "relational") return null;
  return row.value_text ?? "";
}

function decodeListScalarValue(row: PreferenceListValueRow): unknown {
  if (row.item_type === "bool") return Boolean(row.item_bool);
  if (row.item_type === "int") {
    const n = toFiniteNumber(row.item_int);
    return n == null ? 0 : Math.trunc(n);
  }
  if (row.item_type === "float") {
    const n = toFiniteNumber(row.item_float);
    return n == null ? 0 : n;
  }
  return row.item_text ?? "";
}

function buildPreferenceMapFromRelationalRows(
  entryRows: PreferenceEntryRow[],
  listRows: PreferenceListValueRow[],
  objectRows: PreferenceObjectListValueRow[],
): Record<string, unknown> {
  const rebuilt: Record<string, Record<string, unknown>> = Object.fromEntries(
    CATEGORY_ORDER.map((cat) => [cat, {}]),
  ) as Record<string, Record<string, unknown>>;
  const relationalMarkers = new Set<string>();

  for (const row of entryRows) {
    const category = row.category;
    const prefKey = row.preference_key;
    if (!CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number]) || !prefKey) continue;
    const decoded = decodeEntryScalarValue(row);
    if (decoded === null) {
      relationalMarkers.add(relationalKey(category, prefKey));
      continue;
    }
    rebuilt[category][prefKey] = decoded;
  }

  const listGrouped = new Map<string, Array<{ idx: number; value: unknown }>>();
  for (const row of listRows) {
    const category = row.category;
    const prefKey = row.preference_key;
    if (!CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number]) || !prefKey) continue;
    const idx = Math.trunc(toFiniteNumber(row.item_index) ?? 0);
    const key = relationalKey(category, prefKey);
    const bucket = listGrouped.get(key) ?? [];
    bucket.push({ idx, value: decodeListScalarValue(row) });
    listGrouped.set(key, bucket);
  }
  for (const [key, values] of listGrouped.entries()) {
    values.sort((a, b) => a.idx - b.idx);
    const [category, prefKey] = key.split(".", 2);
    rebuilt[category][prefKey] = values.map((x) => x.value);
    relationalMarkers.delete(key);
  }

  const objectGrouped = new Map<string, Map<number, Record<string, unknown>>>();
  for (const row of objectRows) {
    const category = row.category;
    const prefKey = row.preference_key;
    const objectKey = row.object_key;
    if (!CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number]) || !prefKey || !objectKey) continue;
    const idx = Math.trunc(toFiniteNumber(row.item_index) ?? 0);
    const key = relationalKey(category, prefKey);
    const byIdx = objectGrouped.get(key) ?? new Map<number, Record<string, unknown>>();
    const obj = byIdx.get(idx) ?? {};
    obj[objectKey] = decodeEntryScalarValue(row);
    byIdx.set(idx, obj);
    objectGrouped.set(key, byIdx);
  }
  for (const [key, byIdx] of objectGrouped.entries()) {
    const [category, prefKey] = key.split(".", 2);
    const arr = [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, obj]) => obj);
    rebuilt[category][prefKey] = arr;
    relationalMarkers.delete(key);
  }

  for (const marker of relationalMarkers) {
    const [category, prefKey] = marker.split(".", 2);
    rebuilt[category][prefKey] = [];
  }

  return rebuilt;
}

function scalarValueColumns(value: unknown): Record<string, unknown> {
  // Always emit all four nullable value columns so PostgREST bulk-insert
  // receives uniform keys across every row (PGRST102 requires identical keys).
  const base = { value_bool: null, value_int: null, value_float: null, value_text: null };
  if (typeof value === "boolean") return { ...base, value_type: "bool", value_bool: value };
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return { ...base, value_type: "int", value_int: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ...base, value_type: "float", value_float: value };
  }
  return { ...base, value_type: "text", value_text: value == null ? "" : String(value) };
}

function isRelationalValue(category: string, preferenceKey: string, value: unknown): boolean {
  const key = relationalKey(category, preferenceKey);
  if (Object.prototype.hasOwnProperty.call(RELATIONAL_LIST_TYPES, key)) return Array.isArray(value);
  if (RELATIONAL_OBJECT_LIST_KEYS.has(key)) return Array.isArray(value);
  return false;
}

function encodeRelationalRequestRows(values: Record<string, unknown>): {
  entries: Record<string, unknown>[];
  listItems: Record<string, unknown>[];
  objectListItems: Record<string, unknown>[];
} {
  const entries: Record<string, unknown>[] = [];
  const listItems: Record<string, unknown>[] = [];
  const objectListItems: Record<string, unknown>[] = [];

  const categoryMap = toRequestedValuesShape({
    global_prefs: isPlainObject(values.global) ? values.global : {},
    scheduling_prefs: isPlainObject(values.scheduling) ? values.scheduling : {},
  });

  for (const category of CATEGORY_ORDER) {
    const categoryValues = categoryMap[category];
    if (!isPlainObject(categoryValues)) continue;
    for (const [preferenceKey, preferenceValue] of Object.entries(categoryValues)) {
      const entryBase: Record<string, unknown> = { category, preference_key: preferenceKey };
      if (isRelationalValue(category, preferenceKey, preferenceValue)) {
        // Include null value columns so all entry rows have uniform keys.
        entries.push({ ...entryBase, value_type: "relational", value_bool: null, value_int: null, value_float: null, value_text: null });
      } else {
        entries.push({ ...entryBase, ...scalarValueColumns(preferenceValue) });
      }

      const key = relationalKey(category, preferenceKey);
      const listType = RELATIONAL_LIST_TYPES[key];
      if (listType && Array.isArray(preferenceValue)) {
        preferenceValue.forEach((item, itemIndex) => {
          // Always include all nullable item value columns for uniform PostgREST keys.
          const row: Record<string, unknown> = {
            category,
            preference_key: preferenceKey,
            item_index: itemIndex,
            item_type: listType,
            item_bool: null,
            item_int: null,
            item_float: null,
            item_text: null,
          };
          if (listType === "int") row.item_int = Math.trunc(toFiniteNumber(item) ?? 0);
          else row.item_text = String(item ?? "");
          listItems.push(row);
        });
      }

      if (RELATIONAL_OBJECT_LIST_KEYS.has(key) && Array.isArray(preferenceValue)) {
        preferenceValue.forEach((item, itemIndex) => {
          if (!isPlainObject(item)) return;
          for (const [objectKey, objectValue] of Object.entries(item)) {
            objectListItems.push({
              category,
              preference_key: preferenceKey,
              item_index: itemIndex,
              object_key: objectKey,
              ...scalarValueColumns(objectValue),
            });
          }
        });
      }
    }
  }

  return { entries, listItems, objectListItems };
}

function sortedCategories(d: Record<string, unknown>): string[] {
  const keys = Object.keys(d);
  const ordered = CATEGORY_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !CATEGORY_ORDER.includes(k as (typeof CATEGORY_ORDER)[number])).sort();
  return [...ordered, ...rest];
}

function stringArrayFromValue(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}

type ObjectEditorProps = {
  obj: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  depth: number;
  readOnlyKeys?: ReadonlySet<string>;
  fieldLabels?: Record<string, string>;
};

function JsonBlobField({
  label,
  value,
  onCommit,
  hint,
  expectArray,
}: {
  label: string;
  value: unknown;
  onCommit: (parsed: unknown) => void;
  hint?: string;
  expectArray?: boolean;
}) {
  const [text, setText] = useState(() => pretty(value));
  const [parseErr, setParseErr] = useState("");

  const apply = () => {
    setParseErr("");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (expectArray && !Array.isArray(parsed)) {
        setParseErr("Value must be a JSON array.");
        return;
      }
      onCommit(parsed);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-zinc-700">{label}</span>
      <textarea
        className="border w-full font-mono text-xs p-2 min-h-[72px] rounded"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="border px-2 py-0.5 rounded text-xs" onClick={apply}>
          Apply JSON
        </button>
        {hint ? <p className="text-[10px] text-zinc-500">{hint}</p> : null}
      </div>
      {parseErr ? <p className="text-[10px] text-red-600">{parseErr}</p> : null}
    </div>
  );
}

function ObjectFieldEditor({ obj, onChange, depth, readOnlyKeys, fieldLabels }: ObjectEditorProps) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const maxFormDepth = 3;

  const patchKey = (key: string, val: unknown) => {
    const next = { ...obj };
    if (val === undefined) delete next[key];
    else next[key] = val;
    onChange(next);
  };

  if (keys.length === 0) {
    return <p className="text-xs text-zinc-500">No keys in this category yet.</p>;
  }

  return (
    <div className="space-y-3">
      {keys.map((key) => {
        const v = obj[key];
        const id = `pref-${key}-${depth}`;
        const displayLabel = fieldLabels?.[key] ?? key;
        const isReadOnly = readOnlyKeys?.has(key) ?? false;

        if (typeof v === "boolean") {
          if (isReadOnly) {
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0">{displayLabel}</span>
                <span className="text-xs text-zinc-600">{v ? "true" : "false"}</span>
                <span className="text-[10px] text-zinc-400">read-only</span>
              </div>
            );
          }
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <label htmlFor={id} className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0">
                {displayLabel}
              </label>
              <div className="flex gap-1">
                <button
                  type="button"
                  id={id}
                  className={`border px-2 py-1 rounded text-xs ${v ? "bg-emerald-100 border-emerald-400" : "bg-white"}`}
                  onClick={() => patchKey(key, true)}
                >
                  true
                </button>
                <button
                  type="button"
                  className={`border px-2 py-1 rounded text-xs ${!v ? "bg-zinc-200 border-zinc-500" : "bg-white"}`}
                  onClick={() => patchKey(key, false)}
                >
                  false
                </button>
              </div>
            </div>
          );
        }

        if (typeof v === "number" && Number.isFinite(v)) {
          if (isReadOnly) {
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0">{displayLabel}</span>
                <span className="text-xs text-zinc-600 font-mono">{String(v)}</span>
                <span className="text-[10px] text-zinc-400">read-only</span>
              </div>
            );
          }
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <label htmlFor={id} className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0">
                {displayLabel}
              </label>
              <input
                id={id}
                type="number"
                className="border px-2 py-1 rounded text-xs flex-1 min-w-[120px] max-w-md"
                value={Number.isFinite(v) ? String(v) : ""}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  patchKey(key, Number.isFinite(n) ? n : 0);
                }}
              />
            </div>
          );
        }

        if (typeof v === "string") {
          if (isReadOnly) {
            const display = v === "" ? "—" : v;
            return (
              <div key={key} className="flex flex-wrap items-start gap-2">
                <span className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0 pt-1.5">{displayLabel}</span>
                <div className="flex flex-col gap-0.5 flex-1 min-w-[160px]">
                  <span className="text-xs text-zinc-800 font-mono break-all rounded bg-zinc-50 px-2 py-1 border border-zinc-100">
                    {display}
                  </span>
                  <span className="text-[10px] text-zinc-400">read-only (managed outside this panel)</span>
                </div>
              </div>
            );
          }
          return (
            <div key={key} className="flex flex-wrap items-start gap-2">
              <label htmlFor={id} className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0 pt-1.5">
                {displayLabel}
              </label>
              <input
                id={id}
                type="text"
                className="border px-2 py-1 rounded text-xs flex-1 min-w-[160px]"
                value={v}
                onChange={(e) => patchKey(key, e.target.value)}
              />
            </div>
          );
        }

        if (v === null) {
          if (isReadOnly) {
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-zinc-700 min-w-[140px]">{displayLabel}</span>
                <code className="text-zinc-500">null</code>
                <span className="text-[10px] text-zinc-400">read-only</span>
              </div>
            );
          }
          return (
            <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-zinc-700 min-w-[140px]">{displayLabel}</span>
              <code className="text-zinc-500">null</code>
              <button type="button" className="border px-2 py-0.5 rounded text-xs" onClick={() => patchKey(key, "")}>
                Set to empty string
              </button>
            </div>
          );
        }

        if (isStringArray(v)) {
          const joined = stringArrayFromValue(v).join(", ");
          return (
            <div key={key} className="flex flex-wrap items-start gap-2">
              <label htmlFor={id} className="text-xs font-medium text-zinc-700 min-w-[140px] shrink-0 pt-1.5">
                {displayLabel}
              </label>
              <textarea
                id={id}
                className="border px-2 py-1 rounded text-xs flex-1 min-h-[60px] min-w-[200px] font-mono"
                placeholder="Comma-separated values, e.g. Monday, Tuesday, Wednesday"
                value={joined}
                onChange={(e) => {
                  const parts = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  patchKey(key, parts);
                }}
              />
            </div>
          );
        }

        if (Array.isArray(v)) {
          return (
            <JsonBlobField
              key={`arr-${key}-${depth}-${pretty(v)}`}
              label={displayLabel}
              value={v}
              expectArray
              onCommit={(parsed) => {
                if (Array.isArray(parsed)) patchKey(key, parsed);
              }}
              hint="Must be a JSON array. Click Apply JSON when done."
            />
          );
        }

        if (isPlainObject(v) && depth < maxFormDepth) {
          return (
            <div key={key} className="border border-zinc-200 rounded p-2 space-y-2 bg-zinc-50/80">
              <div className="text-xs font-semibold text-zinc-800">{key}</div>
              <ObjectFieldEditor
                obj={v}
                depth={depth + 1}
                onChange={(inner) => patchKey(key, inner)}
              />
            </div>
          );
        }

        return (
          <JsonBlobField
            key={`blob-${key}-${depth}-${pretty(v)}`}
            label={displayLabel}
            value={v}
            onCommit={(parsed) => patchKey(key, parsed)}
            hint="Edit as JSON, then Apply JSON."
          />
        );
      })}
    </div>
  );
}

async function clinicPostgrest(
  method: string,
  path: string,
  opts: { bearer: string; anon: string; body?: string; prefer?: string },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const baseUrl = getSupabaseUrl().replace(/\/$/, "");
  const rel = path.replace(/^\//, "");
  const url = `${baseUrl}/rest/v1/${rel}`;
  const headers: HeadersInit = {
    apikey: opts.anon,
    Authorization: `Bearer ${opts.bearer}`,
    Accept: "application/json",
    "Accept-Profile": "clinic",
    "Content-Profile": "clinic",
  };
  if (opts.prefer) {
    headers["Prefer"] = opts.prefer;
  }
  if (opts.body != null) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, { method, headers, body: opts.body });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

export default function PreferencesSyncPanel({ bearer, effectiveClId, onLog }: Props) {
  const anon = getSupabaseAnonKey();
  const [internalKey, setInternalKey] = useState("");
  const [requestType, setRequestType] = useState<PrefRequestType>("merge_patch");
  const [requestedByStId, setRequestedByStId] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>({ global: {} });
  const [activeCategory, setActiveCategory] = useState<string>("global");
  const [showRawJson, setShowRawJson] = useState(false);
  const [rawPayloadText, setRawPayloadText] = useState("");
  const [busy, setBusy] = useState(false);
  const [consumeAfterCreate, setConsumeAfterCreate] = useState(true);

  const categories = useMemo(() => sortedCategories(draft), [draft]);

  const selectedCategory = useMemo(() => {
    if (categories.includes(activeCategory)) return activeCategory;
    return categories[0] ?? "global";
  }, [categories, activeCategory]);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const k = localStorage.getItem(LS_INTERNAL_KEY);
        if (k) setInternalKey(k);
      } catch {
        /* ignore localstorage failures */
      }
    });
  }, []);

  const canSubmit = useMemo(
    () => Boolean(bearer && anon && effectiveClId.trim() && !busy),
    [anon, bearer, busy, effectiveClId],
  );

  const saveInternalKey = (raw: string) => {
    setInternalKey(raw);
    try {
      localStorage.setItem(LS_INTERNAL_KEY, raw);
    } catch {
      /* ignore localstorage failures */
    }
  };

  const setDraftFromParsed = useCallback((obj: Record<string, unknown>) => {
    setDraft(obj);
    const cats = sortedCategories(obj);
    if (cats.length) setActiveCategory(cats[0]);
  }, []);

  const updateCategory = useCallback((cat: string, nextObj: Record<string, unknown>) => {
    setDraft((d) => ({ ...d, [cat]: nextObj }));
  }, []);

  const loadCanonicalFromMain = async () => {
    if (!bearer) {
      onLog("preferences/load-canonical", "Need clinic JWT first.");
      return;
    }
    const cl = effectiveClId.trim();
    if (!cl) {
      onLog("preferences/load-canonical", "Missing effective cl_id.");
      return;
    }
    setBusy(true);
    try {
      const res = await agnenticFetch(agPath("/clinic/organization-preferences/canonical"), {
        method: "GET",
        bearer,
      });
      if (!res.ok || !res.json || typeof res.json !== "object") {
        onLog(`preferences/load-canonical (${res.status})`, res.json != null ? pretty(res.json) : res.text);
        return;
      }
      const body = res.json as PreferenceApiResponse & { cl_id?: string };
      if (body.cl_id && body.cl_id.trim() !== cl) {
        onLog(
          "preferences/load-canonical",
          `JWT tenant ${body.cl_id} differs from UI cl_id ${cl}; using server response.`,
        );
      }
      const requested = toRequestedValuesShape(body);
      setDraftFromParsed(requested);
      onLog("preferences/load-canonical", "Loaded canonical org preference categories from backend.");
    } finally {
      setBusy(false);
    }
  };

  const loadProjectionFromClinic = async () => {
    if (!bearer) {
      onLog("preferences/load-projection", "Need clinic JWT first.");
      return;
    }
    if (!anon) {
      onLog("preferences/load-projection", "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY (needed for PostgREST apikey).");
      return;
    }
    const cl = effectiveClId.trim();
    if (!cl) {
      onLog("preferences/load-projection", "Missing effective cl_id.");
      return;
    }
    setBusy(true);
    try {
      onLog("preferences/load-projection", `GET relational projection tables cl_id=${cl} …`);
      const entriesRes = await clinicPostgrest(
        "GET",
        `organization_preference_projection_entries?cl_id=eq.${encodeURIComponent(
          cl,
        )}&select=category,preference_key,value_type,value_bool,value_int,value_float,value_text`,
        { bearer, anon },
      );
      if (!entriesRes.ok) {
        onLog(`preferences/load-projection entries (${entriesRes.status})`, pretty(entriesRes.json));
        return;
      }
      const listRes = await clinicPostgrest(
        "GET",
        `organization_preference_projection_list_values?cl_id=eq.${encodeURIComponent(
          cl,
        )}&select=category,preference_key,item_index,item_type,item_bool,item_int,item_float,item_text&order=category.asc,preference_key.asc,item_index.asc`,
        { bearer, anon },
      );
      if (!listRes.ok) {
        onLog(`preferences/load-projection list (${listRes.status})`, pretty(listRes.json));
        return;
      }
      const objectRes = await clinicPostgrest(
        "GET",
        `organization_preference_projection_object_list_values?cl_id=eq.${encodeURIComponent(
          cl,
        )}&select=category,preference_key,item_index,object_key,value_type,value_bool,value_int,value_float,value_text&order=category.asc,preference_key.asc,item_index.asc,object_key.asc`,
        { bearer, anon },
      );
      if (!objectRes.ok) {
        onLog(`preferences/load-projection object-list (${objectRes.status})`, pretty(objectRes.json));
        return;
      }

      const entries = Array.isArray(entriesRes.json) ? (entriesRes.json as PreferenceEntryRow[]) : [];
      const listItems = Array.isArray(listRes.json) ? (listRes.json as PreferenceListValueRow[]) : [];
      const objectItems = Array.isArray(objectRes.json) ? (objectRes.json as PreferenceObjectListValueRow[]) : [];

      if (entries.length === 0 && listItems.length === 0 && objectItems.length === 0) {
        onLog(
          "preferences/load-projection",
          "No relational projection rows yet. Run consume after a successful preference request.",
        );
        return;
      }

      const projection = buildPreferenceMapFromRelationalRows(entries, listItems, objectItems);
      setDraftFromParsed(projection);
      onLog(
        "preferences/load-projection",
        `Loaded clinic projection from relational tables (${entries.length} entries, ${listItems.length} list rows, ${objectItems.length} object rows).`,
      );
    } finally {
      setBusy(false);
    }
  };

  const consumePending = async () => {
    if (!internalKey.trim()) {
      onLog("preferences/consume", "Missing INTERNAL_SERVICE_KEY (X-Internal-Service-Key).");
      return;
    }
    const cl = effectiveClId.trim();
    if (!cl) {
      onLog("preferences/consume", "Missing effective cl_id.");
      return;
    }
    setBusy(true);
    try {
      const res = await agnenticFetch(agPath("/admin/clinic-requests/consume/preferences"), {
        method: "POST",
        headers: { "X-Internal-Service-Key": internalKey.trim() },
        body: JSON.stringify({ cl_id: cl }),
      });
      onLog(
        `preferences/consume (${res.status})`,
        res.json != null ? pretty(res.json) : res.text,
      );
    } finally {
      setBusy(false);
    }
  };

  const createRequest = async () => {
    if (!canSubmit || !bearer) {
      onLog("preferences/create-request", "Missing bearer/anon/cl_id or panel is busy.");
      return;
    }
    const cl = effectiveClId.trim();
    let parsed: Record<string, unknown> = {};
    if (requestType !== "reset_default") {
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        onLog("preferences/create-request", "Payload must be a category-keyed JSON object.");
        return;
      }
      parsed =
        requestType === "merge_patch"
          ? stripGlobalClinicManagedKeysForSubmit(draft as Record<string, unknown>)
          : (draft as Record<string, unknown>);
    }

    // Build the single atomic RPC payload.  All inserts (parent + children) run
    // inside one PL/pgSQL transaction via clinic.submit_preference_change so a
    // dropped connection can never leave the queue in a partial state.
    const rows =
      requestType !== "reset_default" ? encodeRelationalRequestRows(parsed) : null;

    const rpcPayload: Record<string, unknown> = {
      cl_id: cl,
      request_type: requestType,
      entries: rows?.entries ?? [],
      list_values: rows?.listItems ?? [],
      object_list_values: rows?.objectListItems ?? [],
    };
    const staff = requestedByStId.trim();
    if (staff) rpcPayload.requested_by_st_id = staff;

    setBusy(true);
    try {
      const rpcRes = await clinicPostgrest("POST", "rpc/submit_preference_change", {
        bearer,
        anon,
        body: JSON.stringify({ payload: rpcPayload }),
        prefer: "return=representation",
      });
      onLog(
        `preferences/create-request rpc (${rpcRes.status})`,
        rpcRes.json != null ? pretty(rpcRes.json) : rpcRes.text,
      );
      if (!rpcRes.ok) {
        return;
      }

      const result = rpcRes.json as { request_id?: unknown } | null;
      const requestId = typeof result?.request_id === "string" ? result.request_id : null;
      if (!requestId) {
        onLog("preferences/create-request", "RPC succeeded but response missing request_id.");
        return;
      }

      onLog(
        "preferences/create-request",
        `Atomic request created: ${requestId}` +
          (rows
            ? ` (${rows.entries.length} entries, ${rows.listItems.length} list, ${rows.objectListItems.length} object-list)`
            : " (reset_default — no payload rows)"),
      );

      if (consumeAfterCreate) {
        await consumePending();
      }
    } finally {
      setBusy(false);
    }
  };

  const activeObj =
    selectedCategory && isPlainObject(draft[selectedCategory])
      ? (draft[selectedCategory] as Record<string, unknown>)
      : {};

  return (
    <section className="border border-zinc-300 rounded p-4 space-y-3">
      <h2 className="font-medium">Phase G — Clinic preferences sync (queue → main)</h2>
      <p className="text-xs text-zinc-500">
        <strong>Load canonical</strong> calls{" "}
        <code className="text-xs">GET …/clinic/organization-preferences/canonical</code> (clinic JWT → main merged prefs).
        <strong>Clinic name</strong> and <strong>WhatsApp phone</strong> cannot be edited here; they stay on the canonical
        record outside this flow. For <strong>merge_patch</strong>, they are omitted from the request payload so they cannot
        be changed from this panel; <strong>replace</strong> still sends the loaded values unchanged. Edit other fields below (or raw JSON).
        Creates writes via{" "}
        <code className="text-xs">POST …/rpc/submit_preference_change</code> (one transaction into{" "}
        <code className="text-xs">clinic.preference_change_requests</code> and child rows); consume applies to main and mirrors projection/events.
      </p>

      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="border px-3 py-1 rounded" onClick={() => void loadCanonicalFromMain()} disabled={busy}>
          Load canonical categories
        </button>
        <button type="button" className="border px-3 py-1 rounded" onClick={() => void loadProjectionFromClinic()} disabled={busy}>
          Load clinic projection
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="border px-2 py-1"
          value={requestType}
          onChange={(e) => setRequestType(e.target.value as PrefRequestType)}
        >
          <option value="merge_patch">merge_patch</option>
          <option value="replace">replace</option>
          <option value="reset_default">reset_default</option>
        </select>
        <input
          className="border px-2 py-1 flex-1 min-w-[220px] font-mono text-xs"
          placeholder="requested_by_st_id (optional, st_...)"
          value={requestedByStId}
          onChange={(e) => setRequestedByStId(e.target.value)}
        />
      </div>

      <div className="border rounded p-3 bg-white space-y-3">
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-xs text-zinc-600 mr-1">Category:</span>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`border px-2 py-1 rounded text-xs font-mono ${
                cat === selectedCategory ? "bg-zinc-800 text-white border-zinc-800" : "bg-zinc-50 hover:bg-zinc-100"
              }`}
              onClick={() => setActiveCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        <ObjectFieldEditor
          obj={activeObj}
          depth={0}
          onChange={(next) => updateCategory(selectedCategory, next)}
          readOnlyKeys={selectedCategory === "global" ? GLOBAL_CLINIC_MANAGED_KEYS : undefined}
          fieldLabels={selectedCategory === "global" ? GLOBAL_FIELD_LABELS : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="text-xs text-zinc-600 underline"
          onClick={() => {
            setShowRawJson((s) => {
              const next = !s;
              if (next) setRawPayloadText(pretty(draft));
              return next;
            });
          }}
        >
          {showRawJson ? "Hide" : "Show"} raw JSON (full payload)
        </button>
        {showRawJson ? (
          <button
            type="button"
            className="border px-2 py-0.5 rounded text-xs"
            onClick={() => {
              try {
                const v = JSON.parse(rawPayloadText) as unknown;
                if (!v || typeof v !== "object" || Array.isArray(v)) {
                  onLog("preferences/raw-json", "Root value must be a JSON object.");
                  return;
                }
                setDraftFromParsed(v as Record<string, unknown>);
                onLog("preferences/raw-json", "Applied JSON object to the form.");
              } catch (err) {
                onLog("preferences/raw-json", `Invalid JSON: ${String(err)}`);
              }
            }}
          >
            Apply raw JSON to form
          </button>
        ) : null}
      </div>
      {showRawJson ? (
        <textarea
          className="border w-full font-mono text-xs p-2 min-h-[180px]"
          value={rawPayloadText}
          onChange={(e) => setRawPayloadText(e.target.value)}
          spellCheck={false}
        />
      ) : null}

      <div className="flex flex-wrap gap-2 items-center">
        <input
          className="border px-2 py-1 flex-1 min-w-[260px] font-mono text-xs"
          placeholder="INTERNAL_SERVICE_KEY (for consume endpoint)"
          value={internalKey}
          onChange={(e) => saveInternalKey(e.target.value)}
        />
        <label className="text-xs flex items-center gap-2">
          <input
            type="checkbox"
            checked={consumeAfterCreate}
            onChange={(e) => setConsumeAfterCreate(e.target.checked)}
          />
          Consume immediately after create
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="border px-3 py-1 rounded" onClick={() => void createRequest()} disabled={!canSubmit}>
          Enqueue prefs (rpc)
        </button>
        <button type="button" className="border px-3 py-1 rounded" onClick={() => void consumePending()} disabled={busy}>
          POST consume/preferences
        </button>
      </div>
    </section>
  );
}
