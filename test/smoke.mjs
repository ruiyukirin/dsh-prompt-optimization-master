/**
 * dsh-prompt-enhance — host half smoke test
 * Author: Kirin (ruiyukirin)
 *
 * Runs the real host half against a fake Cordis context and a real HTTP server,
 * so route registration, the request guard, prompt assembly, streaming
 * accumulation, result cleaning, error codes and cancellation are all exercised
 * without restarting DSH.
 *
 *   node test/smoke.mjs
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

/** A fake `ctx.llm` whose behaviour each test sets. */
let streamFactory = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
let lastGenerateOptions = null

function makeStream() {
  const stream = streamFactory(lastGenerateOptions)
  return stream
}

// ---- fake Cordis context ----
const routes = []
const warnings = []

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

// The service registry a plugin may only reach through `ctx.get(key)` or a
// declared `inject`.
const services = {
  logger: { warn: (message) => warnings.push(String(message)) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  llm: { stream: (options) => { lastGenerateOptions = options; return makeStream() } },
}

const ctx = {
  get(key) { return services[key] },
  inject(services, callback) {
    if (services.includes('webServer')) callback(hostCtx)
  },
}

// Cordis refuses a direct service property access that was never declared with
// `inject`. Reproduce that guard, otherwise the sandbox happily allows
// `ctx.llm` and this test cannot catch the real failure mode.
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

async function post(routePath, body, headers = {}) {
  const response = await fetch(base + routePath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  let data = null
  try { data = await response.json() } catch { /* keep null */ }
  return { status: response.status, data }
}

const streamOf = (...chunks) => (async function* () { for (const chunk of chunks) yield chunk })()
const textDelta = (text) => ({ type: 'text-delta', index: 0, text })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const errored = (message, code) => ({ type: 'finish', reason: { kind: 'error', failure: { message, code } } })

// ---- 1. route table ----
section('1. 路由注册')
check('注册了 3 条路由', routes.length === 3, routes.map((r) => r.path))
check('enhance 路由存在', routes.some((r) => r.path === '/dsh-prompt-enhance/enhance'))
check('cancel 路由存在', routes.some((r) => r.path === '/dsh-prompt-enhance/cancel'))
check('config 路由存在', routes.some((r) => r.path === '/dsh-prompt-enhance/config'))

// ---- 2. config ----
section('2. /config')
{
  const { status, data } = await post('/dsh-prompt-enhance/config')
  check('HTTP 200', status === 200, status)
  check('minTextLength = 1', data?.minTextLength === 1, data?.minTextLength)
  check('报告 provider', data?.provider === 'mock-provider', data?.provider)
  check('报告 model', data?.model === 'mock-model', data?.model)
  check('ready = true', data?.ready === true, data)
}

// ---- 3. 请求守卫 ----
section('3. 请求守卫')
{
  const desktop = await post('/dsh-prompt-enhance/config', {}, { origin: 'dsh-app://app' })
  check('接受桌面版 Origin dsh-app://app', desktop.status === 200, desktop.status)

  const foreign = await post('/dsh-prompt-enhance/config', {}, { origin: 'https://evil.example.com' })
  check('拒绝外部 Origin（403）', foreign.status === 403, foreign.status)

  const noOrigin = await post('/dsh-prompt-enhance/config', {}, {})
  check('接受无 Origin 的调用', noOrigin.status === 200, noOrigin.status)

  const wrongMethod = await fetch(base + '/dsh-prompt-enhance/config', { method: 'GET' })
  check('拒绝非 POST（405）', wrongMethod.status === 405, wrongMethod.status)
}

// ---- 4. 提示词组装 ----
section('4. 提示词组装')
{
  streamFactory = () => streamOf(textDelta('优化后的提示词'), stop)
  const { data } = await post('/dsh-prompt-enhance/enhance', { text: '帮我看下这段代码' })
  check('返回 ok', data?.ok === true, data)
  check('拼接了文本分片', data?.text === '优化后的提示词', data?.text)
  check('provider 传对了', lastGenerateOptions?.provider === 'mock-provider', lastGenerateOptions?.provider)
  check('model 传对了', lastGenerateOptions?.model === 'mock-model', lastGenerateOptions?.model)
  check('system 提示词非空', typeof lastGenerateOptions?.system === 'string' && lastGenerateOptions.system.length > 200, lastGenerateOptions?.system?.length)
  check('system 提到 Prompt Engineering', /Prompt Engineering Expert/.test(lastGenerateOptions?.system ?? ''))
  check('system 含 800 字符长度约束', /maximum length should be around 800 characters/.test(lastGenerateOptions?.system ?? ''))
  check(
    'system 含 WorkBuddy 的 2 组英文少样本',
    /A website for my dog/.test(lastGenerateOptions?.system ?? '') && /genie router/.test(lastGenerateOptions?.system ?? ''),
  )
  check('user 消息含草稿原文', JSON.stringify(lastGenerateOptions?.messages ?? []).includes('帮我看下这段代码'))
  check('user 消息含语言锁定条款', JSON.stringify(lastGenerateOptions?.messages ?? []).includes('LANGUAGE CONSISTENCY'))
  check('带上了 signal（可取消）', lastGenerateOptions?.signal instanceof AbortSignal)
}

// ---- 4b. 单次请求的模型覆盖 ----
section('4b. 单次请求的模型覆盖')
{
  streamFactory = () => streamOf(textDelta('覆盖后的结果'), stop)

  const both = await post('/dsh-prompt-enhance/enhance', { text: '草稿', provider: 'custom-provider', model: 'custom-model' })
  check('provider 覆盖生效', lastGenerateOptions?.provider === 'custom-provider', lastGenerateOptions?.provider)
  check('model 覆盖生效', lastGenerateOptions?.model === 'custom-model', lastGenerateOptions?.model)
  check('覆盖时仍返回结果', both.data?.text === '覆盖后的结果', both.data?.text)

  await post('/dsh-prompt-enhance/enhance', { text: '草稿', model: 'another-model' })
  check(
    '只覆盖 model 时 provider 跟随默认',
    lastGenerateOptions?.provider === 'mock-provider' && lastGenerateOptions?.model === 'another-model',
    { provider: lastGenerateOptions?.provider, model: lastGenerateOptions?.model },
  )

  await post('/dsh-prompt-enhance/enhance', { text: '草稿', provider: '   ' })
  check(
    '空白覆盖值被忽略（回落默认路由）',
    lastGenerateOptions?.provider === 'mock-provider' && lastGenerateOptions?.model === 'mock-model',
    { provider: lastGenerateOptions?.provider, model: lastGenerateOptions?.model },
  )
}

// ---- 5. 多分片累积 ----
section('5. 多分片累积')
{
  streamFactory = () => streamOf(textDelta('第一段'), textDelta('，第二段'), stop)
  const { data } = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('分片按顺序拼接', data?.text === '第一段，第二段', data?.text)
}

// ---- 6. 结果清洗 ----
section('6. 结果清洗')
{
  streamFactory = () => streamOf(textDelta('```markdown\n清理后的内容\n```'), stop)
  const fenced = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('剥掉 markdown 围栏', fenced.data?.text === '清理后的内容', fenced.data?.text)

  streamFactory = () => streamOf(textDelta('“带中文引号的结果”'), stop)
  const quoted = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('剥掉首尾引号', quoted.data?.text === '带中文引号的结果', quoted.data?.text)
}

// ---- 7. 错误路径 ----
section('7. 错误路径')
{
  const empty = await post('/dsh-prompt-enhance/enhance', { text: '   ' })
  check('空输入 -> empty_input', empty.data?.code === 'empty_input', empty.data)

  const tooLong = await post('/dsh-prompt-enhance/enhance', { text: 'x'.repeat(20_001) })
  check('超长 -> too_long', tooLong.data?.code === 'too_long', tooLong.data?.code)

  streamFactory = () => streamOf(errored('rate limited', 'RATE_LIMIT'))
  const rateLimited = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('上游失败 -> 透传 code', rateLimited.data?.code === 'RATE_LIMIT', rateLimited.data)

  streamFactory = () => streamOf(textDelta('   '), stop)
  const blank = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('空白结果 -> empty_result', blank.data?.code === 'empty_result', blank.data)

  streamFactory = () => streamOf(textDelta('草稿'), stop)
  const unchanged = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('原样返回 -> unchanged', unchanged.data?.code === 'unchanged', unchanged.data)

  // Measured in the real Host: reasoning can consume the whole output budget,
  // so a budget hit must surface as its own code rather than an empty result.
  streamFactory = () => streamOf(textDelta('还没写完就被截断'), { type: 'finish', reason: { kind: 'max-tokens' } })
  const truncated = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('触发输出上限 -> truncated', truncated.data?.code === 'truncated', truncated.data)

  streamFactory = () => streamOf({ type: 'finish', reason: { kind: 'max-tokens' } })
  const truncatedEmpty = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('推理吃光预算 -> truncated（而不是 empty_result）', truncatedEmpty.data?.code === 'truncated', truncatedEmpty.data)

  check('失败都写了 warn 日志', warnings.length >= 2, warnings)
}

// ---- 8. 取消 ----
section('8. 取消')
{
  const unknown = await post('/dsh-prompt-enhance/cancel', { requestId: 'nope' })
  check('未知 requestId -> cancelled false', unknown.data?.cancelled === false, unknown.data)

  streamFactory = () => (async function* () {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      yield textDelta('x')
    }
    yield stop
  })()

  const pending = post('/dsh-prompt-enhance/enhance', { text: '草稿内容', requestId: 'cancel-me' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const cancelResult = await post('/dsh-prompt-enhance/cancel', { requestId: 'cancel-me' })
  check('取消成功', cancelResult.data?.cancelled === true, cancelResult.data)

  const settled = await pending
  check('被取消的请求返回 aborted', settled.data?.code === 'aborted', settled.data)
}

// ---- 9. LLM 服务缺席 ----
section('9. llm 服务缺席')
{
  const saved = services.llm
  services.llm = undefined
  const result = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('llm 不可用 -> llm_unavailable', result.data?.code === 'llm_unavailable', result.data)
  services.llm = saved

  const savedSelection = services.agentDefaultModel
  services.agentDefaultModel = { currentSelection: () => undefined }
  const noRoute = await post('/dsh-prompt-enhance/enhance', { text: '草稿' })
  check('没有模型路由 -> no_route', noRoute.data?.code === 'no_route', noRoute.data)
  services.agentDefaultModel = savedSelection
}

server.close()

console.log(`\n${'='.repeat(48)}`)
console.log(failures === 0 ? `全部通过：${checks} 项检查` : `失败 ${failures} 项 / 共 ${checks} 项检查`)
process.exit(failures === 0 ? 0 : 1)
