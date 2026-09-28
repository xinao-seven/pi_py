# Token 消耗优化：压缩触发点、工具结果预算、并行调用提示、计划注入不剥离

> 背景：2026-09 的用量分析发现，单个会话的累计 prompt 可达 **4300 万～1.09 亿 token**，
> 其中 99%+ 是缓存命中。这不是「单轮工具调用太多」，而是 **「LLM 请求轮数 × 只增不减的
> 上下文」** 的算术结果：agent 循环每轮都把全部历史重发一遍，轮数 ≈ 工具调用次数。
> 本文档记录针对四个放大器的修复（代码与测试）、豁免边界与验证方法。

## 1. 实测诊断（为什么改这四处）

对本仓库工作区的真实会话 JSONL（每条 assistant 消息的 `usage`）做解析：

| 会话 | 请求轮数 | 工具调用 | 上下文增长 | 累计 prompt | 缓存命中 | 轮均工具数 |
| --- | --- | --- | --- | --- | --- | --- |
| 09-27 13:15 | 482 | 514 | 8.8K → 40 万 | 1.09 亿 | 99.4% | 1.07 |
| 09-28 02:08 | 229 | 276 | 14K → 32 万 | 4330 万 | 99.3% | 1.21 |
| 09-27 14:26 | 105 | 112 | 9.6K → 13 万 | 920 万 | 99.0% | 1.07 |

四个放大器：

1. **自动压缩永不触发**：SDK 的触发条件是 `contextTokens > contextWindow - reserveTokens`，
   缺省 `reserveTokens=16K`；deepseek 系模型标称窗口 1M ⇒ 要涨到约 98 万才压缩，实测涨到
   30～40 万也不触发。上下文越大，之后**每一轮**的重读都跟着变大。
2. **工具结果又大又永久驻留**：SDK 内置截断上限 2000 行 / 50KB（模块级常量，不可配置），
   实测 `read` 单次最大 39K 字符（≈ 1 万多 token）且永久留在会话里。
3. **轮均只有 1 个工具调用**：482 轮里 433 轮（90%）只带 1 个 toolCall——协议支持一轮并行
   多个调用，模型只是不倾向用。轮数直接乘在「每轮重发全部上下文」上。
4. **计划完成时的一次性大重读**：计划进入 `completed` 后 `onContext` 的 keep 集合变为空，
   历史中部的 `web-plan-execution-context` 注入被剥离，其后所有消息整体位移——实测一次
   计划完成引发 **12 万 token** 的全价重读（缓存分歧点与注入位置吻合）。

## 2. 修复清单

### 2.1 压缩触发点按模型窗口换算（`services/compaction-policy.ts`）

新模块，纯函数 `resolveCompactionSettings(configured, contextWindow)`：

- **触发点上限 200K**（`COMPACTION_TRIGGER_TOKENS`）：窗口超过 200K 时把 `reserveTokens`
  抬到 `max(配置值, contextWindow - 200K)`，即「无论标称窗口多大，工作上下文涨到 20 万就压缩」；
- **keepRecentTokens 缺省 48K**（`PLATFORM_KEEP_RECENT_TOKENS`，SDK 缺省 20K）：保留区约覆盖
  20～40 轮的逐字工作区（正在改的文件最近几版、刚跑的测试输出）；
- **防御**：`keepRecentTokens` 夹到 `触发点 - 16K` 以内（否则压缩在保留区里打转）；
  `enabled: false` 原样放行（尊重显式关闭）；字段缺省按 SDK/平台默认补齐。

接线（`services/agent-registry.ts`）：

- `create()`：预设显式配置优先，没给就用平台默认 `{enabled, 16384, 48K}`，按模型
  `contextWindow` 换算后经 `SettingsManager.applyOverrides` 应用（仅内存，不写 settings.json）；
- `open()`：会话 JSONL 里落的是**解析后的值**（重开不再需要模型目录）；旧会话没有
  compaction 字段时补平台默认，模型窗口从 JSONL 的 `model_change` 条目恢复
  （`modelContextWindowOf()`，查不到就跳过换算，绝不阻断打开会话）；
- 内置「Coding Agent（默认）」预设的 `keepRecentTokens` 提到 48K（`services/preset-service.ts`）。

> 每次压缩的一次性成本 ≈ 一次全量总结请求；对照收益（之后每轮上下文从 30 万级回到
> 48K+摘要 级），在长自主运行里净赚。拿 482 轮会话粗算：不设限累计 ≈ 1.09 亿，
> 触发点 200K / 保留 48K 时 ≈ 5000 万，**省一半以上**，而模型每轮做的工作不变。

### 2.2 工具结果预算 12KB（`services/tool-output-limit.ts`）

