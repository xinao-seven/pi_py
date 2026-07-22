# 后端 FastAPI 方案

## 1. 目标

用 FastAPI 替换 Next.js API Routes，提供 REST API + SSE 事件流，对接 Python Agent 内核或 pi RPC 子进程，同时提供 Vue 前端所需的静态文件服务。

## 2. 架构选型

### 方案 A：对接 Python Agent 内核（推荐，如果完成了 plan-agent-core.md）

```
Vue 前端 ←HTTP/SSE→ FastAPI ←直接调用→ pi_agent.AgentSession (Python)
```

- 完全 Python 栈，部署简单
- 无需管理子进程
- 需要 Phase 1 先完成 agent 内核

### 方案 B：对接 pi RPC 子进程（无需自研内核）

```
Vue 前端 ←HTTP/SSE→ FastAPI ←stdin/stdout pipe→ pi --rpc (Node.js 子进程)
```

- 立即可用，零内核开发
- 需要 Node.js 运行时
- ~85% 功能覆盖（缺少 navigate_tree / set_tools）

### 方案 C：混合模式（最灵活）

```
Vue 前端 ←HTTP/SSE→ FastAPI
                      ├── 新 session → Python Agent 内核
                      └── 旧 session → .jsonl 文件直读
```

- 新消息用 Python 内核处理
- 旧 session 文件直接读取（用于侧边栏列表、上下文）
- 两个路径互不干扰

**本文档以方案 A 为主要设计目标，兼容方案 B/C。**

## 3. API 设计

### 3.1 路由总览

```
GET    /api/sessions                  # 列出所有 session
GET    /api/sessions/{id}             # 获取单个 session（含上下文）
PATCH  /api/sessions/{id}             # 重命名 session
DELETE /api/sessions/{id}             # 删除 session（级联重定向子节点）
GET    /api/sessions/{id}/context     # 获取指定 leaf 的上下文
POST   /api/sessions/{id}/merge       # 合并分支 session

POST   /api/agent/new                 # 创建新 session + 发送首条消息
POST   /api/agent/{id}                # 向活跃 session 发送命令
GET    /api/agent/{id}/events         # SSE 事件流

GET    /api/files/{path:path}         # 读取工作区文件（用于 FileViewer）
GET    /api/models                    # 获取可用模型列表
GET    /api/models-config             # 读取模型配置文件
POST   /api/models-config             # 写入模型配置文件

GET    /api/skills/search             # 搜索 skills
POST   /api/skills/install            # 安装 skill
```

### 3.2 核心端点详细设计

#### 3.2.1 Session 管理 API

```python
# GET /api/sessions
{
    "sessions": [
        {
            "path": "/home/user/.pi/agent/sessions/project/20240701_abc.jsonl",
            "id": "abc123",
            "cwd": "/home/user/project",
            "name": "重构用户模块",
            "created": "2024-07-01T10:00:00",
            "modified": "2024-07-01T15:30:00",
            "messageCount": 24,
            "firstMessage": "帮我看一下用户模块的代码",
            "parentSessionId": null  # null 或父 session 的 id
        }
    ]
}

# GET /api/sessions/{id}
{
    "sessionId": "abc123",
    "filePath": "/path/to/session.jsonl",
    "info": { /* 同上面的 session 对象 */ },
    "tree": [ /* SessionTreeNode 树结构 */ ],
    "leafId": "entry_123",
    "context": {
        "messages": [ /* AgentMessage[] */ ],
        "entryIds": ["entry_001", "entry_002", ...],
        "thinkingLevel": "medium",
        "model": {"provider": "anthropic", "modelId": "claude-sonnet-4-6"}
    },
    "agentState": {  // 可选，includeState=true 时返回
        "running": true/false,
        "state": {
            "isStreaming": false,
            "isCompacting": false,
            "contextUsage": {"percent": 45, "contextWindow": 200000, "tokens": 90000},
            "systemPrompt": "...",
            "thinkingLevel": "medium"
        }
    }
}

# DELETE /api/sessions/{id}
# 返回 { "ok": true, "reparentedCount": 2 }
# 级联逻辑：子 session 的 parentSession 指向被删除 session 的 parentSession
```

