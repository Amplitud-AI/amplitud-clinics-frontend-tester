"use client";

import { LOGIN_PATH, signOutWithScope } from "@/lib/auth/sign-out";
import { createClient } from "@/lib/supabase/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agnenticFetch, agPath } from "@/lib/agnentic";
import {
  extractClIdFromJwtPayload,
  decodeJwtPayload,
} from "@/lib/jwt";
import ActiveSessionsPanel from "@/components/ActiveSessionsPanel";
import WhatsAppMcpSessionsPanel from "@/components/WhatsAppMcpSessionsPanel";
import StaffRosterPanel from "@/components/StaffRosterPanel";
import ClinicMembershipsPanel from "@/components/ClinicMembershipsPanel";
import PatientPreferredDoctorPanel from "@/components/PatientPreferredDoctorPanel";
import ClinicRagPanel from "@/components/ClinicRagPanel";
import PatientRagPanel from "@/components/PatientRagPanel";
import PreferencesSyncPanel from "@/components/PreferencesSyncPanel";
import OperatorClinicProvisionPanel, {
  type ProvisionSuccessPayload,
} from "@/components/OperatorClinicProvisionPanel";
import {
  AnnotationFrame,
  AnnotationLegend,
} from "@/components/FlowAnnotation";
import {
  AG_PREFIX,
  getAgnenticBaseUrl,
  getGoogleOauthReturnUrl,
  getSupabaseAnonKey,
  getSupabaseUrl,
  getWhatsAppServiceUrl,
} from "@/lib/config";

const LS_GATEWAY = "clinic_flow_gateway_user_id";

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

