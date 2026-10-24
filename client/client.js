window.__ModuleLoader__.load({ id: "dsh-prompt-optimization-master", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-prompt-optimization-master — client half
 * Author: Kirin (ruiyukirin)
 *
 * Mounts the ✨ enhance button into the composer toolbar cell
 * `conversation.input.right`, immediately before the submit action.
 *
 * Draft contract (verified against the live slot, see docs/阶段0-探针结论.md):
 *   read  : props.useInput(s => s.draft)
 *   write : props.inputActions.setDraft(text)
 *
 * Three states, mirroring WorkBuddy's EnhancePrompt:
 *   idle    ✨  enhance the current draft
 *   loading ⏳  click cancels and restores the original
 *   done    ↩️  click restores the original
 * The button is hidden while the draft is empty, which is what makes it appear
 * on typing and disappear again on clearing.
 */

const React = require('react')
const h = React.createElement
const { useCallback, useEffect, useRef, useState } = React

const MIN_TEXT_FALLBACK = 1
/** Used only until `POST /config` answers with the runtime's real default. */
const HOST_TIMEOUT_FALLBACK_MS = 60_000
/** Mirrors the host clamp, so the seconds field cannot promise what the host refuses. */
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 300_000
const ROUTE = '/dsh-prompt-enhance'
const selectDraft = (state) => state.draft
const selectPhase = (state) => state.phase

/**
 * Zero-width space (U+200B). The editor inserts it as an invisible placeholder,
 * so a draft that looks empty can still be one character long. WorkBuddy strips
 * it before measuring; without that the button appears for a blank draft and
 * fires a pointless model call.
 */
const ZERO_WIDTH_RE = /\u200B/g

/**
 * Input phases during which the composer is not accepting new input. The
 * vocabulary is taken from the harness input shell itself, which refuses
 * `insertText` in exactly these two phases. Any other value leaves the button
 * usable, so an unknown phase can never lock the user out.
 */
const BUSY_INPUT_PHASES = ['submitting', 'adjudicating']

function cleanDraft(value) {
  return value.replace(ZERO_WIDTH_RE, '').trim()
}

// ---- i18n ----
// Registered through the harness locale service, so the button follows the
// language chosen in Settings → Language, like every shipped control.
const LOCALE_NS = 'dsh-prompt-optimization-master'

const LOCALES = {
  zh: {
    'button.enhance': '增强提示词',
    'button.enhancing': '增强中…（点击取消并还原）',
    'button.revert': '恢复原文',
    'button.failed': '增强失败：{message}（点一下重试）',
    'error.empty_input': '草稿是空的',
    'error.too_long': '草稿太长了',
    'error.truncated': '输出被截断了，没能生成完整提示词（若是"会思考"的模型，去「设置 → 提示词优化」指定一个不思考的模型）',
    'error.timeout': '优化超时了（超过 {seconds} 秒没结果），请换个更快的模型或稍后再试',
    'error.empty_result': '模型没返回内容',
    'error.unchanged': '模型认为无需改动',
    'error.llm_unavailable': '模型服务不可用',
    'error.no_route': '没有可用的模型',
    'error.llm_error': '模型调用失败',
    'error.untrusted_origin': '请求被宿主守卫拒绝',
    'error.fallback': '增强失败',
    'hint.hostMissing': '（宿主半未加载，请重启 DSH）',
    'hint.forbidden': '（请求被宿主守卫拒绝）',
    'settings.nav': '提示词优化',
    'settings.title': '提示词优化',
    'settings.desc': '给输入框加一个 ✨ 按钮：点一下，把还没发出去的草稿改写成更清晰、更具体的提示词；再点一下还原原文。',
    'settings.enabled': '启用 ✨ 按钮',
    'settings.enabledHint': '关闭后按钮会从输入框消失，随时可以回到这里重新打开。',
    'settings.minLength': '最少字符数',
    'settings.minLengthHint': '草稿短于这个长度就不显示按钮；留空则跟随宿主默认值',
    'settings.modelMode': '优化用模型',
    'settings.modelCustom': '指定模型（不勾选则跟随当前会话模型）',
    'settings.modelSelect': '可用模型',
    'settings.modelPick': '跟随上面的勾选（不指定）',
    'settings.modelsLoading': '正在读取可用模型…',
    'settings.modelsFailed': '读不到模型列表，请在下面手动填写',
    'settings.modelsEmpty': '宿主没有返回模型列表，请在下面手动填写',
    'settings.modelsPartial': '这些提供方没连上，暂时列不出来：{names}',
    'settings.modelManual': '手动填写提供方和模型 ID',
    'settings.provider': '提供方 provider（可留空）',
    'settings.model': '模型 ID',
    'settings.modelRequired': '指定模型时必须选一个或手动填写模型 ID',
    'settings.timeoutLabel': '超时时间（秒）',
    'settings.timeoutPlaceholder': '留空用宿主默认值',
    'settings.timeoutHint': '超过这个时间就放弃本次增强。留空则跟随宿主默认值（{seconds} 秒），可填 {min}–{max} 秒。',
    'settings.save': '保存',
    'settings.saved': '已保存',
    'settings.close': '关闭',
    'settings.hint': '设置保存在本机浏览器里，重装插件不会丢失。',
  },
  en: {
    'button.enhance': 'Enhance prompt',
    'button.enhancing': 'Enhancing… (click to cancel and restore)',
    'button.revert': 'Restore original',
    'button.failed': 'Enhancement failed: {message} (click to retry)',
    'error.empty_input': 'the draft is empty',
    'error.too_long': 'the draft is too long',
    'error.truncated': 'the model output was cut off before finishing (for a thinking model, pin a non-thinking one in Settings → Prompt optimization)',
    'error.timeout': 'the rewrite timed out (no result within {seconds} seconds); try a faster model or retry later',
    'error.empty_result': 'the model returned nothing',
    'error.unchanged': 'the model saw nothing to change',
    'error.llm_unavailable': 'the model service is unavailable',
    'error.no_route': 'no model route is available',
    'error.llm_error': 'the model call failed',
    'error.untrusted_origin': 'the request was rejected by the host guard',
    'error.fallback': 'enhancement failed',
    'hint.hostMissing': ' (the host half is not loaded — restart DSH)',
    'hint.forbidden': ' (rejected by the host guard)',
    'settings.nav': 'Prompt optimization',
    'settings.title': 'Prompt optimization',
    'settings.desc': 'Adds a ✨ button to the composer: one click rewrites the unsent draft into a clearer, more specific prompt; click again to restore the original.',
    'settings.enabled': 'Enable the ✨ button',
    'settings.enabledHint': 'Switched off, the button disappears from the composer — come back here any time to turn it on again.',
    'settings.minLength': 'Minimum characters',
    'settings.minLengthHint': 'The button hides while the draft is shorter than this; leave empty to follow the host default',
    'settings.modelMode': 'Model for enhancement',
    'settings.modelCustom': 'Use a specific model (unchecked follows the current session model)',
    'settings.modelSelect': 'Available models',
    'settings.modelPick': 'Follow the checkbox above (no override)',
    'settings.modelsLoading': 'Reading the available models…',
    'settings.modelsFailed': 'Could not read the model list — fill it in manually below',
    'settings.modelsEmpty': 'The host returned no model list — fill it in manually below',
    'settings.modelsPartial': 'These providers could not be reached, so their models are missing: {names}',
    'settings.modelManual': 'Enter the provider and model id manually',
    'settings.provider': 'Provider (optional)',
    'settings.model': 'Model id',
    'settings.modelRequired': 'Pick a model or fill in a model id',
    'settings.timeoutLabel': 'Timeout (seconds)',
    'settings.timeoutPlaceholder': 'Empty follows the host default',
    'settings.timeoutHint': 'Give up on one enhancement after this long. Empty follows the host default ({seconds}s); {min}–{max}s is allowed.',
    'settings.save': 'Save',
    'settings.saved': 'Saved',
    'settings.close': 'Close',
    'settings.hint': 'Settings are stored in this browser; reinstalling the plugin keeps them.',
  },
}

/** Translator handed back by the locale service; null means "service unusable". */
let serviceT = null

/** Best-effort language used when the locale service cannot answer a key. */
function guessLanguage() {
  try {
    const lang = String((document.documentElement && document.documentElement.lang) || '')
    if (/^zh/i.test(lang)) return 'zh'
    if (lang) return 'en'
  } catch { /* ignore */ }
  try {
    if (/^zh/i.test(String(navigator.language || ''))) return 'zh'
  } catch { /* ignore */ }
  return 'en'
}

/**
 * Resolve one key. The locale service wins; anything unusable falls back to the
 * built-in dictionary, so a missing entry can never paint a raw key such as
 * "settings.title" into the UI.
 */
function t(key) {
  if (serviceT) {
    try {
      const fromService = serviceT(key)
      if (typeof fromService === 'string' && fromService !== key && fromService.length > 0) return fromService
    } catch { /* ignore */ }
  }
  const table = LOCALES[guessLanguage()] || LOCALES.en
  return table[key] || LOCALES.en[key] || key
}

function tf(key, vars) {
  let text = t(key)
  if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
  return text
}

// ---- settings (client-side) ----
// Everything the user can tune lives here. Only the model override has to reach
// the host, and it travels per request, so no host-side settings store is needed.
const SETTINGS_KEY = 'dsh-prompt-optimization-master:settings'
/** Fired when the settings page saves, so the composer button can re-read. */
const SETTINGS_EVENT = 'dsh-prompt-optimization-master:settings-changed'
const SETTINGS_DEFAULTS = { enabled: true, minTextLength: null, provider: '', model: '', timeoutMs: null }

function loadSettings() {
  const fallback = { enabled: true, minTextLength: null, provider: '', model: '', timeoutMs: null }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      enabled: parsed.enabled !== false,
      minTextLength: typeof parsed.minTextLength === 'number' && parsed.minTextLength >= 0 ? parsed.minTextLength : null,
      provider: typeof parsed.provider === 'string' ? parsed.provider : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      // Milliseconds on the wire, seconds in the UI. A saved value outside the
      // allowed band is treated as "follow the host" instead of being clamped
      // silently, so the user sees the field they are really running with.
      timeoutMs: typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0 ? parsed.timeoutMs : null,
    }
  } catch {
    return fallback
  }
}

