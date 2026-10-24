/**
 * dsh-prompt-optimization-master — host half
 * Author: Kirin (ruiyukirin)
 *
 * Owns the model call behind the composer's ✨ enhance button. The call runs on
 * its own `ctx.llm.stream()` request: it creates no Session, writes nothing to
 * the session log, and therefore costs the conversation no context. That is the
 * same isolation WorkBuddy gets from its sidecar process.
 *
 * Routes (all POST, JSON body, same-app origin only):
 *   /dsh-prompt-enhance/enhance  { text, requestId }  → { ok, text } | { ok:false, code, error }
 *   /dsh-prompt-enhance/cancel   { requestId }        → { ok, cancelled }
 *   /dsh-prompt-enhance/config   {}                   → { minTextLength, provider, model, ready }
 *
 * Transport note: the desktop renderer is served from the custom `dsh-app://`
 * scheme and Electron forwards every non-asset path to this HTTP server, so a
 * relative fetch arrives here with `Origin: dsh-app://app` and the loopback
 * `Host`. A strict host-vs-origin comparison would reject exactly the desktop
 * app, so the guard accepts the desktop document origin explicitly.
 */

export const name = 'dsh-prompt-optimization-master';

const MIN_TEXT_LENGTH = 1;
const MAX_INPUT_CHARS = 20_000;

/**
 * Output budget, split by whether the routed model thinks before it answers.
 *
 * Measured against `deepseek-flash` with reasoning enabled: one short rewrite
 * emitted 132 characters of visible text after 2632 characters of reasoning.
 * A 512-token budget was consumed entirely by reasoning and returned nothing
 * visible, so the thinking budget stays well above the visible answer plus
 * that reasoning overhead.
 *
 * The two numbers are deliberately far apart. A model that always reasons
 * (`onlyReasoning`, with thinking that cannot be switched off) spends its whole
 * budget on hidden reasoning first; 4096 tokens were measured to be consumed
 * by reasoning alone on `hy4-preview`, so every request ended truncated after
 * ~90-115 seconds of spinning. Non-thinking models need only a few hundred
 * tokens for the same rewrite.
 */
const MAX_OUTPUT_TOKENS_THINKING = 32_768;
const MAX_OUTPUT_TOKENS_PLAIN = 4_096;

/**
 * Hard wall-clock ceiling for one rewrite, in milliseconds.
 *
 * The host has no timeout of its own, so a reasoning model that burns its whole
 * output budget keeps the button spinning for minutes before reporting failure.
 * The budget is only an output limit; it does not bound latency, so the wall
 * clock needs its own guard. Cancellation stays cooperative: the abort lands and
 * the request reports `timeout` instead of leaving the UI spinning forever.
 */
const ENHANCE_TIMEOUT_MS = 60_000;

/**
 * How long a model-info lookup may block the rewrite before it is ignored.
 *
 * This has to be short. The lookup sits directly in front of the model call, so
 * every millisecond it waits is latency the user feels on the button. A slow or
 * hanging lookup must never add its full guard to a fast model: 5s was measured
 * to turn a 3s rewrite into an 8s one. Unknown degrades to the small budget,
 * which is the safe answer for a non-thinking model.
 */
const MODEL_INFO_TIMEOUT_MS = 1_200;

/**
 * Least time a retry must be given to be worth starting.
 *
 * The two attempts share ENHANCE_TIMEOUT_MS, so once most of it is spent a
 * second call cannot finish a slow rewrite; starting one would only add latency
 * before the same failure. Below this the first result is reported as-is.
 */
const MIN_RETRY_MS = 10_000;

/**
 * How long a resolved model-info answer stays usable, in milliseconds.
 *
 * The lookup decides the output budget, so caching it avoids paying the same
 * latency on every rewrite. But a model can be repointed at a different backend
 * (or have its reasoning capability changed) while DSH keeps running, and an
 * answer cached forever would then keep sizing the budget for a model that is no
 * longer in use. Five minutes is short enough to recover on its own and long
 * enough that a burst of rewrites shares one lookup.
 */
const MODEL_INFO_TTL_MS = 5 * 60_000;

/** Bounds for a per-request timeout, so a typo cannot make the button useless. */
const MIN_ENHANCE_TIMEOUT_MS = 5_000;
const MAX_ENHANCE_TIMEOUT_MS = 300_000;

