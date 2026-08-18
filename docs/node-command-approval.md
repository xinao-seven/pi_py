# Node 后端细化命令审批

更新日期：2026-08-18

## 目标

Pi 的 `bash` 工具能够执行任意系统命令。原有实现仅在少数“危险命令”上暂停，这对删除和格式化足够，
但不能让用户区分“项目写入”“依赖变更”“网络访问”和“远端 Git 写入”等不同副作用。

新的策略仍保持普通只读检查（如 `ls`、`find`、`git log`）不被打断，同时为需要确认的命令附加
风险级别和影响分类，前端可在授权前展示更完整的上下文。

## 策略层级

`node-pi/server/extensions/tool-approval.ts` 的 `classifyBashCommand()` 以以下顺序评估命令：

| 优先级 | 例子 | 风险 | 分类 | 行为 |
| --- | --- | --- | --- | --- |
| 1 | 递归删除、格式化、关机、强制推送、远程脚本直管道执行 | `critical` | `destructive` / `system` / `git_remote` / `network` | 必须确认 |
| 2 | `git push`、依赖安装/升级/发布 | `high` | `git_remote` / `dependency_change` | 必须确认 |
| 3 | `curl`、`wget`、Shell 重定向、`tee` | `medium` | `network` / `workspace_write` | 必须确认 |
| 4 | `ls`、`find`、`git log` 等纯读取检查 | — | — | 直接执行 |

危险规则优先于敏感规则，确保 `git push --force` 一直显示为 `critical`，不会被一般的 Git 远端规则
降级。规则应以保守的“需要确认”方式扩展；新规则必须同时新增命中和普通命令放行测试。

## 事件和状态流

```text
bash tool_call
  → classifyBashCommand()
  → pi:tool_approval:pending
  → ToolApprovalBroker（唯一的挂起/超时状态）
  → SSE tool_call_pending { rule, risk, category, ... }
  → ToolApprovalDialog
  → POST /api/agent/:sessionId { type: "approve_tool", approved }
  → pi:tool_approval:decide
  → 扩展放行或阻断工具调用
```

`risk` 为 `medium`、`high` 或 `critical`；`category` 为 `workspace_write`、
`dependency_change`、`network`、`git_remote`、`destructive` 或 `system`。它们是扩展、
服务端、SSE 与前端之间的契约，修改时必须同步更新所有层和契约测试。

审批中枢仍默认在 30 秒后拒绝。用户拒绝、超时、AbortSignal、会话删除和服务关闭均按拒绝结算；
扩展不能自行保存审批队列，避免会话重载后出现无法清理的等待项。

## 如何新增规则

1. 优先判断命令是否可被安全视作只读；若是，不加规则。
2. 危及数据或系统的规则加入 `DANGEROUS_COMMAND_RULES`；其他明确副作用加入
   `SENSITIVE_COMMAND_RULES`，并给出简明的中文原因、风险和分类。
3. 在 `test/services/tool-approval.test.ts` 中同时测试分类、允许、拒绝、超时或中止路径。
4. 若新增分类或风险级别，更新 `PendingToolApproval`、`StreamEvent`、前端 `PendingToolCall` 和本文件。
