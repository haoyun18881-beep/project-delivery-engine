from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass
class SessionMeta:
    session_id: str
    path: Path
    cwd: str | None = None
    originator: str | None = None
    source: Any | None = None
    thread_source: str | None = None


@dataclass
class AssistantAnswer:
    timestamp: str
    text: str
    phase: str
    provisional: bool = False


@dataclass
class QaTurn:
    question_time: str
    question: str
    answers: list[AssistantAnswer] = field(default_factory=list)


@dataclass
class SessionDiary:
    meta: SessionMeta
    turns: list[QaTurn]


@dataclass
class IncrementalSessionDiary:
    meta: SessionMeta
    turns: list[QaTurn]
    committed_offset: int
    file_size: int
    pending_turn: bool = False
    pending_turn_offset: int | None = None
    pending_commentary_offset: int | None = None


def iter_session_files(sessions_root: Path) -> Iterable[Path]:
    if not sessions_root.exists():
        return []
    return sorted(sessions_root.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime)


def message_payload(row: object) -> dict[str, Any]:
    """Read diary messages from either Codex rollout representation."""
    if not isinstance(row, dict) or not isinstance(row.get("payload"), dict):
        return {}
    payload = row["payload"]
    if row.get("type") == "event_msg":
        return payload
    if row.get("type") != "response_item" or payload.get("type") != "message":
        return {}

    role = payload.get("role")
    phase = payload.get("phase")
    content = payload.get("content")
    if role not in ("user", "assistant") or not isinstance(content, list):
        return {}
    parts = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") not in ("input_text", "output_text", "text"):
            continue
        text = item.get("text")
        if isinstance(text, str) and (role != "user" or not should_skip_user_message(text)):
            parts.append(text)
    message = "\n".join(parts).strip()
    if role == "user":
        return {"type": "user_message", "message": message}
    if phase in ("final", "final_answer"):
        return {"type": "agent_message", "message": message, "phase": "final_answer"}
    if phase == "commentary":
        return {"type": "agent_message", "message": message, "phase": phase}
    return {}


def parse_session_file(path: Path, include_commentary: bool = False) -> SessionDiary | None:
    meta: SessionMeta | None = None
    turns: list[QaTurn] = []
    current: QaTurn | None = None
    user_row_type = ""
    final_row_type = ""
    commentary_buffer: list[AssistantAnswer] = []

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            row_type = row.get("type")
            timestamp = str(row.get("timestamp", ""))
            if row_type == "session_meta":
                payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
                # Codex 0.144+ can embed parent session metadata inside a
                # sub-agent rollout. The first session_meta owns the file;
                # later copies must never overwrite its identity.
                if meta is None:
                    meta = SessionMeta(
                        session_id=str(payload.get("session_id") or payload.get("id") or path.stem),
                        path=path,
                        cwd=payload.get("cwd"),
                        originator=payload.get("originator"),
                        source=payload.get("source"),
                        thread_source=payload.get("thread_source"),
                    )
                    if meta.thread_source and meta.thread_source != "user":
                        return None
                continue
            payload = message_payload(row)
            event_type = payload.get("type")
            if event_type == "user_message":
                message = str(payload.get("message", "")).strip()
                if should_skip_user_message(message):
                    continue
                if (
                    current is not None
                    and not final_row_type
                    and user_row_type != row_type
                    and current.question == message
                ):
                    # Preserve the legacy timestamp when both representations
                    # describe the same pending question.
                    if row_type == "event_msg" and not current.answers and not commentary_buffer:
                        current.question_time = timestamp
                        user_row_type = row_type
                    continue
                current = finish_turn(current, commentary_buffer, turns)
                commentary_buffer = []
                current = QaTurn(question_time=timestamp, question=message)
                user_row_type = row_type
                final_row_type = ""
            elif event_type == "agent_message" and current is not None:
                phase = str(payload.get("phase", ""))
                message = str(payload.get("message", "")).strip()
                if not message:
                    continue
                if row_type == "response_item" and phase == "commentary" and not include_commentary:
                    continue
                answer = AssistantAnswer(timestamp=timestamp, text=message, phase=phase)
                if phase == "final_answer":
                    if final_row_type and final_row_type != row_type:
                        continue
                    current.answers.append(answer)
                    final_row_type = row_type
                elif include_commentary:
                    current.answers.append(answer)
                else:
                    commentary_buffer.append(answer)

    current = finish_turn(current, commentary_buffer, turns)
    if meta is None:
        meta = SessionMeta(session_id=path.stem, path=path)
    if meta.thread_source and meta.thread_source != "user":
        return None
    return SessionDiary(meta=meta, turns=turns)


