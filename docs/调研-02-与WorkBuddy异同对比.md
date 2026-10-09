# 调研 02：本插件与腾讯 WorkBuddy「EnhancePrompt（增强提示词）」机制异同对比

作者：Kirin（ruiyukirin）
对比对象：本机插件 `dsh-prompt-enhance` ⟷ WorkBuddy 桌面版输入框 ✨ 增强提示词按钮
证据来源：写死的本地文件，全部离线可复核（见文末「附录 C：取证命令」）

> **证据性质声明（重要）**
> WorkBuddy 一侧的结论来自**反编译**（decompile，把打包后的 JS 还原成可读代码）取证，**不是官方文档**，
> 常量与函数名都是压缩后的短名（`Xo`/`Zo`/`fQt`/`rkr`…）。因此：
> ① 反编译只能证明「代码里有什么」，不能证明「产品设计意图是什么」；
> ② 未在反编译产物中出现的行为，本文一律写「未验证」，**不做推测补全**；
> ③ WorkBuddy 内部存在**两套**增强提示词实现（见第 1 节注），本文凡未特别说明，均以 `input.enhance.*` 文案 + `useEnhancePrompt` 钩子那一套为准。
> ④ **附录 E 是主观产品建议，不属于取证结论**，引用时请与第一到十二节的事实判定分开。

---

## 零、结论先行

**一句话**：架构骨架高度一致（按钮三态、空草稿隐藏、独立调模型、原文备份、改动即失效、结果清洗），
**本插件在「工程健壮性」上更厚**（取消链路、错误码、清洗、截断处理），
**WorkBuddy 在「编辑器集成深度」上更厚**（回写令牌、零宽字符、按会话隔离、非文本块保留），
**提示词层面：user 任务模板几乎是逐字照搬，system 角色提示词被改写并丢了一条硬约束（约 800 字符上限）。**

### 判定汇总（第 1–10 维度）

| 判定 | 数量 | 维度 |
|---|---|---|
| 一致 | 2 | 2 按钮状态机、8 不占对话上下文 |
| 部分一致 | 8 | 1 触发与位置、3 读写草稿、4 备份与失效、5 取消、6 结果清洗、7 双层提示词、9 模型选择、10 错误码 |
| 不一致 | 0 | — |

第 11、12 维度是**单边清单**（一方有、另一方没有），逐条给出「有/无 + 证据」，不做总分判定。

**另一条容易误解的共同点（已凿实，见第 8.1 节）**：两边增强时**都不读对话历史**。
WorkBuddy 底层是向 `/api/v1/llm/completions` 发的**单次无状态补全**请求，请求体只有
`{systemPrompt, userPrompt, agentName, model?}`，没有 `messages`/`history`/`conversationId`；
本插件也只发 `system` + 一条 user 消息。所以"根据上下文优化"只在弱含义下成立 ——
你在**草稿里自己写进去**的背景会被一起改写，草稿之外的对话内容不会被参考。

### 最关键的 3 条差异

1. **提示词：`TASK_PROMPT`（用户任务模板）≈ 逐字照搬，`SYSTEM_PROMPT`（系统角色提示词）被改写且丢约束。**
   字符级比对显示 `Zo`（WorkBuddy 的 user 模板）与 `TASK_PROMPT` 只差 **4 处**（`assistant→agent`、去掉两个 `'s`、`→`换成`->`）；
   但 `Xo`（WorkBuddy 的 system 角色提示词）里那条 `maximum length should be around 800 characters` **在本插件里完全没有对应物**。
2. **取消：本插件有真正的宿主侧取消链路；WorkBuddy 的宿主函数里一行取消代码都没有。**
   本插件 `/cancel` + `requestId`（请求标识）+ `inFlight`（在途请求表）+ 流内 `signal.aborted` 兜底；
   WorkBuddy 的 `es()`（宿主增强函数）只做「空输入→取 sidecar 端点→runAgent→清洗」，中止只发生在渲染进程（renderer process）。
3. **编辑器集成：WorkBuddy 用 `pendingApply`（待应用令牌）+ 零宽空格剔除 + 按会话（session）隔离状态；本插件靠纯字符串 `setDraft`（写回草稿），没有这三样。**

---

## 证据等级标记

| 标记 | 含义 |
|---|---|
| 【A】 | 本次**直接**从反编译原文取证（含英文原文引用） |
| 【B】 | 本插件源码原文 |
| 【C】 | 本插件 README / docs 的一手记录（作者整理或实测） |
| 【N】 | **未验证**（反编译或源码中找不到证据，不推测） |

---

## 一、触发与位置

**判定：部分一致**（语义一致：都在输入框右侧工具栏、都"有内容才出现"；挂载宿主与门控来源不同）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 挂载位置 | 输入框工具栏**右侧分组** `data-cb-chat-input-toolbar-right`，紧挨在发送按钮 `hQt` **之前** | slot（插槽）`conversation.input.right`，`order: 20` | 一致（语义） |
| 组件形态 | `fQt` 是**纯展示组件**，状态由外层传入（`loading/disabled/hasBackup/errorMessage/onCancel`…） | `EnhanceButton` 自带全部状态（`phase`/`error`/`backupRef`） | 不一致（架构） |
| 空草稿隐藏 | `fQt` 里 `if(!e&&t)return null`（不 loading 且 disabled 就不渲染）；另一套实现 `DGt` 里 `if(!a&&!o&&!s&&!i)return null`（无内容就渲染 null） | `if (!loading && !canRevert && !hasContent) return null` | 一致 |
| 最小长度 | `minTextLength: 1`（钩子输出，来自 provider 配置层 `FF('enhance')`）；门控函数 `wGt(blocks, minTextLength) = CGt(blocks).length >= minTextLength` | `MIN_TEXT_LENGTH = 1`（宿主常量），经 `/config` 下发给客户端；`text.trim().length >= minTextLength` | 部分一致（阈值同，来源不同：WB 外部可配，DSH 写死） |
| 零宽字符剔除 | `TGt = '\u200B'`；`CGt(e) = e.filter(text).map(x=>x.text.split(TGt).join('')).join(' ').trim()` —— **剔除零宽空格后再计数** | 无；`'\u200B'` 不是 JS `trim()` 会去掉的字符，因此**只含一个零宽空格的草稿会显示按钮并真的发起请求** | **不一致（本插件缺失）** |
| 禁用门控 | 父组件传 `disabled: xe`（输入框禁用 / `checkSendDisabled(当前内容)`） | 客户端**不读取**任何 composer 禁用态，按钮始终可点 | **不一致（本插件缺失）** |

证据【A】：
- 按钮渲染：`...e.enhancePromptConfig&&(0,d3.jsx)(fQt,{loading:an,disabled:xe,onEnhance:tn,onRevert:rn,hasBackup:on,errorMessage:sn,onCancel:nn,icon:e.enhancePromptConfig.icon}),U&&Pe,H(Dx.BEFORE_SEND_BUTTON),!k&&!A&&(0,d3.jsx)(hQt,{...})` —— `lib-chat-ui-CHONh1NB.js`
- 零宽剔除：`function CGt(e){return e.filter(e=>e.type==='text'&&typeof e.text==='string').map(e=>e.text.split(TGt).join('')).join(' ').trim()}`；`TGt='\u200B'` —— 同上
证据【B】：`client/client.js` L237-L243、L28、L278-L283
证据【C】：`docs/阶段0-探针结论.md`（插槽 props 与 `useInput` 契约实测）