#### 3.2.2 Agent 命令 API

```python
# POST /api/agent/new
# Body: { "cwd": "/path", "type": "prompt", "message": "hello",
#         "toolNames": ["read","bash","edit","write"],
#         "provider": "anthropic", "modelId": "claude-sonnet-4-6",
#         "thinkingLevel": "medium" }
# Response: { "success": true, "sessionId": "real-uuid" }

# POST /api/agent/{id}
# Body: { "type": "prompt", "message": "hello" }
# 支持的命令类型：
#   prompt, steer, follow_up, abort
#   set_model, set_thinking_level
#   set_tools, get_tools
#   compact, abort_compaction
#   fork, navigate_tree
#   get_state
#   append_custom_message
```

#### 3.2.3 SSE 事件流

```python
# GET /api/agent/{id}/events
# Content-Type: text/event-stream
# Cache-Control: no-cache
# Connection: keep-alive

# 事件格式（Server-Sent Events）：
data: {"type":"connected","sessionId":"abc123"}

data: {"type":"agent_start"}

data: {"type":"message_start","role":"user","entryId":"..."}
data: {"type":"message_end","role":"user","entryId":"...","message":{...}}

data: {"type":"message_update","delta":{"text":"好的"}}

data: {"type":"tool_execution_start","toolCallId":"...","toolName":"bash"}
data: {"type":"tool_execution_end","toolCallId":"..."}

data: {"type":"message_end","entryId":"...","message":{...}}

data: {"type":"agent_end"}

# 心跳（每 30 秒，SSE 注释行，客户端忽略）
: heartbeat
```

## 4. FastAPI 应用结构

```
server/
├── __init__.py
├── main.py                    # FastAPI 应用入口
├── pyproject.toml
│
├── routes/
│   ├── __init__.py
│   ├── sessions.py            # Session CRUD API
│   ├── agent.py               # Agent 命令 + SSE 事件流
│   ├── files.py               # 工作区文件读取
│   ├── models.py              # 模型列表 + 配置
│   └── skills.py              # Skills 搜索/安装
│
├── services/
│   ├── __init__.py
│   ├── session_registry.py    # 活跃 Agent 实例注册表
│   ├── agent_bridge.py        # Agent 内核 ↔ HTTP 桥梁
│   └── file_service.py        # 文件读取服务（白名单 + 安全）
│
├── middleware/
│   ├── __init__.py
│   └── cors.py                # CORS 配置
│
└── static/                    # Vue 构建产物（生产部署时）
```

## 5. 核心服务设计

### 5.1 Session Registry（~150 行）