def read_session_meta(path: Path) -> SessionMeta:
    """Read only the session metadata so sub-agent files can be skipped cheaply."""
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict) or row.get("type") != "session_meta":
                continue
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            return SessionMeta(
                session_id=str(payload.get("session_id") or payload.get("id") or path.stem),
                path=path,
                cwd=payload.get("cwd"),
                originator=payload.get("originator"),
                source=payload.get("source"),
                thread_source=payload.get("thread_source"),
            )
    return SessionMeta(session_id=path.stem, path=path)


MAX_PENDING_EVENT_BYTES = 16 * 1024 * 1024


def read_event_at_offset(path: Path, offset: int) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Reload one pending event without persisting conversation text in state."""
    if offset < 0 or offset >= path.stat().st_size:
        return None
    with path.open("rb") as handle:
        handle.seek(offset)
        raw_line = handle.readline(MAX_PENDING_EVENT_BYTES + 1)
    if not raw_line or len(raw_line) > MAX_PENDING_EVENT_BYTES:
        return None
    try:
        row = json.loads(raw_line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    payload = message_payload(row)
    return (row, payload) if payload else None


def parse_session_file_incremental(
    path: Path,
    start_offset: int = 0,
    include_commentary: bool = False,
    finalize_provisional: bool = False,
    pending_turn_offset: int | None = None,
    pending_commentary_offset: int | None = None,
) -> IncrementalSessionDiary | None:
    """Parse only bytes after the last safe JSONL cursor.

    Pending state stores event offsets, never conversation text. The parser
    reloads at most one user event and the last commentary event, then reads only
    newly appended bytes. This keeps long-running tool tails truly incremental.

    ``finalize_provisional`` is retained for CLI compatibility, but a live EOF
    turn is not finalized from file age alone. Once a provisional diary entry is
    written, the diary's deterministic dedupe key prevents a later final answer
    from replacing it. Waiting for either ``final_answer`` or the next user turn
    preserves the final answer without storing conversation text in scan state.
    """
    meta = read_session_meta(path)
    file_size = path.stat().st_size
    if meta.thread_source and meta.thread_source != "user":
        return None
    if start_offset < 0 or start_offset > file_size:
        start_offset = 0
        pending_turn_offset = None
        pending_commentary_offset = None
    if pending_turn_offset is not None and not (0 <= pending_turn_offset <= start_offset):
        raise RuntimeError(f"pending user offset is outside the safe cursor: {path}")
    if pending_commentary_offset is not None and not (0 <= pending_commentary_offset < start_offset):
        raise RuntimeError(f"pending commentary offset is outside the safe cursor: {path}")
    if pending_commentary_offset is not None and pending_turn_offset is None:
        raise RuntimeError(f"pending commentary exists without a pending user event: {path}")
    if pending_commentary_offset is not None and pending_turn_offset is not None and pending_turn_offset >= start_offset:
        raise RuntimeError(f"pending commentary cannot be reloaded before its user event: {path}")

    turns: list[QaTurn] = []
    current: QaTurn | None = None
    user_row_type = ""
    commentary_buffer: list[AssistantAnswer] = []
    committed_offset = start_offset
    turn_start_offset = start_offset
    last_commentary_offset: int | None = None
    turn_reloadable = True
    commentary_reloadable = True
    incomplete_tail_offset: int | None = None

    if pending_turn_offset is not None and 0 <= pending_turn_offset < start_offset:
        loaded = read_event_at_offset(path, pending_turn_offset)
        if loaded is None:
            raise RuntimeError(f"pending user event cannot be safely reloaded at offset {pending_turn_offset}: {path}")
        row, payload = loaded
        message = str(payload.get("message", "")).strip()
        if payload.get("type") != "user_message" or should_skip_user_message(message):
            raise RuntimeError(f"pending user offset does not reference a recordable user event: {path}")
        current = QaTurn(question_time=str(row.get("timestamp", "")), question=message)
        user_row_type = row["type"]
        turn_start_offset = pending_turn_offset
    if current is not None and pending_commentary_offset is not None and 0 <= pending_commentary_offset < start_offset:
        loaded = read_event_at_offset(path, pending_commentary_offset)
        if loaded is None:
            raise RuntimeError(
                f"pending commentary event cannot be safely reloaded at offset {pending_commentary_offset}: {path}"
            )
        row, payload = loaded
        message = str(payload.get("message", "")).strip()
        if payload.get("type") != "agent_message" or not message:
            raise RuntimeError(f"pending commentary offset does not reference an assistant event: {path}")
        commentary_buffer.append(
            AssistantAnswer(
                timestamp=str(row.get("timestamp", "")),
                text=message,
                phase=str(payload.get("phase", "")),
            )
        )
        last_commentary_offset = pending_commentary_offset

    with path.open("rb") as handle:
        handle.seek(start_offset)
        while True:
            line_start = handle.tell()
            raw_line = handle.readline()
            if not raw_line:
                break
            line_end = handle.tell()
            try:
                row = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                # A concurrently written EOF prefix is retried from its start.
                # A complete malformed JSONL line is irrecoverable and skipped.
                if not raw_line.endswith(b"\n"):
                    incomplete_tail_offset = line_start
                    break
                committed_offset = line_end
                continue

            # Valid JSON is complete even if the writer has not appended the
            # optional trailing LF yet. It is safe to process and commit.
            committed_offset = line_end

            payload = message_payload(row)
            if not payload:
                continue
            row_type = row["type"]
            timestamp = str(row.get("timestamp", ""))
            event_type = payload.get("type")
            if event_type == "user_message":
                message = str(payload.get("message", "")).strip()
                # Machine-injected user events are transparent. They must not
                # close a real main-thread turn that is waiting for its final.
                if should_skip_user_message(message):
                    continue
                if current is not None and user_row_type != row_type and current.question == message:
                    if row_type == "event_msg" and last_commentary_offset is None:
                        current.question_time = timestamp
                        user_row_type = row_type
                        turn_start_offset = line_start
                        turn_reloadable = len(raw_line) <= MAX_PENDING_EVENT_BYTES
                    continue
                if current is not None:
                    finish_turn(current, commentary_buffer, turns)
                commentary_buffer = []
                last_commentary_offset = None
                current = QaTurn(question_time=timestamp, question=message)
                user_row_type = row_type
                turn_start_offset = line_start
                turn_reloadable = len(raw_line) <= MAX_PENDING_EVENT_BYTES
                continue

            if event_type == "agent_message" and current is not None:
                phase = str(payload.get("phase", ""))
                message = str(payload.get("message", "")).strip()
                if not message:
                    continue
                if row_type == "response_item" and phase == "commentary" and not include_commentary:
                    continue
                answer = AssistantAnswer(timestamp=timestamp, text=message, phase=phase)
                if phase == "final_answer":
                    current.answers.append(answer)
                    turns.append(current)
                    current = None
                    commentary_buffer = []
                    last_commentary_offset = None
                elif include_commentary:
                    current.answers.append(answer)
                    last_commentary_offset = line_start
                    commentary_reloadable = len(raw_line) <= MAX_PENDING_EVENT_BYTES
                else:
                    commentary_buffer.append(answer)
                    last_commentary_offset = line_start
                    commentary_reloadable = len(raw_line) <= MAX_PENDING_EVENT_BYTES
                continue

        eof_offset = handle.tell()

    safe_eof_offset = incomplete_tail_offset if incomplete_tail_offset is not None else eof_offset
    committed_offset = max(committed_offset, safe_eof_offset)
    if current is not None and not turn_reloadable:
        if user_row_type != "response_item":
            raise RuntimeError(f"pending user event exceeds the {MAX_PENDING_EVENT_BYTES}-byte reload bound: {path}")
        # A response_item can include a large attachment. Retry from its
        # start once the file grows, without storing the message in state.
        committed_offset = turn_start_offset
        last_commentary_offset = None
        commentary_reloadable = True
    if current is not None and last_commentary_offset is not None and not commentary_reloadable:
        raise RuntimeError(f"pending commentary event exceeds the reload bound: {path}")
    next_turn_offset = turn_start_offset if current is not None else None
    next_commentary_offset = last_commentary_offset if current is not None else None

    return IncrementalSessionDiary(
        meta=meta,
        turns=turns,
        committed_offset=committed_offset,
        file_size=file_size,
        pending_turn=current is not None,
        pending_turn_offset=next_turn_offset,
        pending_commentary_offset=next_commentary_offset,
    )


def finish_turn(
    current: QaTurn | None,
    commentary_buffer: list[AssistantAnswer],
    turns: list[QaTurn],
) -> QaTurn | None:
    if current is None:
        return None
    if not current.answers and commentary_buffer:
        last = commentary_buffer[-1]
        current.answers.append(
            AssistantAnswer(timestamp=last.timestamp, text=last.text, phase=last.phase, provisional=True)
        )
    if current.answers:
        turns.append(current)
    return None


def should_skip_user_message(message: str) -> bool:
    stripped = message.strip()
    return not stripped or stripped.startswith((
        "<subagent_notification>",
        "<environment_context>",
        "<recommended_plugins>",
        "<turn_aborted>",
        "<codex_delegation>",
        "# AGENTS.md instructions for ",
    ))