> 注【A】：WorkBuddy 里另有一套**独立实现** `DGt`，走 `chatInput.enhance.*` 文案、自己管 `pendingApply`/本地 `AbortController`，
> 与本插件结构更像（状态自持）。两套并存说明该功能在 WorkBuddy 内至少重构过一次；本文其余部分以 `fQt` + `useEnhancePrompt` 为主。

---

## 二、按钮状态机（三态）

**判定：一致**（三态定义、图标语义、点击行为逐项对应；差异仅在错误态表现）

| 状态 | WorkBuddy（`fQt`） | 本插件（`EnhanceButton`） | 判定 |
|---|---|---|---|
| 空闲有草稿 | ✨ `input.enhance.title` = "Enhance prompt"，点击 `onEnhance` | ✨ "增强提示词"，点击 `enhance` | 一致 |
| 优化中可取消 | loading⇒ `c = loading && !!onCancel`；转圈，提示 `input.enhance.enhancing` = "Enhancing..."，点击 `onCancel` | `phase==='loading'`，转圈，title "增强中…（点击取消并还原）"，点击 `cancel` | 一致 |
| 已优化可还原 | `l = !loading && hasBackup`；回退箭头，提示 `input.enhance.revert` = "Revert to original"，点击 `onRevert` | `canRevert = phase==='done' && backupRef.current!==null`；回退箭头，title "恢复原文"，点击 `revert` | 一致 |
| 加载中禁用 | `u = loading ? !c : disabled`（可取消时可点，不可取消时禁用） | loading 时按钮不禁用（点击=取消） | 一致（语义） |
| 错误态 | `errorMessage` **替换**提示文案；按钮仍渲染，可再点重试 | `error` 追加到 title 尾部（"增强失败：…（点一下重试）"）并加 `.is-error` **变红** | 部分一致（本插件视觉更明确） |

证据【A】：`fQt=({loading:e,disabled:t,onEnhance:n,onRevert:r,hasBackup:i,errorMessage:a,onCancel:o,icon:s})=>{let c=e&&!!o,l=!e&&i,u=e?!c:t;if(!e&&t)return null;let d=a||(e?J['input.enhance.enhancing']:l?J['input.enhance.revert']:J['input.enhance.title']);...onClick:c?o:l?r:n...}` —— `lib-chat-ui-CHONh1NB.js`
证据【B】：`client/client.js` L245-L266

---

## 三、读草稿与写回草稿

**判定：部分一致**（都是"读草稿→改模型→整段回写"，但底层对象不同：Slate 块数组 ⟷ 纯字符串）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 数据模型 | 编辑器块数组（Slate，`{type:'text',text}` 等） | 纯字符串 `draft` | 不一致 |
| 读 | 钩子外层：`r = kC(e=>e.draft.content.blocks)`；编辑器实例另取 `P.current.string()` / `toContentBlocks()` | `props.useInput(s => s.draft)` | 部分一致（都是选择器/快照读） |
| 写回 | **经令牌**：`makePending(blocks)` → 编辑器 effect 检测到 `seq` 变化后 `P.current?.replace(pendingApply.blocks)`，再回调 `acknowledgePendingApply(seq)` | 直接 `props.inputActions.setDraft(text)`（官方注释：整体替换、光标落末尾） | 不一致（机制不同，见第 11 节） |
| 成功时保留非文本块 | `YOr(e,t)`：把模型返回文本包成一个 text 块，**保留原块数组中所有非 text 块**（附件/其他结构） | 无对应逻辑；整体替换为纯文本 | **不一致（本插件做不到）** |
| 成功时才改写 | 是（成功回调里才 pendingApply） | 是（`data.ok===true` 才 `writeDraft(data.text)`） | 一致 |
| 失败时还原 | 是（catch 里 `pendingApply: makePending(XOr(t))`） | 是（catch 里 `writeDraft(original)`） | 一致 |

证据【A】：
- `function YOr(e,t){let n=qOr(e);if(n==='')return XOr(t);let r=[];for(let e of t)e.type!=='text'&&r.push(e);return[...r,{type:'text',text:n}]}` —— `ui-docs-viewer-C3xwvySY.js`
- 回写 effect：`let t=ie.current?.pendingApply;t&&(Xt.current.has(t.seq)||(Xt.current.add(t.seq),Zt.current={applied:t.blocks,staleValue:e.value},P.current?.replace(t.blocks),ie.current?.acknowledgePendingApply?.(t.seq)))` —— `lib-chat-ui-CHONh1NB.js`
证据【B/C】：`client/client.js` L127-L128、L168-L172；`README.md`（setDraft 为整体替换的官方注释）；`docs/阶段0-探针结论.md`（`useInput` 返回 `draft` 字符串 + `draftRev`）

> 注：本插件草稿本身是**纯文本**，`attachmentIds` 是 InputState 里的独立字段，因此"不保留非文本块"在当前 DSH 契约下**是否会造成实际损失，未验证**。
> 但不能因此说"等价"——WorkBuddy 的写回 API 在语义上就是"保结构替换"。

---

## 四、原文备份、还原、以及"用户改动后备份失效"

**判定：部分一致**（主干逻辑一致：备份原文、还原、改动即失效；判定"改动"的手段不同，本插件有一处行为偏差）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 备份内容 | `backupBlocks: {before, after}`（原文块 + 优化后块），按会话 key 存在 Map 里 | `backupRef`（原文串）+ `optimizedRef`（优化后串），组件内 `useRef` | 一致（语义）/ 不一致（作用域，见第 11 节） |
| 还原 | `onRevert`：`pendingApply(backupBlocks.before)` + 清 `hasEnhancePrompt` | `revert()`：`writeDraft(backup)` + 清 refs + `setPhase('idle')` | 一致 |
| 改动即失效 | `onContentDiverged(blocks)`：与 `backupBlocks.after` **逐块深比较**（`ZOr`），一致则保留，不一致就 `backupBlocks:null` | effect：`text !== optimized` 且 `text !== backupRef.current` 时清空 refs 并回 `idle` | 部分一致 |
| 区分"自己写回" | 用 `Zt.current = {applied, staleValue}` + `suppressDivergedToken`（抑制发散令牌）过滤掉自身写入造成的"变化" | 用 `text === backupRef.current`（等于**原文**）当作"自己的待生效写入" | **不一致（本插件判定条件用错了参照物）** |
| 只在"还没被改过"时保留还原 | 是 | 是 | 一致 |

**这条不一致展开讲**（本插件的一个真实行为偏差）：
WorkBuddy 判断"这次内容变化是不是我自己刚写进去的"，参照物是 `staleValue`（写回前的旧值）/`applied`（写回后的新值）。
本插件参照物是 `backupRef.current`（**原文**）：只要草稿等于原文，就认为"是我自己的异步写回还没生效"，于是**保留**可还原状态。
后果：用户点开一个已优化的草稿，手动把内容改回原文，按钮仍显示"恢复原文"（WorkBuddy 此时会正确地退休还原能力，回到 ✨）。
这个偏差**无害**（再点一次只是把同样的原文再写一遍），但确实与 WorkBuddy 行为不同。