/** Pause before a retried attempt, so an overloaded provider gets room to clear. */
const RETRY_BACKOFF_MS = 400;

/**
 * Failure codes a second attempt cannot fix.
 *
 * These name a bad credential, a request the provider will reject again, or a
 * model that does not exist. Retrying them doubles the user's wait before the
 * same message, so only truly transient failures (rate limits, overloads,
 * dropped connections, 5xx) are retried.
 */
const NON_RETRYABLE_CODES = [
  'invalid_request',
  'invalid_api_key',
  'authentication_error',
  'auth',
  'unauthorized',
  'forbidden',
  'permission_denied',
  'not_found',
  'model_not_found',
  'context_length_exceeded',
  'content_filter',
  'quota_exceeded',
];

/** Role prompt: who the model is while rewriting a draft. */
const SYSTEM_PROMPT = [
  'You are a Prompt Engineering Expert specializing in improving user prompts for a general-purpose AI agent that writes code and operates a local development environment.',
  'When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose.',
  '',
  'ANALYSIS PROCESS:',
  '1. Evaluate the original prompt: identify the main objective, note any ambiguities or gaps, assess the clarity of instructions, and check for missing context.',
  '2. Apply prompt engineering principles: write clear specific instructions; include necessary context; set explicit parameters and constraints; structure the expected output; add relevant examples when they clarify; match tone and complexity to the use case; remove redundant information.',
  '3. Create the enhanced version: maintain the original goal, incorporate the identified improvements, and stay realistic about what to add.',
  '',
  'DO NOT:',
  '- Do not ask for guides or how-tos unless the user asked for one.',
  '- Do not demand code snippets the user never requested.',
  '- Do not suggest specific technologies, libraries, or files the user never mentioned.',
  '- Do not explain HOW to do things; focus on WHAT the result should be.',
  '- Do not answer the question. Expand and rewrite it into a more precise request instead.',
  '',
  // Restored from WorkBuddy's `Xo` tail: the brevity ceiling, the FORMAT clause
  // and the two English few-shots. Without the ceiling the model happily turns a
  // one-line request into a multi-paragraph brief full of requirements the user
  // never asked for.
  'IMPORTANT CONSTRAINTS:',
  "1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user's input itself mixes languages.",
  '2. Keep the enhanced prompt concise - maximum length should be around 800 characters',
  '',
  'FORMAT: Provide only the enhanced prompt with no additional commentary.',
  '',
  'Example: "A website for my dog"',
  'Enhanced prompt: "Design a personalized Next.js website dedicated to showcasing my dog. Include sections such as a photo gallery, a biography detailing the dog\'s breed, age, and personality traits, and a blog for sharing stories or updates about your dog\'s adventures. Add a contact form for visitors to reach out with questions or comments. Ensure the website is visually appealing and easy to navigate, with a responsive design that works well on both desktop and mobile devices."',
  'Example: "Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative. Remove any jargon like \'genie router\'. Use canvas"',
  'Enhanced prompt: "Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Eliminate any technical jargon such as \'genie router\'. Incorporate the concept of using canvas elements naturally within the narrative structure to enhance the technical explanation."',
].join('\n');

/**
 * Task prompt: the rewrite contract, the language lock, and few-shot pairs.
 * The draft is substituted into {input}. Language consistency is stated as the
 * highest priority because it is the failure mode that matters most here, and
 * the bad/good pair exists to suppress meta commentary about language.
 */
const TASK_PROMPT = [
  'You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.',
  '',
  'USER INPUT: {input}',
  '',
  'TASK: Rewrite the user input into a clearer, more specific prompt for the target AI agent.',
  '',
  'CRITICAL PRIORITY - LANGUAGE CONSISTENCY:',
  '1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.',
  '2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.',
  '3. If the user writes in English, the enhanced prompt MUST be entirely in English.',
  '4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.',
  '5. If the user mixes languages, keep a natural matching mix. Do not translate the user intent into a single language.',
  '6. These language rules are behavior instructions only; never include language analysis or language labels in the output.',
  '',
  'ENHANCEMENT REQUIREMENTS:',
  '1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.',
  '2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".',
  '3. Preserve the user original intent, topic, constraints, and target output type. Do not answer the request.',
  '4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.',
  '5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.',
  '6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.',
  '7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.',
  '',
  'EXAMPLES:',
  'User input (Chinese): "请帮我解释这段代码的功能"',
  'Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"',
  'User input (English): "Please explain what this code does"',
  'Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."',
  'User input (Mixed): "这段代码有 bug，can you help me fix it?"',
  'Enhanced prompt: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix with necessary verification steps."',
  'BAD OUTPUT EXAMPLE: User input is in Chinese -> Response must be in Chinese. 请解释这段代码的主要功能',
  'GOOD OUTPUT EXAMPLE: 请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。',
].join('\n');

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** Accept the desktop document origin, a real same-origin request, or a non-browser caller. */
function isTrustedRequest(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'dsh-app://app') return true;
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) reject(new Error('request body too large'));
    });
    request.on('end', () => {
      if (raw.length === 0) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid JSON')); }
    });
    request.on('error', reject);
  });
}

