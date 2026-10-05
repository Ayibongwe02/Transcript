import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const CITE = /\[(?:Source\s*)?(\d+)\]/g;

export function AnswerBody({
  text,
  active,
  onCite,
}: {
  text: string;
  active: number | null;
  onCite: (n: number) => void;
}) {
  const nodes: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(CITE.source, "g");
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const n = Number(m[1]);
    nodes.push(
      <button
        key={key++}
        type="button"
        onClick={() => onCite(n)}
        className={cn(
          "mx-0.5 inline-flex h-5 min-w-5 translate-y-[-1px] items-center justify-center rounded-xs bg-elevated px-1 font-mono text-2xs text-muted shadow-[var(--shadow-border)]",
          active === n && "bg-accent text-accent-fg",
        )}
        aria-label={`Source ${n}`}
      >
        {n}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);

  return <p className="whitespace-pre-wrap text-base leading-relaxed text-fg">{nodes}</p>;
}
