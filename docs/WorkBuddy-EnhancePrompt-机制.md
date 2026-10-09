# 腾讯 WorkBuddy「提示词增强」机制调研记录

作者：Kirin（ruiyukirin）　来源：本机反编译 WorkBuddy 桌面版 `app.asar`
对象：WorkBuddy 输入框的 ✨ 增强提示词按钮（内部代号 **EnhancePrompt**）

> 本文是**一手证据整理**，供后续对比调研引用。所有结论均来自反编译源码，非推测。

---

## 一、内部代号与文件位置

| 项 | 值 |
|---|---|
| 功能内部名 | `enhancePrompt` |
| Cordis/IPC 事件名 | `llm:enhancePrompt` |
| Agent 名 | `enhance-prompt` |
| 日志命名空间 | `llm:enhancePrompt` |
| i18n key | `input.enhance.title` / `.enhancing` / `.revert` |
| 中文文案 | 增强提示词 / 增强中... / 恢复原文 |

反编译产物（已提取，可直接阅读）：
- `D:\DeepSeek Harness\插件\.wb-research\hits\main__server.js` —— 宿主端实现 + 两段提示词原文
- `D:\DeepSeek Harness\插件\.wb-research\hits\renderer__assets__lib-chat-ui-CHONh1NB.js` —— 按钮组件、编辑器读写
- `D:\DeepSeek Harness\插件\.wb-research\hits\renderer__assets__ui-docs-viewer-C3xwvySY.js` —— `useEnhancePrompt` 钩子
- 提取脚本：`D:\DeepSeek Harness\插件\.wb-research\extract-asar.mjs`、`snippet.mjs`

---

## 二、三层架构（与其"不占对话上下文"的隔离方式）

```
[输入框草稿 / Slate 编辑器]
      ↓ 读
[✨ 按钮（渲染进程 UI）]
      ↓ IPC  llm:enhancePrompt
[主进程 server.js]  ← 拼提示词、清洗结果
      ↓ 解析 sidecar（边车进程）端点
[sidecar 边车进程 → 云端大模型]
      ↓ 纯文本
[写回输入框] + 原文进备份
```

**关键点**：走 sidecar 独立链路，**不创建会话、不写会话记录**，因此不占对话上下文。

---

## 三、一次点击的完整流程（宿主端）

```
enhancePrompt({ text, model? }):
  1. text 为空 → { success:false, code:'empty_input' }
  2. getSidecarEndpoint() 失败 → code:'sidecar_unavailable'
  3. createClient(endpoint).runAgent({
       systemPrompt: <角色提示词 Xo>,
       userPrompt:   <任务模板 Zo，把草稿填进 {input}>,
       agentName:    'enhance-prompt',
       model:        <可选>
     })
  4. success=false → code:'llm_error'
  5. 清洗 cleanEnhancedText：trim + 去掉首尾引号（含中文引号“”‘’）
  6. 清洗后为空 → code:'llm_error'
  7. 返回 { success:true, text }
```

错误码全集：`empty_input` / `sidecar_unavailable` / `llm_error` / `unknown`
中止标识：`enhance-prompt-aborted-by-user`（Error.name = 'AbortError'）

---

## 四、按钮三态状态机（源码原文）

```js
fQt = ({ loading, disabled, onEnhance, onRevert, hasBackup, errorMessage, onCancel, icon }) => {
  let c = loading && !!onCancel            // 优化中且可取消
  let l = !loading && hasBackup            // 已优化，可还原
  let u = loading ? !c : disabled
  if (!loading && disabled) return null    // ← 不满足直接不渲染
  let d = errorMessage
    || (loading ? t['input.enhance.enhancing'] : l ? t['input.enhance.revert'] : t['input.enhance.title'])
  return Tooltip(content: d, children: Button({
    onClick: c ? onCancel : l ? onRevert : onEnhance,
    disabled: u,
    children: loading ? <Spinner/> : l ? <RevertIcon/> : (icon || <SparkleIcon/>),
  }))
}
```

| 状态 | 图标 | 悬停提示 | 点击 |
|---|---|---|---|
| 有草稿、空闲 | ✨ | 增强提示词 | 发起优化 |
| 优化中 | 转圈 | 增强中... | **取消**并还原 |
| 已优化 | 回退箭头 | 恢复原文 | 还原原文 |

**出现/消失的门槛**：`minTextLength` 默认 **1**，且先剔除零宽字符 `\u200B`（Slate 隐形占位符）；
另有 `disabled = 输入框禁用 || checkSendDisabled(当前内容)`。**空输入 → 按钮完全不渲染。**

