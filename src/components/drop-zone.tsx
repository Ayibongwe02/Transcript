import { useCallback, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  onFiles: (files: File[]) => void;
  accept?: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

export function DropZone({
  onFiles,
  accept,
  label = "Drop files here",
  hint = "or click to browse",
  disabled,
}: Props) {
  const [over, setOver] = useState(false);

  const take = useCallback(
    (list: FileList | File[] | null) => {
      if (!list) return;
      const files = Array.from(list);
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  return (
    <label
      className={cn(
        "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg bg-elevated px-4 py-6 text-center shadow-[var(--shadow-border)] transition-[box-shadow,background-color] duration-150",
        over && "shadow-[var(--shadow-border-hover)] bg-surface",
        disabled && "pointer-events-none opacity-40",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <Upload className="size-5 text-muted" />
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <input
        type="file"
        className="sr-only"
        multiple
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}
