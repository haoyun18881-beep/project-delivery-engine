"""Run the local QA, daily extraction and weekly review steps."""

import argparse
from datetime import date, datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from storage import (
    digest, file_digest, inside, json_text, local_path, overlaps, read_json,
    read_path, relative_parts, save_json, workflow_lock,
)


QA_HEADING = re.compile(r"^## Q \d{2}:\d{2} \{#(q-[0-9a-f]{10})\}[ \t]*$", re.MULTILINE)
QA_SOURCE = re.compile(r"\d{4}-\d{2}-\d{2}/(?:projects|general)/[^/\\:]+\.md")
QA_ANCHOR = re.compile(r"q-[0-9a-f]{10}")
PROVISIONAL = re.compile(r"^A\d+ \[\d{2}:\d{2}\] provisional:", re.MULTILINE)
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
SOURCE_NOTE_ID = re.compile(r"^id: qa-([0-9a-f]{24})$", re.MULTILINE)
SOURCE_NOTE_HASH = re.compile(r"^source_sha256: ([0-9a-f]{64})$", re.MULTILINE)
REPORT_ID = re.compile(r"(?:daily|weekly)-[0-9a-f]{24}")
WEEKLY_DECISIONS = {
    "healthy", "duplicate", "conflict", "stale", "broken-link",
    "orphan", "wrong-layer", "source-gap", "read-failed",
}


class MissingEvidence(ValueError):
    pass


def get_config(runtime):
    config = read_json(read_path(runtime, "suite-config.json"))
    if config.get("schema_version") != 1 or not isinstance(config.get("restricted"), list):
        raise ValueError("Unsupported suite configuration")
    config["vault"] = local_path(config["vault"])
    config["sessions"] = local_path(config["sessions"])
    if not config["vault"].is_dir() or not config["sessions"].is_dir():
        raise ValueError("The configured vault and session folders must exist")
    roots = (runtime, config["vault"], config["sessions"])
    if config.get("supplement_sessions"):
        config["supplement_sessions"] = local_path(config["supplement_sessions"])
        if not config["supplement_sessions"].is_dir():
            raise ValueError("The configured supplemental Session folder must exist")
        roots += (config["supplement_sessions"],)
    if any(overlaps(left, right) for i, left in enumerate(roots) for right in roots[i + 1:]):
        raise ValueError("Runtime, vault and sessions must remain separate")
    config["restricted"] = [Path(*relative_parts(value)) for value in config["restricted"]]
    config["notes_dir"] = "/".join(relative_parts(config["notes_dir"]))
    inside(config["vault"], config["notes_dir"])
    return config


def files_under(root, *, excluded=(), skip_hidden=True):
    def raise_walk_error(exc):
        raise exc

    for folder, dirs, files in os.walk(root, onerror=raise_walk_error):
        here = Path(folder)
        dirs[:] = sorted(
            name for name in dirs if (not skip_hidden or not name.startswith("."))
            and (here / name).relative_to(root) not in excluded
        )
        for name in dirs:
            local_path(here / name)
        for name in sorted(files):
            path = here / name
            if (not skip_hidden or not name.startswith(".")) and path.relative_to(root) not in excluded:
                yield path


def logger_root(runtime):
    root = inside(runtime, "qa/qa-logger/src")
    read_path(root, "qa_logger/__main__.py")
    return root


def raw_source(runtime, config, value):
    source = local_path(value)
    for name in ("sessions", "supplement_sessions"):
        root = config.get(name)
        if root and root in source.parents and source.is_file() and source.suffix == ".jsonl":
            sys.path.insert(0, str(logger_root(runtime)))
            return source, name, source.relative_to(root).as_posix()
    raise ValueError("Choose one JSONL file inside a configured Session directory")


def raw_turns(source, query):
    from qa_logger.redact import redact_text
    from qa_logger.diary import turn_anchor
    from qa_logger.session_reader import parse_session_file

    parsed = parse_session_file(source)
    if parsed is None or not SESSION_ID.fullmatch(parsed.meta.session_id):
        return
    for turn in parsed.turns:
        block = redact_text(f"Q: {turn.question}\nA: " + "\n".join(row.text for row in turn.answers), "qa fallback")[0]
        if query and query.casefold() not in block.casefold():
            continue
        yield {
            "session": parsed.meta.session_id, "question_time": turn.question_time,
            "anchor": turn_anchor(parsed.meta.session_id, turn.question_time, turn.question),
            "provisional": not any(answer.phase == "final_answer" and not answer.provisional for answer in turn.answers),
            "excerpt": block[:2600],
        }


