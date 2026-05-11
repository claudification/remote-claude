import type { ReactNode } from 'react'

export function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
        {subtitle && <div className="text-[10px] text-comment">{subtitle}</div>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

export function LabeledRow({ label, subtitle, children }: { label: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <div className="min-w-0">
        <div className="text-[10px] font-mono text-muted-foreground">{label}</div>
        {subtitle && <div className="text-[9px] text-comment mt-0.5">{subtitle}</div>}
      </div>
      <div className="shrink-0 flex-1 flex justify-end">{children}</div>
    </div>
  )
}