export default function FlowPlayground() {
  const supabaseUrl = getSupabaseUrl();
  const anon = getSupabaseAnonKey();
  const agBase = getAgnenticBaseUrl();

  const supabase = useMemo(() => {
    if (!supabaseUrl || !anon) return null;
    return createClient();
  }, [supabaseUrl, anon]);

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmailFromSession, setUserEmailFromSession] = useState<string | null>(
    null,
  );

  const [clIdOverride, setClIdOverride] = useState("");
  const [ownerLabel, setOwnerLabel] = useState("");
  const [gatewayUserId, setGatewayUserId] = useState("");
  const [lastGoogleAuthUrl, setLastGoogleAuthUrl] = useState<string | null>(null);
  const [mintTtl, setMintTtl] = useState("900");
  const [transportQs, setTransportQs] = useState("");
  const [waTransportSessionId, setWaTransportSessionId] = useState("");
  const [tpSender, setTpSender] = useState("");
  const [tpReply, setTpReply] = useState("");
  const [tpPauseSkip, setTpPauseSkip] = useState("");
  const [tpUseStaffDir, setTpUseStaffDir] = useState("");
  const [tpStaffIgnoreJson, setTpStaffIgnoreJson] = useState("");
  const [showAnnotations, setShowAnnotations] = useState(true);

  const [rawMethod, setRawMethod] = useState("GET");
  const [rawPath, setRawPath] = useState(
    `${AG_PREFIX}/clinic-access-smoke/cl_demo1`,
  );
  const [rawBody, setRawBody] = useState('{\n  "ttl_seconds": 900\n}');

  const [pgPath, setPgPath] = useState(
    "rest/v1/staff?select=st_id,display_name,email,role,status&limit=10",
  );

  const [log, setLog] = useState("");

  const append = useCallback((title: string, body: string) => {
    setLog((prev) => `${prev}\n\n--- ${title} ---\n${body}`.trimStart());
  }, []);

  const bearer = accessToken;

  const jwtPayload = useMemo(
    () => (bearer ? decodeJwtPayload(bearer) : null),
    [bearer],
  );
  const clIdFromJwt = useMemo(
    () => extractClIdFromJwtPayload(jwtPayload),
    [jwtPayload],
  );
  const effectiveClId = useMemo(
    () => (clIdOverride || clIdFromJwt || "").trim(),
    [clIdOverride, clIdFromJwt],
  );

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
      setUserEmailFromSession(data.session?.user?.email ?? null);
    });
    const sub = supabase.auth.onAuthStateChange((_e, session) => {
      setAccessToken(session?.access_token ?? null);
      setUserEmailFromSession(session?.user?.email ?? null);
    });
    return () => sub.data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const g = localStorage.getItem(LS_GATEWAY);
        if (g) setGatewayUserId(g);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const persistGateway = (id: string) => {
    setGatewayUserId(id);
    try {
      localStorage.setItem(LS_GATEWAY, id);
    } catch {
      /* ignore */
    }
  };

  const signOutLocal = async () => {
    if (!supabase) return;
    const { error } = await signOutWithScope(supabase, "local");
    if (error) {
      append("signOut(local)", error.message);
      return;
    }
    append("signOut(local)", "ok — other tabs/sessions stay alive; redirecting to /login");
    window.location.href = LOGIN_PATH;
  };

  const signOutGlobal = async () => {
    if (!supabase) return;
    const { error } = await signOutWithScope(supabase, "global");
    if (error) {
      append("signOut(global)", error.message);
      return;
    }
    append(
      "signOut(global)",
      "WARNING: all Supabase sessions for this user are revoked project-wide — redirecting to /login",
    );
    window.location.href = LOGIN_PATH;
  };

  const runSmokeWithClId = useCallback(
    async (cid: string, bearerOverride?: string | null) => {
      const t = cid.trim();
      if (!t) return append("smoke", "Missing cl_id");
      const token = (bearerOverride ?? bearer)?.trim();
      if (!token) return append("smoke", "Need access token");
      const path = agPath(`/clinic-access-smoke/${encodeURIComponent(t)}`);
      const r = await agnenticFetch(path, { method: "GET", bearer: token });
      append(
        `GET clinic-access-smoke (${r.status})`,
        r.json != null ? pretty(r.json) : r.text,
      );
    },
    [append, bearer],
  );

  const runSmoke = useCallback(async () => {
    const cid = (clIdOverride || clIdFromJwt || "").trim();
    if (!cid) {
      return append(
        "smoke",
        "Set cl_id override, complete Phase A (prefills), or sign in with JWT that has app_metadata.cl_id",
      );
    }
    await runSmokeWithClId(cid);
  }, [clIdOverride, clIdFromJwt, append, runSmokeWithClId]);

  const refreshClinicJwt = useCallback(async () => {
    if (!supabase) return append("refreshSession", "Configure Supabase URL + anon key");
    const { data, error } = await supabase.auth.refreshSession();
    if (error) {
      append("refreshSession", pretty(error));
      return;
    }
    append(
      "refreshSession",
      data.session?.access_token
        ? "New access token minted (Custom Access Token Hook re-runs on refresh)."
        : "No session returned",
    );
  }, [append, supabase]);

  const switchActiveClinic = useCallback(
    async (nextClId: string) => {
      if (!supabase) return append("clinic switch", "Configure Supabase URL + anon key");
      const clId = nextClId.trim();
      if (!clId) return append("clinic switch", "Missing cl_id");
      const update = await supabase.auth.updateUser({ data: { active_cl_id: clId } });
      if (update.error) return append("updateUser active_cl_id", pretty(update.error));
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.error) return append("refreshSession after switch", pretty(refreshed.error));
      setClIdOverride("");
      setAccessToken(refreshed.data.session?.access_token ?? null);
      append(
        "clinic switch",
        `Requested active_cl_id=${clId}; refreshed JWT so app_metadata.cl_id/role/capabilities are re-scoped by the access-token hook.`,
      );
    },
    [append, supabase],
  );

  const handleProvisionSuccess = useCallback(
    async (payload: ProvisionSuccessPayload) => {
      setClIdOverride(payload.cl_id);
      append("Phase B (from Phase A)", `Prefilled cl_id ${payload.cl_id}.`);
      if (!supabase) {
        append("Phase B", "No Supabase client — sign in, then GET clinic-access-smoke.");
        return;
      }
      const { data: cur } = await supabase.auth.getSession();
      if (!cur.session) {
        append("Phase B", "No Phase 0 session — sign in, then GET clinic-access-smoke.");
        return;
      }
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        append("refreshSession (after Phase A)", pretty(error));
        return;
      }
      const newToken = data.session?.access_token;
      if (!newToken) {
        append("refreshSession (after Phase A)", "No access_token after refresh");
        return;
      }
      append(
        "refreshSession (after Phase A)",
        "Minted new JWT so hook-injected app_metadata.cl_id is present before smoke.",
      );
      await runSmokeWithClId(payload.cl_id, newToken);
    },
    [append, supabase, runSmokeWithClId],
  );

  const oauthStart = async () => {
    setLastGoogleAuthUrl(null);
    if (!bearer) return append("oauth/start", "Need access token");
    const origin =
      typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    const redirect = getGoogleOauthReturnUrl(origin);
    if (redirect.includes("?")) {
      append("oauth/start", "Redirect URL must not contain ? (gateway appends query)");
      return;
    }
    const path = agPath("/calendar/google/oauth/start");
    const r = await agnenticFetch(path, {
      method: "POST",
      bearer,
      body: JSON.stringify({
        redirect_to_app_url: redirect,
        owner_label: ownerLabel.trim() || undefined,
      }),
    });
    append(`POST oauth/start (${r.status})`, r.json != null ? pretty(r.json) : r.text);
    if (r.json && typeof r.json === "object" && r.json !== null) {
      const row = r.json as Record<string, unknown>;
      const g = row.gateway_user_id;
      const authUrl = row.auth_url;
      if (typeof g === "string") persistGateway(g);
      if (r.ok && typeof authUrl === "string" && authUrl.trim()) {
        setLastGoogleAuthUrl(authUrl.trim());
      }
    }
  };

  const oauthFinalize = async (status: "success" | "failure") => {
    if (!bearer) return append("oauth/finalize", "Need access token");
    const gw = gatewayUserId.trim();
    if (!gw) return append("oauth/finalize", "Set gateway_user_id (from start or callback URL)");
    const path = agPath("/calendar/google/oauth/finalize");
    const r = await agnenticFetch(path, {
      method: "POST",
      bearer,
      body: JSON.stringify({ gateway_user_id: gw, status }),
    });
    append(`POST oauth/finalize (${r.status})`, r.json != null ? pretty(r.json) : r.text);
  };

  const mintWa = async () => {
    if (!bearer) return append("whatsapp/mint", "Need access token");
    const ttl = Number(mintTtl) || 900;
    const path = agPath("/clinic/whatsapp/mint-onboarding-token");
    const r = await agnenticFetch(path, {
      method: "POST",
      bearer,
      body: JSON.stringify({ ttl_seconds: ttl }),
    });
    append(`POST mint-onboarding-token (${r.status})`, r.json != null ? pretty(r.json) : r.text);
  };

  const transportSnapshot = async () => {
    if (!bearer) return append("transport", "Need access token");
    const cid = (clIdOverride || clIdFromJwt || "").trim();
    let path = agPath("/clinic/whatsapp/transport-runtime-settings");
    const qs = transportQs.trim();
    if (qs) path += qs.startsWith("?") ? qs : `?${qs}`;
    else if (cid) path += `?cl_id=${encodeURIComponent(cid)}`;
    const r = await agnenticFetch(path, { method: "GET", bearer });
    append(`GET transport-runtime-settings (${r.status})`, r.json != null ? pretty(r.json) : r.text);
  };

  const patchTransportPolicy = async () => {
    if (!bearer) return append("transport-policy", "Need access token");
    const sid = waTransportSessionId.trim();
    const body: Record<string, unknown> = {};
    if (sid) body.session_id = sid;
    if (tpSender) body.sender_filter_mode = tpSender;
    if (tpReply) body.reply_mode = tpReply;
    if (tpPauseSkip === "true") body.pause_skip_agent_execution = true;
    if (tpPauseSkip === "false") body.pause_skip_agent_execution = false;
    if (tpUseStaffDir === "true") body.use_verified_staff_whatsapp_directory = true;
    if (tpUseStaffDir === "false") body.use_verified_staff_whatsapp_directory = false;
    const ignRaw = tpStaffIgnoreJson.trim();
    if (ignRaw) {
      try {
        const arr = JSON.parse(ignRaw) as unknown;
        if (!Array.isArray(arr)) throw new Error("staff_ignore_e164 must be a JSON array of strings");
        body.staff_ignore_e164 = arr;
      } catch (e) {
        return append(
          "transport-policy",
          e instanceof Error ? e.message : "invalid staff_ignore JSON",
        );
      }
    }
    const patchKeys = Object.keys(body).filter((k) => k !== "session_id");
    if (patchKeys.length === 0) {
      return append(
        "transport-policy",
        "Choose at least one field (sender/reply/toggles) or paste staff_ignore JSON (e.g. [\"+5212345678900\"]).",
      );
    }
    const path = agPath("/clinic/whatsapp/transport-policy");
    const r = await agnenticFetch(path, {
      method: "PATCH",
      bearer,
      body: JSON.stringify(body),
    });
    append(
      `PATCH transport-policy (${r.status})`,
      r.json != null ? pretty(r.json) : r.text,
    );
  };

  const rawCall = async () => {
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const init: RequestInit = { method: rawMethod };
    if (rawMethod !== "GET" && rawMethod !== "HEAD" && rawBody.trim()) {
      init.body = rawBody;
    }
    const r = await agnenticFetch(path, {
      ...init,
      bearer: bearer?.trim() ? bearer : undefined,
    });
    append(`${rawMethod} raw (${r.status})`, r.json != null ? pretty(r.json) : r.text);
  };

  const postgrestProbe = async () => {
    if (!bearer) return append("postgrest", "Need clinic JWT");
    const base = supabaseUrl.replace(/\/$/, "");
    const path = pgPath.includes("rest/") ? pgPath : `rest/v1/${pgPath}`;
    const url = `${base}/${path.replace(/^\//, "")}`;
    const r = await fetch(url, {
      headers: {
        apikey: anon,
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        // Staff + org data live in schema `clinic` (see agnentic_platform supabase clinic DDL), not public.
        "Accept-Profile": "clinic",
        "Content-Profile": "clinic",
      },
    });
    const text = await r.text();
    let j: unknown = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = text;
    }
    append(`PostgREST ${r.status} ${url}`, pretty(j));
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 text-sm">
      <header>
        <h1 className="text-xl font-semibold">
          Clinic onboarding API flow{" "}
          <span className="text-amber-700 dark:text-amber-400">[SSR auth build v2]</span>
        </h1>
        <p className="text-zinc-500 mt-1">
          Flow order: <strong>Phase 0</strong> sign in at <code className="text-xs">/login</code> (SSR cookies),{" "}
          <strong>Phase A</strong> operator clinic create,{" "}
          <strong>Phase B</strong> smoke, optional Google OAuth, <strong>Phase C</strong> WhatsApp MCP (QR),{" "}
          <strong>Phase D</strong> mint/snapshot/PATCH transport (after MCP; <code className="text-xs">wa_browser_session_id</code>{" "}
          prefilled from session create), <strong>Phase E</strong> staff roster / silent list,{" "}
          <strong>Phase F</strong> platform knowledge ingest / queue drain, <strong>Phase G</strong> org preferences
          (queue → main; <code className="text-xs">PreferencesSyncPanel</code> below). Canonical doc{" "}
          <code className="text-xs">clinic_onboarding_sequence_flow</code>. Paste{" "}
          <code className="text-xs">WHATSAPP_SESSIONS_API_KEY</code> for registry routes;{" "}
          <code className="text-xs">CLINIC_PROVISIONING_SECRET</code> only in Phase A (never{" "}
          <code className="text-xs">NEXT_PUBLIC_*</code>).
        </p>
      </header>

      <AnnotationLegend enabled={showAnnotations} onToggle={setShowAnnotations} />

      <AnnotationFrame
        enabled={showAnnotations}
        kind="dev"
        title="Environment diagnostics"
        note="The keys exist because each backend has a different trust boundary: public Supabase anon key for RLS calls, clinic JWT for tenant identity, provisioning secret for clinic creation, internal service key for workers, and WhatsApp sessions key for QR/session control. Only public env vars and user JWTs belong in the browser."
      >
        <section className="border border-zinc-300 dark:border-zinc-600 rounded p-4 space-y-2">
          <h2 className="font-medium">Config</h2>
          <ul className="list-disc pl-5 text-zinc-600 dark:text-zinc-400">
            <li>Supabase URL: {supabaseUrl ? "✓" : "✗"}</li>
            <li>Anon key: {anon ? "✓" : "✗"}</li>
            <li>Agnentic base: {agBase}</li>
            <li>
              WhatsApp MCP (nextjs-whatsapp-service):{" "}
              <span className="font-mono">{getWhatsAppServiceUrl()}</span>
            </li>
            <li>Route prefix: {AG_PREFIX}</li>
          </ul>
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Required first login"
        note="Phase 0 cannot be skipped. The clinic admin signs in with OTP before provisioning and every later admin session."
      >
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">Phase 0 — Supabase session (SSR cookies)</h2>
          {!supabase && <p className="text-red-600">Fix NEXT_PUBLIC_SUPABASE_* in `.env`</p>}
          <p className="text-xs text-zinc-500">
            Sign-in uses <code className="text-xs">/login</code> +{" "}
            <code className="text-xs">@supabase/ssr</code> cookies and middleware — same pattern as clinics control.
            Middleware sent you here only after a valid session exists.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              className="border px-3 py-1 rounded"
              onClick={() => void signOutLocal()}
            >
              Log out here
            </button>
            <button
              type="button"
              className="border border-amber-700 px-3 py-1 rounded text-amber-900"
              onClick={() => void signOutGlobal()}
            >
              Log out everywhere
            </button>
            <button type="button" className="border px-3 py-1 rounded text-sm" onClick={() => void refreshClinicJwt()}>
              Refresh JWT
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            After staff is linked or provisioning changes, use <strong>Refresh JWT</strong> (or sign out and sign in
            again at <code className="text-xs">/login</code>) so the Custom Access Token Hook re-runs before registry
            smoke.
          </p>
          <p>
            Session:{" "}
            <span className="font-mono text-xs">{bearer ? "Bearer present" : "none"}</span>
          </p>
          {jwtPayload && (
            <pre className="bg-zinc-100 dark:bg-zinc-900 p-2 overflow-auto text-xs max-h-48">
              {pretty(jwtPayload)}
            </pre>
          )}
          <ActiveSessionsPanel supabase={supabase} bearer={bearer} onLog={append} />
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Required tenant creation"
        note="The real form asks for clinic name and admin email once; the provisioning secret and raw POST stay behind your backend."
      >
        <OperatorClinicProvisionPanel
          suggestedAdminEmail={userEmailFromSession}
          onLog={append}
          onProvisionSuccess={handleProvisionSuccess}
        />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Verify after provision"
        note="This is a real safety check, but production should run refresh + smoke automatically instead of showing a debug button."
      >
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">Phase B — Registry smoke</h2>
          <p className="text-xs text-zinc-500">
            After Phase A, this app calls <code className="text-xs">refreshSession</code> then smoke so the new access
            token includes <code className="text-xs">app_metadata.cl_id</code>. Use Phase 0 → <strong>Refresh JWT</strong>{" "}
            if smoke still fails.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="border px-2 py-1 flex-1 min-w-[200px]"
              placeholder={`cl_id (default from JWT: ${clIdFromJwt ?? "—"})`}
              value={clIdOverride}
              onChange={(e) => setClIdOverride(e.target.value)}
            />
            <button type="button" className="border px-3 py-1 rounded" onClick={() => void runSmoke()}>
              GET clinic-access-smoke
            </button>
          </div>
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Clinic memberships"
        note="Display names are not in the JWT. This calls the backend memberships endpoint and switches clinics by updating user_metadata.active_cl_id, then refreshing the JWT."
      >
        <ClinicMembershipsPanel
          bearer={bearer}
          jwtPayload={jwtPayload}
          activeClId={effectiveClId}
          onSwitchClinic={switchActiveClinic}
          onLog={append}
        />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Calendar connection"
        note="Clinic admin can connect Google Calendar; finalize/debug controls can be hidden behind the normal OAuth return flow."
      >
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">Optional — Google Calendar OAuth (Agnentic)</h2>
          <p className="text-zinc-500">
            Redirect target: <code className="text-xs">/oauth/callback</code> on this origin (no query in base URL).{" "}
            This is where Google sends the user back <em>after</em> OAuth; gateway uses its own Google{" "}
            <code className="text-xs">redirect_uri</code> (often <code className="text-xs">…/oauth/callback</code>{" "}
            on the gateway host).
          </p>
          <input
            className="border px-2 py-1 w-full"
            placeholder="owner_label (optional)"
            value={ownerLabel}
            onChange={(e) => setOwnerLabel(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="border px-3 py-1 rounded" onClick={() => void oauthStart()}>
              POST oauth/start
            </button>
          </div>
          {lastGoogleAuthUrl && (
            <div className="rounded border border-emerald-600/40 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 space-y-2">
              <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">Google consent URL (from response)</p>
              <a
                className="text-xs font-mono break-all text-blue-600 dark:text-blue-400 underline"
                href={lastGoogleAuthUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {lastGoogleAuthUrl}
              </a>
            </div>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="border px-2 py-1 flex-1 font-mono text-xs"
              placeholder="gateway_user_id"
              value={gatewayUserId}
              onChange={(e) => setGatewayUserId(e.target.value)}
            />
            <button type="button" className="border px-3 py-1 rounded" onClick={() => oauthFinalize("success")}>
              Finalize success
            </button>
            <button type="button" className="border px-3 py-1 rounded" onClick={() => oauthFinalize("failure")}>
              Finalize failure
            </button>
          </div>
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="WhatsApp connect and behavior"
        note="This is one real clinic onboarding area: first connect WhatsApp and scan QR, then configure behavior. The token/session/poll steps are real but automated behind the Connect button."
      >
        <div className="rounded border border-lime-300 bg-lime-50/40 p-3 text-xs dark:border-lime-700 dark:bg-lime-950/20">
          <p className="font-medium">Correct production order</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">
            <li>Clinic admin clicks <strong>Connect WhatsApp</strong>.</li>
            <li>Server calls <code>POST clinic/whatsapp/mint-onboarding-token</code> with <code>ttl_seconds</code>.</li>
            <li>Server creates the WhatsApp session and polls for QR automatically.</li>
            <li>Clinic admin scans the QR and sees connected/ready status.</li>
            <li>Clinic admin configures reply mode, staff filtering, and pause behavior.</li>
            <li>Server resolves session IDs and transport snapshots; clinic never handles raw keys or opaque tokens.</li>
          </ol>
        </div>
        <WhatsAppMcpSessionsPanel
          mintTtl={mintTtl}
          showAnnotations={showAnnotations}
          onMintTtlChange={setMintTtl}
          onMintWa={mintWa}
          onLog={append}
          onSessionBound={(id) => {
            setWaTransportSessionId(id);
            append("Phase D prefill", `wa_browser_session_id from MCP session create → ${id}`);
          }}
        />
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">Phase D — WhatsApp staff APIs + transport policy</h2>
          <AnnotationFrame
            enabled={showAnnotations}
            kind="automated"
            title="Transport snapshot"
            note="This is backend/session plumbing used after connection. Production should resolve it behind server routes, not as a clinic-facing control."
          >
            <div className="flex flex-wrap gap-2 items-center">
              <input
                className="border px-2 py-1 flex-1 font-mono text-xs"
                placeholder="extra query e.g. agent_phone_e164=%2B1... (optional)"
                value={transportQs}
                onChange={(e) => setTransportQs(e.target.value)}
              />
              <button type="button" className="border px-3 py-1 rounded" onClick={transportSnapshot}>
                GET transport-runtime-settings
              </button>
            </div>
          </AnnotationFrame>
          <p className="text-xs text-zinc-500">
            <strong>Clinic admin only:</strong> PATCH updates{" "}
            <code className="text-xs">whatsapp_agent_sessions.metadata.transport</code> for the active binding; DB triggers
            mirror into <code className="text-xs">whatsapp_agent_transport_policy</code> / extra-ignore. After Phase C,
            <code className="text-xs"> wa_browser_session_id</code> is prefilled from the MCP{" "}
            <code className="text-xs">POST …/sessions</code> response (not the registry UUID). You may clear the field —
            PATCH can omit <code className="text-xs">session_id</code> and the server resolves the latest active binding.
          </p>
          <AnnotationFrame
            enabled={showAnnotations}
            kind="automated"
            title="Session binding"
            note="The browser session ID comes from the QR/session create step. Production should keep and resolve it automatically before saving transport policy."
          >
            <input
              className="border px-2 py-1 w-full font-mono text-xs"
              placeholder="wa_browser_session_id (e.g. wa-7836b2ba…)"
              value={waTransportSessionId}
              onChange={(e) => setWaTransportSessionId(e.target.value)}
            />
          </AnnotationFrame>
          <AnnotationFrame
            enabled={showAnnotations}
            kind="clinic"
            title="Clinic-facing behavior choices"
            note="These are the settings the clinic admin can actually choose after WhatsApp is connected."
          >
          <div className="flex flex-wrap gap-2 items-end">
            <select
              className="border px-2 py-1 text-xs"
              value={tpSender}
              onChange={(e) => setTpSender(e.target.value)}
              aria-label="sender_filter_mode"
            >
              <option value="">sender: (no change)</option>
              <option value="off">off</option>
              <option value="legacy_allowlist">legacy_allowlist</option>
              <option value="staff_ignore">staff_ignore</option>
            </select>
            <select
              className="border px-2 py-1 text-xs"
              value={tpReply}
              onChange={(e) => setTpReply(e.target.value)}
              aria-label="reply_mode"
            >
              <option value="">reply: (no change)</option>
              <option value="auto_reply">auto_reply</option>
              <option value="silent_capture">silent_capture</option>
            </select>
            <select
              className="border px-2 py-1 text-xs"
              value={tpPauseSkip}
              onChange={(e) => setTpPauseSkip(e.target.value)}
              aria-label="pause_skip_agent_execution"
            >
              <option value="">pause_skip: (no change)</option>
              <option value="true">pause_skip: true</option>
              <option value="false">pause_skip: false</option>
            </select>
            <select
              className="border px-2 py-1 text-xs"
              value={tpUseStaffDir}
              onChange={(e) => setTpUseStaffDir(e.target.value)}
              aria-label="use_verified_staff_whatsapp_directory"
            >
              <option value="">use staff dir: (no change)</option>
              <option value="true">use staff dir: true</option>
              <option value="false">use staff dir: false</option>
            </select>
          </div>
          <textarea
            className="border w-full font-mono text-xs p-2 min-h-[52px]"
            placeholder='Optional staff_ignore_e164 JSON array, e.g. ["+5215512345678"] or [] to clear'
            value={tpStaffIgnoreJson}
            onChange={(e) => setTpStaffIgnoreJson(e.target.value)}
          />
          <button type="button" className="border px-3 py-1 rounded" onClick={() => void patchTransportPolicy()}>
            PATCH clinic/whatsapp/transport-policy
          </button>
          </AnnotationFrame>
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Staff and team"
        note="Real clinic onboarding needs invites, roster review, and WhatsApp channel links for staff."
      >
        <StaffRosterPanel supabase={supabase} bearer={bearer} effectiveClId={effectiveClId} onLog={append} />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Patients and preferred doctor"
        note="This is real clinic onboarding data; patient names are shown in UI, but APIs must keep using pt_id."
      >
        <PatientPreferredDoctorPanel
          bearer={bearer}
          effectiveClId={effectiveClId}
          onLog={append}
        />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Clinic knowledge"
        note="Real frontend surface for clinic-wide RAG. Upload/enqueue is green; server consume and staging review are grey/dev controls."
      >
        <ClinicRagPanel bearer={bearer} effectiveClId={effectiveClId} onLog={append} />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="Patient knowledge"
        note="Real frontend surface, separate from clinic knowledge. A patient must be selected before upload."
      >
        <PatientRagPanel bearer={bearer} effectiveClId={effectiveClId} onLog={append} />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Preferences sync"
        note="Settings edits are real clinic UI, but consume/sync is server-side; the product should show Saved after enqueue."
      >
        <PreferencesSyncPanel bearer={bearer} effectiveClId={effectiveClId} onLog={append} />
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="dev"
        title="PostgREST probe"
        note="A tester-only RLS/debug tool. The real clinic frontend should call specific screens, not expose arbitrary paths."
      >
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">PostgREST (RLS) — same Supabase project</h2>
          <p className="text-xs text-zinc-500">
            Probes send <code className="text-xs">Accept-Profile: clinic</code> — roster is{" "}
            <code className="text-xs">clinic.staff</code> (not <code className="text-xs">public.staff</code>). Expose
            schema <code className="text-xs">clinic</code> in Supabase → Settings → Data API.
          </p>
          <input
            className="border px-2 py-1 w-full font-mono text-xs"
            value={pgPath}
            onChange={(e) => setPgPath(e.target.value)}
          />
          <button type="button" className="border px-3 py-1 rounded" onClick={postgrestProbe}>
            GET (apikey + Bearer session)
          </button>
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="dev"
        title="Raw API console"
        note="Pure dev/test affordance. Do not include arbitrary Agnentic calls in the real clinic onboarding UI."
      >
        <section className="border border-zinc-300 rounded p-4 space-y-3">
          <h2 className="font-medium">Raw Agnentic call</h2>
          <p className="text-xs text-zinc-500">
            Adds Authorization only when a Supabase session exists (Phase 0).
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              className="border px-2 py-1"
              value={rawMethod}
              onChange={(e) => setRawMethod(e.target.value)}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="border px-2 py-1 flex-1 min-w-[200px] font-mono text-xs"
              value={rawPath}
              onChange={(e) => setRawPath(e.target.value)}
            />
            <button type="button" className="border px-3 py-1 rounded" onClick={rawCall}>
              Send
            </button>
          </div>
          <textarea
            className="border w-full font-mono text-xs p-2 min-h-[100px]"
            value={rawBody}
            onChange={(e) => setRawBody(e.target.value)}
          />
        </section>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="dev"
        title="Tester log"
        note="Useful while validating endpoints, but not a product surface for clinic staff."
      >
        <section className="border border-zinc-300 rounded p-4">
          <h2 className="font-medium mb-2">Log</h2>
          <textarea
            readOnly
            className="w-full font-mono text-xs p-2 min-h-[280px] bg-zinc-50 dark:bg-zinc-950"
            value={log}
          />
          <button type="button" className="mt-2 border px-3 py-1 rounded" onClick={() => setLog("")}>
            Clear log
          </button>
        </section>
      </AnnotationFrame>
    </div>
  );
}
