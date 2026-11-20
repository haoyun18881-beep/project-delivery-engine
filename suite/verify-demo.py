"""Rehearse the complete workflow on the untouched synthetic demo from setup.py."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from setup import DEMO_ARCHIVED_ID, DEMO_ID
from storage import digest, local_path, read_json, save_json


def call(*argv, expect_failure=False):
    result = subprocess.run(
        list(map(str, argv)), capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    if expect_failure and result.returncode:
        return result.stderr
    if result.returncode or expect_failure:
        raise ValueError(result.stderr.strip() or "Unexpected command result")
    return json.loads(result.stdout)


def require(condition, meaning):
    if not condition:
        raise ValueError(meaning)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    root = local_path(parser.parse_args().root)
    runtime = root / "runtime"
    config = read_json(local_path(runtime / "suite-config.json"))
    vault, sessions, project = root / "wiki", root / "sample-sessions", root / "报名工具"
    fixtures = list(sessions.glob("*.jsonl"))
    archives = list((root / "sample-archive").glob("*.jsonl"))
    require(
        config.get("demo_session") == DEMO_ID
        and config.get("vault") == str(vault) and config.get("sessions") == str(sessions)
        and config.get("supplement_sessions") == str(root / "sample-archive")
        and len(fixtures) == 1 and DEMO_ID in fixtures[0].name
        and len(archives) == 1 and DEMO_ARCHIVED_ID in archives[0].name,
        "Point --root to a new synthetic demo created by setup.py",
    )
    require(not (runtime / "daily-ledger.json").exists(), "Use a fresh demo for this rehearsal")
    tool = project / ".agents" / "skills" / "project-delivery-engine" / "scripts" / "project-gov.mjs"
    startup = call("node", tool, "startup", "--root", project, "--json")
    require(startup["ok"] and "验证空名单导出" in (project / "TODO.md").read_text(encoding="utf-8"),
            "Project startup or its next action is missing")

    def workflow(*args, **kwargs):
        return call(sys.executable, "-B", runtime / "workflow.py", *args, **kwargs)

    source_hash = digest(fixtures[0].read_bytes())
    archive_hash = digest(archives[0].read_bytes())
    initial = workflow("daily")
    require(initial["total_pending"] == 2, "Expected two new synthetic Q/A turns")
    evidence = workflow("evidence", "--session", DEMO_ID)
    require(evidence["route"] == "diary-manifest" and len(evidence["items"]) == 2, "Could not follow the diary manifest")
    item, greeting = evidence["items"]
    require("离线核对名单" in item["excerpt"] and item["anchor"].startswith("q-"), "Missing quoted decision or anchor")
    gap = workflow("evidence", "--session", DEMO_ARCHIVED_ID)
    require(gap["items"] == [], "The archival Session was already present in the diary")
    fallback_args = ("--raw-session", archives[0], "--query", "断网时")
    fallback = workflow("evidence", *fallback_args)
    require(fallback["route"] == "raw-session" and "导出时间" in fallback["items"][0]["excerpt"], "The raw fallback missed the archival evidence")
    restored = workflow("supplement", *fallback_args)
    require(restored["route"] == "session-supplement", "The missing item was not registered as a supplement")
    initial = workflow("daily")
    require(initial["total_pending"] == 3, "Daily did not include the missing item from the Session")
    daily_review = runtime / "demo-daily-review.json"
    rows = [
        {
            "id": restored["id"], "sha256": restored["sha256"], "decision": "keep",
            "reason": "记录了可以迁移到近似场景的离线约束。",
            "title": "断网时保留离线核对名单",
            "takeaway": "预先导出本地 CSV。用断网状态下的一条测试报名验证能核对名单，并显示导出时间。",
            "applies_when": "签到点的网络不稳定，且核对可以基于一份现场快照。",
            "limits": "多人实时编辑或处理敏感名单时，需要重新验证权限、同步和保存方式。",
        },
        {
            "id": greeting["id"], "sha256": greeting["sha256"],
            "decision": "skip", "reason": "礼貌回应，无可复用结论。",
        },
        {
            "id": item["id"], "sha256": item["sha256"], "decision": "skip",
            "reason": "取舍已在项目中保留，可复用的验收动作采用补证条目，避免重复。",
        },
    ]
    save_json(daily_review, {"snapshot": initial["snapshot_id"], "items": rows[:1]})
    apply_args = ("apply-daily", "--snapshot", initial["snapshot_id"], "--review", daily_review)
    require("every item exactly once" in workflow(*apply_args, expect_failure=True), "Incomplete daily review passed")
    save_json(daily_review, {"snapshot": initial["snapshot_id"], "items": rows})
    daily = workflow(*apply_args)
    require(daily == {"reviewed": 3, "notes_created": 1}, "Daily keep/skip did not apply")
    require(workflow(*apply_args)["notes_created"] == 0, "Repeating the accepted review duplicated a note")
    require(workflow("daily")["total_pending"] == 0, "Incremental run repeated accepted sources")
    note = vault / "10-经验库" / "每日提炼" / f"qa-{restored['id']}.md"
    note_text = note.read_text(encoding="utf-8")
    require(restored["anchor"] in note_text and DEMO_ARCHIVED_ID in note_text and "适用条件" in note_text, "Wiki note lost its evidence or scope")
    recall = read_json(project / ".agents" / "skills" / "personal-knowledge-recall" / "local-config.json")
    require(Path(recall["vault_root"]) == vault and (vault / "00-AI入口.md").is_file(), "Recall points at the wrong wiki")

    # Make sure the configured weekly scope excludes private areas in the sample.
    private = vault / "60-个人档案" / "示例私有.md"
    private.parent.mkdir(exist_ok=False)
    private.write_text("# 合成私有页\n", encoding="utf-8")
    example_gap = note.parent / "旧做法待核对.md"
    missing_id = "0" * 24
    missing_hash = "0" * 64
    with example_gap.open("x", encoding="utf-8") as stream:
        stream.write(f"---\nid: qa-{missing_id}\nsource_sha256: {missing_hash}\n---\n\n# 合成缺证页\n\n这里只模拟一篇缺少登记来源的旧笔记。\n")
    weekly = workflow("weekly")
    pages = read_json(Path(weekly["snapshot"]))["items"]
    require(len(pages) == 6 and all(not row["path"].startswith("60-") for row in pages), "Weekly scope omitted a public page or included a restricted page")
    require({page["qa_source"] for page in pages if "qa_source" in page} == {"match", "missing"}, "Weekly did not distinguish supported and missing sources")
    weekly_review = runtime / "demo-weekly-review.json"
    reviewed = [
        {
            **page,
            "decision": "source-gap" if page.get("qa_source") == "missing" else "healthy",
            "reason": "核对到这一版示例页的来源状态。",
        }
        for page in pages
    ]
    save_json(weekly_review, {"snapshot": weekly["snapshot_id"], "items": reviewed})
    week_result = workflow("apply-weekly", "--snapshot", weekly["snapshot_id"], "--review", weekly_review)
    require(week_result["reviewed"] == len(pages) and week_result["read_failed"] == 0 and week_result["source_gaps"] == 1,
            "Weekly review did not cover all eligible pages and report the missing source")
    require(digest(fixtures[0].read_bytes()) == source_hash and digest(archives[0].read_bytes()) == archive_hash,
            "A source Session was unexpectedly changed")
    require(all(digest((vault / page["path"]).read_bytes()) == page["sha256"] for page in pages), "Weekly review changed wiki content")
    print(json.dumps({
        "project_startup": True, "qa_turns": 2, "session_supplements": 1, "daily_reviewed": 3, "wiki_notes_created": 1,
        "incremental_pending": 0, "weekly_pages_reviewed": week_result["reviewed"],
        "weekly_source_gaps": week_result["source_gaps"],
        "wiki_note": str(note), "weekly_report": week_result["report"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, TypeError, ValueError) as exc:
        raise SystemExit(f"Demo stopped: {exc}") from None
