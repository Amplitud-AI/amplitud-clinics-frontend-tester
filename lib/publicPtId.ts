/**
 * Client-side pt_id allocation for dev/tester only.
 * Mirrors `agnentic_platform.entity_ids.generate_public_pt_id` + `slug_from_cl_id`
 * (see `scoped_prefixed_ids.py` / `clinic_ids.py`). Production apps may use an RPC instead.
 */

const NANOID = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix5(): string {
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => NANOID[b % NANOID.length]).join("");
}

/** `cl_xxxxx` → five-char slug after prefix. */
export function slugFromClId(clId: string): string {
  const c = clId.trim();
  if (!/^cl_[a-z0-9]{5}$/i.test(c)) {
    throw new Error("cl_id must match cl_[a-z0-9]{5}");
  }
  return c.slice(3).toLowerCase();
}

/** `pt_{slug}_{5}` — must match clinic.patients CHECK constraints. */
export function generatePublicPtId(clId: string): string {
  return `pt_${slugFromClId(clId)}_${randomSuffix5()}`;
}
