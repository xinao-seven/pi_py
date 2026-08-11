# 项目开发规范

更新日期：2026-08-11

本规范适用于 pi-agent-python 的全部代码、测试与文档改动。核心原则：

> **学习性复刻必须能对照原版 pi 的行为，新增代码必须能通过测试，文档必须与代码一致。**

## 1. 项目定位与参考基线

- 用 Python + FastAPI + Vue 3 **学习性复刻** pi coding agent 与 Pi-Agent-Web，
  目标是结构清晰、可逐层测试的全栈 Coding Agent，而不是逐行翻译 TypeScript。
- 参考基线固定为 pi `dd6bea41`、Pi-Agent-Web `664f5a9c`（见
  [`docs/implementation-plan.md`](implementation-plan.md)）。参考仓库更新时，
  先记录新提交号与兼容差异，再决定是否跟进，避免基线漂移。
- 分层与依赖方向见 [`docs/three-layer-architecture.md`](three-layer-architecture.md)，
  这是**硬性约束**，由 `tests/unit/test_architecture.py` 校验：
  - `pi_ai` 不得导入 `pi_agent` / `pi_coding_agent`
  - `pi_agent` 不得导入 `pi_coding_agent`
  - FastAPI（`server/`）与 Vue（`web/`）位于 `pi_coding_agent` 之上

## 2. 目录结构

```text
src/pi_ai/            # 底层：模型原子类型、Provider（anthropic/openai/deepseek/fake）
src/pi_agent/         # 中层：通用 Agent loop、事件、工具抽象
src/pi_coding_agent/  # 顶层：Session v3、Coding Agent 组装、资源加载、工具实现
server/               # FastAPI 应用层：routes（薄）→ services（逻辑）→ errors（统一错误）
web/                  # Vue 3 + Vite + Pinia 前端
tests/                # unit（纯逻辑）/ integration（ASGI 全链路）/ compat（pi fixture）
scripts/              # 启动与验证脚本（.ps1 / .bat / .py）
docs/                 # 架构、计划、实施状态等文档
```

新增代码按职责落入对应层；**禁止**在 `server/routes/` 中堆业务逻辑。

## 3. 编码规范

### 3.1 Python

- 文件头写英文 docstring 概述，随后一行 `中文说明：...` 补充用途；模块内新增类
  也保留这一模式，中文注释解释“为什么”，代码本身表达“是什么”。
- 使用 `from __future__ import annotations` 与完整类型注解；优先 `dataclass`；
  只读数据结构加 `frozen=True, slots=True`。
- 服务层类放在 `server/services/`，每个文件一个核心类；路由通过
  `Depends(request.app.state.xxx)` 取服务，保持薄路由。
- 业务错误抛 `server.errors.APIError(status, code, message)`（机器码用 snake_case）；
  配置/输入类错误用 `ValueError` 子类，由路由统一转 APIError。
- 不引入未使用 import；不做未在测试中覆盖的“顺手优化”。

### 3.2 TypeScript / Vue

- 组件统一 `<script setup lang="ts">` + 组合式 API。
- 类型集中在 `web/src/types/index.ts`；API 调用统一走 `web/src/lib/api.ts`
  （统一错误解析为 `ApiError`）。
- 状态管理用 Pinia（`web/src/stores/`）；组件间共享状态不直接 props 深传。

## 4. 配置与安全规范（重要）

### 4.1 原版 pi 的 `~/.pi/agent` 只读

pi.py 直接复用原版 pi 的用户配置，**一律只读，绝不创建/改写**，避免影响原版 pi：

| 文件 | 用途 | 读取入口 |
|------|------|----------|
| `auth.json` | API Key（`/login` 写入） | `PiConfig.resolve_api_key()` |
| `settings.json` | 默认 Provider / 模型 / 思考档位 | `PiConfig.read_settings()` |
| `models.json` | 用户自定义 Provider 覆盖 | `PiConfig.read_models()` |
| `models-store.json` | 内置模型缓存目录 | `PiConfig.read_models_store()` |

- 密钥与 pi 的设置**不通过环境变量获取**；部署覆盖只允许纯 infra 变量
  （会话目录、CORS、超时、静态前端目录等，见 `server/config.py`）。