def collect(runtime, config):
    # The source directory was chosen in setup. Check possible redirects before
    # invoking upstream, which reads files by path and keeps its own scan cursor.
    for path in files_under(config["sessions"], skip_hidden=False):
        if path.suffix.lower() == ".jsonl" and not local_path(path).is_file():
            raise ValueError("The session tree includes an unsupported file")
    diary = inside(runtime, "qa-diary")
    if diary.exists():
        for path in files_under(diary, skip_hidden=False):
            local_path(path)
    env = {**os.environ, "PYTHONPATH": str(logger_root(runtime))}
    subprocess.run([
        sys.executable, "-B", "-m", "qa_logger", "scan-sessions",
        "--sessions-root", str(config["sessions"]),
        "--diary-root", str(diary),
        "--state-path", str(inside(runtime, "qa-scan-state.json")),
    ], cwd=runtime, env=env, stdout=subprocess.DEVNULL, check=True)


def manifests(runtime, day=None, session=None, item_id=None):
    diary = inside(runtime, "qa-diary")
    if not diary.exists():
        return
    days = [inside(diary, day)] if day else sorted(diary.glob("????-??-??"))
    seen = set()
    for folder in days:
        located = inside(diary, f"{folder.name}/_meta/manifest.jsonl")
        if not located.is_file():
            continue
        with located.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = json.loads(line)
                source = f"{folder.name}/{record['target'].replace(chr(92), '/')}"
                anchor = record["anchor"]
                session_id = record["session"]["id"]
                if not (QA_SOURCE.fullmatch(source) and QA_ANCHOR.fullmatch(anchor) and SESSION_ID.fullmatch(session_id)):
                    raise ValueError("Unexpected QA manifest entry")
                key = digest(f"{session_id}|{anchor}".encode())[:24]
                if key in seen:
                    raise ValueError("Duplicate QA identity in the manifest")
                seen.add(key)
                if (session and session_id != session) or (item_id and key != item_id):
                    continue
                yield {
                    "id": key, "day": folder.name, "source": source, "anchor": anchor,
                    "session": session_id, "question_time": record["question_time"], "route": "diary-manifest",
                }


def qa_block(runtime, item, cache):
    source = item["source"]
    if source not in cache:
        path = inside(runtime, f"qa-diary/{source}")
        if not path.is_file():
            raise MissingEvidence(f"Diary file missing for QA item {item['id']}")
        text = path.read_text(encoding="utf-8")
        headings = list(QA_HEADING.finditer(text))
        parts = {}
        for i, heading in enumerate(headings):
            anchor = heading.group(1)
            if anchor in parts:
                raise ValueError("Repeated QA anchor in a diary")
            end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
            parts[anchor] = text[heading.end():end].strip()
        cache[source] = parts
    block = cache[source].get(item["anchor"])
    if block is None:
        raise MissingEvidence(f"Diary block missing for QA item {item['id']}")
    return block


def supplementary(runtime, config, seen, wanted=None):
    directory = inside(runtime, "supplements")
    for path in sorted(directory.glob("*.json")):
        if path.stem in seen or (wanted is not None and path.stem not in wanted):
            continue
        stored = read_json(local_path(path))
        item, excerpt = stored["item"], stored["excerpt"]
        if item["id"] != path.stem or digest(excerpt.encode("utf-8")) != item["sha256"]:
            raise ValueError("Saved Session supplement failed its content check")
        root_key = stored["source_root"]
        if root_key not in ("sessions", "supplement_sessions") or not config.get(root_key):
            continue
        source = inside(config[root_key], item["source"])
        if source.is_file() and file_digest(source) == stored["source_sha256"]:
            yield item, excerpt


