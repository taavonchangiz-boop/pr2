// =====================================================================
// POSTYAR — AI provider registry
// ---------------------------------------------------------------------
// Each provider reads its API key from env POSTYAR_AI_<PROVIDER>_KEY.
// If unconfigured, `available` returns false. The default fallback
// provider is `postyar-zai`, which uses the in-house z-ai-web-dev-sdk
// and is always available (no key required).
//
// Each provider's `chat` implementation actually calls the provider's
// public HTTP API over fetch (TLS verified by default — no toggle).
// We never expose the API key to the browser.
// =====================================================================
import { cache } from "@/lib/security/cache";
import { sanitizeRaw, getSetting } from "@/lib/providers/util";

// ---------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------
export type AiChatRole = "system" | "user" | "assistant";
export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}
export interface AiChatRequest {
  messages: AiChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface AiChatResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
  providerName: string;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly available: boolean;
  chat(req: AiChatRequest): Promise<AiChatResponse>;
}

// ---------------------------------------------------------------------
// Provider identifier union (used by AiJob.provider column)
// ---------------------------------------------------------------------
export type AiProviderId =
  | "openai"
  | "gemini"
  | "grok"
  | "deepseek"
  | "anthropic"
  | "openrouter"
  | "mistral"
  | "together"
  | "ollama"
  | "postyar-zai";

export const AI_PROVIDER_IDS: AiProviderId[] = [
  "openai",
  "gemini",
  "grok",
  "deepseek",
  "anthropic",
  "openrouter",
  "mistral",
  "together",
  "ollama",
  "postyar-zai",
];

// ---------------------------------------------------------------------
// Per-provider documented model IDs (static list, used for validation).
// When a provider is unconfigured, the list is still returned so that
// the UI can show the documented model IDs.
// ---------------------------------------------------------------------
export const AI_MODELS: Record<AiProviderId, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash", "gemini-2.5-flash"],
  grok: ["grok-2", "grok-2-mini", "grok-3", "grok-3-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-sonnet-4-5"],
  openrouter: ["openrouter/auto", "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001"],
  mistral: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo", "open-mixtral-8x7b"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "mistralai/Mistral-7B-Instruct-v0.3"],
  ollama: ["llama3.1", "llama3.2", "mistral", "qwen2.5", "phi3"],
  "postyar-zai": ["postyar-default"],
};

export function getValidModels(provider: string): string[] {
  return AI_MODELS[provider as AiProviderId] ?? [];
}

export function validateModel(provider: string, model: string): void {
  const list = getValidModels(provider);
  if (!list.includes(model)) {
    throw new Error(`مدل «${model}» برای ارائه‌دهنده «${provider}» پشتیبانی نمی‌شود.`);
  }
}

// ---------------------------------------------------------------------
// Env key resolution
// V4 M-14 — ONE authoritative resolver: provider config resolves through
// getSetting (admin settings UI first, env fallback). Previously these
// were env-only reads, so every admin write in the AI settings group was
// dead config. The settings UI writes ONE generic key (POSTYAR_AI_API_KEY)
// bound to the admin-selected default provider (POSTYAR_AI_PROVIDER);
// per-provider env keys remain supported for multi-provider deployments.
// ---------------------------------------------------------------------
async function getEnvKey(provider: AiProviderId): Promise<string> {
  if (provider === "postyar-zai") return ""; // in-house SDK, no key
  if (provider === "ollama") return (await getSetting("POSTYAR_AI_OLLAMA_URL", "")).trim(); // URL only
  const defaultProvider = (await getSetting("POSTYAR_AI_PROVIDER", "")).trim();
  const generic = (await getSetting("POSTYAR_AI_API_KEY", "")).trim();
  if (generic && defaultProvider === provider) return generic;
  return (await getSetting(`POSTYAR_AI_${provider.toUpperCase().replace(/-/g, "_")}_KEY`, "")).trim();
}

/** DB-aware availability (async — the authoritative check). */
export async function isProviderAvailableAsync(provider: AiProviderId): Promise<boolean> {
  if (provider === "postyar-zai") return true;
  const k = await getEnvKey(provider);
  if (provider === "ollama") return Boolean(k);
  return Boolean(k && k.length >= 8);
}

/**
 * ENV-ONLY availability snapshot (sync) — kept ONLY for the synchronous
 * `available` getters on the provider registry objects. The AUTHORITATIVE
 * availability check is {@link isProviderAvailableAsync} (settings-UI
 * aware); decision paths (dispatch, pickProvider, status listing) MUST
 * use the async variant.
 */