证据【A】：`function ZOr(e,t){if(e.length!==t.length)return!1;...}`、`function okr(e){return function(t){...ZOr(t,e.backupBlocks.after)?...:{...e,hasEnhancePrompt:!1,backupBlocks:null}}}`、
`if(!r&&i)return;Zt.current=null;ie.current.onContentDiverged(e.value??[])`（`literal / staleValue` 过滤） —— `ui-docs-viewer-C3xwvySY.js` / `lib-chat-ui-CHONh1NB.js`
证据【B】：`client/client.js` L153-L166（含注释 "a draft still equal to the ORIGINAL text is our own pending update"）

---

## 五、取消（中止）机制

**判定：部分一致**（渲染侧思路同为中止控制器；**宿主侧本插件完整、WorkBuddy 缺失**）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 中止原语 | `AbortController`（中止控制器）的 `signal` 作为参数传进 `enhanceService(text, signal, opts)` | 客户端 `POST /cancel {requestId}`，宿主 `controller.abort()` | 不一致（调用形态） |
| 宿主/BFF 侧（后端服务层）取消 | **`es()` 函数体内没有任何 `AbortController`/`abort` 相关代码**，只有 `empty_input`/`sidecar_unavailable`/`llm_error`/`unknown` 四条分支；`ts()` 注册的 IPC（进程间通信）处理器 `e.handle(qo, (e)=>es(t,{text:e.text, model:e.model}))` 也不转发 signal | `inFlight: Map<requestId, AbortController>`，`/cancel` 按 id 中止；插件卸载时统一 abort 全部在途请求 | **不一致（本插件更完整）** |
| 新请求取代旧请求 | 是：`let a=i.abortController;a&&!a.signal.aborted&&a.abort()`（同一个会话 key 只留一个） | 是：客户端对新请求先 `POST /cancel` 旧 id；宿主对同 id 再次 enhance 也会 abort 前一个 | 一致 |
| 取消后的界面 | `onCancel`：abort + `pendingApply(originalBlocks)` 还原 | `cancel()`：`POST /cancel` + `writeDraft(backup)` + 回 idle | 一致 |
| 中止信号是否真到达模型侧 | **未验证**：宿主 `es()` 不接收 signal，渲染层 abort 是否导致 sidecar（边车进程）真的停掉云端请求，反编译中看不到证据 | 是：`llm.stream({ signal })`，且**流循环内每个分片都再查一次 `signal?.aborted`**（防适配器不理会 signal 继续吐） | 部分一致（本插件可证、WB 未验证） |
| 会话切换/组件卸载时清理 | 有：会话集合变化时中止已消失会话的控制器；卸载 effect 里 abort 全部 + 清 `originalBlocks` | 无（无会话概念；组件卸载时仅置 `mountedRef=false`，**不中止在途请求**，靠宿主最终写回被忽略） | 不一致（本插件缺清理，但不会串台，见下） |

证据【A】：
- 宿主：`async function es(e,t){let n=typeof t?.text==='string'?t.text:'';if(n.trim()==='')return{success:!1,text:'',code:'empty_input',error:'Empty input'};...a=await e.createClient(i).runAgent({systemPrompt:Xo,userPrompt:Qo(n),agentName:Yo,model:r})...}` —— `main__server.js`
- 渲染：`let o=new AbortController;i.abortController=o;...e.enhanceService(n,o.signal,...)` —— `ui-docs-viewer-C3xwvySY.js`
证据【B】：`dsh/index.js` L143、L190-L210、L307-L310、L328-L339、L341-L347；`client/client.js` L139、L174-L184、L198-L199
证据【C】：`README.md`「实测记录」（业务错误 HTTP 200 + `ok:false` 的坑）

---

## 六、结果清洗

**判定：部分一致**（都 trim + 去首尾引号；**本插件多剥 Markdown 围栏、去成串引号；WorkBuddy 会少剥一层**）

| 清洗步骤 | WorkBuddy `$o` | 本插件 `cleanEnhancedText` | 判定 |
|---|---|---|---|
| trim | `e.trim()` | `String(text??'').trim()` | 一致 |
| 去首尾引号 | `/^["'"“”‘’]|["'"“”‘’]$/g` —— **无 `+`**，最多各去 1 个字符 | `/^["'“”‘’]+|["'“”‘’]+$/g` —— 有 `+`，去整串 | 部分一致（本插件更彻底） |
| 中英文引号覆盖 | `"` `'` `“` `”` `‘` `’` | 同集合 | 一致 |
| Markdown 围栏 | **无** | `/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/` 先剥一层 | **不一致（本插件多一步）** |
| 清洗后为空 | `llm_error`（"Enhanced result is empty"） | `empty_result`（独立错误码） | 部分一致 |
| 清洗后等于原文 | **无此校验**（原样当成功，并开启"可还原"） | `unchanged` 错误码，直接判失败 | **不一致（本插件多一步）** |

证据【A】：`function $o(e){return e.trim().replace(/^["'"\u201C\u201D\u2018\u2019]|["'"\u201C\u201D\u2018']$/g,'')}`；调用处 `let o=$o(a.text??'');return o.trim()===''?{...code:'llm_error'...}:{success:!0,text:o}` —— `main__server.js`
证据【B】：`dsh/index.js` L133-L140、L226-L236

---

## 七、双层提示词逐条对照（**本次重点，英文原文引用**）

**判定：部分一致**
- **user 任务模板（`Zo` ⟷ `TASK_PROMPT`）：几乎逐字一致**，字符级比对仅 4 处差异（净 -7 字符：2279 → 2272）。
- **system 角色提示词（`Xo` ⟷ `SYSTEM_PROMPT`）：被改写**（角色从 "development code assistant" 换成"通用编码/操作型助手"），
  并且**丢掉一条硬约束**（约 800 字符长度上限）和 2 个英文少样本、1 条 FORMAT 条款、"writing code" 定位句。

### 7.1 WorkBuddy 的 system 角色提示词 `Xo`（英文原文节选，【A】）

> "You are a Prompt Engineering Expert specializing in improving user prompts **for a development code assistant**. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. **The requests are being made to an AI assistant that specializes in writing code.**
> TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.
> ANALYSIS PROCESS: Evaluate the original prompt: Identify the main objective / Note any ambiguities or gaps / Assess the clarity of instructions / Check for missing context / Apply these prompt engineering principles: Write clear, specific instructions…Create the enhanced version: Maintain the original goal … **Ensure clarity and completeness** / **Be realistic in the features to add**
> Do NOT request guides/how-tos unless the user asks / Do NOT ask for code snippets / Do NOT suggest specific technologies unless mentioned in the user's prompt / Do NOT explain HOW to do things, focus on WHAT / Do NOT answer questions - expand/rewrite them to be more detailed
> IMPORTANT CONSTRAINTS: 1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input… 2. **Keep the enhanced prompt concise - maximum length should be around 800 characters**
> FORMAT: Provide only the enhanced prompt with no additional commentary.
> Example: \"A website for my dog\" … Example: \"Convert this to a friendly tone…\""（`Xo` 全长 2986 字符）

### 7.2 WorkBuddy 的 user 任务模板 `Zo`（英文原文节选，【A】）

