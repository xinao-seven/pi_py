# Python 三层架构

本项目按 pi 的核心三件套组织为三个可独立导入的 Python 包。设计依据包括
本地 `E:\code\pi\packages` 源码，以及
[三层架构解析](https://dg-ai-notes.pages.dev/modules/ch02-three-layer-arch/)。

## 依赖方向

```text
pi_ai（底层：模型原子类型和 Provider）
  ↑                    ↑
  │                    │
pi_agent（中层：通用 Agent loop、状态、事件和可执行工具抽象）
  ↑                    │
  └──── pi_coding_agent（顶层：Session、文件工具和 Coding Agent 组装）
```

硬性规则：

- `pi_ai` 不得导入 `pi_agent` 或 `pi_coding_agent`。
- `pi_agent` 可以导入 `pi_ai`，不得导入 `pi_coding_agent`。
- `pi_coding_agent` 可以同时导入 `pi_agent` 和 `pi_ai`。
- FastAPI 和 Vue 属于应用层，位于 `pi_coding_agent` 之上。

## pi_ai

对应 `E:\code\pi\packages\ai`，负责“如何统一调用不同模型”：

```text
src/pi_ai/
├── types.py                 # Message、Model、Tool 原子类型
└── providers/
    ├── base.py              # LLMProvider streaming protocol
    ├── transport.py         # 可注入的 HTTP SSE 边界
    ├── anthropic.py         # Anthropic Messages 映射
    ├── openai_compatible.py # OpenAI Chat Completions 兼容映射
    ├── registry.py          # Provider 注册与显式配置入口
    └── fake.py              # 离线 Agent 测试 Provider
```

这一层不知道 Agent loop、Session 和文件工具的存在。真实 Provider 把厂商消息与 SSE
事件转换为统一字典协议；测试通过注入内存 transport 验证映射，不需要真实 API Key。

## pi_agent

对应 `E:\code\pi\packages\agent`，负责“如何让模型与工具循环工作”：

```text
src/pi_agent/
├── types.py                 # AgentTool、ToolResult、执行策略
├── events.py                # AgentEvent
├── tool_registry.py         # 通用工具注册和启停
├── agent_loop.py            # Provider → tool → Provider 循环
└── agent.py                 # 公共 Agent API
```

这一层不包含 read、bash、edit 等具体工具，也不决定 Session 如何写入磁盘。为了允许
上层接入持久化，loop 只接受结构化的 `TranscriptStore` 协议，不引用其实现。

## pi_coding_agent

对应 `E:\code\pi\packages\coding-agent`，负责“如何组装一个编程助手”：

```text
src/pi_coding_agent/
├── agent_session.py         # Agent + SessionManager + coding tools
├── core/
│   └── session_manager.py   # pi Session v3 JSONL
└── tools/
    ├── read/write/edit/ls（当前集中在 file_tools.py）
    ├── grep/find
    ├── bash
    └── paths.py
```

system prompt、Skills、compaction、重试、配置和 FastAPI bridge 等编程助手业务能力，
后续都进入这一层，而不是放回通用 `pi_agent`。

## 类型递进

```text
pi_ai.Tool
  name + description + input_schema
        ↓
pi_agent.AgentTool
  + label + execute + execution_mode
        ↓
pi_coding_agent concrete tools
  + 文件系统行为、路径边界、输出格式和业务说明
```

这种组织允许：只使用 `pi_ai` 调模型；使用 `pi_ai + pi_agent` 构建非编程 Agent；或者
使用三层得到完整 Coding Agent。
