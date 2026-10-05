import type { ReactNode } from "react";

export function PageHeader({
  kicker,
  title,
  body,
  actions,
}: {
  kicker: string;
  title: string;
  body?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-xl">
        <p className="text-2xs font-medium tracking-wider text-muted uppercase">{kicker}</p>
        <h1 className="mt-1.5 font-display text-3xl leading-tight text-fg md:text-4xl">{title}</h1>
        {body ? <p className="mt-2.5 text-sm leading-relaxed text-muted">{body}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
