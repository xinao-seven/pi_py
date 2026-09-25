# 移动端适配：对话界面更紧凑、按钮不再变形

适用范围：`web/`（`ChatWindow` / `ChatInput` / `AgentControls` / `MessageView` / `MarkdownContent` /
`TaskPlanPanel` / `QuestionDialog` / `AppShell` / `globals.css` / `index.html`）
断点：**统一 760px**（与仓库既有窄屏规则一致），只影响窄屏，桌面端样式一字未动。

---

## 1. 两个问题

1. **一屏内容太少**：窄屏下头部 62px + 分支条 + 控制条 + 输入区把消息区挤掉大半；
   消息区内边距 26/17/35、行间距 38px，字号行高偏松。
2. **按钮变形**：窄屏下几处 flex 行排不下时**只靠收缩**，于是文案被挤成两行、按钮高度不齐：

| 位置 | 症状 | 根因 |
| --- | --- | --- |
| 聊天头部 | 「切换项目 / 文件 / 计划·任务」被压成两行 | `.chat-header` 是 `gap:10px` 的 flex 行，`.header-meta` 没有 `nowrap` / `flex: 0 0 auto` |
| 输入区 | 运行态的「插入指令 / 排队跟进 / 停止」+ 发送方式选择器互相挤压 | `.composer-actions` 只有 `justify-content: flex-end`，没有 `flex-wrap`，子项默认 `flex-shrink: 1` |
| 计划/任务面板 | 头部工具按钮、步骤操作按钮换行 | `.work-panel-tools button` 等没有 `nowrap` |
| 提问弹窗 | 底部「取消 / 提交」被警示文字挤扁 | `.question-actions` 单行 flex，警示文字与按钮抢宽度 |
| 设置/弹窗底部 | 按钮换行 | `.config-footer` 单行 flex |

---

## 2. 修法（三条规则）

### 规则一：能换行就换行，不能换行就横向滚动——绝不允许收缩变形

```css
/* 输入区：整行可换行，按钮保住固有尺寸 */
.composer-actions { flex-wrap: wrap; row-gap: 7px; }
.attach-button, .send-mode, .queue-button, .send-button, .abort-button {
  flex: 0 0 auto;
  white-space: nowrap;
}
```

```css
/* 头部：标题可收缩，按钮组改为"可滚动条"（放不下就滑，尺寸不变） */
.chat-heading { flex: 1 1 auto; min-width: 0; }
.header-meta { flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.header-meta > button { flex: 0 0 auto; min-height: 28px; white-space: nowrap; }
```

同样思路用在 `.config-footer`（换行 + 拉平铺满）、`.question-actions`（警示文字独占一行）、
`.work-panel-tools button` / `.work-panel-body button`（`flex: 0 0 auto` + `nowrap`）。
`AgentControls` 本来就已经是 `overflow-x: auto` + 子项 `flex: 0 0 auto`，只需收紧尺寸。

### 规则二：把高度还给消息区（窄屏高度预算）

| 区块 | 桌面 | 窄屏 |
| --- | --- | --- |
| `.chat-header` | 48px | **46px**（padding `0 10px`，隐藏工作区路径与模型/上下文芯片） |
| `.branch-strip` | 34px | 28px 左右（padding `4px 10px`） |
| `.agent-controls` | 30px | 28px（`select` max-width 170 → 108，标签字号 8px，上下文米尺 52 → 40px） |
| `.composer-dock` | `0 16px 10px` | `0 8px calc(8px + safe-area)` |
| `.message-list` | `28px 22px 32px` | **`14px 12px 20px`** |
| `.virtual-row` 行距 | 38px | **24px**（虚拟列表的行距靠 padding-bottom，测量会跟着更新） |
| `.message-row` 间距 | 34px | 22px；正文行高 1.8 → **1.7**（字号保持 14px） |
| 代码块 / 表格 | - | pre padding 13/14 → 10/11、字号 12 → 11.5；表格 padding 6/10 → 5/7 |

字号**不缩小**：移动端 14px 是舒适区间，压缩空间靠留白与行高。

### 规则三：移动端视口与安全区

- `index.html` 的 viewport 加 `viewport-fit=cover`，否则 `env(safe-area-inset-*)` 恒为 0。
- 底部安全区（iPhone home 指示条）：
  `.composer-dock`（输入框）、`.config-footer`（弹窗按钮）、`.sidebar`（侧栏列表）、
  `.dialog-backdrop`（提问弹窗）都用 `calc(x + env(safe-area-inset-bottom))`。
- 弹窗高度用 **`dvh`**（`max-height: 100vh; max-height: 100dvh;` 两行做回退）：
  移动端地址栏收起/展开时 `100vh` 会把底部按钮顶出可视区。
- `QuestionDialog` 窄屏改成**贴底抽屉**（`align-items: flex-end` + 底部安全区），
  比居中弹窗多出一屏内容。

---

## 3. 验证

```powershell
cd web
npm run typecheck   # exit 0
npm run lint        # 0 error（105 个既有 warning）
npm test            # 28 文件 / 149 例
npm run build       # dist/assets/*.css 中含 dvh×2、safe-area×4、flex-wrap×13、nowrap×27
```

样式改动无法用 jsdom 做有意义的断言（它不做布局），因此**没有视觉回归测试**：
产物中能验证规则确实被编译进去，实际观感需在窄窗口 / 真机上确认。

## 4. 已知限制

1. 只覆盖 **≤760px**；平板（760–1024px）仍走桌面布局（控制条与头部会在中等宽度下横向滚动）。
2. 头部按钮在极窄屏（<330px）仍需横向滑动才能全部看到——这是刻意的取舍：
   宁可滑动，也不把按钮压成两行。
3. 未做「移动端专用组件」（如把头部按钮收进 `⋯` 菜单、输入区改成底部抽屉式编辑器）。
   若后续要减少滑动，那是下一步的方向。
4. 安全区依赖浏览器的 `env()` 支持（iOS Safari 11+/Chrome 69+），老浏览器下退化为无额外留白。
