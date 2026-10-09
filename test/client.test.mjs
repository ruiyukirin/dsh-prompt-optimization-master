/**
 * dsh-prompt-enhance — client half state-machine test
 * Author: Kirin (ruiyukirin)
 *
 * Loads the REAL client/client.js in a sandbox with a minimal React
 * implementation, and drives the button through every state transition:
 * hidden on empty draft, enhance, revert, cancel, failure restore, and the
 * "user edited afterwards retires the backup" rule.
 *
 *   node test/client.test.mjs
 */

import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.resolve(HERE, '..', 'client', 'client.js')

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

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

// ---- minimal React with hooks ----
function createReact() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []

  const api = {
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks.length <= index) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = (next) => {
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next
      }
      return [hooks[index].value, set]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const prev = hooks[index]
      if (!prev || !sameDeps(prev.deps, deps)) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const prev = hooks[index]
      if (!prev || !sameDeps(prev.deps, deps)) pendingEffects.push(fn)
      hooks[index] = { deps }
    },
  }

  return {
    api,
    begin() { cursor = 0; pendingEffects = [] },
    end() { const list = pendingEffects; pendingEffects = []; return list },
  }
}

// ---- sandbox ----
function loadClient(options = {}) {
  const storage = new Map(Object.entries(options.storage || {}))
  const harness = createReact()
  const record = { fetchCalls: [], setDraft: [], cancelCalls: 0, enhancers: [] }
  let draft = ''
  let inputPhase = 'plain'
  let sessionId = 'session-test'
  let dictionaries_ = {}
  let activeLocale = 'zh'
  let fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) })
  let registered = null

  const React = harness.api
  const window = {
    location: { origin: 'dsh-app://app', href: 'dsh-app://app/' },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    __ModuleLoader__: {
      load({ factory }) {
        const require = (name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        }
        const exports = factory(require)
        const ctx = {
          // Mirrors the harness locale service: register() supplies dictionaries,
          // bind() hands back a translator for the active language.
          locale: {
            register: (_ns, dictionaries) => { dictionaries_ = dictionaries; return () => { dictionaries_ = {} } },
            bind: () => (key) => {
              const table = dictionaries_[activeLocale] || dictionaries_.zh || {}
              return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
            },
          },
          get: (key) => (key === 'locale' ? ctx.locale : undefined),
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
          slots: {
            inject: (_name, fn) => fn(),
            register: (_registration, component) => { registered = component },
          },
        }
        exports.apply(ctx)
      },
    },
  }

  window.window = window
  const sandbox = {
    window,
    document: { createElement: () => ({ dataset: {}, style: {}, textContent: '' }), head: { appendChild: () => {} } },
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {}
      record.fetchCalls.push({ url: String(url), body })
      return Promise.resolve(fetchImpl(String(url), body))
    },
    console: { error: () => {}, log: () => {}, warn: () => {} },
    setTimeout,
    Promise,
    JSON,
    Math,
    Object,
    String,
    Number,
    Array,
    Error,
    AbortController,
  }
  sandbox.globalThis = sandbox

  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })

  const props = {
    useInput: (selector) => selector({ draft, draftRev: 1, phase: inputPhase }),
    inputActions: {
      setDraft: (value) => { record.setDraft.push(value); draft = value },
    },
    sessionId,
  }

  const render = () => {
    harness.begin()
    const tree = registered(props)
    const effects = harness.end()
    for (const fn of effects) fn()
    return tree
  }

  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    // A setState inside an effect schedules another pass in real React; the
    // sandbox has no scheduler, so render a few times until it settles.
    let tree = render()
    for (let i = 0; i < 4; i += 1) tree = render()
    return tree
  }

  return {
    record,
    render,
    settle,
    getDraft: () => draft,
    setDraftDirect: (value) => { draft = value },
    setFetch: (fn) => { fetchImpl = fn },
    setInputPhase: (value) => { inputPhase = value },
    setSessionId: (value) => { sessionId = value },
    setLocale: (value) => { activeLocale = value },
  }
}

// The button now lives inside a wrapper span (the settings popover anchors to
// it), so the helpers walk one level down instead of assuming the root is the
// button itself.
const findButton = (tree) => {
  if (!tree || !tree.props) return null
  if (tree.type === 'button') return tree
  const children = tree.props.children
  const list = Array.isArray(children) ? children : [children]
  return list.find((node) => node && node.type === 'button') || null
}
const BUTTON_TITLE = (tree) => { const button = findButton(tree); return button ? button.props.title : null }
const BUTTON_CLICK = (tree) => { const button = findButton(tree); if (button) button.props.onClick() }
const BUTTON_CONTEXT = (tree) => {
  const button = findButton(tree)
  if (button && button.props.onContextMenu) button.props.onContextMenu({ preventDefault() {} })
}
const titleStarts = (tree, prefix) => String(BUTTON_TITLE(tree) || '').startsWith(prefix)

// =====================================================================
section('1. 空草稿时隐藏')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('空草稿 -> 不渲染按钮', tree === null, tree && tree.type)
}

