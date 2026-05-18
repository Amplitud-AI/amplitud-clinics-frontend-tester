"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

function CallbackBody() {
  const sp = useSearchParams();
  const serialized = useMemo(() => {
    const o: Record<string, string> = {};
    sp.forEach((v, k) => {
      o[k] = v;
    });
    return JSON.stringify(o, null, 2);
  }, [sp]);

  const userId = sp.get("user_id") ?? sp.get("gateway_user_id") ?? "";

  return (
    <div className="p-8 max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">OAuth return</h1>
      <p className="text-sm text-zinc-500">
        Google / gateway redirects here with query params. Use{" "}
        <code className="text-xs bg-zinc-100 px-1">user_id</code> as{" "}
        <strong>gateway_user_id</strong> for POST{" "}
        <code className="text-xs">calendar/google/oauth/finalize</code>.
      </p>
      <pre className="text-xs bg-zinc-100 dark:bg-zinc-900 p-3 overflow-auto">
        {serialized || "{}"}
      </pre>
      {userId && (
        <p className="text-sm">
          gateway_user_id: <code className="text-xs break-all">{userId}</code>
        </p>
      )}
      <Link href="/" className="underline text-sm">
        ← Back to flow tester
      </Link>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading…</div>}>
      <CallbackBody />
    </Suspense>
  );
}