/** Strip the wrappers a model likes to add even when told not to. */
function cleanEnhancedText(text) {
  let value = String(text ?? '').trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/;
  const fenced = value.match(fence);
  if (fenced) value = fenced[1].trim();
  value = value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  return value;
}

/**
 * Ask the host what the routed model can do, never letting the lookup itself
 * become a hang. Returns null when the runtime cannot answer, so every caller
 * degrades to the safe budget instead of failing.
 *
 * `cache` remembers the answer per route and is owned by the caller, not by the
 * module: the lookup sits in front of every rewrite, so paying it twice is pure
 * latency, but a module-level map would outlive the plugin and leak between
 * mounts. A failed lookup is remembered too — retrying one that hangs would
 * only stall the same way again, and the retry-on-truncation path already
 * covers a model misclassified as non-thinking.
 */
async function resolveModelInfo(llm, provider, model, cache) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null;
  const key = `${String(provider)}${String(model)}`;
  if (cache && cache.has(key)) {
    const entry = cache.get(key);
    // Entries carry their own timestamp so a re-pointed model is noticed
    // without restarting DSH; a stale answer is refetched instead of reused.
    if (entry && typeof entry.at === 'number' && Date.now() - entry.at < MODEL_INFO_TTL_MS) return entry.value;
    if (cache.delete) cache.delete(key);
  }

  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), MODEL_INFO_TIMEOUT_MS);
  });
  let info = null;
  try {
    info = await Promise.race([llm.resolveModelInfo(provider, model), guard]);
  } catch {
    info = null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const settled = info ?? null;
  if (cache) cache.set(key, { value: settled, at: Date.now() });
  return settled;
}

/**
 * Does this model think before it answers, with no way to switch that off?
 *
 * `resolveModelInfo` reports `{ reasoning: { efforts: [{ id, name }], defaultEffort } }`;
 * it carries no `supports` flag, so the presence of `reasoning` is what marks a
 * thinking model. A model with no reasoning metadata at all is reported with the
 * single level `off`, which means it never thinks — the same seam says "this
 * capability is unavailable" by omitting `reasoning` entirely.
 *
 * Anything that offers a thinking level other than `off` pays for reasoning out
 * of the same output budget, so it gets the larger budget. An `off` entry only
 * helps when it is the real switch; a model whose sole level is `off` never
 * thinks at all.
 */
function thinksUnavoidably(info) {
  const reasoning = info?.reasoning;
  if (!reasoning) return false;
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  if (efforts.length === 0) return false;
  const ids = efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter(Boolean);
  return !(ids.length === 1 && ids[0] === 'off');
}

/**
 * The model's own output ceiling, from `resolveModelInfo().defaultMaxTokens`.
 *
 * Requesting more than a model allows is not clamped for us: the adapter passes
 * `maxTokens` straight through, so an over-ask can fail the request outright.
 * Returns null when the runtime does not report one, which means "no known cap".
 */
function outputCeiling(info) {
  const declared = info?.defaultMaxTokens;
  return Number.isSafeInteger(declared) && declared > 0 ? declared : null;
}