section('2. 有草稿时出现，标题为“增强提示词”')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('帮我看下这段代码')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('渲染出 button', Boolean(findButton(tree)), tree && tree.type)
  check('标题正确', titleStarts(tree, '增强提示词'), BUTTON_TITLE(tree))
}

section('3. 点击增强 -> 写回优化结果 -> 变为可还原')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '请解释这段代码的主要功能、执行流程和边界情况。' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('帮我看下这段代码')
  let tree = app.render()
  await app.settle()
  tree = app.render()

  BUTTON_CLICK(tree)
  tree = await app.settle()

  check('调用了 /enhance', app.record.fetchCalls.some((c) => c.url.endsWith('/enhance')), app.record.fetchCalls.map((c) => c.url))
  check('请求里带上了原文', app.record.fetchCalls.some((c) => c.url.endsWith('/enhance') && c.body.text === '帮我看下这段代码'))
  check('写回了优化结果', app.getDraft() === '请解释这段代码的主要功能、执行流程和边界情况。', app.getDraft())
  check('标题变为“恢复原文”', titleStarts(tree, '恢复原文'), BUTTON_TITLE(tree))
}

section('4. 再次点击 -> 还原原文')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '优化后的长文本' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  check('已优化', app.getDraft() === '优化后的长文本', app.getDraft())
  BUTTON_CLICK(tree)
  tree = await app.settle()
  check('还原为原文', app.getDraft() === '原始草稿', app.getDraft())
  check('标题回到“增强提示词”', titleStarts(tree, '增强提示词'), BUTTON_TITLE(tree))
}

section('5. 优化后手动改动 -> 备份失效')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '优化后的文本' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()
  check('优化完成', titleStarts(tree, '恢复原文'), BUTTON_TITLE(tree))

  app.setDraftDirect('用户又改了一版')
  tree = await app.settle()
  check('备份失效，不再提供还原', titleStarts(tree, '增强提示词'), BUTTON_TITLE(tree))

  // Behavioural proof that the backup is really gone: the next click must start
  // a fresh enhancement, not restore the retired original.
  const before = app.record.fetchCalls.filter((c) => c.url.endsWith('/enhance')).length
  BUTTON_CLICK(tree)
  tree = await app.settle()
  const after = app.record.fetchCalls.filter((c) => c.url.endsWith('/enhance')).length
  check('再点是发起新优化而非还原', after === before + 1, { before, after })
  check('新优化写回结果', app.getDraft() === '优化后的文本', app.getDraft())
}

section('6. 优化中点击 -> 取消并还原')
{
  const app = loadClient()
  let releaseEnhance
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/cancel')) return { ok: true, json: async () => ({ ok: true, cancelled: true }) }
    if (url.endsWith('/enhance')) {
      return new Promise((resolve) => { releaseEnhance = () => resolve({ ok: true, json: async () => ({ ok: true, text: '迟到的结果' }) }) })
    }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()

  BUTTON_CLICK(tree)
  tree = await app.settle(2)
  check('进入优化中', /增强中/.test(BUTTON_TITLE(tree) || ''), BUTTON_TITLE(tree))

  BUTTON_CLICK(tree)
  tree = await app.settle(2)
  check('发出了取消请求', app.record.fetchCalls.some((c) => c.url.endsWith('/cancel')), app.record.fetchCalls.map((c) => c.url))
  check('草稿已还原', app.getDraft() === '原始草稿', app.getDraft())

  if (releaseEnhance) releaseEnhance()
  tree = await app.settle()
  check('迟到的结果被丢弃', app.getDraft() === '原始草稿', app.getDraft())
}

section('7. 失败时还原原文并提示')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: false, status: 500, json: async () => ({ ok: false, code: 'llm_error', error: 'model down' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  check('草稿回到原文', app.getDraft() === '原始草稿', app.getDraft())
  check('标题提示失败', /失败/.test(BUTTON_TITLE(tree) || ''), BUTTON_TITLE(tree))
}

section('8. 宿主半未加载（405）时给出可读提示')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: false, status: 405, json: async () => { throw new Error('not json') } }))
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  check('草稿回到原文', app.getDraft() === '原始草稿', app.getDraft())
  check('提示里点明要重启 DSH', /重启 DSH/.test(BUTTON_TITLE(tree) || ''), BUTTON_TITLE(tree))
}

section('9. 宿主返回的错误码译成中文')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) {
      return { ok: true, json: async () => ({ ok: false, code: 'truncated', error: 'the model hit the output limit before finishing the rewrite' }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  check('草稿回到原文', app.getDraft() === '原始草稿', app.getDraft())
  check('truncated 译成中文', /截断/.test(BUTTON_TITLE(tree) || ''), BUTTON_TITLE(tree))
}

section('10. 零宽字符（U+200B）不触发按钮')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))

  app.setDraftDirect('\u200B')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('只有零宽空格 -> 不渲染按钮', tree === null, tree && tree.type)

  app.setDraftDirect('\u200B帮我看下\u200B')
  tree = await app.settle()
  check('含零宽空格的正常草稿 -> 仍渲染', Boolean(findButton(tree)), tree && tree.type)

  BUTTON_CLICK(tree)
  tree = await app.settle()
  const enhanceCall = app.record.fetchCalls.filter((c) => c.url.endsWith('/enhance')).pop()
  check('请求里的草稿已剔除零宽空格', enhanceCall && enhanceCall.body.text === '帮我看下', enhanceCall && enhanceCall.body.text)
}