def supplement(runtime, config, file, query):
    raw, root_key, relative = raw_source(runtime, config, file)
    fingerprint = file_digest(raw)
    matches = list(raw_turns(raw, query))
    if len(matches) != 1 or matches[0]["provisional"]:
        raise ValueError("Choose a query that identifies one final answer in this Session")
    if file_digest(raw) != fingerprint:
        raise ValueError("The Session changed during extraction; retry with a stable source file")
    item = matches[0]
    key = digest(f"{item['session']}|{item['anchor']}".encode())[:24]
    if next(manifests(runtime, item_id=key), None):
        raise ValueError("This turn already has an organized diary entry")
    excerpt = item.pop("excerpt")
    day = datetime.fromisoformat(item["question_time"].replace("Z", "+00:00")).astimezone().date().isoformat()
    item.update({
        "id": key, "day": day, "source": relative, "route": "session-supplement",
        "sha256": digest(excerpt.encode("utf-8")),
    })
    path = inside(runtime, f"supplements/{key}.json")
    record = {"item": item, "excerpt": excerpt, "source_root": root_key, "source_sha256": fingerprint}
    if path.is_file() and read_json(path) == record:
        return {"recorded": False, "already_recorded": True, **item}
    save_json(path, record)
    return {"recorded": True, "already_recorded": False, **item}


def qa_index(runtime, config, wanted=None, *, report_gaps=False):
    # Use a one-document cache so a large diary need not be retained in memory.
    cache = {}
    previous = None
    seen = set()
    for item in manifests(runtime):
        if wanted is not None and item["id"] not in wanted:
            continue
        seen.add(item["id"])
        if item["source"] != previous:
            cache.clear()
            previous = item["source"]
        try:
            block = qa_block(runtime, item, cache)
        except MissingEvidence:
            if not report_gaps:
                raise
            continue
        yield {
            **item, "sha256": digest(block.encode("utf-8")),
            "provisional": bool(PROVISIONAL.search(block)),
        }
    for item, _ in supplementary(runtime, config, seen, wanted):
        yield item


def print_result(payload):
    print(json.dumps(payload, ensure_ascii=False))


def evidence(runtime, config, args):
    sys.path.insert(0, str(logger_root(runtime)))
    from qa_logger.redact import redact_text

    if args.raw_session:
        if args.day or args.session or args.id:
            raise ValueError("--raw-session is a separate evidence route")
        file, _, relative = raw_source(runtime, config, args.raw_session)
        results = []
        for turn in raw_turns(file, args.query):
            results.append({**turn, "source": relative})
            if len(results) == args.limit:
                break
        return {"route": "raw-session", "limit": args.limit, "items": results}

    if not (args.id or args.session or args.day):
        raise ValueError("Use --id, --session or --day; use --query with --day for a bounded keyword search")
    if args.day:
        date.fromisoformat(args.day)
    found = []
    cache = {}
    seen = set()
    for item in manifests(runtime, args.day, args.session, args.id):
        seen.add(item["id"])
        block = qa_block(runtime, item, cache)
        if args.query and args.query.casefold() not in block.casefold():
            continue
        found.append({
            **item, "sha256": digest(block.encode("utf-8")),
            "provisional": bool(PROVISIONAL.search(block)),
            "excerpt": redact_text(block, "qa evidence")[0][:2600],
        })
        if len(found) == args.limit:
            break
    if len(found) < args.limit:
        wanted = {args.id} if args.id else None
        for item, excerpt in supplementary(runtime, config, seen, wanted):
            if (args.session and item["session"] != args.session) or (args.day and item["day"] != args.day):
                continue
            if args.query and args.query.casefold() not in excerpt.casefold():
                continue
            found.append({**item, "excerpt": excerpt})
            if len(found) == args.limit:
                break
    routes = {item["route"] for item in found}
    route = next(iter(routes)) if len(routes) == 1 else "diary-and-supplements" if routes else "diary-manifest"
    return {"route": route, "limit": args.limit, "items": found}


def ledger(runtime):
    path = inside(runtime, "daily-ledger.json")
    return read_json(path) if path.is_file() else {}


def queue_report(runtime, kind, items):
    record = {"items": items}
    if kind == "weekly":
        record["captured_on"] = date.today().isoformat()
    report_id = snapshot_id(kind, record)
    path = inside(runtime, f"reports/{report_id}.json")
    save_json(path, {"id": report_id, **record})
    return {"snapshot": str(path), "snapshot_id": report_id, "items": len(items)}


def snapshot_id(kind, record):
    return f"{kind}-{digest(json_text(record).encode('utf-8'))[:24]}"


