/**
 * Client-side AI answer providers for the knowledge hub.
 * Keys and endpoints stay in localStorage on this device — never sent to a
 * product backend except as the one-shot payload of an Ask request.
 *
 * Three slots:
 *  1. Grok (xAI) — default OpenAI-compatible chat at api.x.ai
 *  2. Claude (Anthropic) — Messages API
 *  3. Custom — any OpenAI-compatible base URL (OpenAI, Azure, Ollama, etc.)
 */

export const AI_PROVIDER_IDS = ["grok", "claude", "custom"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiProviderConfig = {
  id: AiProviderId;
  label: string;
  enabled: boolean;
  /** API key / token. Empty means "use env fallback on server if any". */
  apiKey: string;
  /** Model id sent to the provider. */
  model: string;
  /**
   * Base URL for OpenAI-compatible chat completions (no trailing slash).
   * Only used by `custom`; Grok/Claude use fixed endpoints.
   */
  baseUrl: string;
};

export type AiProvidersState = {
  activeId: AiProviderId;
  providers: Record<AiProviderId, AiProviderConfig>;
};

const STORAGE_KEY = "knowledge-hub.ai-providers.v1";

export const DEFAULT_PROVIDERS: Record<AiProviderId, AiProviderConfig> = {
  grok: {
    id: "grok",
    label: "Grok (xAI)",
    enabled: true,
    apiKey: "",
    model: "grok-4.5",
    baseUrl: "https://api.x.ai/v1",
  },
  claude: {
    id: "claude",
    label: "Claude (Anthropic)",
    enabled: false,
    apiKey: "",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    enabled: false,
    apiKey: "",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  },
};

function coerceProvider(id: AiProviderId, raw: unknown): AiProviderConfig {
  const base = DEFAULT_PROVIDERS[id];
  if (!raw || typeof raw !== "object") return { ...base };
  const v = raw as Partial<AiProviderConfig>;
  return {
    id,
    label: base.label,
    enabled: typeof v.enabled === "boolean" ? v.enabled : base.enabled,
    apiKey: typeof v.apiKey === "string" ? v.apiKey : "",
    model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : base.model,
    baseUrl:
      typeof v.baseUrl === "string" && v.baseUrl.trim()
        ? v.baseUrl.trim().replace(/\/+$/, "")
        : base.baseUrl,
  };
}

export function loadAiProviders(): AiProvidersState {
  if (typeof window === "undefined") {
    return { activeId: "grok", providers: { ...DEFAULT_PROVIDERS } };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeId: "grok", providers: structuredClone(DEFAULT_PROVIDERS) };
    const parsed = JSON.parse(raw) as Partial<AiProvidersState>;
    const providers = {
      grok: coerceProvider("grok", parsed.providers?.grok),
      claude: coerceProvider("claude", parsed.providers?.claude),
      custom: coerceProvider("custom", parsed.providers?.custom),
    };
    const activeId =
      parsed.activeId && AI_PROVIDER_IDS.includes(parsed.activeId as AiProviderId)
        ? (parsed.activeId as AiProviderId)
        : "grok";
    return { activeId, providers };
  } catch {
    return { activeId: "grok", providers: structuredClone(DEFAULT_PROVIDERS) };
  }
}

export function saveAiProviders(state: AiProvidersState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function updateProvider(
  state: AiProvidersState,
  id: AiProviderId,
  patch: Partial<Omit<AiProviderConfig, "id" | "label">>,
): AiProvidersState {
  const next: AiProvidersState = {
    ...state,
    providers: {
      ...state.providers,
      [id]: { ...state.providers[id], ...patch, id, label: state.providers[id].label },
    },
  };
  saveAiProviders(next);
  return next;
}

export function setActiveProvider(state: AiProvidersState, id: AiProviderId): AiProvidersState {
  const next = { ...state, activeId: id };
  saveAiProviders(next);
  return next;
}

/** Payload sent with each Ask — only the active provider's credentials. */
export type AiCallConfig = {
  providerId: AiProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
};

export function resolveCallConfig(state: AiProvidersState): AiCallConfig {
  const p = state.providers[state.activeId] ?? state.providers.grok;
  return {
    providerId: p.id,
    apiKey: p.apiKey.trim(),
    model: p.model.trim() || DEFAULT_PROVIDERS[p.id].model,
    baseUrl: (p.baseUrl.trim() || DEFAULT_PROVIDERS[p.id].baseUrl).replace(/\/+$/, ""),
  };
}

export function providerStatusLabel(p: AiProviderConfig): string {
  if (!p.enabled && p.id !== "grok") {
    // Grok can still fall back to server XAI_API_KEY
  }
  if (p.apiKey) return "Key saved locally";
  if (p.id === "grok") return "Uses server XAI_API_KEY if set";
  if (p.id === "claude") return "Paste an Anthropic API key";
  return "Paste key + base URL";
}

export function maskKey(key: string): string {
  const t = key.trim();
  if (!t) return "";
  if (t.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, t.length - 4))}${t.slice(-4)}`;
}
