/**
 * Optional LLM hook: any OpenAI-compatible /chat/completions endpoint.
 * Env: OPENAI_BASE_URL (e.g. https://api.openai.com/v1 or a local vLLM/Ollama gateway), OPENAI_API_KEY, OPENAI_MODEL.
 * Returns null when not configured or on any error, so callers always have a non-LLM fallback.
 */
export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export function llmFromEnv(env = process.env): LlmConfig | null {
  if (!env.OPENAI_BASE_URL && !env.OPENAI_API_KEY) return null;
  return { baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-4o-mini" };
}

export async function chat(cfg: LlmConfig | null, system: string, user: string, opts: { json?: boolean; temperature?: number } = {}): Promise<string | null> {
  if (!cfg) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${(cfg.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.7,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
