# 前端缺陷修复：Skills 面板单条过长撑满弹窗 + 弹窗滚不动

> 类型：纯前端布局修复（无后端/契约变更）。涉及 `web/src/globals.css`、`SettingsDialog.vue`、
> `SkillsConfig.vue`、`SessionInfoPanel.vue` 与一条布局契约测试。

## 1. 现象

设置 → Skills：某个 skill 的描述很长时（例如本机 `agent-reach` 的 900 字多段触发说明）：

1. **单个条目沾满整个模态框**：一条就把面板正文占掉大半（量到 90%），其他 skill 被挤到看不见；
2. **无法向下滑动**：窗口较矮时滚轮怎么滚都够不到弹窗下半部分（列表后面的条目、「完成」按钮）。

同一症状也能在「会话信息」面板复现（弹窗比视口高、底部被裁且滚不到）。

## 2. 复现与量测方法（为什么必须用真浏览器）

`scrollHeight/clientHeight` 在 jsdom 里恒为 0，**「滚不动」这类缺陷单测跑不出来**。所以这次用的是
一条「真 DOM + 真 CSS」的量测链路：

1. 用 Vitest + `@vue/test-utils` 挂载**真实组件**（`SettingsDialog` / `SessionInfoPanel`，API 打桩喂真实
   skill 数据），把 `wrapper.html()` 落盘 —— 拿到带 `data-v-*` 的真实 DOM；
2. 取**构建产物** `web/dist/assets/index-*.css`（真实级联顺序），把两边的 `data-v-*` 作用域标记都去掉
   （dev 与生产的作用域哈希不同，不去掉会两边都对不上，量出来的是「没样式」的假象）；
3. 拼成静态页，用 headless Chrome（`--headless=new --dump-dom --window-size=W,H`）跑一段测量脚本：
   沿 DOM 链打印 `clientHeight/scrollHeight/overflow/min-height/margin/getBoundingClientRect`，
   并把 `scrollTop` 推到 1e6 看**真正能滚多远**；
4. 换几个窗口高度（1280×800 / 600 / 480 / 400）跑同一套，比较修复前后。

> 这套脚本是临时的（`.repro/`，未入库）：它依赖本机 Chrome、要写文件，不适合进 CI。
> CI 里守的是**修复的因果条件**，见 §6。

## 3. 量测结果

修复前（窗口 1280×400，视口高 300）：

| 测点 | 值 |
| --- | --- |
| `section.settings-dialog` | `h=460`（被 `min-height: 460px` 钉住）`top=24 bottom=484` → **底部被切** |
| `div.settings-backdrop` | `overflowY=visible`、`maxScroll=0` → **遮罩层根本不能滚**，被切掉的部分永远够不着 |
| `section.config-dialog`（会话信息面板） | `h=340` 而 `max-height=252px`（`min-height` 赢）→ **底部被切**，遮罩同样 `maxScroll=0` |
| skills 首个条目 | `h=261 / body 291 = 90%` —— 一条几乎占满正文 |

修复后（同一窗口）：

| 测点 | 值 |
| --- | --- |
| `section.settings-dialog` | `h=270 top=24 bottom=294 ≤ 300` ✓ 完整可见 |
| `div.settings-backdrop` | `overflowY=auto`、`maxScroll=18` → 需要时能滚到底 ✓ |
| `nav.settings-nav` | `maxScroll=83` → 导航自己滚，不再把弹窗顶出屏幕 |
| `div.config-body.skills-list` | `maxScroll=476` → 列表照常滚 ✓ |
| skills 首个条目 | `h=261 → 129`（描述盒 `client=50 scroll=182`，3 行 + 内部滚动）；正常窗口下占正文 `57% → 28%` |
| 居中是否还成立 | 合成小弹窗在 1254×700 下**水平居中=true、垂直居中=true** ✓ |

## 4. 根因

四个独立的原因叠在一起：

1. **遮罩层用 `place-items: center` 居中、自己却不可滚**。
   `.modal-backdrop` / `.settings-backdrop` 都是 `position: fixed` + `display: grid` + `place-items: center`，
   弹窗比视口高时，「居中」会把**上下两端同时推到可视区之外**，而遮罩层不滚动 → 两端都够不着。
   页面本身也救不了：`body { overflow: hidden }`。
2. **弹窗的 `min-height` 跟视口较劲**：`.config-dialog { min-height: 340px }`、
   `.settings-dialog { min-height: 460px }`。窗口矮于 `min-height + 48px`（遮罩 padding）时，
   弹窗必然溢出屏幕，`max-height` 也压不住（`min-height` 优先）。
3. **设置页导航列的 `min-content` 高度**：6 个 `min-height: 36px` 的按钮 + 间距 + padding ≈ 255px，
   撑高网格行；`.settings-dialog` 一矮，内容就从 `overflow: hidden` 的盒子里被裁掉，同样滚不到。
