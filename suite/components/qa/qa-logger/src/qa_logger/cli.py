from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

from .diary import build_recorded_turn_keys, rebuild_day_indexes, write_session_diary
from .history_compactor import compact_diary
from .session_reader import SessionDiary, iter_session_files, parse_session_file, parse_session_file_incremental


DEFAULT_SESSIONS_ROOT = Path.home() / ".codex" / "sessions"
DEFAULT_ARCHIVED_ROOT = Path.home() / ".codex" / "archived_sessions"
DEFAULT_DIARY_ROOT = Path.home() / ".codex" / "qa-diary"
DEFAULT_STATE_PATH = DEFAULT_DIARY_ROOT / "_watcher" / "scan-state.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="qa_logger", description="Local Codex QA Diary prototype")
    subcommands = parser.add_subparsers(dest="command", required=True)

    scan = subcommands.add_parser("scan-sessions", help="Scan Codex session JSONL and append main-agent Q/A diary")
    scan.add_argument("--sessions-root", type=Path, default=DEFAULT_SESSIONS_ROOT)
    scan.add_argument("--archived-root", type=Path, default=DEFAULT_ARCHIVED_ROOT)
    scan.add_argument("--include-archived", action="store_true")
    scan.add_argument("--diary-root", type=Path, default=DEFAULT_DIARY_ROOT)
    scan.add_argument("--include-commentary", action="store_true")
    scan.add_argument("--dry-run", action="store_true")
    scan.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
    scan.add_argument("--no-state", action="store_true")
    scan.add_argument("--provisional-after-seconds", type=int, default=300)

    compact = subcommands.add_parser("compact-diary", help="Compact existing QA diary answer bodies")
    compact.add_argument("--diary-root", type=Path, default=DEFAULT_DIARY_ROOT)
    compact.add_argument("--start-day", required=True)
    compact.add_argument("--end-day", required=True)
    compact.add_argument("--dry-run", action="store_true")
    compact.add_argument("--backup-root", type=Path)

    watch = subcommands.add_parser("watch", help="Poll Codex sessions and append diary entries")
    watch.add_argument("--sessions-root", type=Path, default=DEFAULT_SESSIONS_ROOT)
    watch.add_argument("--archived-root", type=Path, default=DEFAULT_ARCHIVED_ROOT)
    watch.add_argument("--include-archived", action="store_true")
    watch.add_argument("--diary-root", type=Path, default=DEFAULT_DIARY_ROOT)
    watch.add_argument("--include-commentary", action="store_true")
    watch.add_argument("--poll-seconds", type=int, default=15)
    watch.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
    watch.add_argument("--no-state", action="store_true")
    watch.add_argument("--provisional-after-seconds", type=int, default=300)

    args = parser.parse_args(argv)
    if args.command == "scan-sessions":
        summary = scan_sessions(
            sessions_root=args.sessions_root,
            diary_root=args.diary_root,
            archived_root=args.archived_root,
            include_archived=args.include_archived,
            include_commentary=args.include_commentary,
            dry_run=args.dry_run,
            state_path=None if args.no_state else args.state_path,
            provisional_after_seconds=args.provisional_after_seconds,
        )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    if args.command == "compact-diary":
        summary = compact_diary(
            diary_root=args.diary_root,
            start_day=args.start_day,
            end_day=args.end_day,
            dry_run=args.dry_run,
            backup_root=args.backup_root,
        )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    if args.command == "watch":
        while True:
            summary = scan_sessions(
                sessions_root=args.sessions_root,
                diary_root=args.diary_root,
                archived_root=args.archived_root,
                include_archived=args.include_archived,
                include_commentary=args.include_commentary,
                dry_run=False,
                state_path=None if args.no_state else args.state_path,
                provisional_after_seconds=args.provisional_after_seconds,
            )
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
            time.sleep(max(args.poll_seconds, 5))
    parser.error("unknown command")
    return 2