def daily(runtime, config, limit):
    collect(runtime, config)
    records = ledger(runtime)
    current = list(qa_index(runtime, config))
    current_ids = {item["id"] for item in current}
    pending = [item for item in current if records.get(item["id"], {}).get("sha256") != item["sha256"]]
    deferred = sum(
        record.get("decision") == "defer" and item_id in current_ids
        for item_id, record in records.items()
    )
    report = queue_report(runtime, "daily", pending[:limit]) if pending else {"items": 0}
    return {
        **report, "total_pending": len(pending), "deferred": deferred,
        "previously_reviewed_source_missing": len(set(records) - current_ids),
    }


def wiki_index(runtime, config):
    vault = config["vault"]
    notes_dir = inside(vault, config["notes_dir"])
    pages, references = [], {}
    for path in files_under(vault, excluded=config["restricted"]):
        if path.suffix.lower() != ".md":
            continue
        data = local_path(path).read_bytes()
        relative = path.relative_to(vault).as_posix()
        page = {"path": relative, "sha256": digest(data)}
        if notes_dir in path.parents:
            lines = data.decode("utf-8-sig").replace("\r\n", "\n").split("---", 2)
            if len(lines) == 3 and not lines[0].strip():
                note_id = SOURCE_NOTE_ID.search(lines[1])
                note_digest = SOURCE_NOTE_HASH.search(lines[1])
                if note_id and note_digest:
                    references[relative] = (note_id.group(1), note_digest.group(1))
        pages.append(page)
    if references:
        wanted = {key for key, _ in references.values()}
        source_hashes = {
            item["id"]: item["sha256"]
            for item in qa_index(runtime, config, wanted, report_gaps=True)
        }
        for page in pages:
            if page["path"] in references:
                key, expected = references[page["path"]]
                actual = source_hashes.get(key)
                page["qa_source"] = "missing" if not actual else ("match" if actual == expected else "changed")
    return sorted(pages, key=lambda item: item["path"])


def decisions(runtime, report_id, review_path, kind, index_key):
    if not REPORT_ID.fullmatch(report_id) or not report_id.startswith(f"{kind}-"):
        raise ValueError(f"Expected a {kind} snapshot identifier")
    report = read_json(read_path(runtime, f"reports/{report_id}.json"))
    rows = report["items"]
    payload = {name: value for name, value in report.items() if name != "id"}
    if report["id"] != report_id or snapshot_id(kind, payload) != report_id:
        raise ValueError("Snapshot content does not match its identifier")
    review = read_json(local_path(review_path))
    if review["snapshot"] != report_id:
        raise ValueError("Review must name this snapshot")
    accepted = {row[index_key]: row for row in review["items"]}
    if len(accepted) != len(review["items"]) or set(accepted) != {row[index_key] for row in rows}:
        raise ValueError("Review must cover every item exactly once")
    for row in rows:
        if row["sha256"] != accepted[row[index_key]]["sha256"]:
            raise ValueError("Review refers to different input bytes")
    return rows, accepted


def field(row, name, maximum=500):
    value = row.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\n" in value or "\r" in value:
        raise ValueError(f"Review field {name} must be one nonempty line of up to {maximum} characters")
    return value.strip()


def apply_daily(runtime, config, args):
    rows, reviewed = decisions(runtime, args.snapshot, args.review, "daily", "id")
    records = ledger(runtime)
    latest = {item["id"]: item for item in qa_index(runtime, config, {row["id"] for row in rows})}
    pending_writes = {}
    for item in rows:
        key = item["id"]
        if latest.get(key) != item:
            raise ValueError("QA source has changed or disappeared. Run daily and review the new snapshot.")
        row = reviewed[key]
        decision = row["decision"]
        record = {**item, "decision": decision, "reason": field(row, "reason")}
        if decision == "keep":
            if item["provisional"]:
                raise ValueError("A provisional QA answer needs final evidence before it can be kept")
            relative = f"{config['notes_dir']}/qa-{key}.md"
            destination = inside(config["vault"], relative)
            note_rel = Path(*relative_parts(relative))
            if any(note_rel == path or path in note_rel.parents for path in config["restricted"]):
                raise ValueError("The managed daily note folder is restricted")
            frontmatter = (
                "---\n"
                f"id: qa-{key}\nstatus: evidence-backed\nas_of: {item['day']}\n"
                f"source_sha256: {item['sha256']}\n---\n"
            )
            label = "Session 补证" if item["route"] == "session-supplement" else "QA 日记"
            body = (
                f"\n# {field(row, 'title', 90)}\n\n{field(row, 'takeaway')}\n\n"
                f"适用条件：{field(row, 'applies_when')}\n\n适用边界：{field(row, 'limits')}\n\n"
                f"来源：{label} {item['day']} · {item['source']}#{item['anchor']} · 会话 {item['session']} · 定位编号 {key}\n"
            )
            text = frontmatter + body
            if destination.exists():
                if destination.read_text(encoding="utf-8") != text:
                    raise ValueError(f"Existing note requires a separate review: {relative}")
            else:
                pending_writes[destination] = text
            record["note"] = relative
        elif decision not in ("skip", "defer"):
            raise ValueError("Daily decision must be keep, skip or defer")
        old = records.get(key)
        if old and old["sha256"] == item["sha256"] and old != record:
            raise ValueError("That input version already has a different recorded decision")
        records[key] = record
    for path, contents in pending_writes.items():
        # Exclusive create preserves a note made by somebody else during review.
        local_path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(contents)
    save_json(inside(runtime, "daily-ledger.json"), records)
    return {"reviewed": len(rows), "notes_created": len(pending_writes)}


