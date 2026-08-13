# Agent 内核 Python 复刻方案

## 1. 目标

用 Python 复刻 `@earendil-works/pi-coding-agent` 的核心能力，支持 2-3 个特定 LLM Provider，实现与现有 Web UI 完全兼容的 Agent 引擎。

## 2. 范围

### 2.1 支持的功能

| 功能 | 说明 |
|------|------|
| Agent 主循环 | prompt → LLM → tool_call → execute → 循环（流式） |
| steer / followUp | 运行中注入消息 / 排队消息 |
| abort | 中断当前运行 |
| 工具系统 | read / bash / edit / write / grep / find / ls |
| 工具切换 | 运行时启用/禁用工具（三档预设：关闭/默认/全部） |
| thinking level | auto / off / minimal / low / medium / high / xhigh |
| 模型切换 | 运行时切换模型 |
| fork | 从任意消息分叉出新 session |
| navigate_tree | 同文件内分支跳转 |
| compact | 上下文压缩（调用 LLM 生成摘要） |
| auto-compaction | 上下文溢出自动压缩 |
| auto-retry | rate limit / 服务器错误自动重试 |
| Session 持久化 | .jsonl 文件读写，兼容现有格式 |
| System prompt | 工具列表 + guidelines 动态构建 |
| Skills 加载 | 从 `.agents/skills/` 目录加载 |
| Prompt Templates | 文件模板展开 |
| 上下文用量 | 实时查询 token 用量 |
| Session 统计 | 累计 token 数 + 费用 |

### 2.2 不支持的功能

| 功能 | 原因 |
|------|------|
| 多 Provider 抽象层 | 只适配 2-3 个特定 Provider |
| Extension 系统 | 复杂度高，Web UI 未使用 |
| TUI 交互模式 | 不属于 Web 场景 |
| Project Trust 确认 | Web 场景由前端确认替代 |
| OAuth 认证流程 | 只用 API Key |

## 3. 项目结构

```
pi_agent/
├── __init__.py
├── pyproject.toml
│
├── core/
│   ├── __init__.py
│   ├── agent_session.py      # Agent 主循环（核心）
│   ├── session_manager.py    # .jsonl 读写 + fork/navigate/compact
│   ├── session_context.py    # buildSessionContext (compaction 裁剪)
│   ├── system_prompt.py      # System prompt 构建
│   ├── compaction.py         # 上下文压缩（LLM 摘要生成）
│   ├── retry.py              # 自动重试逻辑
│   └── skills.py             # Skills 加载
│
├── providers/
│   ├── __init__.py
│   ├── base.py               # Provider 抽象基类
│   ├── anthropic.py          # Anthropic (Claude Sonnet/Opus)
│   ├── openai.py             # OpenAI (GPT-4o/o3/o4-mini)
│   └── deepseek.py           # DeepSeek (V3/R1)  [可选]
│
├── tools/
│   ├── __init__.py
│   ├── registry.py           # 工具注册表
│   ├── bash.py               # 命令执行
│   ├── read.py               # 文件读取
│   ├── edit.py               # 精确文本替换
│   ├── write.py              # 文件写入
│   ├── grep.py               # 内容搜索
│   ├── find.py               # 文件名搜索
│   └── ls.py                 # 目录列表
│
└── events.py                 # 事件类型定义
```

## 4. 核心模块设计

### 4.1 Provider 抽象层（~400 行）

```python
# providers/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Any

@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str | list[dict]
    tool_call_id: str | None = None
    tool_calls: list[dict] | None = None

@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]

class LLMProvider(ABC):
    """Provider 抽象基类。每个 Provider 只需实现 5 个方法。"""
    
    @abstractmethod
    async def stream(
        self,
        model: str,
        messages: list[Message],
        tools: list[ToolDefinition],
        thinking_level: str,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        """流式调用 LLM，yield 增量事件:
        - {"type": "text_delta", "text": "..."}
        - {"type": "thinking_delta", "text": "..."}
        - {"type": "tool_call_start", "id": "...", "name": "...", "index": N}
        - {"type": "tool_call_delta", "id": "...", "arguments": "..."}
        - {"type": "done", "usage": {...}}
        """
        ...
    
    @abstractmethod
    def count_tokens(self, messages: list[Message], model: str) -> int:
        """估算 token 数（用于上下文溢出检测）"""
        ...
    
    @abstractmethod
    def supports_thinking(self, model: str) -> list[str]:
        """返回该模型支持的 thinking level 列表"""
        ...
```

