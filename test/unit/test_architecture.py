import ast
import asyncio
from pathlib import Path

from pi_agent import Agent, ToolRegistry
from pi_ai import FakeProvider


SOURCE_ROOT = Path(__file__).resolve().parents[2] / "src"


def imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def test_package_dependency_direction_is_one_way() -> None:
    violations: list[str] = []
    forbidden = {
        "pi_ai": {"pi_agent", "pi_coding_agent"},
        "pi_agent": {"pi_coding_agent"},
    }
    for package, denied in forbidden.items():
        for path in (SOURCE_ROOT / package).rglob("*.py"):
            bad = imported_roots(path) & denied
            if bad:
                violations.append(f"{path.relative_to(SOURCE_ROOT)} imports {sorted(bad)}")
    assert violations == []


def test_generic_agent_runs_without_coding_agent_session() -> None:
    provider = FakeProvider([
        [{"type": "text_delta", "text": "plain agent"}, {"type": "done", "stop_reason": "stop"}]
    ])
    agent = Agent(provider=provider, model="fake", tools=ToolRegistry())

    asyncio.run(agent.prompt("hello"))

    assert agent.messages[-1]["content"] == [{"type": "text", "text": "plain agent"}]
