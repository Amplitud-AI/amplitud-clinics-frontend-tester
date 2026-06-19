"use client";

import type { ReactNode } from "react";

export type AnnotationKind = "clinic" | "dev" | "automated";

const ANNOTATION_STYLES: Record<AnnotationKind, string> = {
  clinic: "border-lime-500 bg-lime-50/35 dark:border-lime-400 dark:bg-lime-950/20",
  dev: "border-red-500 bg-red-50/35 dark:border-red-400 dark:bg-red-950/20",
  automated: "border-zinc-400 bg-zinc-100/60 dark:border-zinc-500 dark:bg-zinc-900/50",
};

const BADGE_STYLES: Record<AnnotationKind, string> = {
  clinic: "border-lime-600 bg-lime-100 text-lime-950 dark:border-lime-400 dark:bg-lime-950 dark:text-lime-100",
  dev: "border-red-600 bg-red-100 text-red-950 dark:border-red-400 dark:bg-red-950 dark:text-red-100",
  automated:
    "border-zinc-500 bg-zinc-200 text-zinc-900 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-100",
};

const KIND_LABELS: Record<AnnotationKind, string> = {
  clinic: "Green: real clinic frontend",
  dev: "Red: dev/test only",
  automated: "Grey: real but automated/hidden",
};

type AnnotationFrameProps = {
  children: ReactNode;
  enabled: boolean;
  kind: AnnotationKind;
  note: string;
  title: string;
};

export function AnnotationFrame({
  children,
  enabled,
  kind,
  note,
  title,
}: AnnotationFrameProps) {
  if (!enabled) return <>{children}</>;

  return (
    <div className={`rounded border-4 p-2 space-y-2 ${ANNOTATION_STYLES[kind]}`}>
      <AnnotationBadge kind={kind} title={title} note={note} />
      {children}
    </div>
  );
}

type AnnotationBadgeProps = {
  kind: AnnotationKind;
  note: string;
  title: string;
};

function AnnotationBadge({ kind, note, title }: AnnotationBadgeProps) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
      <span className={`w-fit rounded border px-2 py-1 text-xs font-semibold ${BADGE_STYLES[kind]}`}>
        {KIND_LABELS[kind]}
      </span>
      <p className="max-w-xl text-xs font-medium text-zinc-700 dark:text-zinc-200">
        <strong>{title}:</strong> {note}
      </p>
    </div>
  );
}

type AnnotationLegendProps = {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
};

export function AnnotationLegend({ enabled, onToggle }: AnnotationLegendProps) {
  return (
    <section className="rounded border border-zinc-300 p-4 space-y-3 dark:border-zinc-600">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Screenshot annotation mode</h2>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
          />
          Show all markup for PNG capture
        </label>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <LegendItem kind="clinic" text="Clinic admin/staff should see this in the real onboarding UI." />
        <LegendItem kind="dev" text="Keep this in the tester only; do not ship it in the clinic UI." />
        <LegendItem kind="automated" text="The behavior is real, but the frontend should automate or hide it." />
      </div>
    </section>
  );
}

function LegendItem({ kind, text }: { kind: AnnotationKind; text: string }) {
  return (
    <div className={`rounded border p-3 text-xs ${ANNOTATION_STYLES[kind]}`}>
      <p className="font-semibold">{KIND_LABELS[kind]}</p>
      <p className="mt-1 text-zinc-600 dark:text-zinc-300">{text}</p>
    </div>
  );
}
