"""Coding-agent session, resources, and application services."""

from pi_coding_agent.core.compaction import (
    CompactionPreparation,
    CompactionSettings,
    CompactionSummarizer,
    CompactionSummary,
    ProviderCompactionSummarizer,
    is_context_overflow,
    prepare_compaction,
    should_compact,
)
from pi_coding_agent.core.prompt_templates import PromptTemplate, expand_prompt_template
from pi_coding_agent.core.resource_loader import CodingResourceLoader, CodingResources
from pi_coding_agent.core.session_manager import SessionInfo, SessionManager
from pi_coding_agent.core.skills import Skill, SkillsResult, load_skills
from pi_coding_agent.core.system_prompt import build_system_prompt

__all__ = [
    "CompactionPreparation",
    "CompactionSettings",
    "CompactionSummarizer",
    "CompactionSummary",
    "CodingResourceLoader",
    "CodingResources",
    "PromptTemplate",
    "ProviderCompactionSummarizer",
    "SessionInfo",
    "SessionManager",
    "Skill",
    "SkillsResult",
    "build_system_prompt",
    "expand_prompt_template",
    "is_context_overflow",
    "load_skills",
    "prepare_compaction",
    "should_compact",
]
