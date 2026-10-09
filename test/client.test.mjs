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
// One element factory shared by every store: it carries no state of its own.
function createElementImpl(type, props, ...children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

// Each mounted component gets its own hook store. The `react` handle handed to
// the module is a proxy that routes every hook call to whichever store is
// currently rendering — otherwise a component rendered for a second slot would
// silently share (and corrupt) the first one's hooks.
function createReact() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []

  const api = {
    createElement: createElementImpl,
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
    hooks,
    begin() { cursor = 0; pendingEffects = [] },
    end() { const list = pendingEffects; pendingEffects = []; return list },
  }
}

// ---- sandbox ----
function loadClient(options = {}) {
  const storage = new Map(Object.entries(options.storage || {}))
  const harness = createReact()
  const pageHarness = createReact()
  let activeHarness = harness
  // The module receives this proxy once, at load time, so hook calls must find
  // their store dynamically rather than being bound to whichever was first.
  const React = {
    createElement: createElementImpl,
    useState: (...args) => activeHarness.api.useState(...args),
    useRef: (...args) => activeHarness.api.useRef(...args),
    useCallback: (...args) => activeHarness.api.useCallback(...args),
    useEffect: (...args) => activeHarness.api.useEffect(...args),
  }
  const record = { fetchCalls: [], setDraft: [], cancelCalls: 0, enhancers: [] }
  let draft = ''
  let inputPhase = 'plain'
  let sessionId = 'session-test'
  let dictionaries_ = {}
  let activeLocale = 'zh'
  let fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) })
  let registered = null
  const registrations = new Map()
  const listeners = []
  let appliedInject = null

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
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0 },
    addEventListener: (type, fn) => { listeners.push({ type, fn }) },
    removeEventListener: (type, fn) => {
      for (let i = listeners.length - 1; i >= 0; i -= 1) {
        if (listeners[i].type === type && listeners[i].fn === fn) listeners.splice(i, 1)
      }
    },
    dispatchEvent: (event) => {
      const type = event && event.type
      for (const entry of listeners.slice()) if (entry.type === type) entry.fn(event)
      return true
    },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type } },
    __ModuleLoader__: {
      load({ factory }) {
        const require = (name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        }
        const exports_ = factory(require)
        appliedInject = exports_.inject
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
            register: (registration, component) => {
              registrations.set(registration.name, { registration, component })
              // Two slots are registered now, so the composer one is tracked by
              // name instead of "the last component registered".
              if (registration.name === 'conversation.input.right') registered = component
            },
          },
        }
        exports_.apply(ctx)
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
    activeHarness = harness
    harness.begin()
    if (!registered) return null
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
    getInject: () => appliedInject,
    getRegistration: (slotName) => registrations.get(slotName),
    /** Render the settings page with the single prop the slot hands it.
     *  Its own store, so consecutive renders keep the page's state while the
     *  composer button keeps its own. */
    renderPage: (pageProps = { close: () => {} }) => {
      const entry = registrations.get('settings.section')
      if (!entry) return null
      activeHarness = pageHarness
      pageHarness.begin()
      const tree = entry.component(pageProps)
      for (const fn of pageHarness.end()) fn()
      return tree
    },
    getStorage: () => storage,
    getPageHarness: () => pageHarness,
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

section('13. 设置：注册进设置页侧边栏 + 关闭后按钮整体消失')
{
  const app = loadClient({
    storage: { 'dsh-prompt-optimization-master:settings': JSON.stringify({ enabled: false, minTextLength: null, provider: '', model: '' }) },
  })
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('原始草稿')
  let tree = app.render()
  await app.settle()
  tree = app.render()

  // Disabled means gone: the settings page is the way back, so there is no trap.
  check('关闭后按钮整体消失', tree === null, tree && tree.type)

  const entry = app.getRegistration('settings.section')
  check('注册了设置页 settings.section', Boolean(entry), entry && entry.registration)
  check('设置页 id 正确', entry && entry.registration.id === 'dsh-prompt-optimization-master', entry && entry.registration.id)
  check('设置页 label 是 thunk（可跟随语言）', entry && typeof entry.registration.label === 'function', entry && typeof entry.registration.label)
  check('label 内容为中文导航名', entry && entry.registration.label() === '提示词优化', entry && entry.registration.label())
  check('带了 locale 命名空间', entry && entry.registration.locale === 'dsh-prompt-optimization-master', entry && entry.registration.locale)
}