```python
# services/session_registry.py
import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional
from pi_agent.core.agent_session import AgentSession
from pi_agent.core.session_manager import SessionManager

@dataclass
class SessionEntry:
    """活跃 session 的包装。"""
    session: AgentSession
    listeners: list = field(default_factory=list)
    idle_timer: asyncio.Task | None = None
    alive: bool = True
    
    def reset_idle_timer(self, timeout: int = 600):
        """10 分钟空闲后自动销毁。"""
        if self.idle_timer:
            self.idle_timer.cancel()
        self.idle_timer = asyncio.create_task(self._idle_cleanup(timeout))
    
    async def _idle_cleanup(self, timeout: int):
        await asyncio.sleep(timeout)
        self.destroy()
    
    def destroy(self):
        self.alive = False
        if self.idle_timer:
            self.idle_timer.cancel()
        # 清理事件监听器（由 agent_bridge 处理）


class SessionRegistry:
    """
    全局 Agent 实例注册表。
    一个 session 最多一个活跃的 AgentSession 实例。
    空闲 10 分钟后自动销毁。
    """
    def __init__(self):
        self._entries: Dict[str, SessionEntry] = {}
        self._start_locks: Dict[str, asyncio.Lock] = {}
    
    def get(self, session_id: str) -> SessionEntry | None:
        """获取活跃 session，如果不存在返回 None。"""
        entry = self._entries.get(session_id)
        if entry and entry.alive:
            return entry
        return None
    
    async def get_or_create(
        self,
        session_id: str,
        session_file: str,
        cwd: str,
        provider: str,
        model: str,
        tool_names: list[str] | None = None,
    ) -> SessionEntry:
        """
        获取或创建 AgentSession。
        使用 asyncio.Lock 防止并发创建同一个 session。
        """
        existing = self.get(session_id)
        if existing:
            return existing
        
        # 防止并发创建
        lock = self._start_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            # 双重检查（并发情况下另一个协程可能已经创建）
            existing = self.get(session_id)
            if existing:
                return existing
            
            # 创建 AgentSession
            session_manager = (
                SessionManager.open(session_file)
                if session_file
                else SessionManager.create(cwd)
            )
            
            agent = AgentSession(
                provider=provider,
                model=model,
                cwd=cwd,
                session_manager=session_manager,
                tools=tool_names,
            )
            
            entry = SessionEntry(session=agent)
            self._entries[session_id] = entry
            entry.reset_idle_timer()
            return entry
        finally:
            self._start_locks.pop(session_id, None)
    
    def remove(self, session_id: str):
        """从注册表移除 session。"""
        entry = self._entries.pop(session_id, None)
        if entry:
            entry.destroy()


# 全局单例
registry = SessionRegistry()
```

### 5.2 Agent Bridge（~200 行）

```python
# services/agent_bridge.py
import asyncio
from typing import AsyncIterator
from .session_registry import registry, SessionEntry

class AgentBridge:
    """
    HTTP API 与 Agent 内核之间的桥梁。
    处理：
    - 命令转发（agent.send_command）
    - 事件订阅（agent.subscribe）
    - SSE 流式推送
    - abort 信号传播
    """
    
    @staticmethod
    async def send_command(session_id: str, command: dict) -> dict:
        """
        向 agent 发送命令，返回结果。
        支持的命令：
        - prompt / steer / follow_up / abort
        - set_model / set_thinking_level
        - set_tools / get_tools
        - compact / abort_compaction
        - fork / navigate_tree
        - get_state
        """
        entry = registry.get(session_id)
        if not entry:
            raise ValueError(f"Session {session_id} 未激活")
        
        entry.reset_idle_timer()
        agent = entry.session
        
        cmd_type = command["type"]
        
        if cmd_type == "prompt":
            # prompt 是异步的，事件通过 subscribe 返回
            images = command.get("images")
            asyncio.create_task(agent.prompt(command["message"], images))
            return {"success": True}
        
        elif cmd_type == "abort":
            await agent.abort()
            return {"success": True}
        
        elif cmd_type == "get_state":
            usage = agent.get_context_usage()
            return {
                "sessionId": session_id,
                "isStreaming": agent._is_streaming,
                "isCompacting": agent._is_compacting,
                "thinkingLevel": agent.thinking_level,
                "model": {"provider": agent.provider_name, "id": agent.model},
                "contextUsage": usage,
            }
        
        elif cmd_type == "set_model":
            agent.set_model(command["modelId"])
            return {"success": True, "model": agent.model}
        
        elif cmd_type == "fork":
            entry_id = command["entryId"]
            new_file = agent.session_manager.fork(entry_id)
            # 返回新 session 信息
            new_sm = SessionManager.open(new_file)
            return {
                "cancelled": False,
                "newSessionId": new_sm.get_header()["id"],
            }
        
        # ... 其他命令
        
        else:
            raise ValueError(f"不支持的命令：{cmd_type}")
    
    @staticmethod
    async def event_stream(session_id: str) -> AsyncIterator[str]:
        """
        生成 SSE 事件流。
        用于 GET /api/agent/{id}/events。
        """
        entry = registry.get(session_id)
        if not entry:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Session 未激活'})}\n\n"
            return
        
        queue = asyncio.Queue()
        
        def on_event(event: dict):
            """将 agent 事件放入队列。"""
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass
        
        # 订阅 agent 事件
        unsubscribe = entry.session.subscribe(on_event)
        
        # 发送连接成功事件
        yield f"data: {json.dumps({'type': 'connected', 'sessionId': session_id})}\n\n"
        
        try:
            while True:
                # 等待事件，30 秒超时后发心跳
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ":\n\n"  # SSE 心跳（注释行）
        except asyncio.CancelledError:
            pass
        finally:
            unsubscribe()
```

