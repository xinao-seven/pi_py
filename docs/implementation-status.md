# 实施状态

更新日期：2026-07-22

当前代码已经重组为 `pi_ai`、`pi_agent`、`pi_coding_agent` 三个包，并通过自动化测试
约束单向依赖。

## 已完成

### 阶段 0：工程骨架

- Python `src` 包结构和 pytest 配置。
- 参考基线固定为 `pi@dd6bea41` 和 `Pi-Agent-Web@664f5a9c`。

### 阶段 1：Session v3 数据层

- JSONL 解析以及 v1→v2→v3 迁移。
- append-only 消息、模型、thinking、compaction、custom、label 和 session info entry。
- 活动分支、树结构、compaction-aware context 和 Web `entryIds`。
- Session metadata 列表、最近会话筛选、同文件分支和跨项目 fork。
- 使用本地 pi 仓库的 2.3 MB 真实旧版 fixture 进行兼容验证。

### 阶段 2：工具运行时首版

- Provider-neutral 工具协议、注册表和运行时启停。
- read、bash、edit、write、grep、find、ls。
- 工作区路径边界、输出截断、精确编辑、Windows PowerShell、超时和取消清理。

### 阶段 3：Agent 主循环

已经实现：

- Provider streaming protocol、统一流事件和离线 FakeProvider。
- Anthropic Messages Provider：消息/图片/工具映射、thinking budget、SSE delta 和 usage 归一化。
- OpenAI-compatible Chat Completions Provider：多模态消息、工具调用、reasoning delta 和 usage 归一化。
- 可注入的 HTTP SSE transport、Provider 注册表和显式配置工厂。
- Agent/turn/message/tool 生命周期事件。
- 默认并行工具调用，以及全局/单工具 `sequential` 执行策略。
- 并行执行时结束事件按完成顺序发出，ToolResult 按模型调用顺序写入 Session。
- transient Provider 错误自动重试：默认最多 3 次、指数退避、取消和额度错误快速失败。
- context usage：优先使用最近成功响应的 usage，并估算后续消息及无 usage 时的完整上下文。
- steer、follow-up、abort。
- 消息与工具结果写入 Session v3。

### 阶段 4：上下文管理与资源加载

已经实现：

- usage-first context token 估算与窗口占用百分比。
- 手动 compaction，以及 `compaction_start` / `compaction_end` 生命周期事件和独立取消。
- 超过阈值时自动 compaction。
- 上下文溢出后最多执行一次 compaction 并自动重试原 Provider turn。
- 裁剪点保持完整用户回合，避免拆散 assistant tool call 与对应 ToolResult。
- 可注入 `CompactionSummarizer`，以及使用当前 Provider 的结构化摘要实现。
- `AGENTS.md` / `CLAUDE.md` 按祖先到工作目录顺序加载并注入 project context。
- `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 和活动工具列表组装 system prompt。
- `.pi/skills`、`.agents/skills` 递归发现、frontmatter 校验、冲突诊断和 XML 技能清单。
- `.pi/prompts` Markdown 模板、带引号参数、默认值、切片以及 `/skill:name` 命令展开。
- AgentSession 支持资源重载，并在 prompt、steer、follow-up 中统一展开资源命令。
- 分支跳转可计算公共祖先、收集废弃路径并生成可注入 Provider 的 branch summary。
- 用户消息与 custom message 导航会恢复编辑文本；分支摘要支持生命周期事件和独立取消。
- Session 统计遍历完整 append-only 历史，汇总消息、工具调用、token 与成本。
- 成本明细按 `provider/model` 区分模型响应，并将工具、compaction 和 branch summary 归入
  `Tools/summaries`。

阶段 4 的计划功能已经完成。后续增强项：

- 超大单回合的 split-turn 双摘要策略；当前实现会保守地保留完整回合。

## 当前已知差异

- read 首版仅支持 UTF-8 文本，尚未处理图片。
- grep/find 会忽略 `.git`、`node_modules` 和 `__pycache__`，但尚未完整解析任意 `.gitignore` 规则。
- bash 已处理直接子进程的超时和取消；完整跨平台进程树终止仍需专项验证。
- Provider 请求和 SSE 映射已有完全离线测试，但尚未进行需要 API Key 的受控真实服务 smoke test。

## 验证结果

```text
72 passed
```

包含三层依赖约束、Session、真实 pi fixture、7 个工具、bash 超时/取消、离线 Agent
工具循环、并行/顺序工具调度、自动重试、上下文估算、compaction/溢出恢复、分支摘要/树导航、
Session 用量与成本统计、Skills/模板/项目指令加载，以及 Anthropic/OpenAI-compatible 请求与流事件映射测试。全部 Provider 测试均使用
注入的内存 transport，没有访问网络或消耗 API 额度。
