"""Public stateful Agent API.

中文说明：对外公开的 Agent 门面，直接继承 AgentRuntime，
让调用方（如 FastAPI bridge）可以按 Agent 的语义使用主循环运行时。
"""

from pi_agent.agent_loop import AgentRuntime


class Agent(AgentRuntime):
    """Named public facade over the reusable Agent loop runtime.

    中文说明：对可复用主循环运行时的命名门面，方便外部以“Agent”为单位引用。
    """