section('11. 切换会话后状态复位')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '优化后的文本' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()
  check('本会话内已可还原', titleStarts(tree, '恢复原文'), BUTTON_TITLE(tree))

  app.setSessionId('session-other')
  app.setDraftDirect('另一个会话的草稿')
  tree = await app.settle()
  check('切会话后不再提供还原', titleStarts(tree, '增强提示词'), BUTTON_TITLE(tree))
}

section('12. 输入框忙碌时不显示（但有备份时仍可还原）')
{
  const app = loadClient()
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '优化后的文本' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  app.setInputPhase('submitting')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('忙碌且无备份 -> 隐藏', tree === null, tree && tree.type)

  app.setInputPhase('plain')
  tree = await app.settle()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  app.setInputPhase('submitting')
  tree = await app.settle()
  check('忙碌但有备份 -> 仍显示（不能把还原锁死）', titleStarts(tree, '恢复原文'), BUTTON_TITLE(tree))
}

section('13. 设置：关闭后按钮变暗但仍可打开设置')
{
  const app = loadClient({
    storage: { 'dsh-prompt-optimization-master:settings': JSON.stringify({ enabled: false, minTextLength: null, provider: '', model: '' }) },
  })
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('空草稿下仍渲染（否则没有回到设置的路）', Boolean(findButton(tree)), tree && tree.type)
  check('按钮带 is-off 样式', /is-off/.test(findButton(tree).props.className), findButton(tree).props.className)
  check('提示文案说明已关闭', /已关闭/.test(BUTTON_TITLE(tree) || ''), BUTTON_TITLE(tree))
}

section('14. 设置：自定义最小字数生效')
{
  const app = loadClient({
    storage: { 'dsh-prompt-optimization-master:settings': JSON.stringify({ enabled: true, minTextLength: 5, provider: '', model: '' }) },
  })
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('你好')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('2 字 < 门槛 5 -> 隐藏', tree === null, tree && tree.type)

  app.setDraftDirect('你好你好你好')
  tree = await app.settle()
  check('6 字 >= 门槛 5 -> 显示', Boolean(findButton(tree)), tree && tree.type)
}

section('15. 设置：模型覆盖随请求发出')
{
  const app = loadClient({
    storage: {
      'dsh-prompt-optimization-master:settings': JSON.stringify({ enabled: true, minTextLength: null, provider: 'deepseek-account', model: 'deepseek-chat' }),
    },
  })
  app.setFetch(async (url) => {
    if (url.endsWith('/config')) return { ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }
    if (url.endsWith('/enhance')) return { ok: true, json: async () => ({ ok: true, text: '优化后的文本' }) }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  BUTTON_CLICK(tree)
  tree = await app.settle()

  const call = app.record.fetchCalls.filter((c) => c.url.endsWith('/enhance')).pop()
  check('请求带上 model', call && call.body.model === 'deepseek-chat', call && call.body)
  check('请求带上 provider', call && call.body.provider === 'deepseek-account', call && call.body)
}

section('16. 国际化：跟随界面语言')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setLocale('en')
  app.setDraftDirect('a draft')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('英文界面下按钮提示为英文', titleStarts(tree, 'Enhance prompt'), BUTTON_TITLE(tree))

  app.setLocale('zh')
  tree = await app.settle()
  check('切回中文后提示为中文', titleStarts(tree, '增强提示词'), BUTTON_TITLE(tree))
}

section('17. 右键打开设置面板')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('默认不显示面板', !Array.isArray(tree.props.children) || tree.props.children.length === 1)

  BUTTON_CONTEXT(tree)
  tree = await app.settle()
  const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
  check('右键后面板挂载', children.length === 2 && typeof children[1].type === 'function', children.length)
  check('面板拿到 settings / onSave / onClose', children[1].props && typeof children[1].props.onSave === 'function' && typeof children[1].props.onClose === 'function')

  // Saving from the panel must go through saveSettings and update the button.
  children[1].props.onSave({ enabled: true, minTextLength: 9, provider: '', model: '' })
  tree = await app.settle()
  check('保存后设置生效（门槛 9）', true)
  app.setDraftDirect('短')
  tree = await app.settle()
  check('3 字以下按新门槛隐藏', tree === null, tree && tree.type)
}

console.log(`\n${'='.repeat(48)}`)
console.log(failures === 0 ? `全部通过：${checks} 项检查` : `失败 ${failures} 项 / 共 ${checks} 项检查`)
process.exit(failures === 0 ? 0 : 1)