### 5.3 File Service（~100 行）

```python
# services/file_service.py
import os
from pathlib import Path

class FileService:
    """
    工作区文件读取服务。
    安全措施：
    - 白名单：允许读取的根目录（session 的 cwd + agent 配置目录）
    - 黑名单：禁止读取 .env, .git/config, ~/.ssh 等敏感文件
    - 大小限制：最大 1MB
    """
    
    ALLOWED_ROOTS: set[str] = set()
    FORBIDDEN_PATTERNS = [
        ".env", ".env.*", "*.pem", "*.key",
        ".git/config", "~/.ssh/*", "~/.aws/*",
    ]
    MAX_FILE_SIZE = 1 * 1024 * 1024  # 1MB
    
    @classmethod
    def add_root(cls, path: str):
        cls.ALLOWED_ROOTS.add(os.path.abspath(path))
    
    @classmethod
    def read_file(cls, relative_path: str, cwd: str) -> dict:
        """读取工作区文件。返回 {content, language, size}。"""
        full_path = os.path.normpath(os.path.join(cwd, relative_path))
        
        # 安全检查
        if not cls._is_allowed(full_path):
            raise PermissionError(f"无权访问：{relative_path}")
        
        if os.path.getsize(full_path) > cls.MAX_FILE_SIZE:
            raise ValueError(f"文件过大（>{cls.MAX_FILE_SIZE // 1024 // 1024}MB）")
        
        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        
        return {
            "content": content,
            "language": cls._guess_language(full_path),
            "size": len(content),
        }
    
    @classmethod
    def list_directory(cls, relative_path: str, cwd: str) -> list[dict]:
        """列出目录内容（用于 FileExplorer）。"""
        ...
```

## 6. FastAPI 路由实现示例

### 6.1 Agent 路由（~250 行）

