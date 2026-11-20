from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
import re
import shutil

from .diary import compact_answer_text


ANSWER_HEADING_RE = re.compile(r"^A\d+ \[[0-9:]+\]( provisional)?:\n\n", re.MULTILINE)
NEXT_SECTION_RE = re.compile(r"^(?:A\d+ \[[0-9:]+\](?: provisional)?:|## Q .*)\n\n", re.MULTILINE)


@dataclass
class CompactFileResult:
    path: str
    answers_seen: int
    answers_changed: int
    bytes_before: int
    bytes_after: int
    lines_before: int
    lines_after: int

    @property
    def changed(self) -> bool:
        return self.answers_changed > 0


def compact_diary(
    diary_root: Path,
    start_day: str,
    end_day: str,
    dry_run: bool = False,
    backup_root: Path | None = None,
) -> dict[str, object]:
    if start_day > end_day:
        raise ValueError("start_day must be earlier than or equal to end_day")

    diary_root = diary_root.expanduser()
    day_dirs = [
        path
        for path in sorted(diary_root.iterdir() if diary_root.exists() else [])
        if path.is_dir() and start_day <= path.name <= end_day
    ]
    planned: list[tuple[Path, CompactFileResult, str]] = []
    all_results: list[CompactFileResult] = []
    for day_dir in day_dirs:
        for path in iter_body_markdown(day_dir):
            result, updated = compact_file(path, diary_root)
            all_results.append(result)
            if result.changed:
                planned.append((path, result, updated))

    actual_backup_root: Path | None = None
    if planned and not dry_run:
        actual_backup_root = backup_root or default_backup_root(diary_root)
        actual_backup_root.mkdir(parents=True, exist_ok=False)
        for day_dir in day_dirs:
            shutil.copytree(day_dir, actual_backup_root / day_dir.name)
        for path, _result, updated in planned:
            path.write_text(updated, encoding="utf-8")

    return build_summary(
        diary_root=diary_root,
        start_day=start_day,
        end_day=end_day,
        dry_run=dry_run,
        backup_root=actual_backup_root,
        day_dirs=day_dirs,
        results=all_results,
    )


def iter_body_markdown(day_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for name in ("projects", "general"):
        folder = day_dir / name
        if folder.exists():
            paths.extend(sorted(folder.glob("*.md")))
    return paths


def compact_file(path: Path, diary_root: Path) -> tuple[CompactFileResult, str]:
    original = path.read_text(encoding="utf-8", errors="ignore")
    pieces: list[str] = []
    cursor = 0
    answers_seen = 0
    answers_changed = 0

    for match in ANSWER_HEADING_RE.finditer(original):
        if match.start() < cursor:
            continue
        end = next_section_start(original, match.end())
        section = original[match.start() : end]
        body = original[match.end() : end]
        body_text = body.strip("\n")
        provisional = bool(match.group(1))
        answers_seen += 1

        replacement = section
        if body_text and "Diary retention:" not in body_text:
            compacted = compact_answer_text(body_text, provisional=provisional)
            if compacted != body_text:
                replacement = f"{match.group(0)}{compacted}\n\n"
                answers_changed += 1

        pieces.append(original[cursor : match.start()])
        pieces.append(replacement)
        cursor = end

    pieces.append(original[cursor:])
    updated = "".join(pieces)
    result = CompactFileResult(
        path=str(path.relative_to(diary_root)).replace("\\", "/"),
        answers_seen=answers_seen,
        answers_changed=answers_changed,
        bytes_before=len(original.encode("utf-8")),
        bytes_after=len(updated.encode("utf-8")),
        lines_before=count_lines(original),
        lines_after=count_lines(updated),
    )
    return result, updated


def next_section_start(text: str, offset: int) -> int:
    match = NEXT_SECTION_RE.search(text, offset)
    return match.start() if match else len(text)


def count_lines(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def default_backup_root(diary_root: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return diary_root.parent / "qa-diary-backups" / f"history-compact-{timestamp}"


def build_summary(
    diary_root: Path,
    start_day: str,
    end_day: str,
    dry_run: bool,
    backup_root: Path | None,
    day_dirs: list[Path],
    results: list[CompactFileResult],
) -> dict[str, object]:
    changed = [result for result in results if result.changed]
    bytes_before = sum(result.bytes_before for result in results)
    bytes_after = sum(result.bytes_after for result in results)
    lines_before = sum(result.lines_before for result in results)
    lines_after = sum(result.lines_after for result in results)
    return {
        "diary_root": str(diary_root),
        "start_day": start_day,
        "end_day": end_day,
        "dry_run": dry_run,
        "backup_root": str(backup_root) if backup_root is not None else None,
        "days_seen": [path.name for path in day_dirs],
        "files_seen": len(results),
        "files_changed": len(changed),
        "answers_seen": sum(result.answers_seen for result in results),
        "answers_changed": sum(result.answers_changed for result in results),
        "bytes_before": bytes_before,
        "bytes_after": bytes_after,
        "bytes_delta": bytes_after - bytes_before,
        "lines_before": lines_before,
        "lines_after": lines_after,
        "lines_delta": lines_after - lines_before,
        "changed_files": [asdict(result) for result in changed],
    }
