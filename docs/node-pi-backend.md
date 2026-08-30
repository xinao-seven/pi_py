# Node.js + 原版 Pi 后端

`node-pi/server/` 使用 Fastify 与原版 `@earendil-works/pi-coding-agent` SDK，作为实际使用的后端。现有 Python/FastAPI 后端（`pi-python/`）继续保留为复刻与学习实现；两者通过同一套 `/api` REST/SSE 协议服务 Vue 前端。

## 已实现

- 原版 Pi Session：新建、提示词、steer、follow-up、停止、模型/思考级别/工具切换、压缩与树导航。
- 图片输入：最多 4 张、单张最大 5 MB，以 `image/*` Base64 content block 直接交给 Pi，不落盘。
- SSE：支持 `Last-Event-ID` 回放和 15 秒心跳。
- 历史会话：扫描 `~/.pi/agent/sessions`；查看、发送命令或订阅事件时按需恢复，不会启动时全部载入内存。
- 分支：`POST /api/sessions/{sessionId}/fork` 使用原版 Pi 的 `createBranchedSession` 创建持久化分支。
- 会话合并：`POST /api/sessions/{sessionId}/merge` 将来源会话的独有内容写为有上限、可审计的自定义摘要条目；不额外调用模型。
- 会话元数据：`PATCH /api/sessions/{sessionId}` 重命名；`DELETE /api/sessions/{sessionId}` 停止活动会话、重定向子会话父引用后删除持久化文件。
- 模型目录：离线读取原版 Pi 的模型和认证配置；不将凭据返回给浏览器。
- 工作区：兼容 Vue 现有的 home、workspace 列表与默认工作区接口；用户可显式登记任意已有本地目录，并在 Node 服务重启后复用。新增 `POST /api/workspaces/pick`，在用户点击 UI 按钮时打开 Windows 系统目录选择器。
- 文件面板：目录浏览、UTF-8 文本预览和图片/音频预览；仅允许已注册工作区，且屏蔽 `.env`、凭据、密钥和大型生成目录。
- 模型配置：`GET/PUT /api/models-config` 读取和原子写入原版 Pi 的 `models.json`；密钥只能是 `$ENV_VAR` 引用，保存后刷新新建会话使用的模型运行时。
- Skills：`GET/PATCH /api/skills` 使用原版 Pi 的 Skills 发现逻辑，并支持切换 `disable-model-invocation` 后重载活动会话资源。
- 会话预设：`~/.pi/agent/node-server-presets.json` 存储自定义预设（系统提示词、工具、压缩策略、默认模型与思考等级）。
  预设支持 MCP 服务白名单 `mcpServers`：`null`/缺省 = 使用全部已配置的 MCP 服务，`[]` = 禁用，
  非空数组 = 只注入名单内 server 的工具（`POST /api/agent/new` 也可直接传 `mcpServers`）。
  白名单只影响注入会话的工具集合；MCP 连接池与工具名映射始终按全量配置维护，不同预设的会话互不污染。
- MCP 列表接口：`GET /api/mcp/servers?cwd=<工作区>` 返回合并配置与实时连接状态；
  省略 `cwd` 时只返回用户级配置（状态为新增的 `idle`，表示"仅配置、未建立连接"），
  供预设编辑等没有工作区上下文的界面选择 MCP 白名单。

## 工具审批

Node 后端通过原版 Pi 的 inline extension 在 Bash 命令命中高风险规则时拦截执行（例如递归删除、格式化磁盘、关机、强制 Git 推送或远程脚本直管道执行）。`find`、`ls`、`git log` 等普通检查命令不会中断。服务向 SSE 推送 `tool_call_pending`，Vue 已有确认弹窗会通过 `approve_tool` 决定是否执行。审批 30 秒后超时拒绝；拒绝、会话中止和服务关闭也都会拒绝。该服务默认仅监听 loopback；若要部署到网络环境，仍须在反向代理前配置鉴权与限流。

## Plan 模式

聊天输入框上方的 **开启 Plan 模式** 可把当前会话切换到只读规划期；用户接着在同一个输入框发送需求，
Agent 只能调查和讨论，生成 `Plan:` 后必须由用户确认才会恢复写入能力并顺序执行。步骤进度由 Agent 的
`[DONE:n]` 标记驱动，模式与步骤随会话 JSONL 恢复。接口为 `GET /api/agent/:sessionId/plan` 和统一 Agent 命令中的 `plan_*`，状态也会以
`plan_updated` SSE 推送。详见 [`node-web-plan-mode.md`](node-web-plan-mode.md)。

## 启动

```powershell
cd node-pi/server
npm install --ignore-scripts
npm run typecheck
npm run test
npm run dev
```

默认监听 `127.0.0.1:8001`。开发时可运行：

```powershell
.\scripts\start-node-dev.ps1
```

该脚本会启动 Node 服务和 Vue 开发服务器，并以 `VITE_BACKEND_URL=http://127.0.0.1:8001` 将 `/api` 代理到 Node 服务。
脚本会先等待 Node 的 `/api/health` 成功后再启动 Vite；若 8001 被占用或 Node 未能启动，会直接输出错误，而不会启动一个连接不到后端的前端。
