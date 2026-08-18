from __future__ import annotations

import json
from pathlib import Path

import pytest

from pi_coding_agent.core.session_manager import (
    CURRENT_SESSION_VERSION,
    SessionManager,
    assert_valid_session_id,
    build_context_entries,
    build_session_context,
    build_session_context_with_entry_ids,
    build_session_info,
    find_most_recent_session,
    migrate_session_entries,
    parse_session_entries,
)


def _entry(entry_type: str, entry_id: str, parent_id: str | None, **fields: object) -> dict[str, object]:
    return {
        "type": entry_type,
        "id": entry_id,
        "parentId": parent_id,
        "timestamp": "2026-01-01T00:00:00.000Z",
        **fields,
    }


def test_parse_session_entries_skips_bad_lines_and_preserves_unicode() -> None:
    content = '\n'.join([
        '{"type":"session","id":"s1","cwd":"E:/项目"}',
        'not json',
        '42',
        '',
        '{"type":"message","message":{"role":"user","content":"你好"}}',
    ])

    entries = parse_session_entries(content)

    assert len(entries) == 2
    assert entries[0]["cwd"] == "E:/项目"
    assert entries[1]["message"]["content"] == "你好"


def test_migrate_v1_to_v3_adds_tree_and_renames_hook_message() -> None:
    entries = [
        {"type": "session", "id": "session", "cwd": "E:/code"},
        {"type": "message", "message": {"role": "user", "content": "one"}},
        {"type": "message", "message": {"role": "hookMessage", "content": "two"}},
        {"type": "compaction", "firstKeptEntryIndex": 1, "summary": "s", "tokensBefore": 10},
    ]

    assert migrate_session_entries(entries) is True

    assert entries[0]["version"] == CURRENT_SESSION_VERSION
    assert entries[1]["parentId"] is None
    assert entries[2]["parentId"] == entries[1]["id"]
    assert entries[2]["message"]["role"] == "custom"
    assert entries[3]["firstKeptEntryId"] == entries[1]["id"]
    assert "firstKeptEntryIndex" not in entries[3]
    assert migrate_session_entries(entries) is False


def test_context_follows_selected_branch_and_tracks_settings() -> None:
    entries = [
        _entry("model_change", "model", None, provider="anthropic", modelId="claude-a"),
        _entry("thinking_level_change", "think", "model", thinkingLevel="medium"),
        _entry("message", "u1", "think", message={"role": "user", "content": "root"}),
        _entry(
            "message",
            "a1",
            "u1",
            message={"role": "assistant", "content": [], "provider": "openai", "model": "gpt-a"},
        ),
        _entry("message", "u2", "u1", message={"role": "user", "content": "branch"}),
    ]

    context = build_session_context(entries, "a1")

    assert [message["role"] for message in context["messages"]] == ["user", "assistant"]
    assert context["thinkingLevel"] == "medium"
    assert context["model"] == {"provider": "openai", "modelId": "gpt-a"}

    branch_context = build_session_context(entries, "u2")
    assert [message["content"] for message in branch_context["messages"]] == ["root", "branch"]
    assert branch_context["model"] == {"provider": "anthropic", "modelId": "claude-a"}


def test_latest_compaction_keeps_summary_selected_history_and_new_entries() -> None:
    entries = [
        _entry("message", "u1", None, message={"role": "user", "content": "old"}),
        _entry("message", "a1", "u1", message={"role": "assistant", "content": []}),
        _entry("message", "u2", "a1", message={"role": "user", "content": "keep"}),
        _entry(
            "compaction",
            "c1",
            "u2",
            summary="summary",
            firstKeptEntryId="u2",
            tokensBefore=100,
        ),
        _entry("message", "a2", "c1", message={"role": "assistant", "content": [{"type": "text", "text": "new"}]}),
    ]

    selected = build_context_entries(entries)
    context = build_session_context(entries)

    assert [entry["id"] for entry in selected] == ["c1", "u2", "a2"]
    assert [message["role"] for message in context["messages"]] == [
        "compactionSummary",
        "user",
        "assistant",
    ]
    assert context["messages"][0]["summary"] == "summary"
    web_context = build_session_context_with_entry_ids(entries)
    assert web_context["entryIds"] == ["c1", "u2", "a2"]


def test_explicit_none_leaf_builds_empty_context() -> None:
    entries = [_entry("message", "u1", None, message={"role": "user", "content": "hello"})]

    assert build_session_context(entries, None)["messages"] == []
    assert build_session_context(entries)["messages"][0]["content"] == "hello"