**为什么只有 3 个抽象方法：**
- 流式调用由 Provider SDK 原生支持（`anthropic.AsyncAnthropic` / `openai.AsyncOpenAI`）
- token 计数可直接用 SDK 的 tokenizer 或用字符数估算
- thinking 支持是静态配置，不需要运行时发现

### 4.1.1 Anthropic Provider（~120 行）

```python
# providers/anthropic.py
class AnthropicProvider(LLMProvider):
    THINKING_LEVELS = {
        "auto": None,           # 不传 thinking 参数
        "off": {"type": "disabled"},
        "minimal": {"type": "enabled", "budget_tokens": 1024},
        "low": {"type": "enabled", "budget_tokens": 2048},
        "medium": {"type": "enabled", "budget_tokens": 4096},
        "high": {"type": "enabled", "budget_tokens": 8192},
        "xhigh": {"type": "enabled", "budget_tokens": 16384},
    }
    
    async def stream(self, model, messages, tools, thinking_level, system_prompt=None):
        thinking = self.THINKING_LEVELS.get(thinking_level)
        # 直接用 anthropic SDK 的 streaming API
        async with self.client.messages.stream(
            model=model,
            system=system_prompt or "",
            messages=self._convert_messages(messages),
            tools=self._convert_tools(tools),
            thinking=thinking,
            max_tokens=16384,
        ) as stream:
            async for event in stream:
                yield self._convert_event(event)
```

### 4.1.2 OpenAI Provider（~120 行）

```python
# providers/openai.py
class OpenAIProvider(LLMProvider):
    REASONING_EFFORT = {
        "auto": None,
        "off": None,              # 非 reasoning 模型不支持
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": None,            # OpenAI 没有 xhigh，回退到 high
    }
    
    async def stream(self, model, messages, tools, thinking_level, system_prompt=None):
        # reasoning 模型 (o3/o4-mini) vs 非 reasoning (GPT-4o) 处理不同
        is_reasoning = model.startswith("o3") or model.startswith("o4")
        ...
```

### 4.2 Agent 主循环（~600 行）

