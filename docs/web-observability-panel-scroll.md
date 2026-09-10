# 前端缺陷修复：设置 → 用量页面滚不动、下半部分看不到

> 类型：纯前端布局修复（无后端/契约变更）。涉及 `web/src/components/ObservabilityPanel.vue` 与一条回归测试。

## 1. 现象

设置弹窗 → 「用量」页（`ObservabilityPanel`）在窗口高度不足时**无法滚动**：

- 只能看到「用量与可观测性」标题、KPI 卡片、模型/工具表格；
- 「审批」「每日成本」「最近运行」被截断在弹窗下边缘之外，鼠标滚轮也不起作用（不是滚动到底的问题，是**根本没有滚动条**）。

其他四个分类（模型 / 预设 / Skills / MCP）都正常，只有用量页有这个问题——这是定位的关键线索。

## 2. 根因

滚动链断在中间一层，`.observability-panel` 拿到了内容高度而不是容器高度：

```
.settings-dialog       height: min(680px, 90vh)  ← 定高
└─ .settings-layout    display:grid; flex:1; min-height:0   ← 高度确定
   └─ .settings-content  min-height:0; overflow:hidden       ← 定高 + 裁剪，但不滚动
      └─ .observability-panel  min-height:0; overflow-y:auto ← 有滚动声明，但高度是 auto
```

`.observability-panel` 的 `height` 是 `auto`，会被内容撑到远超父容器的高度；`overflow-y: auto` **只在元素自身高度受限时才生效**，所以滚动条永远不出现；而父级 `.settings-content` 是 `overflow: hidden`，超出的部分直接被裁掉。

对照其他四个面板就能看出差别——它们走的是既有的一条「嵌入式面板」通道：

```
.settings-embedded-panel        height: 100%           (globals.css)
└─ .config-dialog--embedded     height: 100%; flex column
   └─ .config-body              flex: 1; min-height: 0; overflow: auto   ← 真正滚动的是这里
```

`ObservabilityPanel` 既不是 `config-dialog`，也没有 `height: 100%`，等于**既没要高度、也没人给它高度**，滚动链在这一层断掉。

## 3. 修法

在 `ObservabilityPanel.vue` 的 scoped 样式里给面板补上高度约束，并加注释说明「为什么必须自己吃掉这 100%」：

```css
.observability-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  /* 嵌入设置弹窗时父级 .settings-content 是定高 + overflow:hidden：
     这里必须自己吃掉那 100% 高度，否则面板会被内容撑高、下半部分被父级裁掉，
     自身的 overflow-y 永远不会触发（其他面板靠 .config-dialog--embedded 达到同样效果）。 */
  height: 100%;
  min-height: 0;
  padding: 4px 2px 24px;
  overflow-y: auto;
  overscroll-behavior: contain; /* 滚到底不要把父层（弹窗背后的页面）一起带着滚 */
}
```

只改了这一个组件：

- 不动 `globals.css`，不给 `.settings-content` 引入新的 flex 布局，其他面板与「常规」页的既有滚动行为零改动；
- 独立使用（父级高度 auto）时 `height: 100%` 退化为 `auto`，行为与修复前一致，不会产生新的回归面。

## 4. 验证证据

| 证据 | 结果 |
|------|------|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（62 条 warning 为仓库既有基线） |
| `npm run test` | 27 文件 / **129** 用例全绿（基线 128 + 本次新增 1） |
| `npm run build` | 构建成功（`dist` 未纳入版本库） |
| 产物 CSS 断言 | `.observability-panel[data-v-…]{…height:100%…overflow-y:auto}` 确实进包 |
| 回归防线反向验证 | 临时删掉 `height: 100%` → 新增用例失败；恢复后通过 |

## 5. 回归防线（为什么是「读源码的测试」）

jsdom 没有布局引擎，`scrollHeight/clientHeight` 恒为 0，**滚不动这类缺陷在单测里跑不出来**。因此新增一条布局契约测试（`test/components/ObservabilityPanel.test.ts`）：

```ts
it('fills its container and scrolls internally when embedded', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/ObservabilityPanel.vue'), 'utf8');
  const rule = /\.observability-panel\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  expect(rule).toContain('height: 100%');
  expect(rule).toContain('overflow-y: auto');
  expect(rule).toContain('min-height: 0');
});
```

它守住的是**修复的因果条件**（面板必须显式取得容器高度并内部滚动），而不是样式文本本身；三条声明任意一条被删掉都会红灯。

## 6. 人工确认（唯一无法自动化的部分）

`cd web && npm run dev` → 打开 设置 → 用量 → 把浏览器窗口高度调小到出现截断线，此时：

1. 面板右侧出现滚动条；
2. 能一路滚到「最近运行」列表最后一条，且展开 run 详情的步骤表时同样可滚；
3. 「常规」页与其他四个面板的滚动行为不变。