新内联扩展，挂 SDK 的 `tool_result` 钩子（`agent.afterToolCall` 的返回值会替换真正进
上下文与 JSONL 的内容）：

- 只收**文本块**，图片块原样保留（截图是视觉任务的输入）；
- 预算按全部文本块的**字节总和**计，缺省 12KB（`TOOL_OUTPUT_MAX_BYTES`）；
- `bash` 保留**末尾**（报错/测试摘要通常在尾部，与 SDK 的 tail 截断同方向），
  其余工具保留**开头**（与 read 的 head + offset 分页语义一致）；
- 截断时追加说明，引导模型用 `offset/limit`、`grep`、`head/tail` 分次精确获取；
- 切块按字节测量并对齐 UTF-8 字符边界（不会切出半个汉字）；
- 未超限返回 `undefined` ⇒ SDK 视为「未修改」，零开销放行。

### 2.3 系统提示词追加并行调用引导（`agent-registry.ts` 的 `loader()`）

- 通过 `DefaultResourceLoader` 的 `appendSystemPromptOverride` 追加 `PARALLEL_TOOL_CALL_GUIDANCE`：
  「相互独立的调用合并在同一轮并行发出；有依赖的等前序结果；写操作与它的读取目标不要同轮并行」；
- `appendSystemPromptOverride` 只做「在现有 append 来源基础上追加」，**不覆盖**预设系统提示词
  与用户已发现的 append 文件。

### 2.4 计划结束态保留注入，不再从历史中部剥离（`services/plan-mode-service.ts`）

- `onContext` 的 keep 集合：规划期 `{PLANNING, ENDED}`、执行期 `{EXECUTING, ENDED}`、
  **结束态（completed/abandoned/paused，计划还在）保留全部三类**（`ENDED_KEEP_TYPES`）、
  无计划时才清空（旧行为）；
- `beforeAgentStart` 在结束态注入一条 `web-plan-ended-context`（`buildEndedContext`）：
  `[PLAN ENDED]` + 状态/进度 + 「历史中更早注入的进度与指令已失效，以本条为准」。
  它只**追加在末尾**（尾部追加不动前缀），内容带 revision ⇒ 状态不变时去抖生效；
- M4 的两条缓存纪律不变：规划/执行期注入去抖（内容相同不重复注入）、工具集恒定。
  净效果：计划完成的瞬间不再有全量重读；代价转移到「下一个计划开始时」按 keep-last
  规则剥离上一轮循环的注入（有计划 A→B 切换才发生，单计划会话完全不发生）。

## 3. 豁免与边界

- **「极简（原版 pi）」会话豁免全部平台策略**：7 个能力全关（`InlineCapabilities.stock`）时
  压缩不做加成、不注册工具结果预算扩展、不追加并行调用提示——它的存在意义就是原版行为。
- **`compaction.enabled: false`**：预设/设置显式关闭时原样透传，不抬触发点。
- **「关文件扩展」≠「极简」**：只关 fileExtensions 的预设能力仍开着其余能力 ⇒ 平台策略照常
  生效；只有 7 个能力全关才算 stock。
- **CLI 不受影响**：策略只存在于 Web 后端装配会话的路径（SettingsManager 内存覆盖 +
  本服务自己的内联扩展），`models.json`/`settings.json` 均不写入。
- **前端契约零变化**：没有新增 REST 字段、SSE 事件或类型（`session-config` 落盘条目只是
  多了 `compaction` 字段，`parseSessionConfig` 原本就支持）。

## 4. 验证

- 单元测试：
  - `test/services/compaction-policy.test.ts`：1M 窗口换算（触发点=200K）、小窗口不动、
    更激进配置保留、病态 keepRecent 夹取、enabled=false 放行、字段缺省补齐；
  - `test/services/tool-output-limit.test.ts`：未超限不改写、head/tail 两方向、UTF-8 边界
    （不产生 U+FFFD）、图片保留、多块合并计量、扩展注册与改写；
  - `test/services/plan-mode.test.ts`：完成/暂停后 `onContext` 不再剥离注入、ENDED 说明
    末尾注入 + 去抖、无计划会话保持旧行为；
  - `test/services/agent-registry-factory.test.ts`：平台默认压缩接线、1M 模型换算落盘、
    极简豁免、并行提示追加且不覆盖既有来源、旧会话 open 补默认与 `model_change` 恢复。
- 全量：`npm run typecheck && npm test`（495 用例）+ `npm run build` + `npm run spike` +
  `npm run eval`（pass@1 100%，并行提示未破坏评测）全绿。
- 上线后的观测建议：用量面板已记录 `cacheHitRate` 与请求形状指纹；对比优化前后
  「每 run 的累计 prompt token」（runs 表聚合）即可量化收益。若发现模型重读已读文件
  的比例上升，优先排查保留区（48K）是否不够。