> "You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.
> USER INPUT: {input}
> TASK: Rewrite the user input into a clearer, more specific prompt **for the target AI assistant**.
> CRITICAL PRIORITY - LANGUAGE CONSISTENCY: 1. You MUST detect the language of the user input above and write the enhanced prompt in that same language. 2. If the user writes in Chinese… 5. If the user mixes languages, keep a natural matching mix. **Do not translate the user's intent** into a single language. 6. These language rules are behavior instructions only; never include language analysis or language labels in the output.
> ENHANCEMENT REQUIREMENTS: 1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis. 2. Do not include language labels or meta notes such as \"User input is in Chinese\"… 3. Preserve **the user's original intent**, topic, constraints, and target output type… 4. Always make a substantive enhancement… 5. If the original prompt is already clear, lightly polish it… 6. …Do not end with an unfinished list, dangling conjunction, or trailing colon. 7. Do not add unrelated requirements…
> EXAMPLES: User input (Chinese)/(English)/(Mixed) …
> BAD OUTPUT EXAMPLE: User input is in Chinese **→** Response must be in Chinese. 请解释这段代码的主要功能
> GOOD OUTPUT EXAMPLE: 请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"

### 7.3 `Zo` ⟷ `TASK_PROMPT` 字符级差异（全量，仅 4 处）

| # | WorkBuddy `Zo` 原文 | 本插件 `TASK_PROMPT` | 性质 |
|---|---|---|---|
| 1 | `for the target AI **assistant**` | `for the target AI **agent**` | 改写（去 code assistant 化） |
| 2 | `Do not translate **the user's intent**` | `Do not translate **the user intent**` | 笔误级改写 |
| 3 | `Preserve **the user's original intent**` | `Preserve **the user original intent**` | 笔误级改写 |
| 4 | `BAD OUTPUT EXAMPLE: … **→** Response…` | `… **->** Response…` | 符号替换（Unicode 箭头→ASCII） |

> 除此之外，两者**内容完全相同**：语句、条目编号、3 组中/英/混排少样本、"坏输出 vs 好输出"对照、
> 语言锁定 6 条（含"不许输出语言分析元话术"）、长度/完整性的 7 条要求，全部一致。
> 差别只在排版：`Zo` 原文带 4 空格缩进与空行分节，本插件去掉缩进、用空行分节。
> 复现方式见附录 C（逐行归一化 + 字符级重同步比对）。

### 7.4 `Xo` ⟷ `SYSTEM_PROMPT` 逐条对照

| # | WorkBuddy `Xo`（英文原文节选） | 本插件 `SYSTEM_PROMPT` | 判定 |
|---|---|---|---|
| 1 | "…improving user prompts **for a development code assistant**" | "…for a **general-purpose AI agent that writes code and operates a local development environment**" | **改写**（目标助手元信息扩宽，正是任务要求的适配点） |
| 2 | "**The requests are being made to an AI assistant that specializes in writing code.**"（原文出现 2 次） | 无 | **删除** |
| 3 | ANALYSIS PROCESS 9 个平铺条目 | 编号 1/2/3，合并为"评估 → 套原则 → 成稿"三段 | 收敛改写（信息基本保留） |
| 4 | "Create the enhanced version: … **Ensure clarity and completeness**" | 无独立对应 | **丢失**（"clarity" 只在他处泛指） |
| 5 | "**Be realistic in the features to add**" | "stay realistic about what to add" | 等价 |
| 6 | "Do NOT request guides/how-tos unless the user asks" | "Do not ask for guides or how-tos unless the user asked for one." | 等价改写 |
| 7 | "Do NOT ask for code snippets"（绝对禁令） | "Do not demand code snippets **the user never requested**." | 改写（绝对禁令→条件禁令） |
| 8 | "Do NOT suggest specific technologies unless mentioned in the user's prompt" | "Do not suggest specific technologies, **libraries, or files** the user never mentioned." | 改写（外延扩大） |
| 9 | "Do NOT explain HOW to do things, focus on WHAT" | "Do not explain HOW to do things; focus on WHAT the result should be." | 等价 |
| 10 | "Do NOT answer questions - expand/rewrite them to be **more detailed**" | "Do not answer the question. Expand and rewrite it into a **more precise request** instead." | 改写（more detailed → more precise） |
| 11 | IMPORTANT CONSTRAINTS 1：语言匹配最高优先级（**在 system 层）** | 移到 `TASK_PROMPT`「CRITICAL PRIORITY」6 条（**user 层**） | 部分一致（位置迁移；user 层更细，system 层不再重申） |
| 12 | IMPORTANT CONSTRAINTS 2：**"maximum length should be around 800 characters"** | **无任何长度约束**（只有 `maxTokens: 4096` 词元预算，不是字符约束） | **不一致（丢失）** |
| 13 | FORMAT："Provide only the enhanced prompt with no additional commentary." | 无（由 `TASK_PROMPT`#1 等价覆盖） | 迁移/去重 |
| 14 | `Xo` 内 2 个英文少样本（"A website for my dog"；"Convert this to a friendly tone…canvas"） | 无 | **丢失** |
| 15 | — | `TASK_PROMPT` 末尾的 BAD/GOOD 对照 | 两边 `Zo`/`TASK_PROMPT` 都有，非差异 |

**少样本总量**：WorkBuddy = `Xo` 2 组 + `Zo` 3 组 + BAD/GOOD；本插件 = 3 组 + BAD/GOOD（**少 2 组**）。

证据【A】：`var Yo='enhance-prompt',Xo='You are a Prompt Engineering Expert …'` / `Zo='You are a prompt enhancement assistant. …'`；调用 `runAgent({systemPrompt:Xo,userPrompt:Qo(n),…})`，`function Qo(e){return Zo.replace('{input}',e)}` —— `main__server.js`
证据【B】：`dsh/index.js` L35-L50（`SYSTEM_PROMPT`）、L58-L91（`TASK_PROMPT`）、L178-L188（`system`/`messages` 分离传入）

---

## 八、是否占用对话上下文

**判定：一致**（效果一致：都不进会话记录、**都不读对话历史**；机制不同：sidecar ⟷ `ctx.llm.stream`）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 隔离载体 | sidecar（边车进程）+ `e.createClient(endpoint).runAgent({...})`，`agentName:'enhance-prompt'` | `ctx.llm.stream({provider, model, system, messages, maxTokens, signal})` | 机制不同 |
| 建会话 | 未在可见代码中创建会话/写会话日志 | **不创建 Session、不写会话日志**（源码头注释 + 代码只调 `llm.stream`） | 一致（效果） |
| **是否读对话历史** | **不读**：底层 `Ko.runAgent` 只做**白名单字段拼装**，POST 到 `/api/v1/llm/completions`（单次补全接口），请求体**没有 `messages` / `history` / `conversationId`** | **不读**：`messages` 数组里只有 1 条 user 消息，无任何历史 | 一致 |
| **`sessionId` 是否落地** | **不落地**：渲染层把 `sessionId` 传进了调用选项，但宿主处理器 `ts()` 只透传 `text`/`model`，而 `runAgent` 白名单里**根本没有 `sessionId` 字段** | 无会话概念 | 一致（都拿不到） |
| 端点可用性 | 先 `getSidecarEndpoint()`，失败即 `sidecar_unavailable` | 先查 `ctx.get('llm')` 与 `agentDefaultModel` 路由，失败即 `llm_unavailable`/`no_route` | 一致（同类前置检查） |
| 证据强度 | 反编译明文可证：**请求体不含历史、走单次补全接口**（升级为【A】）；"不写会话记录"仍无直接取证（看不到服务端落库行为） | 源码结构可证 + `README.md` 标注的实测记录 | 部分（WB 侧【A】+【C】，DSH 侧【B】+【C】） |

