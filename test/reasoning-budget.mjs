/**
 * dsh-prompt-optimization-master — reasoning-budget regression test
 * Author: Kirin (ruiyukirin)
 *
 * Covers the failure that made the button spin forever without producing a
 * rewrite: a model that thinks before it answers spent the whole fixed output
 * budget on reasoning, so every request ended `truncated` after ~90-115s.
 *
 * These checks lock in the repair:
 *   - the output budget follows the routed model's reasoning capability;
 *   - the model's own ceiling caps the request;
 *   - a cut-off on the small budget retries once with the larger one;
 *   - a pointless retry is never sent;
 *   - a hanging capability lookup never fails or stalls the rewrite.
 *
 *   node test/reasoning-budget.mjs
 *
 * The real 60-second wall-clock timeout is opt-in, because waiting it out
 * would dominate the suite:
 *
 *   DSH_PE_SLOW_TESTS=1 node test/reasoning-budget.mjs
 */

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMPL = pathToFileURL(path.resolve(HERE, '..', 'dsh', 'index.js')).href

let failures = 0
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---- fake Cordis context ----
const routes = []

/**
 * Per-test behaviour of the fake model route.
 *
 * The plugin caches a route's capabilities, and the cache key is
 * provider+model, so every case below runs on its OWN model id. That keeps the
 * cases independent and doubles as a check that the cache is keyed by route
 * rather than shared across them.
 */
let currentModel = 'mock-model-0'
let streamFactory = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
const catalog = new Map()
let lastOptions = null

/** Route the next case to a fresh model id and describe that model. */
function routeTo(id, describe) {
  currentModel = id
  catalog.set(id, typeof describe === 'function' ? describe : async () => describe)
  return id
}

const hostCtx = {
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => { /* dispose */ }
    },
  },
}

const services = {
  logger: { warn: () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: currentModel }) },
  llm: {
    stream(options) {
      lastOptions = options
      return streamFactory(options)
    },
    resolveModelInfo(provider, model) {
      const entry = catalog.get(model)
      if (entry === undefined) return Promise.resolve({ id: model, name: model })
      return entry(provider, model)
    },
  },
}

const ctx = {
  get(key) { return services[key] },
  inject(names, callback) {
    if (names.includes('webServer')) callback(hostCtx)
  },
}

for (const key of ['llm', 'agentDefaultModel', 'logger']) {
  Object.defineProperty(ctx, key, {
    configurable: true,
    get() { throw new Error(`cannot get property "${key}" without inject`) },
    set() { throw new Error(`cannot set property "${key}" without inject`) },
  })
}

const impl = await import(IMPL)
impl.apply(ctx, {})

