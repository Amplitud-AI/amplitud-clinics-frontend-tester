# Clinic knowledge — two-tier queue and staging

This describes the **clinic onboarding** path in Phase F (`KnowledgeRagPanel`), not the **Advanced** direct Agnentic F1/F2 calls.

## Flow

1. **F1 / F2 — Enqueue**  
   With Phase 0 Bearer (clinic **admin** JWT), anon key, and Phase B `cl_id`, you **POST** a row to `clinic.knowledge_change_requests` with `request_status = pending`.  
   - File path: inline `payload.text` (+ `source_filename`).  
   - URL path: `source_uri` + usually empty `payload` (worker downloads the URL unless you add inline `text`).

2. **Staging — Review and edit**  
   The tester loads the inserted row into the **staging** panel (title + payload JSON).  
   Adjust CSV/text in `payload.text`, fix JSON, or add fields the worker should see.  
   **Save draft** issues **PATCH** on the same row id (`payload`, `title`), keeping `request_status` as `pending`.

3. **F3 — Consume**  
   With `INTERNAL_SERVICE_KEY`, **Confirm & ingest** calls Agnentic `POST /admin/clinic-requests/consume/knowledge`.  
   The platform worker reads **pending** rows from clinic PostgREST and ingests using the **current** `payload` / `source_uri` on each row.

4. **F4 — Verify**  
   After a successful consume, the panel runs `GET /knowledge/test` (same as before).

## Database requirement (draft PATCH)

Clinic Supabase must allow **authenticated** clinic admins to **UPDATE** their own tenant’s **pending** rows.  
If **Save draft** returns 401/403, apply the migration in the main repo:

`agnentic_platform/supabase/clinic_supabase_project_identity_and_schemas/sql/23_knowledge_change_requests_admin_pending_update.sql`

That script **GRANT UPDATE** to `authenticated` and adds policy `knowledge_change_requests_admin_update_pending` (admin JWT, matching `cl_id`, `request_status = 'pending'` for both `USING` and `WITH CHECK`).

## Manual E2E checklist (edited payload reaches ingest)

Prerequisites: clinic admin JWT, anon key, `cl_id`, Agnentic running with `INTERNAL_SERVICE_KEY` matching the tester, migration **23** applied on the clinic project if PATCH was failing.

1. **Enqueue**  
   - Choose a small `.txt` or `.csv` file → **Enqueue file (F1)**.  
   - Confirm the log shows `201` / `200` and the staging panel shows `id: …` and payload JSON.

2. **Edit**  
   - In the payload textarea, change `text` to a distinctive string (e.g. append `E2E_STAGING_MARKER`).  
   - Optionally change **Title**.

3. **Save draft**  
   - Click **Save draft (PATCH)**.  
   - Expect success log with `PATCH` 200 and representation body matching your edits.

4. **Verify Supabase** (optional)  
   - In Supabase SQL editor or Table UI:  
     `select id, title, payload, request_status from clinic.knowledge_change_requests where id = '<staging id>';`  
   - Confirm `payload->>'text'` contains `E2E_STAGING_MARKER`.

5. **Reload from clinic** (optional)  
   - Click **Reload from clinic** — editor should match DB.

6. **Ingest**  
   - Set `INTERNAL_SERVICE_KEY`.  
   - Click **Confirm & ingest (F3→F4)**.  
   - Expect F3 success and F4 verification output.

7. **Assert consumed content**  
   - In platform world-state / knowledge tooling (or logs), confirm ingested content includes `E2E_STAGING_MARKER` (proves the worker used the **post-PATCH** payload, not the original file-only snapshot).

## UX notes

- **Unsaved edits**: **Confirm & ingest** is disabled while staging is dirty; **Save draft** first so the row in Supabase matches what you approve.  
- **Multiple pending rows**: The worker may process every `pending` row for `cl_id` in one consume. For isolated tests, use a dedicated clinic or clear old pendings.  
- **Clear staging (UI only)** does not delete the DB row; it only clears the local editor.

## Out of scope

- Changing `knowledge_change_requests` schema beyond PATCHable fields (`payload`, `title`, etc.).  
- Playwright automation (not installed in this package); use the checklist above or add `@playwright/test` later if you want scripted E2E.
