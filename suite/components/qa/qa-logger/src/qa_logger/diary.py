from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
import re

from .redact import redact_text
from .session_reader import AssistantAnswer, QaTurn, SessionDiary
from .slug import project_slug


FINAL_ANSWER_MAX_CHARS = 1800
FINAL_ANSWER_MAX_LINES = 32
PROVISIONAL_ANSWER_MAX_CHARS = 800
PROVISIONAL_ANSWER_MAX_LINES = 14


def write_session_diary(
    diary_root: Path,
    session: SessionDiary,
    recorded_keys: set[str] | None = None,
    rebuild_indexes: bool = True,
) -> list[Path]:
    written: list[Path] = []
    for turn in session.turns:
        day = local_day(turn.question_time)
        day_dir = diary_root / day
        anchor = turn_anchor(session.meta.session_id, turn.question_time, turn.question)
        fingerprint = turn_fingerprint(turn.question_time, turn.question)
        if already_recorded(
            day_dir,
            session.meta.session_id,
            anchor,
            fingerprint,
            turn.question_time,
            recorded_keys=recorded_keys,
        ):
            continue
        project_root = session.meta.cwd
        project_name = Path(project_root).name if project_root else "general"
        if project_root:
            target = day_dir / "projects" / f"{project_slug(project_name, project_root)}.md"
            scope = "projects"
        else:
            target = day_dir / "general" / "general.md"
            scope = "general"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            title = project_name if scope == "projects" else "General"
            target.write_text(f"# {title}\n\n", encoding="utf-8")
        append_turn(target, turn, session)
        write_meta(day_dir, turn, session, target, fingerprint)
        if recorded_keys is not None:
            recorded_keys.add(f"fp:{fingerprint}")
            recorded_keys.add(f"ts:{turn.question_time}")
        written.append(target)
    if written and rebuild_indexes:
        rebuild_day_indexes(diary_root)
    return sorted(set(written))


def append_turn(path: Path, turn: QaTurn, session: SessionDiary) -> None:
    q_text, q_redacted = redact_text(turn.question, "question")
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        anchor = turn_anchor(session.meta.session_id, turn.question_time, turn.question)
        handle.write(f"## Q {short_time(turn.question_time)} {{#{anchor}}}\n\n")
        handle.write(f"Q [{short_time(turn.question_time)}]:\n\n")
        handle.write(f"{q_text}\n\n")
        if q_redacted:
            handle.write("> Redaction: sensitive-looking text was replaced before persistence.\n\n")
        for index, answer in enumerate(turn.answers, start=1):
            retained_text = compact_answer_text(answer.text, provisional=answer.provisional)
            a_text, a_redacted = redact_text(retained_text, f"answer[{index}]")
            marker = " provisional" if answer.provisional else ""
            handle.write(f"A{index} [{short_time(answer.timestamp)}]{marker}:\n\n")
            handle.write(f"{a_text}\n\n")
            if a_redacted:
                handle.write("> Redaction: sensitive-looking text was replaced before persistence.\n\n")


def write_meta(
    day_dir: Path,
    turn: QaTurn,
    session: SessionDiary,
    target: Path,
    fingerprint: str,
) -> None:
    meta_dir = day_dir / "_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "session": {
            "id": session.meta.session_id,
            "path": str(session.meta.path),
            "cwd": session.meta.cwd,
            "originator": session.meta.originator,
            "source": session.meta.source,
            "thread_source": session.meta.thread_source,
        },
        "question_time": turn.question_time,
        "answer_times": [answer.timestamp for answer in turn.answers],
        "target": str(target.relative_to(day_dir)),
        "anchor": turn_anchor(session.meta.session_id, turn.question_time, turn.question),
        "turn_fingerprint": fingerprint,
    }
    manifest = meta_dir / "manifest.jsonl"
    with manifest.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
        handle.write("\n")


def already_recorded(
    day_dir: Path,
    session_id: str,
    anchor: str,
    fingerprint: str,
    question_time: str,
    recorded_keys: set[str] | None = None,
) -> bool:
    if recorded_keys is not None:
        return f"fp:{fingerprint}" in recorded_keys or f"ts:{question_time}" in recorded_keys
    manifest = day_dir / "_meta" / "manifest.jsonl"
    if not manifest.exists():
        return False
    for record in read_manifest(manifest):
        if record.get("turn_fingerprint") == fingerprint:
            return True
        # Legacy manifests did not store a content fingerprint. Codex session
        # forks preserve the original event timestamp, which is therefore the
        # safest backwards-compatible cross-session dedupe key.
        if record.get("question_time") == question_time:
            return True
        if record.get("session", {}).get("id") == session_id and record.get("anchor") == anchor:
            return True
    return False


def build_recorded_turn_keys(diary_root: Path) -> set[str]:
    keys: set[str] = set()
    if not diary_root.exists():
        return keys
    for manifest in diary_root.glob("????-??-??/_meta/manifest.jsonl"):
        for record in read_manifest(manifest):
            fingerprint = str(record.get("turn_fingerprint", "")).strip()
            question_time = str(record.get("question_time", "")).strip()
            if fingerprint:
                keys.add(f"fp:{fingerprint}")
            if question_time:
                keys.add(f"ts:{question_time}")
    return keys


