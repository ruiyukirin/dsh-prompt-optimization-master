/**
 * dsh-prompt-enhance — host half
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

export const name = '@ruiyukirin/dsh-prompt-enhance';

const MIN_TEXT_LENGTH = 1;
const MAX_INPUT_CHARS = 20_000;
/**
 * Measured against `deepseek-flash` with reasoning enabled: one short rewrite
 * emitted 132 characters of visible text after 2632 characters of reasoning.
 * A 512-token budget was consumed entirely by reasoning and returned nothing
 * visible, so the cap stays well above the visible answer plus that overhead.
 */
const MAX_OUTPUT_TOKENS = 4_096;

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

export function apply(ctx, config) {
  const inFlight = new Map(); // requestId -> AbortController

  function selectedRoute() {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return { provider: String(selection.provider), model: String(selection.model) };
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * One isolated completion. Returns the enhanced prompt text or throws an
   * Error carrying a stable `code` the client can route on.
   */
  async function enhance(text, signal) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') {
      const error = new Error('the llm service is unavailable in this runtime');
      error.code = 'llm_unavailable';
      throw error;
    }

    const route = selectedRoute();
    if (!route) {
      const error = new Error('no provider/model route is selected');
      error.code = 'no_route';
      throw error;
    }

    let enhanced = '';
    let failure = null;
    let truncated = false;

    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: TASK_PROMPT.replace('{input}', text) }],
      }],
      maxTokens: MAX_OUTPUT_TOKENS,
      signal,
    });

    for await (const chunk of stream) {
      // Do not rely on the provider honouring the signal: cancellation must
      // land even when an adapter keeps streaming after the abort.
      if (signal?.aborted) {
        const error = new Error('aborted by user');
        error.code = 'aborted';
        throw error;
      }
      if (chunk.type === 'text-delta') {
        enhanced += chunk.text;
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason;
        if (reason && reason.kind === 'error') failure = reason.failure ?? null;
        else if (reason && reason.kind === 'max-tokens') truncated = true;
        else if (reason && reason.kind === 'aborted') {
          const error = new Error('aborted by user');
          error.code = 'aborted';
          throw error;
        }
      }
    }

    if (failure) {
      const error = new Error(failure.message || 'model call failed');
      error.code = failure.code || 'llm_error';
      throw error;
    }

    // A cut-off rewrite is worse than no rewrite, so a budget hit is an error
    // rather than a silently incomplete prompt.
    if (truncated) {
      const error = new Error('the model hit the output limit before finishing the rewrite');
      error.code = 'truncated';
      throw error;
    }

    const cleaned = cleanEnhancedText(enhanced);
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
            return {
              ok: true,
              minTextLength: MIN_TEXT_LENGTH,
              maxInputChars: MAX_INPUT_CHARS,
              provider: routeInfo?.provider ?? null,
              model: routeInfo?.model ?? null,
              ready: Boolean(routeInfo) && typeof ctx.get('llm')?.stream === 'function',
              hasLlmService: typeof ctx.get('llm')?.stream === 'function',
              selectionKeys: selection === null ? null : Object.keys(selection),
              selection,
            };
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
              const enhanced = await enhance(text, controller.signal);
              return { ok: true, text: enhanced, requestId };
            } catch (e) {
              const code = e && e.code ? String(e.code) : 'unknown';
              const message = e instanceof Error ? e.message : String(e);
              if (code !== 'aborted') {
                ctx.get('logger')?.warn?.(`[dsh-prompt-enhance] enhance failed (${code}): ${message}`);
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
    }, 'dsh-prompt-enhance: routes');
  });
}
