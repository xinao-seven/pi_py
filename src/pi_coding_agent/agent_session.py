"""Coding-specific assembly of the generic Agent and persistent Session."""

from __future__ import annotations

from pi_agent.agent import Agent
from pi_agent.tool_registry import ToolRegistry
from pi_ai.providers.base import LLMProvider
from pi_coding_agent.core.session_manager import SessionManager


class AgentSession(Agent):
    def __init__(
        self,
        *,
        provider: LLMProvider,
        model: str,
        session_manager: SessionManager,
        tool_registry: ToolRegistry,
        system_prompt: str = "",
        thinking_level: str = "off",
    ) -> None:
        self.session_manager = session_manager
        super().__init__(
            provider=provider,
            model=model,
            session=session_manager,
            tools=tool_registry,
            system_prompt=system_prompt,
            thinking_level=thinking_level,
        )

