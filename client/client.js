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
    'error.truncated': '模型输出被截断，没能生成完整提示词',
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
    'settings.provider': '提供方 provider（可留空）',
    'settings.model': '模型 ID',
    'settings.modelRequired': '指定模型时必须填模型 ID',
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
    'error.truncated': 'the model output was cut off before finishing',
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
    'settings.provider': 'Provider (optional)',
    'settings.model': 'Model id',
    'settings.modelRequired': 'A model id is required when overriding the model',
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
const SETTINGS_DEFAULTS = { enabled: true, minTextLength: null, provider: '', model: '' }

function loadSettings() {
  const fallback = { enabled: true, minTextLength: null, provider: '', model: '' }
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
 */
const ERROR_KEYS = ['empty_input', 'too_long', 'truncated', 'empty_result', 'unchanged', 'llm_unavailable', 'no_route', 'llm_error', 'untrusted_origin']
function errorText(code, fallback) {
  if (code && ERROR_KEYS.indexOf(code) !== -1) return t('error.' + code)
  return fallback || t('error.fallback')
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
    }
  })
  const [saved, setSaved] = useState(false)
  const patch = (next) => setForm((prev) => Object.assign({}, prev, next))

  const submit = () => {
    const model = form.custom ? String(form.model || '').trim() : ''
    saveSettings({
      enabled: form.enabled !== false,
      minTextLength: typeof form.minTextLength === 'number' && form.minTextLength >= 0 ? Math.floor(form.minTextLength) : null,
      provider: model ? String(form.provider || '').trim() : '',
      model,
    })
    // The composer button lives in another slot, so tell it to re-read.
    try { window.dispatchEvent(new window.CustomEvent(SETTINGS_EVENT)) } catch { /* ignore */ }
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const modelMissing = form.custom && !String(form.model || '').trim()

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
      form.custom ? h('input', {
        type: 'text',
        placeholder: t('settings.provider'),
        value: form.provider || '',
        onChange: (e) => patch({ provider: e.target.value }),
      }) : null,
      form.custom ? h('input', {
        type: 'text',
        placeholder: t('settings.model'),
        value: form.model || '',
        onChange: (e) => patch({ model: e.target.value }),
      }) : null,
      modelMissing ? h('p', { className: 'dsh-pe-field-hint' }, t('settings.modelRequired')) : null,
      h('p', { className: 'dsh-pe-field-hint' }, t('settings.hint')),
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
  const [settings, setSettings] = useState(loadSettings)

  // The user's own threshold wins; otherwise follow what the host reports.
  const minTextLength = settings.minTextLength === null ? hostMinTextLength : settings.minTextLength

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
      })
      .catch(() => { /* keep the fallback */ })
    return () => { cancelled = true }
  }, [])

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
      // The optional model override travels with the request, so the host needs
      // no settings store of its own.
      const payloadBody = { text: payload, requestId }
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
      setError(errorText(e && e.code, e instanceof Error ? e.message : String(e)))
      setPhase('idle')
      console.error('[dsh-prompt-optimization-master] failed:', e)
    }
  }, [text, writeDraft, settings.model, settings.provider])

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
  let localeFrom = 'none'
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('locale')
      if (viaGet) { locale = viaGet; localeFrom = 'ctx.get' }
    }
  } catch { /* ignore */ }
  if (!locale) {
    try { if (ctx.locale) { locale = ctx.locale; localeFrom = 'ctx.locale' } } catch { /* ignore */ }
  }

  let registered = false
  if (locale && typeof locale.register === 'function') {
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => locale.register(LOCALE_NS, LOCALES), 'dsh-prompt-optimization-master: dictionaries')
        registered = true
      } catch { /* ignore */ }
    }
  }

  let bindResult = 'not-attempted'
  if (locale && typeof locale.bind === 'function') {
    try {
      const bound = locale.bind(LOCALE_NS)
      if (typeof bound === 'function') { serviceT = bound; bindResult = 'function' }
      else bindResult = typeof bound
    } catch (e) { bindResult = 'threw: ' + String((e && e.message) || e) }
  }

  // TEMPORARY diagnostic: records why the locale path did or did not bind, so a
  // silent failure is readable from disk instead of guessed at.
  try {
    let sample = null
    try { sample = serviceT ? serviceT('settings.title') : null } catch { /* ignore */ }
    window.localStorage.setItem('dsh-prompt-optimization-master:locale-diag', JSON.stringify({
      at: new Date().toISOString(),
      localeFrom,
      hasCtxGet: typeof ctx.get,
      hasCtxEffect: typeof ctx.effect,
      localeKeys: locale ? Object.keys(locale).slice(0, 40) : null,
      registerType: locale ? typeof locale.register : null,
      bindType: locale ? typeof locale.bind : null,
      registered,
      bindResult,
      serviceSample: sample,
      renderedSample: t('settings.title'),
      docLang: (document.documentElement && document.documentElement.lang) || null,
      navLang: (navigator && navigator.language) || null,
    }))
  } catch { /* ignore */ }

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