### 8.1 补充结论：**增强时不看对话上下文**（本次新凿实）

WorkBuddy 的增强请求是**单次、无状态**的补全（completion）调用，全文脉络：

```
渲染层：JOr(blocks) 取出草稿纯文本（顺带剔零宽空格）
   ↓ e.enhanceService(text, signal, { sessionId, model })      ← sessionId 到此为止
宿主 es()：只读 t.text / t.model
   ↓ createClient(endpoint).runAgent({ systemPrompt: Xo, userPrompt: Zo.replace('{input}', text), agentName, model })
Ko.runAgent()：白名单拼装请求体，POST {endpoint}/api/v1/llm/completions
   请求体 = { systemPrompt, userPrompt, temperature, maxTokens, maxTurns, agentName, ...(model?) }
   —— 无 messages / history / conversationId
```

**结论**：WorkBuddy **不读对话历史**，模型看到的只有「两段固定提示词 + 当前草稿文本」。
所谓"根据上下文"，只在**弱含义**下成立：你在草稿里自己写进去的背景信息，会被一并改写。

本插件对照：`llm.stream({ system, messages: [ { role:'user', content:[{type:'text', text: TASK_PROMPT.replace('{input}', text)}] } ] })`
—— 同样只有 `system` + 一条 user 消息，无历史。**在"不吃上下文"这一点上，两边一致**（也都不写会话记录）。

证据【A·新】：`Ko` 类原文 ——
`async runAgent(e){try{let t={systemPrompt:e.systemPrompt,userPrompt:e.userPrompt,temperature:e.temperature,maxTokens:e.maxTokens,maxTurns:e.maxTurns,agentName:e.agentName||'pulse',...e.model&&e.model.trim().length>0?{model:e.model}:{}};return(await a.aa.post(`${this.endpoint}/api/v1/llm/completions`,t,{headers:{'Content-Type':'application/json',...this.stringHeaders()},timeout:3e5,signal:e.abortSignal})).data}...}` —— `main__server.js`
（请求体里 `temperature`/`maxTokens`/`maxTurns` 增强链路都没传，值为 `undefined`，`JSON.stringify` 会直接丢弃这些字段。）

证据【A】：`i=await e.getSidecarEndpoint()` … `e.createClient(i).runAgent({systemPrompt:Xo,userPrompt:Qo(n),agentName:Yo,model:r})`；
处理器 `function ts(e,t){e.handle(qo,async e=>{let n=e??{};return es(t,{text:…n.text…,model:…n.model…})})}` —— `main__server.js`
证据【B/C】：`dsh/index.js` L5-L8 头注释、L159-L188；`README.md`「不占对话上下文：优化走的是独立的模型调用，不创建会话、不写入会话记录」

> 注【N】：WorkBuddy 侧现在**可以证明"请求不带历史、走单次补全接口"**（反编译明文）；
> 但**"服务端不把这次调用写进任何会话/记忆库"仍无法从反编译证明**（看不到 sidecar 服务端与 `/api/v1/llm/completions` 的实现）。
> 本插件「不占上下文」是**作者实测 + 代码结构**支持，本次同样**未在 DSH 运行时独立复验**。

---

## 九、模型选择方式

**判定：部分一致**（都是"跟随当前所选模型"；WorkBuddy 多一个显式指定通道，本插件多一个"无路由即报错"的显式失败）

| 对比项 | WorkBuddy | 本插件 | 判定 |
|---|---|---|---|
| 默认行为 | 渲染层把当前模型 id 传下去：`l=e.getModel?.()`，非空则 `u.model=l` | 宿主读 `ctx.get('agentDefaultModel')?.currentSelection()` → `{provider, model}` | 一致（跟随当前选择） |
| 显式指定 | **支持**：IPC 契约 `model?`（可选），宿主 `r = typeof t?.model==='string' && t.model.trim().length>0 ? t.model.trim() : undefined`，再传给 `runAgent({model:r})` | **不支持**：`/enhance` 只接收 `{text, requestId}`；客户端无法覆盖模型 | 不一致 |
| 分档（快/强模型） | 未见分档逻辑（`input.model.autoMode`/`maxMode` 是输入框的模型选择器，非增强专用分档） | 无 | 一致（都没有） |
| 会话标识 | 传了 `sessionId`（`u.sessionId=c`）进调用选项，但宿主 `ts()` 只透传 `text`/`model`，且 `runAgent` 请求体白名单里**没有** `sessionId` —— **确认未落地**（见第 8.1 节） | 无会话概念 | 一致（都拿不到） |
| 无可用路由时 | 无此分支（模型缺省即交给 sidecar 默认） | `no_route` 错误码 + `/config` 暴露 `ready/provider/model/hasLlmService` | 一致（本插件更显式，归入维度 12） |

证据【A】：`let r=typeof t?.model==='string'&&t.model.trim().length>0?t.model.trim():void 0` … `runAgent({…,model:r})`；渲染层 `let c=e.getSessionId(),l=e.getModel?.(),u={};c&&c.length>0&&(u.sessionId=c),l&&l.length>0&&(u.model=l)` —— `main__server.js` / `ui-docs-viewer-C3xwvySY.js`
证据【B】：`dsh/index.js` L145-L153（`selectedRoute`）、L167-L172、L266-L289（`/config`）

---

## 十、错误码与失败处理

**判定：部分一致**（本插件码更细、多一层 HTTP 层；WorkBuddy 只有 4 个码，把截断/无改动都归并或忽略）

| 情形 | WorkBuddy（`es()` 返回） | 本插件 | 判定 |
|---|---|---|---|
| 空输入 | `empty_input`（"Empty input"） | `empty_input`（"the draft is empty"） | 一致 |
| 输入超长 | 无此校验（输入框本身 `maxLength=1e5`） | `too_long`（>20,000 字符） | **本插件独有** |
| 通道不可用 | `sidecar_unavailable`（取端点失败/端点为空，两条日志） | `llm_unavailable`（无 llm 服务）/ `no_route`（无 provider+model） | 部分一致 |
| 模型调用抛异常 | `unknown`（"CliPulseClient threw unexpectedly"） | `llm_error`（`failure.code` 透传）/ `unknown` | 部分一致 |
| 模型返回 success=false | `llm_error`（err 或 "LLM completion failed"） | `llm_error` | 一致 |
| 输出被预算截断 | **无识别**：`runAgent` 结果若 `success` 就当成功（是否会被判 success 未验证） | `truncated`（`chunk.reason.kind==='max-tokens'`）→ **判失败** | **本插件独有** |
| 清洗后为空 | `llm_error`（"Enhanced result is empty"） | `empty_result` | 部分一致 |
| 返回原文 | 视为成功（并开启可还原） | `unchanged` | **本插件独有** |
| 用户取消 | 渲染层按 `AbortError` 静默处理（无错误码、无提示） | `aborted`（宿主码；客户端不显示错误） | 部分一致 |
| 请求来源不合法 | 无对应层（IPC handle 仅在应用内可用） | `untrusted_origin`（HTTP 403；同源或 `dsh-app://app` 才放行） | **本插件独有** |
| 传输层 | 无 HTTP（IPC handle `e.handle('llm:enhancePrompt', …)`） | HTTP 层：405（路径无人注册 → 客户端提示"宿主半未加载，请重启 DSH"）、403、500 | **本插件独有** |
| 日志 | `e.logger?.error('[enhancePrompt] …',{code, error, endpoint, agentName})` —— **结构化字段更全** | 一条 `logger.warn('[dsh-prompt-enhance] enhance failed (code): message')`；`aborted` 不记 | **WorkBuddy 更好** |
| 用户可见文案 | 无中文映射证据（宿主返回英文 error 文本；渲染层 `errorMessage` 直接用它）**未验证**是否有 code→文案映射 | 中文 `MESSAGES` 映射表（9 条）+ 未知码回落到宿主原文 | 部分一致（DSH 可证更友好） |

