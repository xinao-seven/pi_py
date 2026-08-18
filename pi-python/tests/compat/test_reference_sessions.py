from pathlib import Path

import pytest

from pi_coding_agent.core.session_manager import (
    CURRENT_SESSION_VERSION,
    build_session_context,
    migrate_session_entries,
    parse_session_entries,
)


REFERENCE_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "pi"
    / "packages"
    / "coding-agent"
    / "test"
    / "fixtures"
    / "before-compaction.jsonl"
)


@pytest.mark.skipif(not REFERENCE_FIXTURE.exists(), reason="local pi reference clone is unavailable")
def test_real_pi_v1_fixture_migrates_and_builds_context() -> None:
    entries = parse_session_entries(REFERENCE_FIXTURE.read_text(encoding="utf-8"))

    assert entries[0]["type"] == "session"
    assert entries[0].get("version") is None
    assert migrate_session_entries(entries) is True

    session_entries = entries[1:]
    context = build_session_context(session_entries)
    assert entries[0]["version"] == CURRENT_SESSION_VERSION
    assert all(isinstance(entry.get("id"), str) for entry in session_entries)
    assert len(context["messages"]) > 0
    assert context["model"] is not None