```python
# routes/agent.py
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
from services.session_registry import registry
from services.agent_bridge import AgentBridge
from pi_agent.core.session_manager import SessionManager
import json

router = APIRouter(prefix="/api/agent")

@router.post("/new")
async def create_agent(req: Request):
    """创建新 session + 发送首条消息。"""
    body = await req.json()
    cwd = body.get("cwd")
    if not cwd or not os.path.exists(cwd):
        raise HTTPException(400, f"目录不存在：{cwd}")
    
    tool_names = body.get("toolNames")
    provider = body.get("provider", "anthropic")
    model_id = body.get("modelId", "claude-sonnet-4-6")
    message = body.get("message", "")
    images = body.get("images")
    thinking_level = body.get("thinkingLevel", "auto")
    
    # 创建 session
    temp_key = f"__new__{int(time.time() * 1000)}"
    entry = await registry.get_or_create(
        session_id=temp_key,
        session_file="",  # 空 = 创建新文件
        cwd=cwd,
        provider=provider,
        model=model_id,
        tool_names=tool_names,
    )
    
    # 设置 thinking level
    if thinking_level != "auto":
        entry.session.set_thinking_level(thinking_level)
    
    # 发送 prompt（异步，事件通过 SSE 返回）
    asyncio.create_task(entry.session.prompt(message, images))
    
    # 用 pi 生成的 session 文件路径解析真实 ID
    real_id = entry.session.session_manager.get_header()["id"]
    # 更新注册表的 key
    registry._entries[real_id] = registry._entries.pop(temp_key)
    
    return {"success": True, "sessionId": real_id}


@router.post("/{session_id}")
async def send_command(session_id: str, req: Request):
    """向活跃 session 发送命令。"""
    body = await req.json()
    
    # 尝试已有 session
    if registry.get(session_id):
        result = await AgentBridge.send_command(session_id, body)
        return {"success": True, "data": result}
    
    # Session 未激活 → 从文件加载
    file_path = SessionManager.resolve_path(session_id)
    if not file_path:
        raise HTTPException(404, "未找到会话")
    
    cwd = SessionManager.open(file_path).get_header()["cwd"]
    entry = await registry.get_or_create(
        session_id=session_id,
        session_file=file_path,
        cwd=cwd,
        provider=body.get("provider", "anthropic"),
        model=body.get("modelId", "claude-sonnet-4-6"),
    )
    
    result = await AgentBridge.send_command(session_id, body)
    return {"success": True, "data": result}


@router.get("/{session_id}/events")
async def event_stream(session_id: str):
    """SSE 事件流。"""
    return StreamingResponse(
        AgentBridge.event_stream(session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 nginx 缓冲
        },
    )


@router.get("/{session_id}")
async def get_agent_state(session_id: str):
    """获取 agent 状态。"""
    entry = registry.get(session_id)
    if not entry or not entry.alive:
        return {"running": False}
    
    state = await AgentBridge.send_command(session_id, {"type": "get_state"})
    return {"running": True, "state": state}
```

### 6.2 Session 路由（~200 行）

```python
# routes/sessions.py
from fastapi import APIRouter, HTTPException
from pi_agent.core.session_manager import SessionManager, build_session_context
from services.session_registry import registry

router = APIRouter(prefix="/api/sessions")
SESSIONS_DIR = os.path.expanduser("~/.pi/agent/sessions")

@router.get("")
async def list_sessions():
    """列出所有 session。"""
    sessions = SessionManager.list_all(SESSIONS_DIR)
    return {"sessions": sessions}


@router.get("/{session_id}")
async def get_session(session_id: str, includeState: bool = False):
    """获取单个 session（含上下文）。"""
    file_path = SessionManager.resolve_path(session_id)
    if not file_path:
        raise HTTPException(404, "未找到会话")
    
    sm = SessionManager.open(file_path)
    entries = sm.get_entries()
    leaf_id = sm.get_leaf_id()
    tree = sm.get_tree()
    context = build_session_context(entries, leaf_id)
    header = sm.get_header()
    
    result = {
        "sessionId": session_id,
        "filePath": file_path,
        "info": {
            "path": file_path,
            "id": header["id"],
            "cwd": header.get("cwd", ""),
            "name": sm.get_session_name(),
            "created": header.get("timestamp"),
            "modified": os.path.getmtime(file_path),
            "messageCount": len(context["messages"]),
            "firstMessage": "...",
        },
        "tree": tree,
        "leafId": leaf_id,
        "context": context,
    }
    
    # 可选：附带 agent 运行状态
    if includeState:
        entry = registry.get(session_id)
        if entry and entry.alive:
            state = await AgentBridge.send_command(session_id, {"type": "get_state"})
            result["agentState"] = {"running": True, "state": state}
        else:
            result["agentState"] = {"running": False}
    
    return result


@router.patch("/{session_id}")
async def rename_session(session_id: str, body: dict):
    """重命名 session。"""
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "缺少名称")
    
    file_path = SessionManager.resolve_path(session_id)
    sm = SessionManager.open(file_path)
    sm.append_session_info(name)
    return {"ok": True}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    """删除 session（级联重定向子节点）。"""
    file_path = SessionManager.resolve_path(session_id)
    
    # 销毁活跃实例
    entry = registry.get(session_id)
    if entry:
        entry.destroy()
        registry.remove(session_id)
    
    # 删除文件 + 级联重定向
    from pi_agent.core.session_manager import delete_session_with_reparent
    result = delete_session_with_reparent(file_path)
    return {"ok": True, "reparentedCount": result["reparented_count"]}
```