```python
# core/agent_session.py
class AgentSession:
    """
    Agent 生命周期管理。
    事件通过 async generator 流式输出，或通过回调订阅。
    """
    
    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        cwd: str,
        session_manager: SessionManager,
        tools: list[str] | None = None,
        thinking_level: str = "auto",
    ):
        self.provider = provider
        self.model = model
        self.cwd = cwd
        self.session = session_manager
        self.tool_registry = ToolRegistry(cwd)
        self.thinking_level = thinking_level
        
        # 运行时状态
        self._is_streaming = False
        self._abort_requested = False
        self._steer_queue: list[str] = []
        self._followup_queue: list[str] = []
        self._retry_count = 0
        self._listeners: list[callable] = []
    
    # ── 公共 API ──
    
    async def prompt(self, message: str, images=None) -> AsyncIterator[dict]:
        """发送用户消息，流式返回事件。"""
        ...
    
    async def steer(self, message: str):
        """运行中注入消息。"""
        ...
    
    async def follow_up(self, message: str):
        """运行完成后排队消息。"""
        ...
    
    async def abort(self):
        """中断当前运行。"""
        ...
    
    def set_model(self, model: str):
        """切换模型。"""
        ...
    
    def set_thinking_level(self, level: str):
        """切换推理深度。"""
        ...
    
    def set_active_tools(self, tool_names: list[str]):
        """启用/禁用工具。"""
        ...
    
    async def compact(self, custom_instructions=None) -> dict:
        """手动压缩上下文。"""
        ...
    
    def get_context_usage(self) -> dict:
        """获取当前上下文窗口用量。"""
        ...
    
    def get_session_stats(self) -> dict:
        """获取 session 统计（累计 token + 费用）。"""
        ...
    
    def subscribe(self, listener: callable):
        """订阅事件。"""
        ...
    
    # ── 内部方法 ──
    
    async def _run_agent_turn(
        self, user_message: str, images=None
    ) -> AsyncIterator[dict]:
        """Agent 主循环：prompt → LLM → tool_call → execute → 循环"""
        
        self._is_streaming = True
        self._abort_requested = False
        
        # 1. 构建消息列表
        messages = self._build_messages(user_message, images)
        
        # 2. 写入用户消息到 session 文件
        entry_id = self.session.append_message("user", user_message)
        yield {"type": "message_start", "role": "user", "entryId": entry_id}
        yield {"type": "message_end", "role": "user", "entryId": entry_id}
        
        while True:
            # 3. 检查 abort
            if self._abort_requested:
                yield {"type": "agent_end", "aborted": True}
                break
            
            # 4. 检查上下文溢出 → auto-compaction
            if self._should_auto_compact(messages):
                compact_result = await self._auto_compact(messages)
                yield {"type": "compaction_start", "reason": "overflow"}
                messages = compact_result["messages"]
                yield {"type": "compaction_end", "result": compact_result}
            
            # 5. 调用 LLM
            assistant_msg = None
            tool_calls = []
            
            yield {"type": "agent_start"}
            
            try:
                async for event in self.provider.stream(
                    model=self.model,
                    messages=messages,
                    tools=self.tool_registry.get_definitions(),
                    thinking_level=self.thinking_level,
                    system_prompt=self._build_system_prompt(),
                ):
                    if self._abort_requested:
                        break
                    
                    if event["type"] == "text_delta":
                        yield {"type": "message_update", "delta": event}
                    elif event["type"] == "thinking_delta":
                        yield {"type": "message_update", "thinking": event}
                    elif event["type"] == "tool_call_start":
                        tool_calls.append(event)
                        yield {"type": "tool_execution_start", ...}
                    elif event["type"] == "done":
                        assistant_msg = event["message"]
                
                # 6. 写入 assistant 消息到 session
                entry_id = self.session.append_message("assistant", assistant_msg)
                yield {"type": "message_end", "entryId": entry_id, "message": assistant_msg}
                
            except RetryableError as e:
                if self._retry_count < self._max_retries:
                    self._retry_count += 1
                    yield {"type": "auto_retry_start", "attempt": self._retry_count, ...}
                    await asyncio.sleep(self._retry_delay)
                    continue  # 重试
                else:
                    yield {"type": "agent_end", "error": str(e)}
                    break
            
            # 7. 没有 tool calls → 对话结束
            if not tool_calls:
                # 检查 follow-up 队列
                if self._followup_queue:
                    next_msg = self._followup_queue.pop(0)
                    messages.append({"role": "user", "content": next_msg})
                    continue
                
                yield {"type": "agent_end"}
                break
            
            # 8. 执行 tool calls
            for tc in tool_calls:
                yield {"type": "tool_execution_start", ...}
                result = await self.tool_registry.execute(tc)
                yield {"type": "tool_execution_end", ...}
                
                # 写入 tool_result 到 messages
                messages.append({"role": "tool", "content": result, "tool_call_id": tc["id"]})
                
                # 写入 tool_result 到 session 文件
                self.session.append_message("toolResult", {
                    "toolCallId": tc["id"],
                    "content": result,
                })
            
            # 9. 检查 steer 队列（在下一个 LLM 调用前注入）
            if self._steer_queue:
                steer_msg = self._steer_queue.pop(0)
                messages.append({"role": "user", "content": f"[steer] {steer_msg}"})
                
            # 回到步骤 3，继续循环
            
        self._is_streaming = False
    
    def _should_auto_compact(self, messages: list) -> bool:
        """检查是否需要自动压缩（上下文超过窗口 80%）。"""
        token_count = self.provider.count_tokens(messages, self.model)
        context_window = self._get_context_window()
        return token_count > context_window * 0.8
    
    async def _auto_compact(self, messages: list) -> dict:
        """自动压缩：调用 LLM 生成摘要，裁剪历史。"""
        ...
    
    def _build_messages(self, user_message: str, images=None) -> list:
        """构建消息列表：system prompt + 压缩后的历史 + 新用户消息。"""
        ...
    
    def _build_system_prompt(self) -> str:
        """动态构建 system prompt：工具列表 + guidelines + skills。"""
        ...
```

