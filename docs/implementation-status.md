# 实施状态

更新日期：2026-07-31

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
- 工具调用参数会按当前工具使用的 JSON Schema 子集统一校验；未预期工具异常会归一化为
  `isError=true` 的 ToolResult，同时保留取消传播。
- steer、follow-up、abort。
- 消息与工具结果写入 Session v3。

### 阶段 4：上下文管理与资源加载

已经实现：

- usage-first context token 估算与窗口占用百分比。
- 手动 compaction，以及 `compaction_start` / `compaction_end` 生命周期事件和独立取消。
- 超过阈值时自动 compaction。
- `models.json` 的 `contextWindow` 会进入 AgentRuntime；模型切换时同步更新，并由当前 Provider
  动态执行自动 compaction 摘要。
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

### 阶段 5：FastAPI 服务

已经实现：

- FastAPI application factory、环境配置、CORS、OpenAPI 和统一错误响应。
- `GET /api/sessions`、Session 详情、指定 leaf 上下文和会话重命名。
- AgentRegistry：同一 Session 单活跃实例、并发激活锁、空闲超时回收和应用关闭清理。
- `POST /api/agent/new`、Agent 状态和统一命令入口。
- prompt、steer、follow-up、abort、模型、thinking、工具、compaction 和树导航命令。
- SSE 事件流、心跳、多订阅者独立队列、有限事件回放和 `Last-Event-ID` 续传。
- Provider resolver 可注入，ASGI 集成测试完全使用 `FakeProvider`。
- Session 删除会将直接子会话重定向到被删除会话的父节点，再原子更新子会话 header。
- Session merge 对来源独有 entry 生成有界摘要，并作为 `session_merge_summary` custom message
  追加到目标会话；活跃 Agent 会同步刷新上下文。
- Files API 支持目录浏览、UTF-8 文本、图片/音频预览和轮询 SSE 文件变化监听。
- 文件访问只允许已保存 Session 或活跃 Agent 的 cwd；真实路径解析后再次检查边界，并拦截
  `.env`、密钥、凭据和敏感配置目录。
- Models Config 使用原子 JSON 写入；`apiKey` 只允许 `$ENV_VAR` 引用，真实值可从进程环境或
  用户级 `secrets.env` 读取，解析后的密钥不会通过 API 返回。
- Models API 汇总配置模型、默认模型和 thinking level 能力，配置后的 Provider 可直接供
  AgentRegistry 创建实例。
- DeepSeek V4 使用独立 Provider 适配器，支持官方 Chat Completions 流、工具调用、思考开关和
  reasoning effort；Models Config 可一键写入 V4 Flash/Pro、1M 上下文及安全密钥引用。
- Skills API 复用 Coding Agent 的本地发现逻辑，支持诊断展示和
  `disable-model-invocation` 原子切换，并刷新活跃 Agent 的资源。
- 工作区 API 可在受控父目录下创建默认 cwd、登记已有目录并列出允许根目录；Files 和 Skills
  共用同一根目录集合。Web 端提供项目切换弹窗，可复用历史目录、输入受控范围内的新路径或创建
  默认工作区；切换时创建新会话上下文，不会原地修改历史 Session 的 cwd。
- 新会话会持久化初始模型与 thinking level；重新激活会恢复历史 Provider/模型，`set_model`
  支持跨 Provider 原子切换。
- Server 的全局 `agent_dir` 已注入每个 AgentSession，用户级 AGENTS、system prompt、prompts
  与 skills 会进入实际运行链路。

阶段 5 的计划后端能力已经完成。Vue 静态构建托管已在阶段 8 接入；在线 Skills 搜索和安装
仍不属于第一版范围，当前只包含本地发现、启停和加载。

### 阶段 6：Vue 最小纵向界面

已经实现：

- Vue 3、Vite、TypeScript、Pinia 与 Tailwind CSS 4 前端工程，开发服务器将 `/api` 代理到
  本机 FastAPI。
- AppShell、响应式 SessionSidebar、ChatWindow、MessageView 与 ChatInput。
- REST client、统一 API 错误解析、原生 EventSource SSE client 与可测试事件状态机。
- 新建默认工作区、发送首条消息并创建 Session、历史 Session 列表和会话上下文恢复。
- assistant 文本 delta 流式展示、Agent 阶段提示、错误显示、自动滚动和 abort。
- SSE entry ID 去重：刷新或重连后的事件回放不会重复插入已持久化消息。
- 前端单元/组件测试、TypeScript、ESLint 与 Vite 生产构建。

阶段 6 的最小纵向闭环已经完成。Markdown、thinking/tool 详情、模型/工具切换、分支、文件浏览
与配置界面仍按计划属于阶段 7。

### 阶段 7：Web 完整功能（已完成）

7A 消息语义与运行控制已经实现：

- Markdown/GFM 渲染、代码语法高亮，并在 `v-html` 前使用 DOMPurify 清理模型输出。
- thinking 折叠块、tool call 参数与对应 ToolResult 状态/输出展示。
- 运行中的 steer 和 follow-up；输入框可明确选择插入当前回合或排队到下一回合。
- Provider-aware 模型选择、模型能力对应的 thinking level、none/default/full 工具预设。
- 手动 compaction、上下文占用条、自动重试状态和压缩错误反馈。

7B 会话结构与工作区文件已经实现：