## 7. 依赖配置

```toml
# server/pyproject.toml
[project]
name = "pi-agent-server"
version = "0.1.0"
requires-python = ">=3.11"

dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "httpx>=0.27.0",
    "aiofiles>=24.0",
    "python-multipart>=0.0.9",
    "anthropic>=0.34.0",
    "openai>=1.50.0",
    "watchfiles>=0.24.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24.0",
    "httpx-ws>=0.6.0",
]
```

## 8. 部署架构

### 开发模式

```bash
# 启动 FastAPI（端口 8000）
uvicorn server.main:app --reload --port 8000

# 启动 Vue 开发服务器（端口 5173，代理到 8000）
cd web && npm run dev
```

### 生产模式

```
Vue 构建产物（./dist）←── 嵌入 FastAPI 静态文件服务
                                    │
                  ┌─────────────────┘
                  │
         uvicorn server.main:app --port 30141
                  │
        ┌─────────┼─────────┐
        │         │         │
    Sessions    Agent    Files
      API        SSE       API
```

```python
# server/main.py
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from routes import sessions, agent, files, models, skills

app = FastAPI(title="Pi Agent Server")

# API 路由
app.include_router(sessions.router)
app.include_router(agent.router)
app.include_router(files.router)
app.include_router(models.router)
app.include_router(skills.router)

# 生产模式：服务 Vue 前端
FRONTEND_DIR = Path(__file__).parent / "static"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True))
```

## 9. SSE 关键注意事项

```python
# SSE 连接快速断开是常见陷阱。需要：

# 1. 禁用代理缓冲
headers["X-Accel-Buffering"] = "no"  # nginx
headers["Cache-Control"] = "no-cache"

# 2. 定期心跳（防止超时）
# 每 30 秒发送 ":\n\n"（SSE 注释行，浏览器忽略）

# 3. 客户端断开检测
async def event_generator(request: Request):
    queue = asyncio.Queue()
    # ...
    try:
        while True:
            if await request.is_disconnected():
                break
            event = await asyncio.wait_for(queue.get(), timeout=30)
            yield f"data: {json.dumps(event)}\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        unsubscribe()

# 4. 断线重连（由前端 EventSource 自动处理）
# EventSource 原生支持自动重连，无需额外配置
```

## 10. 与方案 B（RPC 子进程）的兼容性

如果需要快速上线而不等 Python 内核完成，可以写一个 RPC 适配器：

```python
# services/rpc_adapter.py
class RpcAgentAdapter:
    """将 pi --rpc 子进程包装成 AgentBridge 兼容接口。"""
    
    def __init__(self, cwd: str):
        self.process = None
        self.cwd = cwd
    
    async def start(self):
        self.process = await asyncio.create_subprocess_exec(
            "pi", "--rpc",
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )
    
    async def send_command(self, command: dict) -> dict:
        """发送 JSON 命令，等待响应。"""
        self.process.stdin.write(
            json.dumps(command).encode() + b"\n"
        )
        await self.process.stdin.drain()
        
        # 读取响应行
        line = await self.process.stdout.readline()
        return json.loads(line)
    
    async def event_stream(self):
        """从 stdout 读取事件流。"""
        while True:
            line = await self.process.stdout.readline()
            if not line:
                break
            event = json.loads(line)
            if "type" in event and event["type"] != "response":
                yield event  # 事件（非响应）
    
    async def stop(self):
        if self.process:
            self.process.terminate()
            await self.process.wait()
```

方案 A 和方案 B 的切换只需要在 `SessionRegistry.get_or_create()` 中选择创建 `AgentSession` 还是 `RpcAgentAdapter`。