证据【A】：宿主四条分支原文见第 5 节；`function ts(e,t){e.handle(qo,async e=>{let n=e??{};return es(t,{text:typeof n.text==='string'?n.text:'',model:typeof n.model==='string'?n.model:void 0})})}` —— `main__server.js`
证据【B】：`dsh/index.js` L212-L236、L240-L260、L293-L305、L315-L321；`client/client.js` L80-L91、L104-L118

---

## 十一、WorkBuddy 有、本插件没有的（逐条取证，含 1 条**反证**）

| # | 能力 | 结论 | 证据 |
|---|---|---|---|
| 1 | **`pendingApply` + `acknowledgePendingApply(seq)` 回写令牌** | **确认存在**。用自增 `seq` 把新内容推给独立编辑器实例，编辑器应用后回调确认，避免 React 状态与编辑器状态互相打架。本插件直接 `setDraft`，无令牌、无确认回路。 | 【A】`m=(e)=>(l.current+=1,{seq:l.current,blocks:e})`；`skr`（确认）：`e.pendingApply.seq!==t?e:{...e,pendingApply:null}`；消费端 effect 见第 3 节 |
| 2 | **零宽字符（ZWSP, `\u200B`）剔除** | **确认存在**。两处：`qOr(e)=e.split(tkr).join('').trim()`（`tkr='\u200B'`）与 `CGt` 同款。本插件缺失 → 只含隐形占位的草稿会误触发。 | 【A】`nkr` 模块：`$Or='__no_session__',ekr={...},tkr='\u200B'`；`function qOr(e){return e.split(tkr).join('').trim()}` |
| 3 | **按会话（session）隔离的状态** | **确认存在**。状态是 `Map<sessionKey, state>`，无会话时落 `'__no_session__'` 兜底；会话集合变化时中止并清理已消失会话；另有 `suppressDivergedToken`（会话切换时自增，抑制一次发散判定）。本插件状态在组件内 `useState`/`useRef`，无会话键。 | 【A】`let{enhanceService:t,sessionId:n,model:r,activeSessionIds:i}=e,a=n&&n.length>0?n:$Or,[o,s]=useState(()=>new Map)`；清理 effect：`for(let[t,n]of c.current.entries()){if(t==='__no_session__'||e.has(t))continue;…r.abort(),c.current.delete(t)}` |
| 4 | **写回时保留非文本块**（附件/结构） | **确认存在**（`YOr`，见第 3 节）。本插件整体替换为纯文本。实际影响**未验证**（DSH 草稿是纯字符串，附件是独立字段）。 | 【A】`function YOr(e,t){…for(let e of t)e.type!=='text'&&r.push(e);return[...r,{type:'text',text:n}]}` |
| 5 | **composer 禁用态联动**（输入框禁用 / `checkSendDisabled`） | **确认存在**：`disabled:xe` 同时喂给增强按钮与发送按钮；本插件不读取任何禁用态。 | 【A】`fQt` 与 `hQt` 共用 `xe`：`(0,d3.jsx)(hQt,{loading:cn,disabled:!a&&xe,…})` |
| 6 | **`icon` 可替换 / `minTextLength` 由外部配置注入** | **确认存在**：`fQt` 收 `icon` 参数；`enhancePromptConfig.minTextLength` 来自 provider 配置层，本插件是写死常量 `MIN_TEXT_LENGTH=1`（`apply(ctx, config)` 的 `config` 未被使用，插件无配置 schema）。 | 【A】`icon:e.enhancePromptConfig.icon`；`{disabled:!1,minTextLength:1,…}`（`ui-docs-viewer`）。【B】`dsh/index.js` L24、L142；`package.json` 无 `dsh.config` |
| 7 | **增强结果"前置对比预览"** | **反证：未找到**。反编译中增强成功后直接 `pendingApply(after)` 覆盖编辑器内容，未见任何并排/差异预览 UI。（同文件存在通用 diff 代码 `Ytr/Ztr/Xtr`，但**未见其与增强功能关联**——标【N】，不能据此说 WB 有预览。） | 【A】成功回调 `patchSessionState(…,{backupBlocks:{before:t,after:a},pendingApply:e.makePending(a)})`，无预览分支 |
| 8 | **两套并行实现共存**（`fQt`+钩子 与 `DGt` 自持状态） | **确认存在**，两套 i18n 前缀不同（`input.enhance.*` / `chatInput.enhance.*`）。这不是"能力差距"，但说明该功能的对外契约在 WB 内部并不唯一，做兼容时要注意。 | 【A】`DGt` 全文见 `lib-chat-ui-CHONh1NB.js`（`wGt`/`kC(e=>e.draft.content.blocks)`/`chatInput.enhance.tooltip`） |

---

## 十二、本插件有、WorkBuddy 没有的

| # | 能力 | 证据 |
|---|---|---|
| 1 | **截断即失败**：`chunk.reason.kind==='max-tokens'` → `truncated` 错误码，宁可不改也不给半截提示词 | 【B】`dsh/index.js` L176、L200-L224；【C】`README.md`（`deepseek-flash` 推理吃光 512 词元预算的实测） |
| 2 | **Markdown 围栏（fence）清洗** | 【B】`dsh/index.js` L135-L137（对比 WB 的 `$o` 无此步） |
| 3 | **"返回原文"判失败**：`unchanged` | 【B】`dsh/index.js` L232-L236 |
| 4 | **输入超长防护**：`MAX_INPUT_CHARS = 20_000` → `too_long` | 【B】`dsh/index.js` L25、L303-L305 |
| 5 | **请求来源守卫**：`isTrustedRequest` 接受 `dsh-app://app` 桌面文档源或同源，否则 403 `untrusted_origin` | 【B】`dsh/index.js` L101-L113、L247-L250；【C】`README.md`（桌面版强制 Origin 的坑） |
| 6 | **405 自诊断提示**：路径无人注册 → 客户端提示"宿主半未加载，请重启 DSH" | 【B】`client/client.js` L80-L91 |
| 7 | **宿主侧取消链路**（`/cancel` + `requestId` + `inFlight` 表 + 流内 `signal.aborted` 兜底 + 卸载时统一 abort） | 【B】`dsh/index.js` L143、L193-L197、L307-L310、L328-L339、L341-L347 |
| 8 | **显式输出预算**：`MAX_OUTPUT_TOKENS = 4_096` 并做过实测标定（WB 未传 `maxTokens`，依赖 `runAgent` 默认值——**该默认值未验证**） | 【B】`dsh/index.js` L26-L32、L186 |
| 9 | **可诊断的 `/config`**：回报 `minTextLength/maxInputChars/provider/model/ready/hasLlmService/selectionKeys/selection`（选择对象原样 JSON），路由解析失败可自查 | 【B】`dsh/index.js` L266-L289 |
| 10 | **用户可见中文错误文案表**（9 条 + 未知码回落宿主原文），失败态按钮变红并提示重试 | 【B】`client/client.js` L104-L118、L257-L261 |
| 11 | **完整可读源码 + 双测试集**：宿主半 38 项、客户端半 24 项离线检查（含对 Cordis `ctx.llm` 守卫的模拟回归） | 【B】`test/smoke.mjs`、`test/client.test.mjs`；【C】`README.md` |
| 12 | **失败时把原文写回草稿**（catch 内 `writeDraft(original)`） | 【B】`client/client.js` L226 —— 注：WB 也有等价还原，**不算差异**，此处仅列出以便核对 |

