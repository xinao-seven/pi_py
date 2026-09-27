# 工具调用块：折叠状态显示命令/路径摘要

> 类型：纯前端展示改进（无后端与 API 契约变更）。涉及
> `web/src/lib/tool-summary.ts`（新增纯函数）、`web/src/components/ToolCallBlock.vue`
> 与两条测试（`test/lib/tool-summary.test.ts`、`test/components/ToolCallBlock.test.ts`）。

---

## 1. 问题

工具调用块折叠起来时 `<summary>` 只有三样东西：字形 `›_`、工具名、状态。长会话里一眼看过去
是一排 `bash 完成 / bash 完成 / read 完成 …`，**看不出每一步到底做了什么**——必须逐条展开，
而展开区是一整块 JSON（含 `timeout` 之类的噪声）。

## 2. 修法

### 2.1 「身份参数」表（`src/lib/tool-summary.ts`）

按工具名取**一个**最有辨识度的字符串参数，压成单行放进 summary：

| 工具 | 取哪个参数 | 折叠后看到 |
| --- | --- | --- |
| `bash` | `command` | `bash npm run typecheck` |
| `read` / `write` / `edit` / `ls` | `path` | `read src/lib/api.ts` |
| `grep` / `find` | `pattern` | `grep TODO` |

三条约定（都是为了「不瞎猜」）：

1. **不认识就返回空串**：MCP 工具（`mcp__x__y`）与将来新增的工具一律退回只有工具名，
   不会去猜 `query`/`q`/`url` 哪个是身份字段；
2. **只做展示**：不判断命令危不危险、不解析路径——危险命令的提示是审批弹窗的职责；
3. **值必须是非空字符串**：数字/对象/数组一律当没有（避免 `[object Object]`），
   流式过程中 `arguments` 还没解析成对象（是半个 JSON 字符串）时自然不显示，不会闪出残缺文本。

多行命令（heredoc）压成单行——summary 是单行布局，不压会撑破行高；
过长不在 JS 里截断，交给 CSS 的 `text-overflow: ellipsis`，同一份文本同时进 `title`，
所以「省略号后面的内容」悬停就能看全。折叠不等于丢信息：展开区的完整参数一字没动。

### 2.2 布局（`ToolCallBlock.vue`）

```
[›_] [bash] [npm run typecheck              ] [完成]
 ↑     ↑      ↑ 摘要：flex 1 1 auto +        ↑ flex 0 0 auto
 0 0 auto     min-width 0 + 省略号            margin-left auto 仍把状态顶到右边
```

关键点：字形、工具名、状态都 `flex: 0 0 auto`（保住固有尺寸、不收缩变形），
只有摘要列参与收缩——这既是视觉需要，也符合
[`web-mobile-adaptation.md`](web-mobile-adaptation.md) 的规则一（放不下就省略/滚动，不压变形）。
窄屏下摘要会被截得更短，但工具名与状态永远完整。

## 3. 验证证据

| 证据 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（warning 为仓库既有基线） |
| `npm run test` | 30 文件 / **158** 用例全绿（相对上一基线 150 增加 8：本文件的 4 + 4） |
| `npm run build` | 构建成功 |

## 4. 回归防线

| 用例 | 守住的因果条件 |
| --- | --- |
| `test/lib/tool-summary.test.ts` | 7 个已知工具各取对参数；多行/多余空白压成单行；**未知工具、缺参数、非字符串、`undefined`/`null`/裸字符串入参统一返回空串**；超长命令不做 JS 截断（避免 title 拿不到全文） |
| `test/components/ToolCallBlock.test.ts` | bash 命令出现在 `summary` 且 `title` 为完整命令；展开区仍是完整参数（含 `timeout`）；read/edit/grep 同样有摘要；**MCP 工具不渲染 `.tool-hint`**（不猜参数）；运行中/等待结果/完成/失败四种状态与摘要共存；`arguments` 缺失时退回纯工具名 |

## 5. 人工确认（jsdom 测不到的部分）

`cd web && npm run dev` → 发一条会让模型跑 bash 的消息：

1. 折叠状态下一行就能读到命令，长命令以省略号收尾、悬停显示全文；
2. 工具名与右侧状态在窄窗口下仍完整，不被命令挤变形；
3. 展开后「参数」区仍是完整 JSON（`command` + `timeout`），没有因为摘要而丢字段。
