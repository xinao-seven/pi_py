# Pi 桌面助手（uTools 插件）

把本地 Pi coding agent（`node-pi/server` 后端 + `web` 前端）接入 uTools 关键词面板。

- 前端：复用 `web` 的完整三栏 IDE（会话侧栏 / 流式聊天 / 文件面板），打包产物已内置。
- 后端：`preload.js` 自动探测并拉起 `node-pi/server`（Fastify + 原版 Pi SDK），监听 `127.0.0.1:8001`。
- 通信：REST + SSE，跨域已由 node-pi/server 的 `@fastify/cors` 放行。

## 前置条件

1. `node-pi/server` 已 `npm install` 且 `npm run build`（需产出 `node-pi/server/dist/server.js`）。
2. Pi 的 API Key 已配置（原版 pi 的 `~/.pi/agent/auth.json`，`node-pi/server` 会复用）。

## 安装到 uTools

1. 打开 uTools 开发者工具 → 新建项目 → 选择本目录的 `plugin.json` → 接入开发。
2. 唤起 uTools（Alt+Space），输入 `pi`（或 `ai` / `ai助手`）进入面板。
3. 首次进入会自动启动后端；若后端路径不对，编辑配置（见下）。

## 后端配置

首次运行会在 `%USERPROFILE%\.pi\agent\utools-config.json` 生成：

```json
{
  "serverDir": "D:/code/pi_py/node-pi/server",
  "port": 8001
}
```

- `serverDir`：node-pi/server 目录（须含 `dist/server.js`）。
- `port`：后端端口（默认 8001，与前端注入的地址一致）。

## 重新构建（web 前端改动后）

```powershell
.\build.ps1
```

脚本会以 `UTOOLS_BUILD=1` 构建 web 的 uTools 变体（相对资源路径），并拷贝产物到本目录。

## 说明

- 本插件是**纯前端**：所有 agent 逻辑都在本地 node-pi/server 进程，uTools 面板关闭不丢会话（会话持久化在 `~/.pi/agent/sessions/`）。
- 危险命令执行前仍会弹确认框（沿用 node-pi/server 的工具审批机制）。