section('13b. 国际化必须声明 locale 注入（本轮 bug 的回归守卫）')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  const inject = app.getInject()
  check('exports.inject 含 slots', Array.isArray(inject) && inject.includes('slots'), inject)
  check('exports.inject 含 locale（漏了就会渲染原始 key）', Array.isArray(inject) && inject.includes('locale'), inject)
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

section('17. 设置页渲染与保存')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('原始草稿')
  await app.settle()

  const page = app.renderPage({ close: () => {} })
  check('设置页渲染出根节点', Boolean(page), page && page.type)
  check('根节点是设置页容器', page && page.props.className === 'dsh-pe-page', page && page.props.className)

  const flat = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    flat.push(node)
    const children = node.props && node.props.children
    for (const child of Array.isArray(children) ? children : [children]) walk(child)
  }
  walk(page)

  const texts = flat.map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).join(' | ')
  check('页面标题已本地化（不是原始 key）', texts.includes('提示词优化'), texts.slice(0, 80))
  check('页面没有裸露的 key', !/settings\.[a-zA-Z]+/.test(texts), texts.match(/settings\.[a-zA-Z]+/g))

  const checkbox = flat.find((n) => n.type === 'input' && n.props.type === 'checkbox')
  check('有启用开关', Boolean(checkbox), checkbox && checkbox.props)
  const numberInput = flat.find((n) => n.type === 'input' && n.props.type === 'number')
  check('有最小字数输入', Boolean(numberInput), numberInput && numberInput.props)
  const saveButton = flat.find((n) => n.type === 'button' && /保存|Save/.test(String(n.props.children)))
  check('有保存按钮', Boolean(saveButton), saveButton && saveButton.props.children)
  const closeButton = flat.find((n) => n.type === 'button' && /关闭|Close/.test(String(n.props.children)))
  check('有壳层给的关闭按钮', Boolean(closeButton), closeButton && closeButton.props.children)
}

section('18. 设置页保存会通知输入框按钮')
{
  const app = loadClient()
  app.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, minTextLength: 1 }) }))
  app.setDraftDirect('原始草稿这里够长')
  let tree = app.render()
  await app.settle()
  tree = app.render()
  check('默认门槛下按钮可见', Boolean(findButton(tree)), tree && tree.type)

  // Save a high threshold from the settings page, then the button must react.
  const page = app.renderPage({ close: () => {} })
  const flat = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    flat.push(node)
    const children = node.props && node.props.children
    for (const child of Array.isArray(children) ? children : [children]) walk(child)
  }
  walk(page)
  const numberInput = flat.find((n) => n.type === 'input' && n.props.type === 'number')
  numberInput.props.onChange({ target: { value: '50' } })

  const page2 = app.renderPage({ close: () => {} })
  const flat2 = []
  const walk2 = (node) => {
    if (!node || typeof node !== 'object') return
    flat2.push(node)
    const children = node.props && node.props.children
    for (const child of Array.isArray(children) ? children : [children]) walk2(child)
  }
  walk2(page2)
  const numberInput2 = flat2.find((n) => n.type === 'input' && n.props.type === 'number')
  check('门槛输入回读为 50', numberInput2 && String(numberInput2.props.value) === '50', numberInput2 && numberInput2.props.value)
  const saveButton = flat2.find((n) => n.type === 'button' && /保存|Save/.test(String(n.props.children)))
  saveButton.props.onClick()
  const stored = app.getStorage().get('dsh-prompt-optimization-master:settings') || ''
  check('设置已写入本地存储', /"minTextLength":50/.test(stored), stored)

  // The composer button listens for the change and re-reads.
  tree = await app.settle()
  check('门槛 50 > 草稿 8 字 -> 按钮隐藏', tree === null, tree && tree.type)
}

console.log(`\n${'='.repeat(48)}`)
console.log(failures === 0 ? `全部通过：${checks} 项检查` : `失败 ${failures} 项 / 共 ${checks} 项检查`)
process.exit(failures === 0 ? 0 : 1)
