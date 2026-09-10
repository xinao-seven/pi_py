# Node Pi Server

使用 Fastify 和原版 `@earendil-works/pi-coding-agent` SDK 的实际运行后端。

该服务将逐步实现与现有 FastAPI 服务一致的 `/api` REST 与 SSE 协议；Vue 前端可通过
`VITE_BACKEND_URL=http://127.0.0.1:8001` 切换至该服务。

```powershell
cd node-pi/server
npm install
npm run dev
```

本项目的工具审批、Plan 模式与 MCP 工具以**内联扩展**注入每个 Pi Session（闭包直连服务单例），
由 `OriginalPiSessionFactory.loader()` 的 `extensionFactories` 注册；用户级/工作区级文件扩展仍由
SDK 自动发现。接入说明见 [`docs/node-extension-system.md`](../../docs/node-extension-system.md)。

日志输出到 stdout，采用人类可读（pino-pretty）格式，包含请求、错误与启动日志；
级别用环境变量 `PI_NODE_LOG_LEVEL` 控制（`trace|debug|info|warn|error|fatal`，默认 `info`；
`warn` 及以上会屏蔽请求日志）。

本服务还会托管前端构建产物（默认 `../../web/dist`，即 `web/dist`），访问
`http://127.0.0.1:8001/` 即可打开同源界面，非 `/api` 的 GET 会回退到 `index.html`（SPA）；
该目录不存在时仅提供 API。目录可用 `PI_NODE_WEB_DIST_DIR` 覆盖。要开放给局域网其他设备，
启动时设置 `PI_NODE_SERVER_HOST=0.0.0.0` 并放行防火墙端口即可。

**访问密码锁**：设置 `PI_NODE_ACCESS_PASSWORD=<密码>` 后，`/api` 除登录/状态/健康检查外
都需要先登录。前端会弹出密码输入框；登录令牌持久化到 localStorage（刷新保持登录），
可直接构造 URL 访问 API 会被服务端 401 拒绝。未设置该变量则不启用，本地开发不受影响。

**用量与可观测性（M1）**：默认开启，把每次运行的成本、延迟、工具成功率与审批命中率写入
`~/.pi/agent-node-server/platform.db`（不碰 `~/.pi/agent`），由前端「设置 → 用量」展示，
查询接口在 `/api/observability/*`。默认不落对话正文、不落密钥。相关变量：

| 变量                                                 | 默认                             | 说明                                     |
| ---------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| `PI_NODE_TRACE`                                      | `1`                              | `0` 关闭（写操作变空实现，接口返回空集） |
| `PI_NODE_STORE`                                      | `sqlite`                         | `memory` 时整体走内存实现                |
| `PI_NODE_TRACE_DB`                                   | `<PI_NODE_DATA_DIR>/platform.db` | 库文件路径                               |
| `PI_NODE_TRACE_CONTENT`                              | `0`                              | `1` 时额外保留已脱敏正文                 |
| `PI_NODE_TRACE_FLUSH_MS` / `_BATCH` / `_MAX_PENDING` | `250` / `200` / `5000`           | 写入队列参数                             |

完整口径与取舍见 [`docs/node-observability-m1.md`](../../docs/node-observability-m1.md)。

**任务（M2）**：`/api/tasks` 提供任务与步骤的 CRUD（列表/详情/新建/修改/取消/步骤增删改），
写入必须带 `ifRevision`（版本过期返回 `409 task_conflict`），变更通过 SSE `task_updated`
推给相关会话。任务与 trace 共用一个 `platform.db`（同库不同表），因此重启不丢，
`runs.task_id` 可把运行成本关联到任务；任务的持久化与 `PI_NODE_TRACE` 开关无关
（trace 只控制观测明细）。设计说明见 [`docs/node-task-domain-m2.md`](../../docs/node-task-domain-m2.md)。

**断点续跑（M3）**：进程崩溃或重启后，`GET /api/tasks/recovery` 给出**待恢复清单**
（只列不跑），前端面板提示「上次运行被中断」，`POST /api/tasks/:id/resume`（202）可一键继续。
执行期用**租约**防双跑（owner = pid + 启动 id，TTL 30s 自动过期），执行中的动作会写
`execution.inFlight` 并做**副作用分级**：只读可直接继续；写操作若步骤声明了
`verification.kind='file'` 则先验证产物（在就补记完成、绝不重跑），否则必须人工确认
（`confirmSideEffect: true`）。SSE 在会话首个连接时补推 `task_recovery_required`。
设计说明见 [`docs/node-task-recovery-m3.md`](../../docs/node-task-recovery-m3.md)。

**Plan 模式（M4）**：计划是 `origin='plan'` 的**任务**（`PlanView` 是它的只读投影），
由内联扩展注册的五个工具产出与推进：`submit_plan` / `update_plan` / `complete_step` /
`block_step` / `ask_user`。规划期只读（能力分类：只读 + 验证类命令放行，写操作与 MCP 拦截），
步骤完成必须带证据且按声明的 `verification` 校验。命令：
`plan_start/execute/pause/resume/refine/abandon`（`plan_enable/disable` 为弃用别名），
`prompt` 支持 `mode: 'plan'`；SSE `plan_updated` 载荷为 `PlanView`。
契约见 [`docs/node-web-plan-mode.md`](../../docs/node-web-plan-mode.md)，
实现说明见 [`docs/node-plan-mode-m4.md`](../../docs/node-plan-mode-m4.md)。

**子任务委派（M5）**：`SubagentService` 按预设（`~/.pi/agent/agents/*.md` + 项目级
`.pi/agents/`）创建**进程内子会话**，只把摘要 + 用量回传父会话；子会话走 `AgentRegistry`
（审批/trace/任务绑定自动生效），落 `~/.pi/agent-node-server/subagents/`。
三条不变量：不递归是结构保证（到 `maxDepth` 不注册工具）、只读预设真的只读
（子会话工具集 = 预设工具集）、一定要收尾（成功/失败/超预算/取消/停机都 `remove`）。
官方文件扩展 `subagent` 已被内联实现同名接管（`INLINE_OWNED_EXTENSION_DIRS`）。
说明见 [`docs/node-subagent-m5.md`](../../docs/node-subagent-m5.md)。

**MCP 模板库（M4.2）**：`GET /api/mcp/templates` 返回推荐清单（`services/mcp/mcp-templates.ts`，
18 个模板 / 7 组，附 `requiresCredentials` 与 `canAddDirectly`），前端配置页据此一键添加或填入表单。
模板自检 `assertTemplateTable()` 保证：凭据只能是 `$ENV` 引用（env / headers / args 三处都做
spawn 时插值，配置文件里永不落明文）、stdio 必有 command、http 必有 url。
说明见 [`docs/node-mcp-guide.md`](../../docs/node-mcp-guide.md) §3。

**向用户提问（M4.1）**：`ask_user` 是与危险命令审批并列的交互通道——工具挂起、SSE 推送、
前端弹窗回答、答案作为工具返回值回到模型。一次可问多题（单选/多选/自由输入），
超时/取消/会话关闭都有确定结算。契约见 [`docs/node-question-channel.md`](../../docs/node-question-channel.md)。

**评测（M4）**：`npm run eval` 跑离线 golden set（fauxProvider 驱动真实管线，7 个用例）
并给出 pass@1 / 计划一次通过率 / 零残留旧标记三项门禁，CI 的 `eval` job 直接调用。
