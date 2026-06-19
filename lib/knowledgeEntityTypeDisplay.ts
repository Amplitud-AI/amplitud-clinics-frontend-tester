/**
 * Mirrors platform rules in agnentic_platform:
 * `schema_handler.determine_entity_type_from_key` + `humanize_entity_type_slug`
 * and clinic consumer `_clinic_ingest_entity_type_slug` resolution order.
 */

const MAX_ENTITY_TYPE_LEN = 120;
const NON_SAFE_ENTITY_TYPE = /[^a-z0-9_]+/g;

/** File path or basename → stem (last segment, strip one extension). */
export function stemFromFileHint(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const base = t.split(/[/\\]/).pop() ?? "";
  if (!base) return "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function determineEntityTypeFromKey(key: string): string {
  const k = (key || "").trim();
  if (!k) return "unknown_entity";

  let stem = k.toLowerCase().trim();
  if (stem.includes(".")) {
    const parts = stem.split(".");
    if (parts.length > 1) {
      stem = parts.slice(0, -1).join(".");
    }
  }
  stem = stem.replace(/ /g, "_").replace(/-/g, "_");
  let slug = stem.replace(NON_SAFE_ENTITY_TYPE, "_");
  slug = slug.replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!slug) return "unknown_entity";
  if (slug.length > MAX_ENTITY_TYPE_LEN) {
    slug = slug.slice(0, MAX_ENTITY_TYPE_LEN).replace(/_+$/g, "");
  }
  return slug || "unknown_entity";
}

export function humanizeEntityTypeSlug(entityType: string): string {
  const raw = (entityType || "").trim();
  if (!raw) return "Unknown source";

  const staged = raw.replace(/^tmp_/i, "").replace(/^temp_/i, "");
  let clean = staged.replace(/_/g, " ").replace(/-/g, " ").trim();
  const lower = clean.toLowerCase();
  if (lower === "unknown entity" || lower === "unknown") return "Unknown";
  if (!clean) clean = raw.replace(/_/g, " ").replace(/-/g, " ").trim();
  if (!clean) {
    const slice = raw.slice(0, MAX_ENTITY_TYPE_LEN);
    return slice.trim() || "Unknown source";
  }
  let titled = titleCaseWords(clean);
  if (titled.trim().length < 2) {
    titled = titleCaseWords(raw.replace(/_/g, " ").replace(/-/g, " ").trim());
  }
  if (titled.trim().length < 2) {
    const slice = raw.slice(0, MAX_ENTITY_TYPE_LEN).replace(/_+$/g, "");
    return slice || "Unknown source";
  }
  return titled.slice(0, MAX_ENTITY_TYPE_LEN).replace(/_+$/g, "") || "Unknown source";
}

/** Roughly matches Python ``str.title()`` on space-separated words. */
function titleCaseWords(s: string): string {
  return s.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/** Same resolution order as `_clinic_ingest_entity_type_slug` (no `source_type`). */
export function deriveEntityTypeSlugForClinicQueue(opts: {
  payload: Record<string, unknown>;
  title: string;
  sourceUri: string | null;
}): string | null {
  const { payload, title, sourceUri } = opts;

  for (const key of ["entity_type", "ingest_entity_type"] as const) {
    const explicit = strField(payload, key);
    if (explicit) {
      const stem = stemFromFileHint(explicit) || explicit;
      return determineEntityTypeFromKey(stem);
    }
  }
  for (const key of ["source_filename", "original_filename"] as const) {
    const raw = strField(payload, key);
    if (raw) {
      const stem = stemFromFileHint(raw);
      if (stem) return determineEntityTypeFromKey(stem);
    }
  }
  const t = title.trim();
  if (t) {
    const stem = stemFromFileHint(t) || t;
    return determineEntityTypeFromKey(stem);
  }
  if (sourceUri && /^https?:\/\//i.test(sourceUri)) {
    try {
      const segs = new URL(sourceUri).pathname.split("/").filter(Boolean);
      const pathName = segs.length ? segs[segs.length - 1]! : "";
      const stem = pathName ? stemFromFileHint(pathName) || pathName : "";
      if (stem) return determineEntityTypeFromKey(stem);
    } catch {
      /* ignore invalid URL */
    }
  }
  return null;
}

export function entityTypeFromProjectionMetadata(metadata: unknown): string | null {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const ingest = (metadata as Record<string, unknown>).ingest;
  if (ingest == null || typeof ingest !== "object" || Array.isArray(ingest)) return null;
  const et = (ingest as Record<string, unknown>).entity_type;
  return typeof et === "string" && et.trim() ? et.trim() : null;
}