def test_manager_branches_labels_and_returns_defensive_copies(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path, session_id="session-1")
    first = manager.append_message({"role": "user", "content": "first"})
    manager.append_message({"role": "assistant", "content": [], "provider": "p", "model": "m"})
    manager.branch(first)
    branch = manager.append_message({"role": "user", "content": "branch"})
    manager.append_label_change(first, "起点")
    manager.append_session_info("  学习\n项目  ")

    assert [entry["id"] for entry in manager.get_branch(branch)] == [first, branch]
    assert manager.get_session_name() == "学习 项目"
    tree = manager.get_tree()
    assert tree[0]["label"] == "起点"
    assert len(tree[0]["children"]) == 2

    copied = manager.get_entries()
    copied[0]["type"] = "changed"
    assert manager.get_entries()[0]["type"] == "message"


def test_custom_entries_and_branch_summary_context(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    root = manager.append_message({"role": "user", "content": "root"})
    manager.append_custom_entry("state", {"hidden": True})
    manager.append_custom_message("notice", "visible to the model", display=True)
    manager.branch_with_summary(root, "abandoned work")

    context = manager.build_session_context()

    assert [message["role"] for message in context["messages"]] == ["user", "branchSummary"]
    assert context["messages"][1]["summary"] == "abandoned work"


def test_create_branched_session_rechains_path_and_sets_parent(tmp_path: Path) -> None:
    manager = SessionManager.create(tmp_path, tmp_path / "sessions", session_id="original")
    first = manager.append_message({"role": "user", "content": "first"})
    second = manager.append_message({
        "role": "assistant",
        "content": [],
        "provider": "test",
        "model": "fake",
    })
    manager.append_label_change(first, "keep")
    old_file = manager.session_file

    new_file = manager.create_branched_session(second)

    assert old_file is not None
    assert new_file is not None and new_file != old_file and new_file.exists()
    assert manager.get_header()["parentSession"] == str(old_file)
    entries = manager.get_entries()
    assert entries[0]["parentId"] is None
    assert entries[1]["parentId"] == entries[0]["id"]
    assert entries[-1]["type"] == "label"
    assert entries[-1]["targetId"] == first


def test_fork_from_copies_history_and_updates_header(tmp_path: Path) -> None:
    original = SessionManager.create(tmp_path, tmp_path / "source", session_id="source")
    original.append_message({"role": "user", "content": "copy me"})
    original.append_message({"role": "assistant", "content": [], "provider": "p", "model": "m"})
    assert original.session_file is not None

    forked = SessionManager.fork_from(
        original.session_file,
        tmp_path / "target-project",
        tmp_path / "target-sessions",
        session_id="forked",
    )

    assert forked.session_file is not None and forked.session_file.exists()
    assert forked.get_header()["parentSession"] == str(original.session_file)
    assert forked.cwd == (tmp_path / "target-project").resolve()
    assert forked.build_session_context()["messages"][0]["content"] == "copy me"


def test_session_info_listing_and_recent_filter(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    first = SessionManager.create(tmp_path / "project-a", sessions, session_id="first")
    first.append_message({"role": "user", "content": [{"type": "text", "text": "first prompt"}]})
    first.append_message({"role": "assistant", "content": [], "provider": "p", "model": "m"})
    second = SessionManager.create(tmp_path / "project-b", sessions, session_id="second")
    second.append_message({"role": "user", "content": "second prompt"})
    second.append_message({"role": "assistant", "content": [], "provider": "p", "model": "m"})
    second.append_session_info("Second")
    (sessions / "invalid.jsonl").write_text('{"type":"message"}\n', encoding="utf-8")

    info = build_session_info(second.session_file)
    listed = SessionManager.list(sessions)

    assert info is not None
    assert info.name == "Second"
    assert info.message_count == 2
    assert info.first_message == "second prompt"
    assert {item.id for item in listed} == {"first", "second"}
    assert SessionManager.list(sessions, cwd=tmp_path / "project-a")[0].id == "first"
    assert find_most_recent_session(sessions, cwd=tmp_path / "project-b") == second.session_file


def test_persistent_manager_flushes_complete_history_on_first_assistant(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    manager = SessionManager.create(tmp_path, sessions, session_id="session-2")
    manager.append_message({"role": "user", "content": "你好"})

    assert manager.session_file is not None
    assert not manager.session_file.exists()

    manager.append_message({
        "role": "assistant",
        "content": [{"type": "text", "text": "世界"}],
        "provider": "test",
        "model": "fake",
    })

    assert manager.session_file.exists()
    lines = manager.session_file.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    assert json.loads(lines[1])["message"]["content"] == "你好"

    reopened = SessionManager.open(manager.session_file)
    assert reopened.session_id == "session-2"
    assert reopened.build_session_context()["messages"][-1]["content"][0]["text"] == "世界"


def test_open_rejects_nonempty_file_without_valid_header(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    path.write_text('{"type":"message","id":"x"}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="header"):
        SessionManager.open(path)


@pytest.mark.parametrize("session_id", ["", "-bad", "bad-", "bad/name", "bad space"])
def test_invalid_session_ids_are_rejected(session_id: str) -> None:
    with pytest.raises(ValueError):
        assert_valid_session_id(session_id)
