# 前端缺陷修复：上下文占用条全黑、Markdown 表格错位、用户消息每行靠右

> 类型：纯前端样式/渲染修复（无后端与 API 契约变更）。涉及
> `web/src/components/AgentControls.vue`、`MarkdownContent.vue`、`MessageView.vue`
> 与对应的三条回归测试。

## 1. 现象

1. **上下文占用条全黑**：输入区「压缩上下文」右侧的占用条（`.context-meter`）在浅色主题下整条看起来是黑的，看不出填充比例。
2. **Markdown 表格错位**：回复里的 GFM 表格没有边框、列对不齐，宽表还会撑出消息容器。
3. **用户消息每行靠右**：自己发出的消息每一行都被推到右边，不是正常的从左到右阅读。

## 2. 根因

**① 上下文条**：`globals.css` 的变量是**分层覆盖**的，最后一块 2026 白灰重设计把
`--accent` 定为深色主题 `#eeeeee`、浅色主题 `#303030`（近黑）；而 `.context-meter` 的轨道
硬编码成 `#292d35`（深灰）。于是浅色主题下「深灰轨道 + 近黑填充」= 整条黑。另外 DeepSeek 的
上下文窗口是 1,000,000，正常对话百分比只有个位数，`width: 3%` 在 52px 轨道上不到 2px，
即使颜色正确也几乎看不见。

**② 表格**：`MarkdownContent.vue` 只有段落/列表/代码块的样式，**完全没有 `table` 规则**，
浏览器用默认表格排版：无边框、无 `border-collapse`、无横向滚动。

**③ 用户消息**：`.message-row--user` 同时有 `justify-content: flex-end`（整条靠右）和
`text-align: right`（块内每一行文字也靠右），后者就是我们不想要的。

## 3. 修法

**① `AgentControls.vue`**

- 轨道改用主题变量 `var(--panel-soft)`（浅色下是浅灰，近黑的 `--accent` 填充才有对比）；
- 填充加 `.is-visible` 类，`percent > 0` 时 `min-width: 3px`，保证最小可见宽度；
- 条右侧显示百分比数字，`title` 同时带 tokens 与百分比。

**② `MarkdownContent.vue`** 新增整组表格样式：

```css
.markdown-content :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto; /* 宽表自己横向滚动，不撑破容器 */
  border: 1px solid var(--line);
  border-collapse: collapse;
}
.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--line); /* 单元格边框把列区分开 */
}
```

外加 `thead` 背景、偶数行斑马纹（深浅主题各一），并保留 marked 输出的
`align="center|right"`（`th` 默认左对齐，仅在显式声明时覆盖）。

**③ `MessageView.vue`** 只删掉 `.message-row--user` 的 `text-align: right`，
保留 `justify-content: flex-end` 与 `padding-left`：整条仍靠右成块，块内文字正常左对齐。

## 4. 验证证据

| 证据 | 结果 |
|------|------|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（warning 为仓库既有基线） |
| `npm run test` | 28 文件 / 138 用例全绿（相对基线 +4：本文三个修复 3 条，另 1 条属成本修复） |
| `npm run build` | 构建成功 |

## 5. 回归防线

| 用例 | 守住的因果条件 |
|------|----------------|
| `test/components/AgentControls.test.ts` → 上下文占用条 | `percent=2` 时填充必须有 `is-visible` 类（最小宽度）且文案为 `2%`；`percent=null`（刚压缩完）时不渲染，避免显示错误的 0% |
| `test/components/MarkdownContent.test.ts` → GFM 表格 | 表格结构生成为 `th`/`td`，且 `align="right|center"` 经 DOMPurify 清洗后仍在（对齐属性被剥掉就红灯） |
| `test/components/MessageView.test.ts` → 用户消息 | 用户行仍带 `message-row--user`，文本只渲染一次 |

颜色对比度、真实像素宽度、表格边框这类纯视觉属性 jsdom 测不出来，只能靠上面的结构断言 +
人工确认兜底。

## 6. 人工确认（唯一无法自动化的部分）

`cd web && npm run dev` → 分别切深色/浅色主题：

1. 发几轮消息后，占用条能看到明显的填充段与右侧百分比数字，浅色主题下不再是一条黑；
2. 让模型输出一个宽表格，表格有边框、列对齐，宽表在消息区内横向滚动而不撑破布局；
3. 自己发的消息每行从左边开始读，整条仍靠右。