def apply_weekly(runtime, config, args):
    rows, reviewed = decisions(runtime, args.snapshot, args.review, "weekly", "path")
    if wiki_index(runtime, config) != rows:
        raise ValueError("The wiki scope or inputs changed; make a new snapshot")
    report = []
    for item in rows:
        row = reviewed[item["path"]]
        if row["decision"] not in WEEKLY_DECISIONS:
            raise ValueError("Unsupported weekly decision")
        if item.get("qa_source") in ("missing", "changed") and row["decision"] == "healthy":
            raise ValueError("A note with missing or changed evidence cannot be marked healthy")
        report.append({**item, "decision": row["decision"], "reason": field(row, "reason")})
    path = inside(runtime, f"reports/{args.snapshot}-reviewed.json")
    result = {"snapshot": args.snapshot, "items": report}
    if path.is_file() and read_json(path) != result:
        raise ValueError("This snapshot already has a different review")
    save_json(path, result)
    return {
        "reviewed": len(report),
        "findings": sum(item["decision"] not in ("healthy", "read-failed") for item in report),
        "source_gaps": sum(item.get("qa_source") in ("missing", "changed") for item in report),
        "read_failed": sum(item["decision"] == "read-failed" for item in report),
        "report": str(path),
    }


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runtime", type=Path, default=Path(__file__).resolve().parent,
        help="configured runtime (defaults to the directory of the installed workflow)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("collect", help="collect the selected sessions into the local QA diary")
    supplement_parser = commands.add_parser("supplement", help="queue one final turn missing from the diary")
    supplement_parser.add_argument("--raw-session", required=True)
    supplement_parser.add_argument("--query", required=True)
    daily_parser = commands.add_parser("daily", help="collect QA and prepare one batch of incremental input")
    daily_parser.add_argument("--limit", type=positive_int, default=100)
    evidence_parser = commands.add_parser("evidence", help="read bounded QA evidence")
    for name in ("id", "session", "day", "query", "raw-session"):
        evidence_parser.add_argument("--" + name)
    evidence_parser.add_argument("--limit", type=positive_int, choices=range(1, 11), default=5)
    commands.add_parser("weekly", help="snapshot eligible wiki pages for semantic review")
    for name in ("daily", "weekly"):
        apply_parser = commands.add_parser("apply-" + name, help="validate and record the matching semantic review")
        apply_parser.add_argument("--snapshot", required=True)
        apply_parser.add_argument("--review", required=True, type=Path)
    args = parser.parse_args()
    runtime = local_path(args.runtime)
    config = get_config(runtime)
    if args.command == "evidence":
        result = evidence(runtime, config, args)
    else:
        with workflow_lock(runtime):
            if args.command == "collect":
                collect(runtime, config)
                result = {"collected": True}
            elif args.command == "daily":
                result = daily(runtime, config, args.limit)
            elif args.command == "supplement":
                result = supplement(runtime, config, args.raw_session, args.query)
            elif args.command == "weekly":
                result = queue_report(runtime, "weekly", wiki_index(runtime, config))
            elif args.command == "apply-daily":
                result = apply_daily(runtime, config, args)
            else:
                result = apply_weekly(runtime, config, args)
    print_result(result)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, ValueError, TypeError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"Workflow stopped: {exc}") from None