---

## 附录 A：① 本插件相对 WorkBuddy 的差距清单

按"影响面 × 修复成本"排序（前 4 条建议优先处理）：

| 优先级 | 差距 | 具体表现 | 建议方向 |
|---|---|---|---|
| 高 | **丢了"约 800 字符"长度约束** | `Xo`：`"Keep the enhanced prompt concise - maximum length should be around 800 characters"`；`SYSTEM_PROMPT` 与 `TASK_PROMPT` 均无对应条款，只有 4096 词元预算 | 在 `SYSTEM_PROMPT` 或 `TASK_PROMPT#6` 补一条字符上限（并按 DSH 习惯改为"约 XXX 字符"） |
| 高 | **零宽字符未剔除** | 草稿只含 `\u200B`（Slate 隐形占位符）时，`trim()` 不去掉它，按钮会显示并发起无意义请求 | 客户端入参前 `draft.replace(/\u200B/g,'')` 再判长度 |
| 高 | **无 composer 禁用态联动** | WorkBuddy：`disabled = 输入框禁用 || checkSendDisabled(内容)`；本插件按钮始终可点（例如正在流式生成/占位锁定期间仍可点） | 客户端读取插槽提供的禁用/发送可用性状态（**需先确认插槽是否下发，未验证**） |
| 中 | **"改动即失效"参照物选错** | 用户手动改回原文时，本插件仍保留"恢复原文"；WorkBuddy 会正确退休 | 把判定改为"与 optimizedRef 比较 + 记录一次写回令牌"，或直接记录 `setDraft` 后的期望值 |
| 中 | **状态未按会话隔离** | 状态在组件内 `useState`；切会话若组件不重挂载，备份/错误会残留（**是否重挂载未验证**，所以只算潜在风险） | 若插槽 props 有 `sessionId`，按其分桶 |
| 中 | **无写回令牌/编辑器级替换** | 依赖 `setDraft` 纯文本整体替换；WorkBuddy 用 `pendingApply` + `replace(blocks)` 保结构 | 受 DSH 插槽契约限制（只有 `setDraft`），**短期无法对齐**；已在 README 记录 |
| 低 | **提示词信息量少于 WB** | system 层丢了 WB 的 2 个英文少样本、FORMAT 条款、"writing code" 定位句、"Ensure clarity and completeness"；语言锁定只在 user 层出现（WB 双层重申） | 按需补回 2 个少样本 + system 层语言锁定重申 |
| 低 | **日志不够结构化** | WB：`logger.error('[enhancePrompt] …',{code, error, endpoint, agentName})`；DSH：单条 warn 文本 | `ctx.get('logger')` 附带 code/requestId 字段 |
| 低 | **`minTextLength` 不可配置** | 宿主常量 `MIN_TEXT_LENGTH = 1`，`apply(ctx, config)` 的 `config` 未使用，无配置 schema | 加 `dsh.config` schema + 读取 config |
| 低 | **无图标可替换 / 无按钮级自定义** | WB `fQt` 收 `icon` 参数 | 非必要 |

## 附录 B：② 本插件做得更好的点

| # | 更好的点 | 依据 |
|---|---|---|
| 1 | **真正的宿主侧取消**：`/cancel` + `requestId` + `inFlight` 表 + **流循环内逐分片复查 `signal.aborted`**（对付不理会 signal 的适配器）；插件卸载时中止全部在途请求。WorkBuddy 的宿主函数里一行取消代码都没有，中止只停在渲染进程，"是否真的停掉 sidecar 请求"无法取证 | 【B】`dsh/index.js` L143/L190-L197/L328-L347；【A】`es()` 全文 |
| 2 | **错误码更细、可路由**：`truncated` / `empty_result` / `unchanged` / `too_long` / `no_route` / `llm_unavailable` / `aborted` / `untrusted_origin`，另有 403/405/500 传输层；WB 只有 4 个码，且**截断、无改动都没有识别**（无改动还被当成成功并开启"恢复原文"，会给用户一个毫无意义的还原按钮） | 【B】`dsh/index.js` L212-L236、L293-L305、L315-L321；【A】`es()` |
| 3 | **截断处理经过实测标定**：发现"推理吃掉全部输出预算"，于是把上限提到 4096 并把 `max-tokens` 单独报成错误——**截断的提示词比不优化更糟**，这个判断 WB 侧没有对应实现 | 【C】`README.md`；【B】L26-L32 |
| 4 | **结果清洗更强**：先剥 Markdown 围栏，再去**成串**首尾引号（WB 的 `$o` 正则无 `+`，模型多打两个引号就漏一个） | 【B】L133-L140；【A】`$o` |
| 5 | **有输入侧与来源侧防护**：20,000 字符上限 + 同源/`dsh-app://app` 守卫 + 不可信来源 403；405 还能自诊断出"宿主半没加载" | 【B】L24-L25、L101-L113、L247-L250；`client/client.js` L80-L91 |
| 6 | **可诊断性更好**：`/config` 把 `provider/model/ready/hasLlmService/selection`（原样 JSON）吐给客户端，路由解析失败能一眼看出原因；WB 只有笼统的 `sidecar_unavailable` | 【B】L266-L289 |
| 7 | **用户可见文案中文化 + 失败可视**：9 条中文映射、未知码回落宿主原文、失败态按钮变红并提示重试 | 【B】`client/client.js` L104-L118、L257-L261 |
| 8 | **工程可验证**：源码完整可读、双离线测试集（38 + 24 项，含回归锁）、README 记录踩坑；对比之下 WB 侧只能反编译取证，且**内部同时存在两套实现**，契约本身不稳定 | 【B】`test/`；【C】`README.md`；【A】`fQt` 与 `DGt` 并存 |

---

## 附录 C：取证命令（可复现）

在 Windows PowerShell（工作目录 `D:\DeepSeek Harness\插件`）下执行。

提示词原文抓取（`snippet.mjs`：文件 / 正则 / 前置字符 / 后置字符 / 命中上限）：

```powershell
node ".wb-research\snippet.mjs" ".wb-research\hits\main__server.js" "Prompt Engineering Expert" 200 2500 3
node ".wb-research\snippet.mjs" ".wb-research\hits\main__server.js" "CRITICAL PRIORITY" 1500 4000 3
node ".wb-research\snippet.mjs" ".wb-research\hits\main__server.js" "return Zo\.replace" 20 5200 2
```

