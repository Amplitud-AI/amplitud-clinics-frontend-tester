import type { SupabaseClient } from "@supabase/supabase-js";

export const STAFF_AVATARS_BUCKET = "staff-avatars";

/** Canonical storage path: `{cl_id}/{st_id}/avatar.webp`. */
export function staffAvatarObjectPath(clId: string, stId: string): string {
  const cl = clId.trim();
  const st = stId.trim();
  if (!cl || !st) throw new Error("STAFF_AVATAR_PATH_REQUIRES_CL_ID_AND_ST_ID");
  return `${cl}/${st}/avatar.webp`;
}

export function staffAvatarPublicUrl(
  supabase: SupabaseClient,
  clId: string,
  stId: string,
): string {
  const path = staffAvatarObjectPath(clId, stId);
  const { data } = supabase.storage.from(STAFF_AVATARS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export function readStaffAvatarUrl(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = metadata.avatar_url;
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  return url || null;
}

export async function uploadStaffAvatarWebp(
  supabase: SupabaseClient,
  clId: string,
  stId: string,
  file: Blob,
): Promise<string> {
  const path = staffAvatarObjectPath(clId, stId);
  const { error } = await supabase.storage
    .from(STAFF_AVATARS_BUCKET)
    .upload(path, file, {
      upsert: true,
      contentType: "image/webp",
      cacheControl: "3600",
    });
  if (error) throw new Error(`STAFF_AVATAR_UPLOAD_FAILED_${error.message}`);
  return staffAvatarPublicUrl(supabase, clId, stId);
}

/** Resize/crop to 256x256 WebP in the browser for harness uploads. */
export async function convertImageFileToWebp256(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("STAFF_AVATAR_CANVAS_UNSUPPORTED");
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = Math.floor((bitmap.width - side) / 2);
  const sy = Math.floor((bitmap.height - side) / 2);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, 256, 256);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9),
  );
  if (!blob) throw new Error("STAFF_AVATAR_WEBP_ENCODE_FAILED");
  return blob;
}

export async function deleteStaffAvatarObject(
  supabase: SupabaseClient,
  clId: string,
  stId: string,
): Promise<void> {
  const path = staffAvatarObjectPath(clId, stId);
  const { error } = await supabase.storage.from(STAFF_AVATARS_BUCKET).remove([path]);
  if (error) throw new Error(`STAFF_AVATAR_DELETE_FAILED_${error.message}`);
}

export async function persistStaffAvatarUrl(
  supabase: SupabaseClient,
  opts: {
    stId: string;
    avatarUrl: string | null;
    asAdmin: boolean;
  },
): Promise<unknown> {
  const rpc = opts.asAdmin ? "update_staff_profile_admin" : "update_own_staff_profile";
  const { data, error } = await supabase.schema("clinic").rpc(rpc, {
    p_st_id: opts.stId,
    p_profile: { avatar_url: opts.avatarUrl },
  });
  if (error) throw new Error(`STAFF_AVATAR_RPC_FAILED_${error.message}`);
  return data;
}
