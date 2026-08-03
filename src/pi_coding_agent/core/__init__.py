"""Coding-agent session, resources, and application services.

中文说明：编程助手核心服务：Session v3 数据层、上下文压缩（compaction）、
分支摘要、Skills/Prompt 模板/项目指令加载、系统提示组装与用量统计。
"""

from pi_coding_agent.core.branch_summary import (
    BranchPreparation,
    BranchSummarizer,
    BranchSummary,
    ProviderBranchSummarizer,
    prepare_branch_summary,
)
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
from pi_coding_agent.core.usage import get_session_stats, get_usage_cost_breakdown

__all__ = [
    "BranchPreparation",
    "BranchSummarizer",
    "BranchSummary",
    "CompactionPreparation",
    "CompactionSettings",
    "CompactionSummarizer",
    "CompactionSummary",
    "CodingResourceLoader",
    "CodingResources",
    "PromptTemplate",
    "ProviderCompactionSummarizer",
    "ProviderBranchSummarizer",
    "SessionInfo",
    "SessionManager",
    "Skill",
    "SkillsResult",
    "build_system_prompt",
    "expand_prompt_template",
    "get_session_stats",
    "get_usage_cost_breakdown",
    "is_context_overflow",
    "load_skills",
    "prepare_compaction",
    "prepare_branch_summary",
    "should_compact",
]