### 4.3 Session 持久化（~400 行）

```python
# core/session_manager.py
class SessionManager:
    """
    .jsonl 文件读写，兼容 pi 现有格式。
    
    文件格式：
    {"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"..."}
    {"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
    ...
    """
    
    def __init__(self, file_path: str = None, cwd: str = None):
        self.file_path = file_path
        self.cwd = cwd
        self.entries: list[dict] = []
        self._header: dict | None = None
        
        if file_path and os.path.exists(file_path):
            self._load()
    
    def _load(self):
        """从 .jsonl 文件加载所有 entries。"""
        with open(self.file_path, "r") as f:
            for line in f:
                entry = json.loads(line)
                self.entries.append(entry)
                if entry.get("type") == "session":
                    self._header = entry
    
    def _save(self):
        """保存所有 entries 到 .jsonl 文件。"""
        os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
        with open(self.file_path, "w") as f:
            for entry in self.entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    
    def append_message(self, role: str, content) -> str:
        """
        追加消息到文件。
        返回 entry_id。
        """
        entry_id = _generate_id()
        parent_id = self._get_leaf_id()
        
        entry = {
            "type": "message",
            "id": entry_id,
            "parentId": parent_id,
            "timestamp": datetime.now().isoformat(),
            "message": {"role": role, "content": content},
        }
        self.entries.append(entry)
        self._save()
        return entry_id
    
    def fork(self, entry_id: str) -> str:
        """从指定 entry 分叉出新 session 文件，返回新文件路径。"""
        ...
    
    def navigate_tree(self, target_id: str) -> list[dict]:
        """在同一文件内跳转到指定 entry 的分支。"""
        ...
    
    def get_entries(self) -> list[dict]:
        """获取所有 entries。"""
        return self.entries
    
    def get_tree(self) -> list[dict]:
        """构建 entry 树结构。"""
        ...
    
    def get_leaf_id(self) -> str | None:
        """获取当前叶子节点 ID。"""
        ...
    
    @staticmethod
    def create(cwd: str, sessions_dir: str = None) -> "SessionManager":
        """创建新 session 文件。"""
        ...
    
    @staticmethod
    def open(file_path: str) -> "SessionManager":
        """打开已有 session 文件。"""
        ...
    
    @staticmethod
    def list_all(sessions_dir: str) -> list[dict]:
        """列出所有 session。"""
        ...


def build_session_context(
    entries: list[dict],
    leaf_id: str | None = None,
) -> dict:
    """
    构建指定 leaf 的会话上下文。
    处理 compaction 裁剪、branch summary 注入。
    """
    ...
```

### 4.4 事件系统（~80 行）

```python
# events.py
"""事件类型定义 - 与 pi 的事件格式兼容。"""

class AgentEvent:
    """事件基类"""
    pass

@dataclass
class AgentStartEvent(AgentEvent):
    type: str = "agent_start"

@dataclass
class AgentEndEvent(AgentEvent):
    type: str = "agent_end"
    aborted: bool = False
    error: str | None = None

@dataclass
class MessageStartEvent(AgentEvent):
    type: str = "message_start"
    role: str
    entry_id: str

@dataclass
class MessageUpdateEvent(AgentEvent):
    type: str = "message_update"
    delta: dict | None = None
    thinking: dict | None = None

@dataclass
class MessageEndEvent(AgentEvent):
    type: str = "message_end"
    entry_id: str
    message: dict

@dataclass
class ToolExecutionStartEvent(AgentEvent):
    type: str = "tool_execution_start"
    tool_call_id: str
    tool_name: str

@dataclass
class ToolExecutionEndEvent(AgentEvent):
    type: str = "tool_execution_end"
    tool_call_id: str

@dataclass
class CompactionStartEvent(AgentEvent):
    type: str = "compaction_start"
    reason: str  # "manual" | "threshold" | "overflow"

@dataclass
class CompactionEndEvent(AgentEvent):
    type: str = "compaction_end"
    result: dict | None = None
    aborted: bool = False

@dataclass
class AutoRetryStartEvent(AgentEvent):
    type: str = "auto_retry_start"
    attempt: int
    max_attempts: int
    error_message: str

@dataclass
class AutoRetryEndEvent(AgentEvent):
    type: str = "auto_retry_end"
    success: bool
    attempt: int
```