4. **单个条目的描述没有高度上限**：`.skill-card p` 是普通段落，描述多长条目就多高 —— 这是「一条沾满
   整个模态框」的直接原因，和前三条叠加后才表现为「点开就只看见一条 + 滚不动」。

## 5. 修法

```css
/* globals.css：遮罩自己可滚；居中交给弹窗的 margin:auto */
.modal-backdrop { overflow-y: auto; }          /* 去掉 place-items: center */
.config-dialog  { margin: auto; min-height: min(340px, calc(100vh - 48px)); }

/* SettingsDialog.vue：同上，另外让导航列自己滚 */
.settings-backdrop { overflow-y: auto; }       /* 去掉 place-items: center */
.settings-dialog   { margin: auto; min-height: min(460px, calc(100vh - 48px)); }
.settings-nav      { min-height: 0; overflow-y: auto; }

/* SkillsConfig.vue：单条描述 3 行封顶 + 内部滚动 */
.skill-card p { max-height: 4.5em; overflow-y: auto; overflow-wrap: anywhere; scrollbar-width: thin; }

/* SessionInfoPanel.vue：skills 段同样封顶（面板里字号 10px、行高 1.6） */
.session-info-skills .session-info-desc { max-height: 4.8em; overflow-y: auto; }
```

三个关键取舍：

- **居中为什么换成 `margin: auto`**：`place-items: center` 在**溢出时**会把两端都推出可视区，而
  auto 外边距在溢出时归零 —— 空间够就居中、不够就贴顶并让遮罩可滚，两种情形都对。已实测居中仍然成立。
- **为什么保留 `.config-dialog` 的 `min-height` 但用 `calc` 封顶**：`min-height` 本身有意义（内容少时别缩成
  一条缝），但它的上限不能超过可用高度，否则「没有内容也溢出」。
- **单条描述为什么是「限高 + 内部滚动」而不是省略号/折叠开关**：这条描述是「什么时候该用这个 skill」的
  判据，纯省略等于把信息藏掉；内部滚动保留全文可达，且不需要 JS 状态、不需要按字数猜阈值
  （同一套 CSS 在任意宽度下都成立）。这与面板里系统提示词 `pre`（`max-height: 320px; overflow: auto`）
  是同一套做法。**不写 `overscroll-behavior: contain`**：描述滚到底要能接着滚面板。

## 6. 回归防线

`web/test/components/modal-layout-contracts.test.ts`（4 条）读源码断言四条因果条件：

| 断言 | 守的是什么 |
| --- | --- |
| `.modal-backdrop` / `.settings-backdrop` 有 `overflow-y: auto` 且**不含** `place-items: center` | 遮罩可滚 + 居中方式正确 |
| `.config-dialog` / `.settings-dialog` 有 `margin: auto`，`min-height` 是 `min(…, calc(100vh - 48px))` | 居中可滚 + 高度不跟视口较劲 |
| `.skill-card p` / `.session-info-skills .session-info-desc` 有 `max-height` + `overflow-y: auto` | 单条不撑满面板 |
| 移动端分支仍是 `min-height: 100dvh` / `min-height: 0` | 整屏分支没被桌面规则改坏 |

反向验证：临时删掉 `overflow-y: auto` 与 `min-height` 封顶 → 第 2 条用例红灯；恢复后通过。

## 7. 已知限制

| 项 | 说明 |
| --- | --- |
| 极矮窗口（视口 < ~340px）正文会很窄 | 弹窗此时按可用高度收缩，正文只剩几十像素高（仍可滚）；这是「不裁掉内容」的代价，不是新缺陷 |
| 描述盒内部滚动是嵌套滚动 | 依赖浏览器滚动链：描述滚到底会接着滚列表（因此刻意不写 `overscroll-behavior: contain`） |
| 只封顶了 skill 描述 | 工具描述/参数等其他文字来自 SDK，长度可控；真要长到失控，同一套规则可以再挂上去 |
| 契约测试读的是源码文本 | 它守因果条件，不守样式文本本身；真要验证像素后果只能按 §2 再用真浏览器量一遍 |

## 8. 人工确认（唯一无法自动化的部分）

`cd web && npm run dev` → 把窗口拖矮（或将开发者工具停靠在下半屏），然后：

1. 设置 → Skills：每个 skill 描述最多 3 行、可单独滚动，**没有哪一条会占满整个面板**；
2. 列表能一路滚到最后一条，底部「完成」按钮始终可见可达；
3. 「会话信息」面板同样：弹窗完整落在视口内，滚轮能把内容滚到底；
4. 正常高度的窗口下弹窗仍然**居中**（未被 `margin: auto` 改成贴顶）。