// ---- real HTTP server over the registered routes ----
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const route = routes.find((entry) => entry.path === url.pathname)
  if (!route) {
    response.writeHead(404)
    response.end()
    return
  }
  Promise.resolve(route.handler(request, response)).catch(() => {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function post(routePath, body = {}) {
  const response = await fetch(base + routePath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data = null
  try { data = await response.json() } catch { /* keep null */ }
  return { status: response.status, data }
}

const config = () => post('/dsh-prompt-enhance/config')
const enhance = (text) => post('/dsh-prompt-enhance/enhance', { text, requestId: 'req-' + Math.random() })

const textDelta = (text) => ({ type: 'text-delta', index: 0, text })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const cutOff = { type: 'finish', reason: { kind: 'max-tokens' } }

/** A reasoning model that offers only real thinking levels. */
const thinkingModel = (extra = {}) => () => ({
  id: currentModel,
  name: 'Mock',
  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
  ...extra,
})

/** A model whose only level is `off`: it never thinks. */
const plainModel = (extra = {}) => () => ({
  id: currentModel,
  name: 'Mock',
  reasoning: { efforts: [{ id: 'off', name: 'Off' }] },
  ...extra,
})

/** A model that carries no reasoning metadata at all. */
const bareModel = (extra = {}) => () => ({ id: currentModel, name: 'Mock', ...extra })

// ---- 1. budget follows the model ----
section('1. 输出额度跟随模型能力')
{
  routeTo('m-thinking', thinkingModel())
  let data = (await config()).data
  check('会思考的模型 -> thinking = true', data?.thinking === true, data)
  check('会思考的模型 -> 额度 32768', data?.maxTokens === 32768, data?.maxTokens)
  check('报告推理档位', Array.isArray(data?.effortIds) && data.effortIds.includes('high'), data?.effortIds)

  routeTo('m-plain', plainModel())
  data = (await config()).data
  check('只有 off 一档 -> thinking = false', data?.thinking === false, data)
  check('不思考的模型 -> 额度 4096', data?.maxTokens === 4096, data?.maxTokens)

  routeTo('m-bare', bareModel())
  data = (await config()).data
  check('没有推理元数据 -> thinking = false', data?.thinking === false, data)
  check('没有推理元数据 -> 额度 4096', data?.maxTokens === 4096, data?.maxTokens)

  check('对外公布超时时间', (await config()).data?.timeoutMs === 60000)
}

// ---- 1b. the capability cache is keyed by route ----
section('1b. 能力缓存按路线隔离')
{
  routeTo('m-cache-a', thinkingModel())
  const a = (await config()).data
  routeTo('m-cache-b', plainModel())
  const b = (await config()).data
  routeTo('m-cache-a', thinkingModel())
  const aAgain = (await config()).data
  check('两条路线各自独立', a?.thinking === true && b?.thinking === false, { a: a?.thinking, b: b?.thinking })
  check('回到原路线仍用缓存的原答案', aAgain?.thinking === true, aAgain?.thinking)
}

// ---- 2. the model's own ceiling caps the request ----
section('2. 模型自身上限封顶')
{
  routeTo('m-cap-plain', plainModel({ defaultMaxTokens: 2048 }))
  let data = (await config()).data
  check('上限低于额度 -> 取上限', data?.maxTokens === 2048, data?.maxTokens)
  check('报告上限值', data?.modelCeiling === 2048, data?.modelCeiling)

  routeTo('m-cap-think', thinkingModel({ defaultMaxTokens: 8000 }))
  data = (await config()).data
  check('会思考 + 低上限 -> 取上限', data?.maxTokens === 8000, data?.maxTokens)
}

// ---- 3. a hanging lookup never stalls or fails the rewrite ----
section('3. 能力查询挂起不影响改写')
{
  routeTo('m-hang', () => new Promise(() => {})) // never settles
  let seenTokens = null
  streamFactory = (options) => {
    seenTokens = options.maxTokens
    return (async function* () { yield textDelta('改写结果'); yield stop })()
  }
  const started = Date.now()
  const { data } = await enhance('原始草稿')
  const elapsed = Date.now() - started
  check('查询卡住时改写仍然成功', data?.ok === true, data)
  check('没有白等整个守卫时间', elapsed < 3000, `${elapsed}ms`)
  check('回退到安全的小额度', seenTokens === 4096, seenTokens)
}

// ---- 4. truncation on the small budget retries with the larger one ----
section('4. 截断自动重试')
{
  routeTo('m-retry', plainModel())
  const seen = []
  streamFactory = (options) => {
    seen.push(options.maxTokens)
    return (async function* () {
      if (seen.length === 1) { yield cutOff; return }
      yield textDelta('重试后的改写结果')
      yield stop
    })()
  }
  const { data } = await enhance('原始草稿')
  check('重试后成功', data?.ok === true, data)
  check('发起了两次请求', seen.length === 2, seen)
  check('第一次用小额度', seen[0] === 4096, seen[0])
  check('第二次用大额度', seen[1] === 32768, seen[1])
}

// ---- 5. a pointless retry is never sent ----
section('5. 无效重试会被抑制')
{
  // The model's own ceiling equals the small budget, so a retry would send the
  // byte-identical request and fail the same way.
  routeTo('m-noretry', plainModel({ defaultMaxTokens: 4096 }))
  let calls = 0
  streamFactory = () => {
    calls += 1
    return (async function* () { yield cutOff })()
  }
  const { data } = await enhance('原始草稿')
  check('仍然报 truncated', data?.code === 'truncated', data)
  check('只发了一次请求', calls === 1, calls)
}

// ---- 5b. a thinking model is not retried, because its budget already is large ----
section('5b. 会思考的模型不重试')
{
  routeTo('m-think-noretry', thinkingModel())
  let calls = 0
  streamFactory = () => {
    calls += 1
    return (async function* () { yield cutOff })()
  }
  const { data } = await enhance('原始草稿')
  check('报 truncated', data?.code === 'truncated', data)
  check('只发了一次请求', calls === 1, calls)
}

// ---- 6. a cut-off on a thinking model explains what to do ----
section('6. 截断提示可自救')
{
  routeTo('m-msg', thinkingModel())
  streamFactory = () => (async function* () { yield cutOff })()
  const { data } = await enhance('原始草稿')
  check('报 truncated', data?.code === 'truncated', data)
  check('提示去设置里指定模型', /Settings/.test(data?.error ?? ''), data?.error)
  check('提示里带上了实际额度', /32768/.test(data?.error ?? ''), data?.error)
}

// ---- 7. normal success still works ----
section('7. 正常路径不受影响')
{
  routeTo('m-ok', plainModel())
  streamFactory = () => (async function* () {
    yield textDelta('请解释这段代码的')
    yield textDelta('主要功能与执行流程。')
    yield stop
  })()
  const { data } = await enhance('解释这段代码')
  check('成功', data?.ok === true, data)
  check('分片拼接正确', data?.text === '请解释这段代码的主要功能与执行流程。', data?.text)
}

// ---- 8. the real 60s deadline (opt-in) ----
if (process.env.DSH_PE_SLOW_TESTS === '1') {
  section('8. 60 秒硬超时（慢速测试）')
  routeTo('m-timeout', plainModel())
  streamFactory = () => (async function* () {
    // Yield once so the stream is alive, then stall forever.
    yield textDelta('开始')
    await new Promise(() => {})
  })()
  const started = Date.now()
  const { data } = await enhance('原始草稿')
  const elapsed = Date.now() - started
  console.log(`  (耗时 ${Math.round(elapsed / 1000)} 秒)`)
  check('超时报 timeout 而不是无限等待', data?.code === 'timeout', data)
  check('在 60 秒附近中止', elapsed >= 59000 && elapsed < 75000, `${elapsed}ms`)
} else {
  console.log('\n8. 60 秒硬超时（慢速测试）\n  skipped 设 DSH_PE_SLOW_TESTS=1 才会跑')
}

server.close()

console.log('\n' + '='.repeat(48))
if (failures === 0) {
  console.log(`全部通过：${checks} 项检查`)
} else {
  console.log(`${checks} 项检查，${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