---

## 五、状态钩子 `useEnhancePrompt` 的设计

配置对象 `enhancePromptConfig` 字段（从 memo 比较器还原）：

```
{ disabled, minTextLength, isEnhancing, hasEnhancePrompt,
  errorMessage, pendingApply, suppressDivergedToken, icon,
  onTriggerEnhance, onCancel, onRevert, onContentDiverged, acknowledgePendingApply }
```

会话内状态（按 sessionId 索引的 Map，无会话时落 `__no_session__` 兜底）：

```
{ isEnhancing, hasEnhancePrompt, errorMessage,
  backupBlocks: { before, after },   // 原文 / 优化后
  pendingApply: { seq, blocks }      // 回写令牌
}
```

四个关键动作：

1. **onEnhance**：先 abort 上一次未完成请求 → 新建 AbortController 存 handles → 备份原文
   → patch `isEnhancing:true` → 带 `sessionId` + 当前模型 id 调服务
   → 成功：`backupBlocks={before,after}`、`hasEnhancePrompt:true`、`pendingApply=makePending(after)`
   → 失败：**先把原文还原回去**，再置 `errorMessage`
2. **onCancel**：abort + 用 `pendingApply(originalBlocks)` 还原
3. **onRevert**：`pendingApply(backupBlocks.before)`，清 `hasEnhancePrompt`
4. **onContentDiverged**：内容变化时与 `backupBlocks.after` 深比较 —— 一致则保留可还原；
   **不一致则清掉备份、收起还原能力**（防止吞掉用户后续修改）

**`pendingApply` + `acknowledgePendingApply(seq)` 是关键设计**：编辑器是独立的 Slate 实例，
React 状态改不动它，所以用"自增序号令牌"把新内容推给编辑器，编辑器应用后回调确认，
避免两边状态互相打架。

---

## 六、喂给模型的提示词（双层）

### 第 1 层：system（角色）

> You are a Prompt Engineering Expert specializing in improving user prompts **for a development code assistant**...

含明确禁令：不要写教程/how-to（除非用户要）；不要要代码片段；不要提用户没提过的技术栈；
不要解释 HOW、只讲 WHAT；**不要回答问题，而是把问题扩写得更精确**。

### 第 2 层：user（任务模板 + 少样本 + 反例）

结构：`USER INPUT: {input}` → TASK → **CRITICAL PRIORITY - LANGUAGE CONSISTENCY**（语言锁定为最高优先级）
→ ENHANCEMENT REQUIREMENTS（7 条）→ EXAMPLES → BAD/GOOD OUTPUT EXAMPLE

硬约束要点：
- 语言锁定为最高优先级；用户用中文就必须全中文；混排则保持自然混排
- **只输出改写后的提示词本身**：无解释、无前言、无 Markdown 围栏、无标签
- 不许出现"语言分析"元话术（反面例子专门堵这个）
- 保留原意、主题、约束、目标输出类型；不许替代用户答题
- 已经够清楚也要轻度润色，不许原样返回
- 不许出现未完成的列表 / 悬空连词 / 结尾冒号
- 长度控制在 **约 800 字符**

（完整英文原文见 `main__server.js` 中的 `Xo` 与 `Zo` 两个常量。）

---

## 七、与 DSH 插件的机制对照速查

| 环节 | WorkBuddy | DSH 插件可对应物 |
|---|---|---|
| 独立调模型 | sidecar 边车进程 | `ctx.llm.stream()`（同样不建会话） |
| 按钮挂载点 | 输入框底部工具栏（模型选择器与语音按钮之间） | slot `conversation.input.right` |
| 三态 | ✨ / 转圈可取消 / 回退还原 | 同 |
| 读草稿 | Slate 编辑器内容 | `props.useInput(s => s.draft)` |
| 写草稿 | Slate 整体替换 | `props.inputActions.setDraft(text)`（官方注释：整体替换、光标落末尾） |
| 出现门槛 | `minTextLength`（默认 1，剔除零宽字符） | 同（客户端门槛，值来自宿主 `/config`） |
| 原文备份 | `backupBlocks.before` | 客户端 `backupRef` |
| 编辑后失效 | `onContentDiverged` 深比较 | 同（`optimizedRef` 比对） |
| 取消 | AbortController + IPC abort | AbortController + `/cancel` 路由 |
| 结果清洗 | 去首尾引号（含中文引号） | 同 + 剥 Markdown 围栏 |
| 提示词 | 双层（角色 + 任务模板/语言锁定/少样本） | 已照搬并适配为"通用编码/操作型助手" |