function saveSettings(settings) {
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* ignore */ }
}

const CSS = `
.dsh-pe-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease}
.dsh-pe-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dsh-pe-btn:disabled{cursor:default;opacity:.6}
.dsh-pe-btn.is-error{color:var(--dsw-alias-state-error-primary,#d7432e)}
.dsh-pe-btn svg{display:block}
@keyframes dsh-pe-spin{to{transform:rotate(360deg)}}
.dsh-pe-spin{animation:dsh-pe-spin .9s linear infinite;transform-origin:50% 50%}
/* Settings page (slot settings.section) — the section draws its own internals. */
.dsh-pe-page{display:flex;flex-direction:column;gap:16px;padding:2px;max-width:640px;color:var(--dsw-alias-label-primary);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;box-sizing:border-box}
.dsh-pe-page h2{margin:0;font-size:16px;font-weight:600}
.dsh-pe-page-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-pe-field{display:flex;flex-direction:column;gap:6px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-pe-field-title{font-size:13px;font-weight:500}
.dsh-pe-field-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-pe-check{display:flex;align-items:center;gap:8px}
.dsh-pe-check label{font-size:13px}
.dsh-pe-page input[type=text],.dsh-pe-page input[type=number]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;font:inherit;box-sizing:border-box}
.dsh-pe-page input[type=text]{width:100%;max-width:360px}
.dsh-pe-page input[type=number]{width:120px}
.dsh-pe-actions{display:flex;align-items:center;gap:12px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-pe-page button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 16px;font:inherit;cursor:pointer}
.dsh-pe-page button.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsh-pe-page button[disabled]{opacity:.5;cursor:not-allowed}
.dsh-pe-saved{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-pe-page select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;font:inherit;max-width:360px;box-sizing:border-box}
/* Transient failure chip. The composer cell is 28x28, so a sentence-length
   reason cannot live inside the button; without this the cause is only in the
   tooltip, which touch and keyboard users never see. */
.dsh-pe-toast{position:fixed;right:16px;bottom:96px;z-index:2147483000;max-width:min(360px,80vw);padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,#1f2023);color:var(--dsw-alias-label-primary,#fff);font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;box-shadow:0 6px 24px rgba(0,0,0,.28);cursor:pointer;animation:dsh-pe-toast-in .18s ease}
@keyframes dsh-pe-toast-in{from{opacity:0}to{opacity:1}}
`