- 模型目录合并顺序：`models-store.json` → pi `models.json` → pi.py 自身覆盖，
  Provider 级字段后者覆盖前者，模型按 `id` 合并（见 `ModelConfigService._merged_providers`）。

### 4.2 pi.py 自身可写配置隔离在 `~/.pi/agent-python/`

- `models.json`：Web“模型配置”界面写入（`apiKey` 只允许 `$ENV_VAR` 引用）。
- `workspaces.json`：手动登记的工作区（原子写入，损坏自动降级为内存模式）。
- 该目录在用户真正写入前**不应被创建**；测试不得触碰真实 `~/.pi`。

### 4.3 密钥安全

- 任何 API 响应**不得包含真实密钥**；自身配置只保存 `$ENV_VAR` 引用。
- `$DEEPSEEK_API_KEY` 这类引用按 `auth.json` 的 key 名映射解析
  （`DEEPSEEK_API_KEY → deepseek`），不读进程环境变量。
- 不要把 `.env`、`secrets.env`、凭据文件放进 Session 工作区；Files API 的敏感文件
  拦截清单新增敏感类型时要同步更新测试。

### 4.4 危险命令人工确认

- 所有 `bash` 工具调用在**执行前**经过 `ToolApprovalGate`（`server/services/tool_approval.py`）：
  命中 `DANGEROUS_RULES` 黑名单（递归删除、格式化、关机、提权删除、强制推送、
  批量卸载、远程脚本管道执行等）时广播 `tool_call_pending` 事件并**挂起**执行，
  等待 `approve_tool` 命令给出允许/拒绝。
- 拒绝/超时（默认 60 秒）按“拒绝”处理，工具不执行，结果归一化为 `isError` 的
  toolResult 交给模型；Agent 被中止或注册项关闭时未确认项一律按拒绝清理。
- 新增危险规则必须同步 `DANGEROUS_RULES` 与 `tests/unit/test_tool_approval.py` 的
  命中/放行用例；集成测试用 `FakeProvider` + 真实 `Remove-Item` 验证允许/拒绝两侧。
- 前端收到 `tool_call_pending` 弹出 `ToolApprovalDialog`（`web/src/components/`），
  允许/拒绝通过 `approve_tool` 命令下发；事件流保持 `pi_agent` 层的
  `ToolApprover` 协议通用（不感知具体规则）。

## 5. 测试规范

- 后端：`tests/unit/`（纯逻辑）+ `tests/integration/`（ASGI 全链路，注入
  `FakeProvider`，绝不访问网络）。
- 前端：`web/src/**/*.test.ts`（vitest）+ typecheck + lint + build。
- **改动必须附带测试**；集成测试的 `ServerSettings` 必须隔离 `agent_dir` /
  `own_config_dir` / `sessions_dir` 到 `tmp_path`，防止污染真实 `~/.pi`。
- 提交前必须全部通过：

```powershell
# 后端（项目根目录）
python -m pytest

# 前端（web/ 目录）
npm run typecheck
npm run lint
npm run test
npm run build
```

## 6. 提交信息规范

遵循 Conventional Commits，`type` ∈ `feat / fix / docs / refactor / test / chore`，
描述用中文（可附英文），必要时加 `scope`：

```text
feat: 复用原版 pi 的 ~/.pi 配置并隔离 pi.py 自身配置
docs:更新项目文档
fix(agent):修复模型切换后上下文窗口未刷新
test(models):补充 auth.json 密钥解析用例
```

- **一个提交只做一件事**；代码与文档分开提交，便于回溯。
- 提交前自查：`git status` 只包含本提交相关文件；`docs/implementation-status.md`
  的行为描述与代码一致。

## 7. 文档规范

- `README.md` 是唯一入口，负责快速上手；细节放 `docs/`，README 只放链接。
- 行为变化必须同步更新 README 与 `docs/implementation-status.md`；文档用中文，
  路径、命令、代码标识用英文原文。
- 新增文档先说明“为什么”（复刻参考、设计取舍），再给“怎么做”。
