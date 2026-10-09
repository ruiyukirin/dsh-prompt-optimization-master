window.__ModuleLoader__.load({ id: "@ruiyukirin/dsh-prompt-enhance", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-prompt-enhance — client half
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

const CSS = `
.dsh-pe-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease}
.dsh-pe-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dsh-pe-btn:disabled{cursor:default;opacity:.6}
.dsh-pe-btn.is-error{color:var(--dsw-alias-state-error-primary,#d7432e)}
.dsh-pe-btn svg{display:block}
@keyframes dsh-pe-spin{to{transform:rotate(360deg)}}
.dsh-pe-spin{animation:dsh-pe-spin .9s linear infinite;transform-origin:50% 50%}
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
    if (response.status === 405) hint = '（宿主半未加载，请重启 DSH）'
    else if (response.status === 403) hint = '（请求被宿主守卫拒绝）'
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
 * The host answers with stable codes; the button speaks human. Unknown codes
 * fall back to the host's own message so nothing is ever swallowed.
 */
const MESSAGES = {
  empty_input: '草稿是空的',
  too_long: '草稿太长了',
  truncated: '模型输出被截断，没能生成完整提示词',
  empty_result: '模型没返回内容',
  unchanged: '模型认为无需改动',
  llm_unavailable: '模型服务不可用',
  no_route: '没有可用的模型',
  llm_error: '模型调用失败',
  untrusted_origin: '请求被宿主守卫拒绝',
}
function errorText(code, fallback) {
  if (code && MESSAGES[code]) return MESSAGES[code]
  return fallback || '增强失败'
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
  const [minTextLength, setMinTextLength] = useState(MIN_TEXT_FALLBACK)

  const backupRef = useRef(null)
  const optimizedRef = useRef(null)
  const requestIdRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

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
        if (typeof data.minTextLength === 'number' && data.minTextLength >= 0) setMinTextLength(data.minTextLength)
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
      const data = await post('/enhance', { text: payload, requestId })
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
      console.error('[dsh-prompt-enhance] failed:', e)
    }
  }, [text, writeDraft])

  if (!useInput || !inputActions || typeof inputActions.setDraft !== 'function') return null

  const hasContent = usable.length >= minTextLength && usable.length > 0
  const loading = phase === 'loading'
  const canRevert = phase === 'done' && backupRef.current !== null

  // Hidden until there is something to enhance — the behaviour that makes the
  // icon show up on typing and vanish on clearing the box. A busy composer also
  // hides it (matching WorkBuddy), except while a result is revertible, so a
  // pending restore can never be locked away.
  if (!loading && !canRevert && (!hasContent || inputBusy)) return null

  let title = '增强提示词'
  let icon = h(SparkleIcon, null)
  let onClick = enhance
  if (loading) {
    title = '增强中…（点击取消并还原）'
    icon = h(SpinnerIcon, null)
    onClick = cancel
  } else if (canRevert) {
    title = '恢复原文'
    icon = h(RevertIcon, null)
    onClick = revert
  }
  if (error) title = '增强失败：' + error + '（点一下重试）'

  return h('button', {
    type: 'button',
    className: 'dsh-pe-btn' + (error ? ' is-error' : ''),
    title,
    'aria-label': title,
    'data-dsh-prompt-enhance': 'button',
    onClick,
  }, icon)
}

// ---- exports (DSH client contract) ----
exports.name = '@ruiyukirin/dsh-prompt-enhance'
exports.inject = ['slots']
exports.apply = function apply(ctx) {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-prompt-enhance'
  style.textContent = CSS
  document.head.appendChild(style)

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'prompt-enhance',
    order: 20,
    label: () => '提示词优化',
  }, EnhanceButton))
}

return module.exports; } });