按钮 / 钩子取证：

```powershell
node ".wb-research\snippet.mjs" ".wb-research\hits\main__server.js" "runAgent" 400 900 8
node ".wb-research\snippet.mjs" ".wb-research\hits\renderer__assets__lib-chat-ui-CHONh1NB.js" "hasBackup" 900 1500 4
node ".wb-research\snippet.mjs" ".wb-research\hits\renderer__assets__lib-chat-ui-CHONh1NB.js" "minTextLength" 1300 900 4
node ".wb-research\snippet.mjs" ".wb-research\hits\renderer__assets__ui-docs-viewer-C3xwvySY.js" "originalBlocks" 1800 2400 4
```

`Zo` ⟷ `TASK_PROMPT` 字符级比对（归一化去缩进/空行后按字符重同步，输出 4 处差异：`assistant→agent`、两处 `'s ` 删除、`→`→`->`；长度 2279 → 2272）。
若重跑，注意 PowerShell 直接 `node -e "...反引号..."` 会被转义吃掉，用 here-string 管道给 `node -`：

```powershell
$code = @'
const fs = require("fs");
const bt = String.fromCharCode(96);
const wb = fs.readFileSync("D:/DeepSeek Harness/插件/.wb-research/hits/main__server.js", "utf8");
let zo = wb.match(new RegExp("Zo=" + bt + "([^" + bt + "]*)" + bt))[1]
  .replace(/\\u([0-9A-Fa-f]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
const dsh = fs.readFileSync("D:/DeepSeek Harness/插件/dsh-prompt-enhance/dsh/index.js", "utf8");
const arr = eval("[" + dsh.match(/const TASK_PROMPT = \[([\s\S]*?)\]\.join/)[1] + "]");
const norm = (s) => s.split("\n").map((l) => l.trim()).filter((l) => l.length).join(" ");
console.log(norm(zo).length, norm(arr.join("\n")).length);
'@
$code | node -
```

---

## 附录 D：判定一览（速查）

| # | 维度 | 判定 | 一句话差异 |
|---|---|---|---|
| 1 | 触发与位置 | 部分一致 | 位置/隐藏语义同；缺零宽字符剔除与禁用态联动 |
| 2 | 按钮三态状态机 | 一致 | ✨ / 转圈可取消 / ↩️ 还原 完全对应 |
| 3 | 读草稿与写回 | 部分一致 | Slate 块数组 + 令牌回写 ⟷ 纯字符串 + `setDraft` |
| 4 | 备份、还原、改动失效 | 部分一致 | 主干一致；"自己写回"的判定参照物不同，有一处行为偏差 |
| 5 | 取消机制 | 部分一致 | 渲染侧思路同；宿主侧本插件完整、WB 无 |
| 6 | 结果清洗 | 部分一致 | 都去引号；本插件多剥围栏、去成串引号、多 `unchanged` 校验 |
| 7 | 双层提示词 | 部分一致 | user 模板近逐字照搬（仅 4 处）；system 被改写且丢 800 字符约束 |
| 8 | 不占对话上下文 | 一致 | sidecar ⟷ `ctx.llm.stream`，效果同、机制不同；**两边都不读对话历史** |
| 9 | 模型选择 | 部分一致 | 都跟随当前模型；WB 支持显式 `model?`，本插件不支持 |
| 10 | 错误码与失败处理 | 部分一致 | 本插件码更细、多 HTTP 层与中国文案；WB 日志字段更结构化 |
| 11 | WB 有 / 本插件无 | 单边清单 | `pendingApply` 令牌、ZWSP 剔除、按会话隔离、非文本块保留、禁用态联动（**"对比预览"反证：不存在**） |
| 12 | 本插件有 / WB 无 | 单边清单 | `truncated`、围栏清洗、`unchanged`、`too_long`、来源守卫、405 自诊断、宿主侧取消、显式 `maxTokens`、可诊断 `/config` |

---

## 附录 E：产品建议——要不要读对话历史（非事实判定，属主观建议）

> **本节是建议与判断，不是从源码得出的事实。上文一到十二节（含附录 A–D）才是取证结论。**
> 本节不含新的反编译证据；凡引用事实处，均指回第 8.1 节的取证结果。请勿把本节观点当作证据引用。

### E.1 主结论：「不读对话历史」是**特性**，不是缺陷

增强功能的职责是**"把你要说的话说清楚"，不是"帮你想说什么"**。因此它的输入应当是
"用户此刻的意图表达 + 固定提示词"，而不是整段会话。

偷偷读历史的最大风险是**污染草稿**：用户正准备切换话题，增强却把上一轮出现的文件名、报错信息、
技术栈塞进尚未发送的草稿里，用户还得手工删。

这一点与 WorkBuddy 自己的提示词**自相矛盾**：`Xo` 明确要求
`Do not suggest specific technologies unless mentioned in the user's prompt`（第 7.4 节第 8 条），
一旦增强链路悄悄带上对话历史，"用户没提过的技术"就可能顺着历史溜进草稿——**自己破自己的禁令**。

### E.2 建议：开一个**很窄的口子**，并逐条写清红线

| 优先级 | 建议 | 红线 |
|---|---|---|
| 高 | **上下文由用户显式带入**：在草稿里 @mention（提及引用）某条消息，或选中一段文字再点 ✨ | 系统不猜；用户点了谁才带谁 |
| 高 | **只用于消歧（指代消解，anaphora resolution），不用于扩写** | 上下文只负责解释"这个 / 上面那个 / 它"指谁，**不新增任何需求、技术选型、文件路径** |
| 中 | **注入结构化 + 最小化**：只取最近 1–2 轮的**用户侧文本**，包成带标签的背景区块（如 `<conversation_context>`），并在提示词里配"仅供消歧"的强约束 | 不带 assistant（助手）长回复、不带工具调用（tool call）输出 |
| 中 | **可见、可关、默认关**：配置项如 `includeRecentTurns: 0/1/2`，**默认 0**；开启后 tooltip（悬停提示）改口为"结合最近对话增强"，结果上给一个角标说明参考了哪几轮 | 用户永远能知道模型看到了什么，也能一键关掉 |

### E.3 一句话产品判断

对增强功能而言，**上下文唯一正当的用途是指代消解，不是需求补全**。
分不清这两件事，"读历史"就会从加分项变成幻觉（hallucination，模型编造）制造机。

反过来说：DSH 这类本地智能体场景里，用户常在同一个输入框里说"把这个函数改成异步的"，
"这个函数"指谁确实需要上下文——**这正是"只做消歧"这条红线的现实依据**。

### E.4 反面教材 + 技术可行性

- **反面教材**：WorkBuddy「渲染层一路传 `sessionId`、宿主完全不用，`runAgent` 白名单里连字段都没有」
  （第 8.1 节取证）—— 这种**"传了不用"是设计债**，别学。要加就明确写成配置项，别留半截参数。
- **技术可行性**：`conversation.input.right` 插槽（slot）交给占用者的 props 里确实有
  `useConversation`、`useTrajectory`（依据见 `docs/阶段0-探针结论.md`），取历史不缺手段，
  缺的只是"要不要读、读多少、给不给用户开关"的产品决策。
  （这两个钩子的具体 API 形状本次**未验证**，真正动手前需先探针。）