## 5. 实施顺序

### 第 1 周：Session 持久化 + 数据层
- `SessionManager` — .jsonl 读写、fork、navigate_tree
- `build_session_context` — compaction 裁剪 + branch summary 注入
- 单元测试：用真实的 pi session 文件验证兼容性

### 第 2 周：工具系统
- `ToolRegistry` — 工具注册表
- 逐个实现：`bash` → `read` → `write` → `edit` → `grep` → `find` → `ls`
- 单元测试：每种工具独立测试

### 第 3 周：Provider 适配 + Agent 主循环（Anthropic）
- `AnthropicProvider` — stream / count_tokens / supports_thinking
- `AgentSession._run_agent_turn` — 完整的主循环
- 集成测试：发送消息 → LLM 返回 → 工具调用 → 继续

### 第 4 周：Agent 主循环完善
- `steer` / `follow_up` 队列机制
- `abort` 信号传播
- `auto-retry` 重试逻辑
- `OpenAIProvider` — 第二个 Provider

### 第 5 周：Compaction + System prompt + Skills
- `compaction.py` — LLM 摘要生成 + 历史裁剪
- `auto-compaction` — 上下文溢出自动触发
- `system_prompt.py` — 工具列表 + guidelines 动态构建
- `skills.py` — `.agents/skills/` 目录加载

### 第 6 周：完善 + 边界情况
- 上下文用量实时查询
- Session 统计（累计 token + 费用）
- 错误处理 + 边界情况
- 与真实 pi session 文件的兼容性测试

## 6. 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 异步框架 | `asyncio` + `aiofiles` | Python 原生异步，无需额外依赖 |
| LLM SDK | `anthropic` + `openai` | 官方 SDK，维护成本低 |
| HTTP 客户端 | `httpx` (async) | 统一的 async HTTP 客户端 |
| JSON 解析 | `json` (标准库) | .jsonl 格式简单，无需第三方库 |
| 进程管理 | `asyncio.subprocess` | bash 工具执行 |
| Token 计数 | SDK tokenizer + 字符估算回退 | 优先精确，失败回退到估算 |
| 配置存储 | `~/.pi/agent/settings.json` | 兼容 pi 现有配置路径 |
| Session 文件 | `~/.pi/agent/sessions/` | 完全兼容 pi 现有路径 |

## 7. 测试策略

```
test/
├── test_session_manager.py    # .jsonl 读写、fork、navigate_tree
├── test_session_context.py    # build_session_context
├── test_tools.py              # 每种工具独立测试
├── test_agent_loop.py         # Agent 主循环集成测试
├── test_compaction.py         # 压缩逻辑
├── test_providers.py          # Provider 适配层
└── fixtures/                  # 测试用的 .jsonl 文件
```

## 8. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|:---:|------|
| Compaction 裁剪逻辑与 pi 不一致 | 中 | 用真实 pi session 文件做对比测试 |
| Anthropic/OpenAI SDK 版本兼容 | 低 | 锁定主要版本 |
| 流式事件格式与前端期望不完全匹配 | 中 | 在事件层做兼容适配 |
| bash 跨平台兼容（Windows） | 中 | 优先支持 Linux/macOS，Windows 后续 |
| Token 计数偏差过大 | 低 | 先用 SDK tokenizer，偏差 < 5% |
