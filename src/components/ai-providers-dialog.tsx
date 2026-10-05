import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AI_PROVIDER_IDS,
  type AiProviderId,
  type AiProvidersState,
  loadAiProviders,
  maskKey,
  providerStatusLabel,
  saveAiProviders,
  updateProvider,
} from "@/lib/hub/ai-providers";
import { cn } from "@/lib/utils";

export function AiProvidersDialog({
  onSaved,
}: {
  onSaved?: (state: AiProvidersState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AiProvidersState>(() => loadAiProviders());
  const [tab, setTab] = useState<AiProviderId>("grok");

  useEffect(() => {
    if (open) {
      const loaded = loadAiProviders();
      setState(loaded);
      setTab(loaded.activeId);
    }
  }, [open]);

  const p = state.providers[tab];

  function patch(partial: Parameters<typeof updateProvider>[2]) {
    const next = updateProvider(state, tab, partial);
    setState(next);
  }

  function saveAndClose() {
    saveAiProviders(state);
    onSaved?.(state);
    toast.success("AI providers saved on this device");
    setOpen(false);
  }

  function clearKey() {
    patch({ apiKey: "" });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted">
          <Settings2 className="size-4" />
          AI
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Answer providers"
        description="Configure up to three writers. Keys stay in localStorage on this device and are only sent with each Ask request."
        className="w-[min(92vw,520px)]"
      >
        <div className="flex flex-wrap gap-1.5">
          {AI_PROVIDER_IDS.map((id) => {
            const cfg = state.providers[id];
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "h-9 rounded-full px-3 text-xs font-medium",
                  active ? "bg-accent text-accent-fg" : "bg-elevated text-muted",
                )}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={p.enabled || tab === state.activeId}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="size-4 rounded border-border"
            />
            Enable this provider
          </label>

          <div>
            <Label htmlFor="ai-model">Model</Label>
            <Input
              id="ai-model"
              value={p.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={
                tab === "grok"
                  ? "grok-4.5"
                  : tab === "claude"
                    ? "claude-sonnet-4-5"
                    : "gpt-4o"
              }
              className="mt-1"
            />
          </div>

          {tab === "custom" && (
            <div>
              <Label htmlFor="ai-base">Base URL (OpenAI-compatible)</Label>
              <Input
                id="ai-base"
                value={p.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="mt-1 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-subtle">
                Works with OpenAI, Azure OpenAI, Ollama, Groq, Together, and other
                /chat/completions endpoints.
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="ai-key">API key</Label>
            <Input
              id="ai-key"
              type="password"
              autoComplete="off"
              value={p.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder={
                p.apiKey
                  ? maskKey(p.apiKey)
                  : tab === "grok"
                    ? "xai-… (or leave empty for XAI_API_KEY env)"
                    : tab === "claude"
                      ? "sk-ant-…"
                      : "sk-… or provider token"
              }
              className="mt-1 font-mono text-xs"
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-subtle">{providerStatusLabel(p)}</p>
              {p.apiKey ? (
                <button
                  type="button"
                  onClick={clearKey}
                  className="text-xs text-muted underline-offset-2 hover:underline"
                >
                  Clear key
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={saveAndClose}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