- Session 列表解析 `parentSessionId` 并按 Fork 父子层级展示；删除父 Session 后仍沿用后端的
  子 Session 重定向语义。
- BranchNavigator 展示 Session 内的树节点，可定位任意历史节点，并从 assistant 叶节点创建
  持久化 Fork Session。
- Session merge 可从其他 Session 选择来源，把有界摘要追加到当前 Session，并刷新当前上下文。
- 新增 `POST /api/sessions/{id}/fork`，对未知节点和不可持久化分支返回稳定错误码。
- FileExplorer 懒加载工作区目录，过滤与路径边界继续复用后端 FileService；文件面板在较窄视口
  下自动改为覆盖式布局。
- FileViewer 支持 UTF-8 文本与代码高亮、图片和音频预览；TabBar 支持多文件打开、切换、关闭，
  切换工作区时清空旧标签，避免跨根目录误读。

7C 配置、多模态输入与异常 Session 已经实现：

- ModelsConfig 以结构化表单管理 Provider、API 协议、Base URL、环境变量 Key 引用和模型列表；
  保存时保留界面尚未显式编辑的兼容扩展字段。
- SkillsConfig 展示项目级和用户级 Skills、加载诊断和模型可见状态，可安全切换
  `disable-model-invocation` 并刷新活跃 Agent 的资源。
- ChatInput 支持选择或粘贴最多 4 张图片、发送前预览和移除；前后端限制单图 5 MB，校验 MIME
  与 base64，并把图片作为原生 content block 传给 Provider、Session 和消息视图。
- 无有效 Session header 的 JSONL 文件作为 orphan 返回，在侧栏显示“不完整”标记、损坏原因且
  不允许继续运行，不再被静默忽略。
- Pydantic 自定义校验上下文统一转换为 JSON 安全的 422 错误信封。

阶段 7 的参考 Web 核心功能清单已经闭环。下一步进入阶段 8 的本地发布、启动脚本、主题/声音、
进一步可访问性和文档收口。

### 阶段 8：本地发布与收口（实现完成，真实 Provider 验收待执行）

8A 本地生产运行链路已经实现：

- `web/dist` 存在时，FastAPI 在所有 `/api` 路由之后挂载 Vue 静态文件，同源提供页面、资源、
  REST 和 SSE；开发模式仍保留独立 Vite 代理。
- `PI_SERVER_WEB_DIST` 可覆盖静态目录，显式空值可关闭托管，便于纯 API 部署。
- 新增 Windows 开发与生产 PowerShell 入口以及可双击的 `.bat` 包装；默认仅监听
  `127.0.0.1`，生产入口可构建前端后启动单端口服务。
- README 补充开发/生产启动、静态托管和凭据安全说明。
- ASGI 集成测试确认首页与静态资源可访问，同时不会遮蔽 `/api/health`。

8B 交互与验收入口已经实现：

- 深色/浅色主题和完成提示音保存在浏览器本机；声音仅在用户主动启用后播放，不影响 Agent。
- 图片除选择和粘贴外支持拖放，拖入时显示明确的投放区域，仍复用数量、大小和类型校验。
- ModelsConfig 与 SkillsConfig 支持 Escape 关闭、打开后自动聚焦关闭按钮；全站保留键盘焦点样式、
  reduced-motion 和移动端覆盖式布局。消息正文、Markdown 与工具状态使用主题变量，亮色模式保持
  深色文字；用户消息只走单一渲染路径，输入框移除多余的黄色焦点框。
- 新增真实 Provider smoke 脚本，从环境变量或用户级 `secrets.env` 读取密钥，显示 Provider/模型
  但不回显 Key；调用
  必须由用户显式执行，因为会访问真实服务并可能产生费用。

阶段 8 的代码和离线验收已经完成。唯一未执行项是需要用户在本机配置 API Key 后运行的
受控真实 Provider smoke test。

## 当前已知差异

- read 首版仅支持 UTF-8 文本，尚未处理图片。
- grep/find 会忽略 `.git`、`node_modules` 和 `__pycache__`，但尚未完整解析任意 `.gitignore` 规则。
- bash 已处理直接子进程的超时和取消；完整跨平台进程树终止仍需专项验证。
- Provider 请求和 SSE 映射已有完全离线测试，但尚未进行需要 API Key 的受控真实服务 smoke test。
- Models Config 不保存明文 API Key，只接受变量引用；真实值由仓库外的用户级 `secrets.env` 或
  环境变量提供，与参考 Web 允许直接保存字符串的行为不同。
- 原生 Windows 文件夹选择器由 `PI_SERVER_WORKSPACE_PARENT` 下的受控选择接口替代。

## 验证结果

```text
Backend: 110 passed
Frontend: 19 passed; typecheck/lint/build passed
```

包含三层依赖约束、Session、真实 pi fixture、7 个工具、bash 超时/取消、离线 Agent
工具循环、并行/顺序工具调度、自动重试、上下文估算、compaction/溢出恢复、分支摘要/树导航、
Session 用量与成本统计、Skills/模板/项目指令加载、FastAPI Session/Agent API、AgentRegistry 与 SSE
回放、Files 安全边界、Session 删除重定向与 merge、Models Config、Skills 与受控工作区，
以及 Anthropic/OpenAI-compatible
请求与流事件映射测试。全部 Provider 测试均使用
注入的内存 transport，没有访问网络或消耗 API 额度。