/** Keep a requested budget inside the model's own ceiling, when one is known. */
function clampBudget(wanted, ceiling) {
  if (ceiling === null) return wanted;
  return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * Turn a requested wall-clock budget into a safe one.
 *
 * The client sends whatever the user typed in Settings, which may be empty, a
 * string, zero, negative or absurdly large. Anything unusable keeps the default
 * rather than failing the rewrite, and a real number is held inside the bounds
 * so the button can never spin for an hour or give up before the model answers.
 */
function clampTimeout(wanted) {
  const value = typeof wanted === 'number' ? wanted : Number(wanted);
  if (!Number.isFinite(value) || value <= 0) return ENHANCE_TIMEOUT_MS;
  return Math.min(MAX_ENHANCE_TIMEOUT_MS, Math.max(MIN_ENHANCE_TIMEOUT_MS, Math.round(value)));
}

/** Does this provider failure look like something a retry could fix? */
function isRetryableFailure(failure) {
  const code = String(failure?.code ?? '').toLowerCase();
  if (code.length === 0) return true;
  if (NON_RETRYABLE_CODES.indexOf(code) !== -1) return false;
  // Providers report their own vocabulary (`rate_limit_exceeded`, `overloaded`,
  // `ECONNRESET`, `500`), so the deny-list is the reliable part: anything that
  // names a credential or a malformed request is refused, everything else is
  // worth one retry.
  if (code.includes('auth') || code.includes('credential') || code.includes('forbidden')) return false;
  if (code.includes('invalid')) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx, config) {
  const inFlight = new Map(); // requestId -> AbortController
  const modelInfo = new Map(); // route key -> resolved model info (or null)

  /**
   * Resolve the provider/model route. A per-request override wins over the
   * session default, so a user can pin this auxiliary call to a cheaper model
   * without changing what the conversation itself uses.
   */
  function selectedRoute(overrides) {
    const wanted = overrides || {};
    const wantedProvider = typeof wanted.provider === 'string' ? wanted.provider.trim() : '';
    const wantedModel = typeof wanted.model === 'string' ? wanted.model.trim() : '';
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      const provider = wantedProvider || (selection?.provider ? String(selection.provider) : '');
      const model = wantedModel || (selection?.model ? String(selection.model) : '');
      if (provider && model) return { provider, model };
    } catch { /* fall through */ }
    return null;
  }

  /**
   * One attempt at the rewrite under a fixed budget and its own deadline.
   * Returns what the stream produced instead of throwing on a cut-off, so the
   * caller can decide whether a larger budget is worth a second try.
   */
  async function runAttempt(llm, route, text, maxTokens, signal, timeoutMs) {
    let enhanced = '';
    let failure = null;
    let truncated = false;

    // One local controller covers the caller's abort and our own deadline, so a
    // timeout reaches the adapter exactly like a user cancel — and stops the
    // request instead of leaving it burning tokens in the background.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!controller.signal.aborted) controller.abort();
    }, timeoutMs);
    const forwardAbort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    if (signal) {
      if (signal.aborted) forwardAbort();
      else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', forwardAbort, { once: true });
      }
    }

    const bail = (code, message) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };

    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: TASK_PROMPT.replace('{input}', text) }],
        }],
        maxTokens,
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        // Do not rely on the provider honouring the signal: cancellation must
        // land even when an adapter keeps streaming after the abort.
        if (controller.signal.aborted) {
          throw timedOut
            ? bail('timeout', `the rewrite did not finish within ${Math.round(timeoutMs / 1000)} seconds`)
            : bail('aborted', 'aborted by user');
        }
        if (chunk.type === 'text-delta') {
          enhanced += chunk.text;
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason;
          if (reason && reason.kind === 'error') failure = reason.failure ?? null;
          else if (reason && reason.kind === 'max-tokens') truncated = true;
          else if (reason && reason.kind === 'aborted') {
            throw timedOut
              ? bail('timeout', `the rewrite did not finish within ${Math.round(timeoutMs / 1000)} seconds`)
              : bail('aborted', 'aborted by user');
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', forwardAbort);
      }
    }

    return { enhanced, failure, truncated };
  }

  /**
   * One isolated completion. Returns the enhanced prompt text or throws an
   * Error carrying a stable `code` the client can route on.
   */
  async function enhance(text, signal, overrides) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') {
      const error = new Error('the llm service is unavailable in this runtime');
      error.code = 'llm_unavailable';
      throw error;
    }

    const route = selectedRoute(overrides);
    if (!route) {
      const error = new Error('no provider/model route is selected');
      error.code = 'no_route';
      throw error;
    }

    // The budget follows the routed model: a model that thinks first needs room
    // for the hidden reasoning, or the rewrite is cut off before it starts.
    const info = await resolveModelInfo(llm, route.provider, route.model, modelInfo);
    const thinking = thinksUnavoidably(info);
    const ceiling = outputCeiling(info);
    let maxTokens = clampBudget(thinking ? MAX_OUTPUT_TOKENS_THINKING : MAX_OUTPUT_TOKENS_PLAIN, ceiling);

    // Both attempts share one wall-clock budget, so a retry can never double
    // the worst-case wait. The spare slice keeps the second try meaningful.
    const budgetMs = clampTimeout(overrides?.timeoutMs);
    const started = Date.now();
    let attempt = await runAttempt(llm, route, text, maxTokens, signal, budgetMs);

    // The lookup can fail or time out, and a model can reason without saying so.
    // A cut-off on the small budget is the one failure a bigger budget can fix,
    // so retry once instead of sending the user to the settings page. When the
    // model's own ceiling already capped the first budget, a retry would send
    // the identical request, so it is skipped.
    const retryBudget = clampBudget(MAX_OUTPUT_TOKENS_THINKING, ceiling);
    if (attempt.truncated && !thinking && retryBudget > maxTokens) {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining >= MIN_RETRY_MS) {
        maxTokens = retryBudget;
        attempt = await runAttempt(llm, route, text, maxTokens, signal, remaining);
      }
    }

    // A transient provider failure (rate limit, overload, dropped connection)
    // usually clears on its own, so it is retried once while the budget allows.
    // Credential and request-shape errors are reported straight away: a second
    // identical call would only double the wait before the same message.
    if (attempt.failure && isRetryableFailure(attempt.failure)) {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining >= MIN_RETRY_MS) {
        await sleep(RETRY_BACKOFF_MS);
        if (signal && signal.aborted) {
          const aborted = new Error('aborted by user');
          aborted.code = 'aborted';
          throw aborted;
        }
        attempt = await runAttempt(llm, route, text, maxTokens, signal, remaining);
      }
    }

    if (attempt.failure) {
      const error = new Error(attempt.failure.message || 'model call failed');
      error.code = attempt.failure.code || 'llm_error';
      throw error;
    }

    // A cut-off rewrite is worse than no rewrite, so a budget hit is an error
    // rather than a silently incomplete prompt. Say what to do about it: with a
    // thinking model the fix is a different route, not a bigger number.
    if (attempt.truncated) {
      const error = new Error(
        `the model used the whole ${maxTokens}-token budget and produced no rewrite; pin a faster model in Settings → Prompt optimization`,
      );
      error.code = 'truncated';
      throw error;
    }

    const cleaned = cleanEnhancedText(attempt.enhanced);
    if (cleaned.length === 0) {
      const error = new Error('the model returned an empty result');
      error.code = 'empty_result';
      throw error;
    }
    if (cleaned === text.trim()) {
      const error = new Error('the model returned the original text unchanged');
      error.code = 'unchanged';
      throw error;
    }
    return cleaned;
  }

  function route(handler) {
    return async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, code: 'untrusted_origin', error: 'untrusted origin' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = await handler(body);
        sendJson(response, 200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(response, 500, { ok: false, error: message });
      }
    };
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-prompt-enhance/config',
          handler: route(async () => {
            const routeInfo = selectedRoute();
            // The selection shape is reported verbatim (JSON-safe copy) so a
            // route-resolution failure is diagnosable from the client side.
            let selection = null;
            try {
              const raw = ctx.get('agentDefaultModel')?.currentSelection?.();
              selection = raw === undefined ? null : JSON.parse(JSON.stringify(raw));
            } catch { /* leave null */ }
            const llm = ctx.get('llm');
            const info = routeInfo ? await resolveModelInfo(llm, routeInfo.provider, routeInfo.model, modelInfo) : null;
            const thinking = thinksUnavoidably(info);
            const ceiling = outputCeiling(info);
            return {
              ok: true,
              minTextLength: MIN_TEXT_LENGTH,
              maxInputChars: MAX_INPUT_CHARS,
              provider: routeInfo?.provider ?? null,
              model: routeInfo?.model ?? null,
              ready: Boolean(routeInfo) && typeof llm?.stream === 'function',
              hasLlmService: typeof llm?.stream === 'function',
              selectionKeys: selection === null ? null : Object.keys(selection),
              selection,
              // Diagnostics: whether the routed model thinks first, and the
              // budget this call would really get after the model's own cap.
              // A thinking route is the one that used to spin for minutes.
              thinking,
              maxTokens: routeInfo
                ? clampBudget(thinking ? MAX_OUTPUT_TOKENS_THINKING : MAX_OUTPUT_TOKENS_PLAIN, ceiling)
                : null,
              modelCeiling: ceiling,
              // The client reads these to render the timeout field and to word
              // its timeout message with the number this runtime really uses.
              timeoutMs: ENHANCE_TIMEOUT_MS,
              minTimeoutMs: MIN_ENHANCE_TIMEOUT_MS,
              maxTimeoutMs: MAX_ENHANCE_TIMEOUT_MS,
              modelInfoTtlMs: MODEL_INFO_TTL_MS,
              effortIds: Array.isArray(info?.reasoning?.efforts)
                ? info.reasoning.efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter(Boolean)
                : null,
            };
          }),
        }),

        // The settings page needs a real list to pick from: asking a person to
        // type "deepseek-flash" is where a non-technical user gives up. The
        // runtime already advertises the catalog (`llm.listProviders()` /
        // `llm.listModels(provider)`), so it is projected here as JSON instead
        // of being duplicated in the client.
        host.webServer.register({
          kind: 'exact',
          path: '/dsh-prompt-enhance/models',
          handler: route(async () => {
            const llm = ctx.get('llm');
            const groups = [];
            const failures = [];
            let fallback = null;
            try {
              const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
              if (selection) fallback = { provider: String(selection.provider ?? ''), model: String(selection.model ?? '') };
            } catch { /* leave null */ }

            const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : [];
            for (const provider of Array.isArray(providers) ? providers : []) {
              const id = String(provider?.id ?? '');
              if (!id) continue;
              const name = String(provider?.name ?? id);
              try {
                const models = await llm.listModels(id);
                const entries = (Array.isArray(models) ? models : [])
                  .filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
                  .map((model) => ({
                    id: model.id,
                    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
                    description: typeof model.description === 'string' ? model.description : null,
                  }));
                // A provider that answers with nothing is noise in a dropdown.
                if (entries.length > 0) groups.push({ id, name, models: entries });
              } catch (e) {
                failures.push({ id, name, message: e instanceof Error ? e.message : String(e) });
              }
            }
            return { ok: true, default: fallback, groups, failures };
          }),
        }),

        host.webServer.register({
          kind: 'exact',
          path: '/dsh-prompt-enhance/enhance',
          handler: route(async (body) => {
            const text = typeof body.text === 'string' ? body.text : '';
            const requestId = typeof body.requestId === 'string' && body.requestId.length > 0
              ? body.requestId
              : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

            if (text.trim().length === 0) {
              return { ok: false, code: 'empty_input', error: 'the draft is empty' };
            }
            if (text.length > MAX_INPUT_CHARS) {
              return { ok: false, code: 'too_long', error: `the draft exceeds ${MAX_INPUT_CHARS} characters` };
            }

            const previous = inFlight.get(requestId);
            if (previous && !previous.signal.aborted) previous.abort();
            const controller = new AbortController();
            inFlight.set(requestId, controller);

            try {
              const enhanced = await enhance(text, controller.signal, {
                provider: typeof body.provider === 'string' ? body.provider : undefined,
                model: typeof body.model === 'string' ? body.model : undefined,
                timeoutMs: body.timeoutMs,
              });
              return { ok: true, text: enhanced, requestId };
            } catch (e) {
              const code = e && e.code ? String(e.code) : 'unknown';
              const message = e instanceof Error ? e.message : String(e);
              if (code !== 'aborted') {
                ctx.get('logger')?.warn?.(`[dsh-prompt-optimization-master] enhance failed (${code}): ${message}`);
              }
              return { ok: false, code, error: message, requestId };
            } finally {
              if (inFlight.get(requestId) === controller) inFlight.delete(requestId);
            }
          }),
        }),

        host.webServer.register({
          kind: 'exact',
          path: '/dsh-prompt-enhance/cancel',
          handler: route(async (body) => {
            const requestId = typeof body.requestId === 'string' ? body.requestId : '';
            const controller = inFlight.get(requestId);
            if (!controller) return { ok: true, cancelled: false };
            if (!controller.signal.aborted) controller.abort();
            inFlight.delete(requestId);
            return { ok: true, cancelled: true };
          }),
        }),
      ];
      return () => {
        for (const controller of inFlight.values()) {
          if (!controller.signal.aborted) controller.abort();
        }
        inFlight.clear();
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-prompt-optimization-master: routes');
  });
}
