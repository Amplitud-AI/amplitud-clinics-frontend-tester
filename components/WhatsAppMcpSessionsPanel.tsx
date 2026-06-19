"use client";

import { useCallback, useEffect, useState } from "react";
import { AnnotationFrame } from "@/components/FlowAnnotation";
import { waApiBase } from "@/lib/whatsapp-service-client";

const LS_KEY = "clinic_flow_wa_sessions_api_key";

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

async function waSessionRequest(
  path: string,
  options: {
    sessionsKey: string;
    staffBearer?: string | null;
    method?: string;
    body?: string;
  },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = waApiBase();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers();
  const sk = options.sessionsKey.trim();
  if (sk) headers.set("Authorization", `Bearer ${sk}`);
  const sb = options.staffBearer?.trim();
  if (sb) headers.set("X-Clinic-Supabase-Authorization", `Bearer ${sb}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function extractQrFromSessionStatus(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object") return null;
  const wa = (data as Record<string, unknown>).whatsapp;
  if (!wa || typeof wa !== "object") return null;
  const qc = (wa as Record<string, unknown>).qrCode;
  return typeof qc === "string" && qc.trim() ? qc : null;
}

export type WhatsAppMcpSessionsPanelProps = {
  mintTtl: string;
  showAnnotations?: boolean;
  onMintTtlChange: (value: string) => void;
  onMintWa: () => void;
  onLog: (title: string, body: string) => void;
  /** Fired when POST /api/whatsapp/sessions returns ``wa_browser_session_id`` (transport PATCH / Phase D). */
  onSessionBound?: (waBrowserSessionId: string) => void;
};

export default function WhatsAppMcpSessionsPanel({
  mintTtl,
  showAnnotations = false,
  onMintTtlChange,
  onMintWa,
  onLog,
  onSessionBound,
}: WhatsAppMcpSessionsPanelProps) {
  const [sessionsApiKey, setSessionsApiKey] = useState("");
  const [opaqueToken, setOpaqueToken] = useState("");
  const [registryId, setRegistryId] = useState("");
  const [pollQr, setPollQr] = useState<string | null>(null);
  const [pollJson, setPollJson] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const k = localStorage.getItem(LS_KEY);
        if (k) setSessionsApiKey(k);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const saveKeyLocal = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, sessionsApiKey);
      onLog("WhatsApp sessions API key", "Saved in localStorage (this browser only).");
    } catch (e) {
      onLog("WhatsApp sessions key save failed", String(e));
    }
  }, [sessionsApiKey, onLog]);

  const createRegistrySession = useCallback(async () => {
    const tok = opaqueToken.trim();
    if (!tok) {
      onLog("POST /api/whatsapp/sessions", "Set opaque_token from POST clinic/whatsapp/mint-onboarding-token.");
      return;
    }
    onLog("POST /api/whatsapp/sessions", `onboarding_token len=${tok.length}`);
    const r = await waSessionRequest("/api/whatsapp/sessions", {
      sessionsKey: sessionsApiKey,
      method: "POST",
      body: JSON.stringify({ onboarding_token: tok }),
    });
    onLog(`sessions create (${r.status})`, pretty(r.json));
    if (r.ok && r.json && typeof r.json === "object") {
      const d = (r.json as Record<string, unknown>).data;
      if (d && typeof d === "object") {
        const row = d as Record<string, unknown>;
        const sid = row.session_id;
        if (typeof sid === "string") setRegistryId(sid);
        const wa = row.wa_browser_session_id;
        if (typeof wa === "string" && wa.trim()) {
          const w = wa.trim();
          onLog("wa_browser_session_id (from 201)", w);
          onSessionBound?.(w);
        }
      }
    }
  }, [opaqueToken, onLog, onSessionBound, sessionsApiKey]);

  const listSessions = useCallback(async () => {
    const r = await waSessionRequest("/api/whatsapp/sessions", {
      sessionsKey: sessionsApiKey,
    });
    onLog(`GET /api/whatsapp/sessions (${r.status})`, pretty(r.json));
  }, [onLog, sessionsApiKey]);

  const pollOneStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      const id = registryId.trim();
      if (!id) {
        if (!opts?.silent) onLog("registry status", "Set registry session_id.");
        return;
      }
      const r = await waSessionRequest(`/api/whatsapp/sessions/${encodeURIComponent(id)}/status`, {
        sessionsKey: sessionsApiKey,
      });
      setPollJson(pretty(r.json));
      const qr = extractQrFromSessionStatus(r.json);
      setPollQr(qr);
      if (!opts?.silent) {
        onLog(
          `GET …/sessions/${id}/status (${r.status})`,
          qr ? "qrCode in payload (see QR below)" : pretty(r.json).slice(0, 2000),
        );
      }
    },
    [registryId, onLog, sessionsApiKey],
  );

  const deleteSession = useCallback(async () => {
    const id = registryId.trim();
    if (!id) return;
    const r = await waSessionRequest(`/api/whatsapp/sessions/${encodeURIComponent(id)}`, {
      sessionsKey: sessionsApiKey,
      method: "DELETE",
    });
    onLog(`DELETE session (${r.status})`, pretty(r.json));
  }, [registryId, onLog, sessionsApiKey]);

  const logoutAll = useCallback(async () => {
    const r = await waSessionRequest("/api/whatsapp/sessions/logout-all", {
      sessionsKey: sessionsApiKey,
      method: "POST",
      body: "{}",
    });
    onLog(`POST logout-all (${r.status})`, pretty(r.json));
  }, [onLog, sessionsApiKey]);

  useEffect(() => {
    if (!registryId.trim()) return;
    const t0 = window.setTimeout(() => {
      void pollOneStatus();
    }, 0);
    const iv = window.setInterval(() => {
      void pollOneStatus({ silent: true });
    }, 3500);
    return () => {
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, [registryId, pollOneStatus]);

  return (
    <section className="border border-zinc-300 rounded p-4 space-y-3">
      <h2 className="font-medium">Phase C — WhatsApp MCP — clinic registry (nextjs-whatsapp-service)</h2>
      <p className="text-xs text-zinc-500">
        Staff mint: sessions <code>Authorization</code> +{" "}
        <code>X-Clinic-Supabase-Authorization</code> (staff JWT). Then create registry session and poll
        QR — same wiring as CA-1 + multi-session onboarding.
      </p>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="clinic"
        title="What clinic sees"
        note="The real frontend should reduce this whole chain to one Connect WhatsApp button, then a loading state, then the QR code to scan."
      >
        <div className="rounded border border-lime-300 bg-lime-50/40 p-3 text-xs dark:border-lime-700 dark:bg-lime-950/20">
          <p className="font-medium">Clinic-facing UX target</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">
            Click <strong>Connect WhatsApp</strong> → backend mints token, creates session, polls status → show QR.
          </p>
        </div>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Server secret for WhatsApp service"
        note="WHATSAPP_SESSIONS_API_KEY proves your backend may create/list/delete WhatsApp browser sessions. It must stay server-side; this local input is only for the tester."
      >
        <div className="space-y-1">
          <span className="text-xs font-medium block">Sessions API key (Bearer)</span>
          <input
            type="password"
            autoComplete="off"
            className="border px-2 py-1 w-full font-mono text-xs"
            placeholder="WHATSAPP_SESSIONS_API_KEY or empty if dev allows unauthenticated"
            value={sessionsApiKey}
            onChange={(e) => setSessionsApiKey(e.target.value)}
          />
          <button type="button" className="border px-2 py-1 text-xs rounded" onClick={saveKeyLocal}>
            Save key locally
          </button>
        </div>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="dev"
        title="Optional session inspection"
        note="Session listing is operator/debug only. The actual mint step is Agnentic POST clinic/whatsapp/mint-onboarding-token with ttl_seconds."
      >
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" className="border px-3 py-1 rounded" onClick={() => void listSessions()}>
            List sessions
          </button>
        </div>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Step 1: Agnentic mint token"
        note="This belongs before opaque_token. The backend verifies the clinic admin JWT and mints the short-lived opaque token with ttl_seconds."
      >
        <div className="flex flex-wrap gap-2 items-center">
          <label className="flex items-center gap-1">
            ttl_seconds
            <input
              className="border px-2 py-1 w-24"
              value={mintTtl}
              onChange={(e) => onMintTtlChange(e.target.value)}
            />
          </label>
          <button type="button" className="border px-3 py-1 rounded" onClick={onMintWa}>
            POST clinic/whatsapp/mint-onboarding-token
          </button>
        </div>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Opaque token"
        note="Paste the opaque_token returned by Agnentic POST clinic/whatsapp/mint-onboarding-token in this tester. In production, the server passes it directly into POST sessions."
      >
        <div className="space-y-1">
          <span className="text-xs font-medium block">opaque_token</span>
          <textarea
            className="border w-full font-mono text-xs p-2 min-h-[56px]"
            value={opaqueToken}
            onChange={(e) => setOpaqueToken(e.target.value)}
          />
        </div>
      </AnnotationFrame>

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Create session and poll QR"
        note="The backend should call POST sessions, keep the registry session_id, and poll status until qrCode appears."
      >
        <div className="flex flex-wrap gap-2">
          <button type="button" className="border px-3 py-1 rounded" onClick={() => void createRegistrySession()}>
            POST sessions (create registry row)
          </button>
          <input
            className="border px-2 py-1 flex-1 min-w-[160px] font-mono text-xs"
            placeholder="registry session_id"
            value={registryId}
            onChange={(e) => setRegistryId(e.target.value)}
          />
          <button type="button" className="border px-3 py-1 rounded" onClick={() => void pollOneStatus()}>
            Poll status now
          </button>
        </div>
      </AnnotationFrame>

      {pollQr && (
        <div className="text-center space-y-2">
          <p className="text-sm font-medium">Registry QR</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL QR */}
          <img src={pollQr} alt="Registry QR" className="mx-auto border bg-white max-w-[280px]" />
        </div>
      )}

      {pollJson && (
        <AnnotationFrame
          enabled={showAnnotations}
          kind="dev"
          title="Status JSON"
          note="The real frontend should render status/QR, not raw WhatsApp service JSON."
        >
          <details className="text-xs">
            <summary className="cursor-pointer text-zinc-600">Last status JSON</summary>
            <pre className="mt-1 p-2 bg-zinc-100 dark:bg-zinc-900 overflow-auto max-h-40">{pollJson}</pre>
          </details>
        </AnnotationFrame>
      )}

      <AnnotationFrame
        enabled={showAnnotations}
        kind="automated"
        title="Session teardown"
        note="Disconnect/change-number actions are real, but production should call these from a controlled backend flow with server secrets."
      >
        <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-200">
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void deleteSession()}>
            DELETE this session
          </button>
          <button type="button" className="border px-3 py-1 rounded text-xs" onClick={() => void logoutAll()}>
            POST logout-all
          </button>
        </div>
      </AnnotationFrame>
    </section>
  );
}
