"""Public stateful Agent API."""

from pi_agent.agent_loop import AgentRuntime


class Agent(AgentRuntime):
    """Named public facade over the reusable Agent loop runtime."""