def read_manifest(path: Path) -> list[dict]:
    records: list[dict] = []
    seen: set[tuple[str, str]] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = (
                str(record.get("turn_fingerprint") or record.get("question_time")),
                str(record.get("question_time")),
            )
            if key in seen:
                continue
            seen.add(key)
            records.append(record)
    records.sort(key=lambda item: str(item.get("question_time", "")))
    return records


def rebuild_day_indexes(diary_root: Path) -> None:
    if not diary_root.exists():
        return
    for day_dir in sorted(path for path in diary_root.iterdir() if path.is_dir()):
        manifest = day_dir / "_meta" / "manifest.jsonl"
        if not manifest.exists():
            continue
        records = read_manifest(manifest)
        lines = [
            f"# {day_dir.name}",
            "",
            "## Main-Agent Summary",
            "",
            "<!-- 手动让主 Agent 在这里写当天复盘摘要；脚本不会改这一节。 -->",
            "",
            "## Script Timeline",
            "",
            "| Time | Scope | Topic | File |",
            "| --- | --- | --- | --- |",
        ]
        for record in records:
            target = str(record.get("target", "")).replace("\\", "/")
            question_time = str(record.get("question_time", ""))
            topic = first_question_line(day_dir / target, str(record.get("anchor", "")))
            scope = "Project" if target.startswith("projects/") else "General"
            lines.append(f"| {short_time(question_time)} | {scope} | {escape_cell(topic)} | `{target}` |")
        lines.append("")
        write_index_preserving_summary(day_dir / "_index.md", lines)


def write_index_preserving_summary(path: Path, generated_lines: list[str]) -> None:
    manual_summary = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="ignore")
        start = existing.find("## Main-Agent Summary")
        end = existing.find("## Script Timeline")
        if start != -1 and end != -1 and end > start:
            manual_summary = existing[start:end].strip()
    if manual_summary:
        output: list[str] = []
        skipping_summary = False
        for line in generated_lines:
            if line == "## Main-Agent Summary":
                output.append(manual_summary)
                skipping_summary = True
                continue
            if skipping_summary:
                if line == "## Script Timeline":
                    skipping_summary = False
                    output.append(line)
                continue
            output.append(line)
        path.write_text("\n".join(output), encoding="utf-8")
        return
    path.write_text("\n".join(generated_lines), encoding="utf-8")


def first_question_line(path: Path, anchor: str) -> str:
    if not path.exists():
        return "Q/A"
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    for index, line in enumerate(lines):
        if f"{{#{anchor}}}" in line:
            saw_question_marker = False
            for next_line in lines[index + 1 : index + 12]:
                match = re.match(r"^Q \[[0-9:]+\]:(.*)$", next_line)
                if match:
                    saw_question_marker = True
                    inline = match.group(1).strip()
                    if inline:
                        return inline
                    continue
                if saw_question_marker and next_line.strip():
                    return next_line.strip()[:120]
    return "Q/A"


def local_day(timestamp: str) -> str:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().date().isoformat()


def short_time(timestamp: str) -> str:
    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()
    return dt.strftime("%H:%M")


def turn_anchor(session_id: str, timestamp: str, question: str) -> str:
    import hashlib

    digest = hashlib.sha256(f"{session_id}|{timestamp}|{question}".encode("utf-8")).hexdigest()[:10]
    return f"q-{digest}"


def turn_fingerprint(timestamp: str, question: str) -> str:
    import hashlib

    normalized = " ".join(question.split())
    return hashlib.sha256(f"{timestamp}|{normalized}".encode("utf-8")).hexdigest()[:20]


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def compact_answer_text(text: str, provisional: bool = False) -> str:
    """Keep future diary answers readable without rewriting historical entries."""
    stripped = text.strip()
    if not stripped:
        return stripped
    max_chars = PROVISIONAL_ANSWER_MAX_CHARS if provisional else FINAL_ANSWER_MAX_CHARS
    max_lines = PROVISIONAL_ANSWER_MAX_LINES if provisional else FINAL_ANSWER_MAX_LINES
    lines = stripped.splitlines()
    if len(stripped) <= max_chars and len(lines) <= max_lines:
        return stripped

    tail_lines = 4 if provisional else 8
    head_lines = max(max_lines - tail_lines, 1)
    head = "\n".join(lines[:head_lines]).strip()
    tail = "\n".join(lines[-tail_lines:]).strip() if len(lines) > head_lines else ""

    omitted_lines = max(0, len(lines) - head_lines - (tail_lines if tail else 0))
    omitted_chars = max(0, len(stripped) - len(head) - len(tail))
    note = (
        f"> Diary retention: 该回答已按未来新增 A 粒度收紧，仅保留首尾摘录；"
        f"省略约 {omitted_lines} 行 / {omitted_chars} 字符。"
    )

    budget = max_chars - len(note) - 8
    if budget < 200:
        budget = max_chars
    if len(head) + len(tail) > budget:
        tail_budget = min(360 if not provisional else 160, max(budget // 4, 80))
        head_budget = max(budget - tail_budget, 80)
        head = head[:head_budget].rstrip()
        tail = tail[-tail_budget:].lstrip() if tail else ""

    parts = [head, note]
    if tail:
        parts.append(tail)
    return "\n\n".join(part for part in parts if part).strip()