def scan_sessions(
    sessions_root: Path,
    diary_root: Path,
    archived_root: Path | None = None,
    include_archived: bool = False,
    include_commentary: bool = False,
    dry_run: bool = False,
    state_path: Path | None = None,
    provisional_after_seconds: int = 300,
) -> dict[str, object]:
    roots = [("sessions", sessions_root)]
    if include_archived and archived_root is not None:
        roots.append(("archived_sessions", archived_root))
    parsed = []
    turn_count = 0
    written_paths: set[str] = set()
    root_stats: list[dict[str, object]] = []
    seen_paths: set[Path] = set()
    use_state = state_path is not None and not dry_run
    scan_state = load_scan_state(state_path) if use_state and state_path is not None else {"version": 1, "files": {}}
    file_state = scan_state.setdefault("files", {})
    recorded_keys = build_recorded_turn_keys(diary_root) if not dry_run else None
    total_processed = 0
    total_bytes_read = 0
    for label, root in roots:
        files = [path for path in iter_session_files(root) if path not in seen_paths]
        seen_paths.update(files)
        root_with_qa = 0
        root_turns = 0
        root_first: str | None = None
        root_last: str | None = None
        root_processed = 0
        root_bytes_read = 0
        for path in files:
            session: SessionDiary | None
            if use_state:
                stat = path.stat()
                state_key = str(path.resolve()).lower()
                previous = file_state.get(state_key) if isinstance(file_state.get(state_key), dict) else {}
                start_offset = int(previous.get("committed_offset", 0))
                pending_turn_offset = previous.get("pending_turn_offset")
                pending_commentary_offset = previous.get("pending_commentary_offset")
                pending_turn_offset = int(pending_turn_offset) if pending_turn_offset is not None else None
                pending_commentary_offset = (
                    int(pending_commentary_offset) if pending_commentary_offset is not None else None
                )
                if start_offset < 0 or start_offset > stat.st_size:
                    start_offset = 0
                    pending_turn_offset = None
                    pending_commentary_offset = None
                if (
                    int(previous.get("incremental_version", 0)) >= 2
                    and int(previous.get("size", -1)) == stat.st_size
                    and int(previous.get("mtime_ns", -1)) == stat.st_mtime_ns
                ):
                    continue
                finalize_provisional = (time.time() - stat.st_mtime) >= max(provisional_after_seconds, 0)
                incremental = parse_session_file_incremental(
                    path,
                    start_offset=start_offset,
                    include_commentary=include_commentary,
                    finalize_provisional=finalize_provisional,
                    pending_turn_offset=pending_turn_offset,
                    pending_commentary_offset=pending_commentary_offset,
                )
                root_processed += 1
                total_processed += 1
                if incremental is None:
                    file_state[state_key] = {
                        "committed_offset": stat.st_size,
                        "size": stat.st_size,
                        "mtime_ns": stat.st_mtime_ns,
                        "thread_source": "subagent",
                        "incremental_version": 2,
                    }
                    continue
                # Sub-agent files are rejected after their first metadata row;
                # count only the main-thread byte range actually eligible for
                # incremental parsing rather than the skipped file's full size.
                bytes_delta = max(0, stat.st_size - start_offset)
                root_bytes_read += bytes_delta
                total_bytes_read += bytes_delta
                file_state[state_key] = {
                    "committed_offset": incremental.committed_offset,
                    "size": stat.st_size,
                    "mtime_ns": stat.st_mtime_ns,
                    "pending_turn": incremental.pending_turn,
                    "pending_turn_offset": incremental.pending_turn_offset,
                    "pending_commentary_offset": incremental.pending_commentary_offset,
                    "session_id": incremental.meta.session_id,
                    "thread_source": incremental.meta.thread_source,
                    "incremental_version": 2,
                }
                session = SessionDiary(meta=incremental.meta, turns=incremental.turns)
            else:
                session = parse_session_file(path, include_commentary=include_commentary)
            if session is None:
                continue
            if not session.turns:
                continue
            parsed.append(session)
            root_with_qa += 1
            root_turns += len(session.turns)
            turn_count += len(session.turns)
            for turn in session.turns:
                day = local_day(turn.question_time)
                root_first = day if root_first is None or day < root_first else root_first
                root_last = day if root_last is None or day > root_last else root_last
            if not dry_run:
                for written in write_session_diary(
                    diary_root,
                    session,
                    recorded_keys=recorded_keys,
                    rebuild_indexes=False,
                ):
                    written_paths.add(str(written))
        root_stats.append(
            {
                "label": label,
                "root": str(root),
                "sessions_seen": len(files),
                "sessions_processed": root_processed if use_state else len(files),
                "sessions_with_qa": root_with_qa,
                "turns_seen": root_turns,
                "bytes_read": root_bytes_read if use_state else None,
                "first_day": root_first,
                "last_day": root_last,
            }
        )
    if written_paths and not dry_run:
        rebuild_day_indexes(diary_root)
    if use_state and state_path is not None:
        save_scan_state(state_path, scan_state)
    return {
        "sessions_root": str(sessions_root),
        "archived_root": str(archived_root) if archived_root is not None else None,
        "diary_root": str(diary_root),
        "include_archived": include_archived,
        "roots": root_stats,
        "sessions_seen": sum(int(item["sessions_seen"]) for item in root_stats),
        "sessions_processed": total_processed if use_state else sum(int(item["sessions_seen"]) for item in root_stats),
        "sessions_with_qa": len(parsed),
        "turns_seen": turn_count,
        "bytes_read": total_bytes_read if use_state else None,
        "written_files": sorted(written_paths),
        "dry_run": dry_run,
        "state_path": str(state_path) if use_state and state_path is not None else None,
    }


def load_scan_state(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"version": 1, "files": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "files": {}}
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("files"), dict):
        return {"version": 1, "files": {}}
    return state


def save_scan_state(path: Path, state: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    temp_path.replace(path)


def local_day(timestamp: str) -> str:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().date().isoformat()