// ---- icons ----
function SparkleIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
    h('path', {
      d: 'M8 1.5l1.35 3.9a2 2 0 001.25 1.25L14.5 8l-3.9 1.35a2 2 0 00-1.25 1.25L8 14.5l-1.35-3.9a2 2 0 00-1.25-1.25L1.5 8l3.9-1.35A2 2 0 006.65 5.4L8 1.5z',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', fill: 'none',
    }),
    h('path', { d: 'M12.8 1.6l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45.45-1.3z', fill: 'currentColor' }),
  )
}

function SpinnerIcon() {
  return h('svg', { className: 'dsh-pe-spin', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
    h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.25 }),
    h('path', { d: 'M14 8a6 6 0 00-6-6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
  )
}

function RevertIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
    h('path', {
      d: 'M3 7.5h6.2a3.3 3.3 0 010 6.6H7',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    h('path', { d: 'M5.4 4.8L3 7.5l2.4 2.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

// ---- host calls ----
async function post(path, payload) {
  const response = await fetch(ROUTE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    credentials: 'same-origin',
  })
  let data = null
  try { data = await response.json() } catch { /* keep null */ }
  if (!response.ok) {
    // 405 is what the harness web server answers for a path no plugin claimed,
    // so it means the host half is not the loaded build rather than a bad call.
    let hint = ''
    if (response.status === 405) hint = t('hint.hostMissing')
    else if (response.status === 403) hint = t('hint.forbidden')
    const failure = new Error(((data && data.error) || ('HTTP ' + response.status)) + hint)
    failure.code = data ? data.code : undefined
    throw failure
  }
  return data
}

function newRequestId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
  } catch { /* fall through */ }
  return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

/**
 * The host answers with stable codes; the button speaks the active UI language.
 * Unknown codes fall back to the host's own message so nothing is swallowed.
 * `vars` fills the placeholders a message uses (the timeout message names its
 * own number, so it can never disagree with the constant in the host).
 */
const ERROR_KEYS = ['empty_input', 'too_long', 'truncated', 'empty_result', 'unchanged', 'llm_unavailable', 'no_route', 'llm_error', 'untrusted_origin', 'timeout']
function errorText(code, fallback, vars) {
  if (code && ERROR_KEYS.indexOf(code) !== -1) return tf('error.' + code, vars)
  return fallback || t('error.fallback')
}

// ---- transient failure chip ----
// A failure sentence does not fit in a 28x28 toolbar cell, and a `title` tooltip
// only appears on mouse hover — so touch, keyboard and "did not think to hover"
// users were told nothing when a rewrite failed. This chip is created outside
// React because the slot owns the button and no container of its own.
const TOAST_MS = 9_000
let toastNode = null
let toastTimer = null

function hideToast() {
  if (toastTimer !== null) {
    try { window.clearTimeout(toastTimer) } catch { /* ignore */ }
    toastTimer = null
  }
  const node = toastNode
  toastNode = null
  if (!node) return
  try { if (node.parentNode) node.parentNode.removeChild(node) } catch { /* ignore */ }
}

function showToast(message, anchor) {
  hideToast()
  try {
    const body = document.body
    if (!body || typeof body.appendChild !== 'function') return
    const node = document.createElement('div')
    node.className = 'dsh-pe-toast'
    node.setAttribute('role', 'alert')
    node.textContent = message
    body.appendChild(node)
    toastNode = node
    // Pin it just above the button when its box is measurable, otherwise the
    // stylesheet's bottom-right fallback keeps it on screen.
    try {
      const rect = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
      if (rect && rect.width > 0 && rect.top > 96) {
        node.style.left = Math.round(rect.left + rect.width / 2) + 'px'
        node.style.top = Math.round(rect.top - 10) + 'px'
        node.style.transform = 'translate(-50%, -100%)'
      }
    } catch { /* keep the fallback position */ }
    try { node.addEventListener('click', hideToast) } catch { /* ignore */ }
    toastTimer = window.setTimeout(hideToast, TOAST_MS)
  } catch { /* a missing DOM must never break the button */ }
}

// ---- settings page ----
// Registered into `settings.section`, so it is its own entry in the settings
// sidebar next to 费用 / 插件市场 / 侧边卡片. That slot hands the owner exactly one
// prop — `close` — and the section draws every part of its own internals.
function SettingsPage(props) {
  const [form, setForm] = useState(() => {
    const current = loadSettings()
    return {
      enabled: current.enabled,
      minTextLength: current.minTextLength,
      provider: current.provider,
      model: current.model,
      custom: Boolean(current.model),
      // An explicit model that the catalog does not contain was typed by hand,
      // so the manual inputs stay open instead of being swallowed by the list.
      manual: false,
      timeoutSeconds: current.timeoutMs === null ? '' : String(Math.round(current.timeoutMs / 1000)),
    }
  })
  const [saved, setSaved] = useState(false)
  // `loading` until the host answers; `failed` degrades to the manual inputs,
  // because a settings page must never become un-saveable over a list request.
  const [catalog, setCatalog] = useState({ state: 'loading', groups: [], failures: [] })
  const [bounds, setBounds] = useState(null)
  const patch = (next) => setForm((prev) => Object.assign({}, prev, next))

  useEffect(() => {
    let alive = true
    post('/models', {}).then((data) => {
      if (!alive) return
      const groups = data && Array.isArray(data.groups) ? data.groups : []
      setCatalog({
        state: groups.length > 0 ? 'ready' : 'failed',
        groups,
        failures: data && Array.isArray(data.failures) ? data.failures : [],
      })
    }).catch(() => {
      if (alive) setCatalog({ state: 'failed', groups: [], failures: [] })
    })
    post('/config', {}).then((data) => {
      if (!alive || !data) return
      setBounds({
        host: typeof data.timeoutMs === 'number' ? data.timeoutMs : HOST_TIMEOUT_FALLBACK_MS,
        min: typeof data.minTimeoutMs === 'number' ? data.minTimeoutMs : MIN_TIMEOUT_MS,
        max: typeof data.maxTimeoutMs === 'number' ? data.maxTimeoutMs : MAX_TIMEOUT_MS,
      })
    }).catch(() => { /* the hint falls back to the built-in numbers */ })
    return () => { alive = false }
  }, [])

  const submit = () => {
    const model = form.custom ? String(form.model || '').trim() : ''
    const rawSeconds = form.timeoutSeconds === '' || form.timeoutSeconds === null ? null : Number(form.timeoutSeconds)
    let timeoutMs = null
    if (rawSeconds !== null && Number.isFinite(rawSeconds) && rawSeconds > 0) {
      timeoutMs = Math.round(rawSeconds * 1000)
      // The host clamps as well; doing it here keeps the saved value honest so
      // the field does not disagree with what the button actually waits for.
      const lo = bounds ? bounds.min : MIN_TIMEOUT_MS
      const hi = bounds ? bounds.max : MAX_TIMEOUT_MS
      timeoutMs = Math.min(hi, Math.max(lo, timeoutMs))
    }
    saveSettings({
      enabled: form.enabled !== false,
      minTextLength: typeof form.minTextLength === 'number' && form.minTextLength >= 0 ? Math.floor(form.minTextLength) : null,
      provider: model ? String(form.provider || '').trim() : '',
      model,
      timeoutMs,
    })
    // The composer button lives in another slot, so tell it to re-read.
    try { window.dispatchEvent(new window.CustomEvent(SETTINGS_EVENT)) } catch { /* ignore */ }
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const modelMissing = form.custom && !String(form.model || '').trim()
  const showManual = form.manual || catalog.state !== 'ready'
  const pickValue = form.manual
    ? '__manual__'
    : (form.model ? JSON.stringify([form.provider || '', form.model]) : '')

  const onPick = (raw) => {
    if (raw === '__manual__') { patch({ manual: true, model: '', provider: '' }); return }
    if (raw === '') { patch({ manual: false, model: '', provider: '' }); return }
    try {
      const parsed = JSON.parse(raw)
      patch({ manual: false, provider: String(parsed[0] || ''), model: String(parsed[1] || '') })
    } catch { patch({ manual: true }) }
  }

  const modelField = () => {
    if (!form.custom) return null
    const parts = []
    if (catalog.state === 'ready') {
      const options = [h('option', { key: '__none__', value: '' }, t('settings.modelPick'))]
      for (const group of catalog.groups) {
        const items = []
        for (const entry of group.models || []) {
          const label = entry.name && entry.name !== entry.id ? entry.name + ' (' + entry.id + ')' : entry.id
          items.push(h('option', { key: group.id + '/' + entry.id, value: JSON.stringify([group.id, entry.id]) }, label))
        }
        if (items.length > 0) options.push(h('optgroup', { key: group.id, label: group.name || group.id }, items))
      }
      options.push(h('option', { key: '__manual__', value: '__manual__' }, t('settings.modelManual')))
      parts.push(h('select', { key: 'pick', value: pickValue, onChange: (e) => onPick(e.target.value) }, options))
      // A provider the host could not enumerate is named instead of silently
      // dropped: "my model is not in the list" must always have an explanation.
      if (catalog.failures.length > 0) {
        parts.push(h('p', { key: 'partial', className: 'dsh-pe-field-hint' },
          tf('settings.modelsPartial', {
            names: catalog.failures.map((entry) => entry.name || entry.id || '?').join('、'),
          })))
      }
    } else if (catalog.state === 'loading') {
      parts.push(h('p', { key: 'loading', className: 'dsh-pe-field-hint' }, t('settings.modelsLoading')))
    } else {
      parts.push(h('p', { key: 'failed', className: 'dsh-pe-field-hint' }, t('settings.modelsFailed')))
    }
    if (showManual) {
      parts.push(h('input', {
        key: 'provider',
        type: 'text',
        placeholder: t('settings.provider'),
        value: form.provider || '',
        onChange: (e) => patch({ provider: e.target.value }),
      }))
      parts.push(h('input', {
        key: 'model',
        type: 'text',
        placeholder: t('settings.model'),
        value: form.model || '',
        onChange: (e) => patch({ model: e.target.value }),
      }))
    }
    return parts
  }

  const timeoutHint = tf('settings.timeoutHint', {
    seconds: Math.round((bounds ? bounds.host : HOST_TIMEOUT_FALLBACK_MS) / 1000),
    min: Math.round((bounds ? bounds.min : MIN_TIMEOUT_MS) / 1000),
    max: Math.round((bounds ? bounds.max : MAX_TIMEOUT_MS) / 1000),
  })

  return h('div', { className: 'dsh-pe-page', 'data-dsh-prompt-optimization-master': 'settings' },
    h('h2', null, t('settings.title')),
    h('p', { className: 'dsh-pe-page-desc' }, t('settings.desc')),

    h('div', { className: 'dsh-pe-field' },
      h('div', { className: 'dsh-pe-check' },
        h('input', {
          type: 'checkbox',
          id: 'dsh-pe-enabled',
          checked: form.enabled !== false,
          onChange: (e) => patch({ enabled: e.target.checked }),
        }),
        h('label', { htmlFor: 'dsh-pe-enabled' }, t('settings.enabled')),
      ),
      h('p', { className: 'dsh-pe-field-hint' }, t('settings.enabledHint')),
    ),

    h('div', { className: 'dsh-pe-field' },
      h('div', { className: 'dsh-pe-field-title' }, t('settings.minLength')),
      h('input', {
        type: 'number',
        min: 0,
        placeholder: t('settings.minLengthHint'),
        value: form.minTextLength === null || form.minTextLength === undefined ? '' : String(form.minTextLength),
        onChange: (e) => {
          const raw = e.target.value
          patch({ minTextLength: raw === '' ? null : Math.max(0, Math.floor(Number(raw) || 0)) })
        },
      }),
      h('p', { className: 'dsh-pe-field-hint' }, t('settings.minLengthHint')),
    ),

    h('div', { className: 'dsh-pe-field' },
      h('div', { className: 'dsh-pe-field-title' }, t('settings.modelMode')),
      h('div', { className: 'dsh-pe-check' },
        h('input', {
          type: 'checkbox',
          id: 'dsh-pe-custom',
          checked: Boolean(form.custom),
          onChange: (e) => patch({ custom: e.target.checked }),
        }),
        h('label', { htmlFor: 'dsh-pe-custom' }, t('settings.modelCustom')),
      ),
      modelField(),
      modelMissing ? h('p', { className: 'dsh-pe-field-hint' }, t('settings.modelRequired')) : null,
      h('p', { className: 'dsh-pe-field-hint' }, t('settings.hint')),
    ),

    h('div', { className: 'dsh-pe-field' },
      h('div', { className: 'dsh-pe-field-title' }, t('settings.timeoutLabel')),
      h('input', {
        type: 'number',
        min: 1,
        placeholder: t('settings.timeoutPlaceholder'),
        value: form.timeoutSeconds,
        onChange: (e) => patch({ timeoutSeconds: e.target.value }),
      }),
      h('p', { className: 'dsh-pe-field-hint' }, timeoutHint),
    ),

    h('div', { className: 'dsh-pe-actions' },
      h('button', {
        type: 'button',
        className: 'primary',
        disabled: modelMissing,
        onClick: submit,
      }, t('settings.save')),
      saved ? h('span', { className: 'dsh-pe-saved' }, t('settings.saved')) : null,
      props && typeof props.close === 'function'
        ? h('button', { type: 'button', onClick: props.close }, t('settings.close'))
        : null,
    ),
  )
}

// ---- component ----
function EnhanceButton(props) {
  const useInput = props.useInput
  const inputActions = props.inputActions

  // Hooks must run unconditionally, so read the draft even when the slot props
  // are incomplete and decide what to do afterwards.
  const draft = useInput ? useInput(selectDraft) : undefined
  const inputPhase = useInput ? useInput(selectPhase) : undefined
  const text = typeof draft === 'string' ? draft : ''
  const usable = cleanDraft(text)
  const inputBusy = typeof inputPhase === 'string' && BUSY_INPUT_PHASES.indexOf(inputPhase) !== -1

  const [phase, setPhase] = useState('idle') // idle | loading | done
  const [error, setError] = useState(null)
  const [hostMinTextLength, setHostMinTextLength] = useState(MIN_TEXT_FALLBACK)
  const [hostTimeoutMs, setHostTimeoutMs] = useState(HOST_TIMEOUT_FALLBACK_MS)
  const [settings, setSettings] = useState(loadSettings)

  // The user's own threshold wins; otherwise follow what the host reports.
  const minTextLength = settings.minTextLength === null ? hostMinTextLength : settings.minTextLength
  // Same rule for the deadline, so a timeout message always names the number
  // this runtime really used instead of a hard-coded one.
  const effectiveTimeoutMs = settings.timeoutMs === null ? hostTimeoutMs : settings.timeoutMs

  const buttonRef = useRef(null)
  const backupRef = useRef(null)
  const optimizedRef = useRef(null)
  const requestIdRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  // The settings page is a separate slot, so it signals changes through a window
  // event; re-read whenever it saves.
  useEffect(() => {
    const onSettingsChanged = () => setSettings(loadSettings())
    try {
      window.addEventListener(SETTINGS_EVENT, onSettingsChanged)
      return () => window.removeEventListener(SETTINGS_EVENT, onSettingsChanged)
    } catch {
      return undefined
    }
  }, [])

  // Per-session isolation. WorkBuddy keys this state by session id; here the
  // component owns it, so a session switch without a remount would otherwise
  // carry the previous session's backup and error banner across.
  useEffect(() => {
    requestIdRef.current = null
    backupRef.current = null
    optimizedRef.current = null
    setPhase('idle')
    setError(null)
  }, [props.sessionId])

  // Ask the host what it considers enough text to be worth enhancing.
  useEffect(() => {
    let cancelled = false
    post('/config', {})
      .then((data) => {
        if (cancelled || !data) return
        if (typeof data.minTextLength === 'number' && data.minTextLength >= 0) setHostMinTextLength(data.minTextLength)
        if (typeof data.timeoutMs === 'number' && data.timeoutMs > 0) setHostTimeoutMs(data.timeoutMs)
      })
      .catch(() => { /* keep the fallback */ })
    return () => { cancelled = true }
  }, [])

  // Show the failure reason where a person will actually see it: a `title`
  // tooltip is invisible to touch and keyboard users, and easy to miss with a
  // mouse. The chip is cleared as soon as the reason changes or the button
  // goes away.
  useEffect(() => {
    if (!error) {
      hideToast()
      return undefined
    }
    showToast(error, buttonRef.current)
    return hideToast
  }, [error])

  // A successful result stays revertible only while the draft still holds it.
  // Any later manual edit retires the backup, so "restore" can never eat work.
  // The write-back is asynchronous, so a draft still equal to the ORIGINAL text
  // is our own pending update rather than a user edit.
  useEffect(() => {
    if (phase !== 'done') return
    const optimized = optimizedRef.current
    if (optimized === null) return
    if (text === optimized) return
    if (text === backupRef.current) return
    backupRef.current = null
    optimizedRef.current = null
    setPhase('idle')
  }, [text, phase])

  const writeDraft = useCallback((value) => {
    if (inputActions && typeof inputActions.setDraft === 'function') {
      inputActions.setDraft(value)
    }
  }, [inputActions])

  const cancel = useCallback(() => {
    const requestId = requestIdRef.current
    requestIdRef.current = null
    if (requestId) post('/cancel', { requestId }).catch(() => { /* best effort */ })
    const backup = backupRef.current
    if (backup !== null) writeDraft(backup)
    backupRef.current = null
    optimizedRef.current = null
    setPhase('idle')
    setError(null)
  }, [writeDraft])

  const revert = useCallback(() => {
    const backup = backupRef.current
    if (backup !== null) writeDraft(backup)
    backupRef.current = null
    optimizedRef.current = null
    setPhase('idle')
    setError(null)
  }, [writeDraft])

  const enhance = useCallback(async () => {
    // Send the draft without invisible placeholder characters; keep the raw text
    // as the backup so "restore" puts back exactly what the user had.
    const original = text
    const payload = cleanDraft(text)
    const requestId = newRequestId()
    const previous = requestIdRef.current
    if (previous) post('/cancel', { requestId: previous }).catch(() => { /* superseded */ })

    requestIdRef.current = requestId
    backupRef.current = original
    optimizedRef.current = null
    setError(null)
    setPhase('loading')

    try {
      // The optional model override and the deadline travel with the request,
      // so the host needs no settings store of its own.
      const payloadBody = { text: payload, requestId, timeoutMs: effectiveTimeoutMs }
      if (settings.model) {
        payloadBody.model = settings.model
        if (settings.provider) payloadBody.provider = settings.provider
      }
      const data = await post('/enhance', payloadBody)
      if (!mountedRef.current || requestIdRef.current !== requestId) return
      // Do NOT clear the in-flight id before validating: a business error
      // arrives as HTTP 200 with ok:false, and clearing first would make the
      // catch below treat it as a superseded request and leave the button
      // spinning forever.
      if (!data || data.ok !== true || typeof data.text !== 'string') {
        const failure = new Error((data && data.error) || 'empty result')
        failure.code = data ? data.code : undefined
        throw failure
      }
      requestIdRef.current = null
      optimizedRef.current = data.text
      writeDraft(data.text)
      setPhase('done')
    } catch (e) {
      if (!mountedRef.current || requestIdRef.current !== requestId) return
      requestIdRef.current = null
      writeDraft(original)
      backupRef.current = null
      optimizedRef.current = null
      setError(errorText(e && e.code, e instanceof Error ? e.message : String(e), {
        seconds: Math.round(effectiveTimeoutMs / 1000),
      }))
      setPhase('idle')
      console.error('[dsh-prompt-optimization-master] failed:', e)
    }
  }, [text, writeDraft, settings.model, settings.provider, effectiveTimeoutMs])

  if (!useInput || !inputActions || typeof inputActions.setDraft !== 'function') return null

  const hasContent = usable.length >= minTextLength && usable.length > 0
  const loading = phase === 'loading'
  const canRevert = phase === 'done' && backupRef.current !== null
  const off = !settings.enabled

  // Hidden until there is something to enhance — the behaviour that makes the
  // icon show up on typing and vanish on clearing the box. A busy composer also
  // hides it (matching WorkBuddy), except while a result is revertible, so a
  // pending restore can never be locked away.
  // Switched off, it disappears entirely: the settings page is the way back.
  if (off) return null
  if (!loading && !canRevert && (!hasContent || inputBusy)) return null

  let title = t('button.enhance')
  let icon = h(SparkleIcon, null)
  let onClick = enhance
  if (loading) {
    title = t('button.enhancing')
    icon = h(SpinnerIcon, null)
    onClick = cancel
  } else if (canRevert) {
    title = t('button.revert')
    icon = h(RevertIcon, null)
    onClick = revert
  }
  if (error) title = tf('button.failed', { message: error })

  return h('button', {
    type: 'button',
    ref: buttonRef,
    className: 'dsh-pe-btn' + (error ? ' is-error' : ''),
    title,
    'aria-label': title,
    'data-dsh-prompt-optimization-master': 'button',
    onClick,
  }, icon)
}

// ---- exports (DSH client contract) ----
exports.name = 'dsh-prompt-optimization-master'
// `locale` must be declared here: without it Cordis never injects the service,
// ctx.locale is unavailable, and every t() silently falls back to the raw key.
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-prompt-optimization-master'
  style.textContent = CSS
  document.head.appendChild(style)

  // Follow the harness UI language. The optional accessor is tried first because
  // a direct service read is guarded when not declared with inject; every step is
  // wrapped so a missing locale can never take the button down.
  let locale
  try {
    if (typeof ctx.get === 'function') locale = ctx.get('locale')
  } catch { /* ignore */ }
  if (!locale) {
    try { if (ctx.locale) locale = ctx.locale } catch { /* ignore */ }
  }

  if (locale && typeof locale.register === 'function' && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => locale.register(LOCALE_NS, LOCALES), 'dsh-prompt-optimization-master: dictionaries')
    } catch { /* ignore */ }
  }

  if (locale && typeof locale.bind === 'function') {
    try {
      const bound = locale.bind(LOCALE_NS)
      if (typeof bound === 'function') serviceT = bound
    } catch { /* ignore */ }
  }

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'prompt-enhance',
    order: 20,
    label: () => t('button.enhance'),
  }, EnhanceButton))

  // The settings page: its own entry in the settings sidebar, next to 费用 /
  // 插件市场. `label` is a thunk so the nav text follows the UI language without
  // re-registering, and `inject` contributes no extra props — the section is
  // handed `close` by the shell.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-prompt-optimization-master',
    order: 35,
    label: () => t('settings.nav'),
    locale: LOCALE_NS,
    inject: () => ({}),
  }, SettingsPage))
}

return module.exports; } });