function getEnvKeySync(provider: AiProviderId): string {
  if (provider === "postyar-zai") return "";
  if (provider === "ollama") return process.env.POSTYAR_AI_OLLAMA_URL ?? "";
  return process.env[`POSTYAR_AI_${provider.toUpperCase().replace(/-/g, "_")}_KEY`] ?? "";
}

export function isProviderAvailable(provider: AiProviderId): boolean {
  if (provider === "postyar-zai") return true;
  if (provider === "ollama") return Boolean(getEnvKeySync(provider));
  const k = getEnvKeySync(provider);
  return Boolean(k && k.length >= 8);
}

// ---------------------------------------------------------------------
// Helpers for HTTP-based providers (OpenAI-compatible)
// ---------------------------------------------------------------------
interface OpenAiCompatibleJson {
  id?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

async function callOpenAiCompatible(opts: {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  providerName: string;
}): Promise<AiChatResponse> {
  // 30s timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(opts.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : "network error";
    throw new Error(`ارتباط با ارائه‌دهنده ${opts.providerName} برقرار نشد: ${msg}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    let errMsg = `کد HTTP ${res.status} از ${opts.providerName}`;
    try {
      const j = (await res.json()) as OpenAiCompatibleJson;
      if (j.error?.message) errMsg = j.error.message;
    } catch {
      // ignore
    }
    throw new Error(`فراخوانی ${opts.providerName} ناموفق بود: ${errMsg}`);
  }
  const data = (await res.json()) as OpenAiCompatibleJson;
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error(`پاسخ خالی از ${opts.providerName} دریافت شد.`);
  }
  return {
    content,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    providerName: opts.providerName,
    model: opts.model,
  };
}

// ---------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------
const openaiProvider: AiProvider = {
  name: "openai",
  get available() { return isProviderAvailable("openai"); },
  async chat(req) {
    const key = await getEnvKey("openai");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده OpenAI پیکربندی نشده است."));
    const model = req.model ?? "gpt-4o-mini";
    validateModel("openai", model);
    return callOpenAiCompatible({
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "openai",
    });
  },
};

const deepseekProvider: AiProvider = {
  name: "deepseek",
  get available() { return isProviderAvailable("deepseek"); },
  async chat(req) {
    const key = await getEnvKey("deepseek");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده DeepSeek پیکربندی نشده است."));
    const model = req.model ?? "deepseek-chat";
    validateModel("deepseek", model);
    return callOpenAiCompatible({
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "deepseek",
    });
  },
};

const grokProvider: AiProvider = {
  name: "grok",
  get available() { return isProviderAvailable("grok"); },
  async chat(req) {
    const key = await getEnvKey("grok");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده Grok پیکربندی نشده است."));
    const model = req.model ?? "grok-3-mini";
    validateModel("grok", model);
    return callOpenAiCompatible({
      endpoint: "https://api.x.ai/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "grok",
    });
  },
};

const openrouterProvider: AiProvider = {
  name: "openrouter",
  get available() { return isProviderAvailable("openrouter"); },
  async chat(req) {
    const key = await getEnvKey("openrouter");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده OpenRouter پیکربندی نشده است."));
    const model = req.model ?? "openrouter/auto";
    validateModel("openrouter", model);
    return callOpenAiCompatible({
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "openrouter",
    });
  },
};

const mistralProvider: AiProvider = {
  name: "mistral",
  get available() { return isProviderAvailable("mistral"); },
  async chat(req) {
    const key = await getEnvKey("mistral");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده Mistral پیکربندی نشده است."));
    const model = req.model ?? "mistral-small-latest";
    validateModel("mistral", model);
    return callOpenAiCompatible({
      endpoint: "https://api.mistral.ai/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "mistral",
    });
  },
};

const togetherProvider: AiProvider = {
  name: "together",
  get available() { return isProviderAvailable("together"); },
  async chat(req) {
    const key = await getEnvKey("together");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده Together پیکربندی نشده است."));
    const model = req.model ?? "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
    validateModel("together", model);
    return callOpenAiCompatible({
      endpoint: "https://api.together.xyz/v1/chat/completions",
      apiKey: key,
      model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      providerName: "together",
    });
  },
};

const ollamaProvider: AiProvider = {
  name: "ollama",
  get available() { return isProviderAvailable("ollama"); },
  async chat(req) {
    const baseUrl = await getEnvKey("ollama");
    if (!baseUrl) return Promise.reject(new Error("ارائه‌دهنده Ollama پیکربندی نشده است."));
    const model = req.model ?? "llama3.2";
    validateModel("ollama", model);
    // V6 C-20 — the Ollama URL is operator/env-configured; validate the
    // scheme before it is ever fetched (no file:/data:/ftp: endpoints).
    // Private/loopback hosts stay ALLOWED here on purpose: Ollama is a
    // self-hosted local inference server and its URL is env-only (never
    // user/admin-settable via the settings API).
    try {
      const u = new URL(`${baseUrl.replace(/\/$/, "")}/api/chat`);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return Promise.reject(new Error("آدرس Ollama نامعتبر است (فقط http/https مجاز است)."));
      }
    } catch {
      return Promise.reject(new Error("آدرس Ollama نامعتبر است."));
    }
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/chat`;
    return (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: req.messages,
            stream: false,
            options: {
              temperature: req.temperature ?? 0.7,
              num_predict: req.maxTokens,
            },
          }),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = e instanceof Error ? e.message : "network error";
        throw new Error(`ارتباط با Ollama برقرار نشد: ${msg}`);
      }
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`فراخوانی Ollama ناموفق بود: کد HTTP ${res.status}`);
      }
      // V6 C-20 — bound the response read (a misconfigured endpoint must
      // not be able to exhaust memory with an endless body).
      const text = await res.text();
      if (text.length > 4 * 1024 * 1024) {
        throw new Error("پاسخ Ollama بیش از حد مجاز بزرگ است.");
      }
      let data: { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        throw new Error("پاسخ Ollama قابل تجزیه نیست.");
      }
      const content = data.message?.content ?? "";
      if (!content) throw new Error("پاسخ خالی از Ollama دریافت شد.");
      return {
        content,
        tokensIn: data.prompt_eval_count ?? 0,
        tokensOut: data.eval_count ?? 0,
        providerName: "ollama",
        model,
      };
    })();
  },
};

