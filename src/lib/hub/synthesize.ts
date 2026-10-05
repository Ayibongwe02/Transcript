import { createServerFn } from "@tanstack/react-start";
import { fallbackAnswer } from "./fallback.ts";
import type { RetrievedChunk } from "./types.ts";

export type AskResult = {
  ok: true;
  answer: string;
  model: string;
  noRelevantContext: boolean;
  sources: RetrievedChunk[];
};

export type AskError = {
  ok: false;
  error: string;
};

export type AiProviderId = "grok" | "claude" | "custom";

type AiCallConfig = {
  providerId?: AiProviderId;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

type AskInput = {
  question: string;
  sources: RetrievedChunk[];
  noRelevantContext: boolean;
  ai?: AiCallConfig;
};

function buildPrompt(question: string, chunks: RetrievedChunk[]): string {
  const contextBlocks = chunks.map((c, i) => {
    return (
      `[Source ${i + 1}]\n` +
      `source_type: ${c.sourceType}\n` +
      `source_file: ${c.sourceFile}\n` +
      `timestamp: ${c.timestamp}\n` +
      `kind: ${c.chunkKind ?? "turn"}\n` +
      `text: ${c.text.slice(0, 800)}`
    );
  });
  const context = contextBlocks.join("\n\n") || "(no context retrieved)";

  return `You are a knowledge-hub assistant. Answer the user's question using ONLY the retrieved context below.
Rules:
1. Base every factual claim on the provided sources. Do not use outside knowledge.
2. Cite sources inline using the form [Source N] where N matches the numbered blocks.
3. If the context is empty, irrelevant, or insufficient to answer, say clearly that the information is not available in the indexed sources. Do not invent an answer.
4. Prefer being specific about which source_type (meeting, code_session, slack, whatsapp, readai, zoom, gmeet, teams, git), file, and timestamp a claim came from when it helps the reader verify.
5. When the question is about minutes, action items, decisions, or attendees, lead with those and name owners.
6. When git or Claude Code sources are present, cite the file path and relate the code to the meeting decisions. Do not invent files that are not in the context.
7. Write in short paragraphs. No preamble.

Retrieved context:
${context}

User question: ${question}

Answer:`;
}

function resolveProvider(ai?: AiCallConfig): {
  providerId: AiProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
} {
  const providerId: AiProviderId =
    ai?.providerId === "claude" || ai?.providerId === "custom" || ai?.providerId === "grok"
      ? ai.providerId
      : "grok";

  const clientKey = (ai?.apiKey ?? "").trim();
  const envGrok = (process.env.XAI_API_KEY ?? "").trim();
  const envClaude = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const envOpenAi = (process.env.OPENAI_API_KEY ?? "").trim();

  let apiKey = clientKey;
  if (!apiKey) {
    if (providerId === "grok") apiKey = envGrok;
    else if (providerId === "claude") apiKey = envClaude;
    else apiKey = envOpenAi;
  }

  const defaults: Record<AiProviderId, { model: string; baseUrl: string }> = {
    grok: { model: "grok-4.5", baseUrl: "https://api.x.ai/v1" },
    claude: { model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com" },
    custom: { model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
  };

  const model = (ai?.model ?? "").trim() || defaults[providerId].model;
  const baseUrl = ((ai?.baseUrl ?? "").trim() || defaults[providerId].baseUrl).replace(
    /\/+$/,
    "",
  );

  return { providerId, apiKey, model, baseUrl };
}

async function callOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ text: string; model: string }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Provider HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("Empty completion from provider");
  return { text, model: body.model || model };
}

async function callClaude(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ text: string; model: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    content?: { type?: string; text?: string }[];
    model?: string;
  };
  const text =
    body.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim() ?? "";
  if (!text) throw new Error("Empty completion from Claude");
  return { text, model: body.model || model };
}

export const synthesizeAnswer = createServerFn({ method: "POST" })
  .validator((input: AskInput) => {
    const question = (input?.question ?? "").trim().slice(0, 2000);
    const sources = Array.isArray(input?.sources) ? input.sources.slice(0, 8) : [];
    const ai = input?.ai
      ? {
          providerId: input.ai.providerId,
          apiKey: typeof input.ai.apiKey === "string" ? input.ai.apiKey.slice(0, 500) : "",
          model: typeof input.ai.model === "string" ? input.ai.model.slice(0, 120) : "",
          baseUrl: typeof input.ai.baseUrl === "string" ? input.ai.baseUrl.slice(0, 300) : "",
        }
      : undefined;
    return {
      question,
      sources,
      noRelevantContext: Boolean(input?.noRelevantContext) || sources.length === 0,
      ai,
    };
  })
  .handler(async ({ data }): Promise<AskResult | AskError> => {
    if (!data.question) {
      return { ok: false, error: "Question is required" };
    }

    const { providerId, apiKey, model, baseUrl } = resolveProvider(data.ai);

    if (!apiKey) {
      return {
        ok: true,
        answer: fallbackAnswer(data.sources),
        model: `fallback-no-api-key (${providerId})`,
        noRelevantContext: data.noRelevantContext,
        sources: data.sources,
      };
    }

    const prompt = data.noRelevantContext
      ? "The retrieved chunks appear weakly related. If they do not actually answer the question, say the information is not available.\n\n" +
        buildPrompt(data.question, data.sources)
      : buildPrompt(data.question, data.sources);

    try {
      const result =
        providerId === "claude"
          ? await callClaude(apiKey, model, prompt)
          : await callOpenAiCompatible(baseUrl, apiKey, model, prompt);

      return {
        ok: true,
        answer: result.text,
        model: `${providerId}/${result.model}`,
        noRelevantContext: data.noRelevantContext,
        sources: data.sources,
      };
    } catch {
      return {
        ok: true,
        answer: fallbackAnswer(data.sources),
        model: `local retrieval (${providerId})`,
        noRelevantContext: data.noRelevantContext,
        sources: data.sources,
      };
    }
  });