const anthropicProvider: AiProvider = {
  name: "anthropic",
  get available() { return isProviderAvailable("anthropic"); },
  async chat(req) {
    const key = await getEnvKey("anthropic");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده Anthropic پیکربندی نشده است."));
    const model = req.model ?? "claude-3-5-haiku-latest";
    validateModel("anthropic", model);
    // Anthropic Messages API: split system vs user/assistant turns.
    const systemText = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const convo = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    return (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: req.maxTokens ?? 1024,
            temperature: req.temperature ?? 0.7,
            system: systemText || undefined,
            messages: convo,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = e instanceof Error ? e.message : "network error";
        throw new Error(`ارتباط با Anthropic برقرار نشد: ${msg}`);
      }
      clearTimeout(timer);
      if (!res.ok) {
        let errMsg = `کد HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j.error?.message) errMsg = j.error.message;
        } catch {
          // ignore
        }
        throw new Error(`فراخوانی Anthropic ناموفق بود: ${errMsg}`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const content = data.content?.find((b) => b.type === "text")?.text ?? "";
      if (!content) throw new Error("پاسخ خالی از Anthropic دریافت شد.");
      return {
        content,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
        providerName: "anthropic",
        model,
      };
    })();
  },
};

const geminiProvider: AiProvider = {
  name: "gemini",
  get available() { return isProviderAvailable("gemini"); },
  async chat(req) {
    const key = await getEnvKey("gemini");
    if (!key) return Promise.reject(new Error("ارائه‌دهنده Gemini پیکربندی نشده است."));
    const model = req.model ?? "gemini-2.0-flash";
    validateModel("gemini", model);
    // Gemini: systemInstruction + contents[]; roles must be "user"/"model"
    const sysText = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    return (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      // L-8: the key is sent in the x-goog-api-key HEADER, never in the
      // URL query — URLs leak into proxies, access logs and error reports.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents,
            systemInstruction: sysText ? { parts: [{ text: sysText }] } : undefined,
            generationConfig: {
              temperature: req.temperature ?? 0.7,
              maxOutputTokens: req.maxTokens,
            },
          }),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = e instanceof Error ? e.message : "network error";
        throw new Error(`ارتباط با Gemini برقرار نشد: ${msg}`);
      }
      clearTimeout(timer);
      if (!res.ok) {
        let errMsg = `کد HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j.error?.message) errMsg = j.error.message;
        } catch {
          // ignore
        }
        throw new Error(`فراخوانی Gemini ناموفق بود: ${errMsg}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!content) throw new Error("پاسخ خالی از Gemini دریافت شد.");
      return {
        content,
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
        providerName: "gemini",
        model,
      };
    })();
  },
};

// ---------------------------------------------------------------------
// postyar-zai — fallback provider using the in-house z-ai-web-dev-sdk.
// Always available (no API key required).
// ---------------------------------------------------------------------
const postyarZaiProvider: AiProvider = {
  name: "postyar-zai",
  get available() { return true; },
  async chat(req) {
    return (async () => {
      // Dynamic import so we don't accidentally pull the SDK into a client bundle.
      const ZAIModule = (await import("z-ai-web-dev-sdk")) as typeof import("z-ai-web-dev-sdk");
      const ZAI = ZAIModule.default;
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: req.messages,
      });
      // The SDK's response shape mirrors OpenAI: choices[].message.content
      const content =
        (completion as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
      if (!content) {
        throw new Error("پاسخ خالی از ارائه‌دهنده داخلی پُست‌یار دریافت شد.");
      }
      const usage =
        (completion as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage ?? {};
      return {
        content,
        tokensIn: usage.prompt_tokens ?? 0,
        tokensOut: usage.completion_tokens ?? 0,
        providerName: "postyar-zai",
        model: "postyar-default",
      };
    })();
  },
};

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------
const REGISTRY: Record<AiProviderId, AiProvider> = {
  openai: openaiProvider,
  gemini: geminiProvider,
  grok: grokProvider,
  deepseek: deepseekProvider,
  anthropic: anthropicProvider,
  openrouter: openrouterProvider,
  mistral: mistralProvider,
  together: togetherProvider,
  ollama: ollamaProvider,
  "postyar-zai": postyarZaiProvider,
};

export function getAiProvider(provider: string): AiProvider {
  const p = REGISTRY[provider as AiProviderId];
  if (!p) {
    throw new Error(`ارائه‌دهنده AI «${provider}» پشتیبانی نمی‌شود.`);
  }
  return p;
}

/**
 * Returns the provider the system should use given the user's configured
 * preference. Falls back to the ADMIN-CONFIGURED default provider
 * (POSTYAR_AI_PROVIDER via getSetting — V4 M-14), then to `postyar-zai`
 * (always available).
 */
export async function pickProvider(preferred?: string | null): Promise<AiProviderId> {
  const wanted = (preferred ?? "").trim() || (await getSetting("POSTYAR_AI_PROVIDER", "")).trim();
  if (wanted && (AI_PROVIDER_IDS as string[]).includes(wanted)) {
    const id = wanted as AiProviderId;
    if (await isProviderAvailableAsync(id)) return id;
  }
  return "postyar-zai";
}

/**
 * Sanitizes a prompt for safe storage: trims, caps length, strips control
 * characters and zero-width characters that could be used to hide payload.
 */
export function sanitizePrompt(input: string, maxLen: number = 8000): string {
  if (typeof input !== "string") return "";
  let s = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s.trim();
}

/**
 * Returns a safe summary of provider config for UI display — never exposes
 * keys. Cached for 60s.
 */
export async function listProviderStatus(): Promise<
  Array<{ id: AiProviderId; available: boolean; models: string[]; defaultModel: string }>
> {
  return await cache.get("ai:provider-status") ?? (await (async () => {
    // V4 M-14 — availability reflects the AUTHORITATIVE (settings-aware)
    // resolver, not the env-only snapshot.
    const out = await Promise.all(
      AI_PROVIDER_IDS.map(async (id) => ({
        id,
        available: await isProviderAvailableAsync(id),
        models: AI_MODELS[id],
        defaultModel: AI_MODELS[id][0] ?? "",
      })),
    );
    await cache.set("ai:provider-status", out, 60_000);
    return out;
  }))();
}

/**
 * Redacts provider details from raw payloads for safe logging/audit.
 * Delegates to the shared sanitizeRaw util.
 *
 * Always returns a Record<string, unknown> shape suitable for the audit
 * `meta` column. (sanitizeRaw returns `unknown` for general inputs, but
 * since we always pass an object, we narrow the return type.)
 */
export function redactAiPayload(input: Record<string, unknown>): Record<string, unknown> {
  const r = sanitizeRaw(input);
  if (r && typeof r === "object" && !Array.isArray(r)) {
    return r as Record<string, unknown>;
  }
  return { value: typeof r === "string" ? r : "[redacted]" };
}
