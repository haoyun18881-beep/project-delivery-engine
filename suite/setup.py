"""Install the public components, or rehearse with an isolated sample."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from uuid import uuid4

from storage import inside, is_redirect, local_path, overlaps, relative_parts, save_json


SUITE = Path(__file__).resolve().parent
REPO = SUITE.parent
EXAMPLE = REPO / "examples" / "suite"
COMPONENTS = SUITE / "components"
SKILLS = ("project-delivery-engine", "codex-qa-diary-recall", "personal-knowledge-recall")
DEFAULT_RESTRICTED = ("60-个人档案", "75-归档", "80-来源档案")
DEFAULT_NOTES_DIR = "10-经验库/每日提炼"
DEMO_ID = "00000000-0000-4000-8000-000000000123"
DEMO_ARCHIVED_ID = "00000000-0000-4000-8000-000000000124"


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def copy_files(source, target, entries):
    target.mkdir(parents=True, exist_ok=False)
    for name in entries:
        src = inside(source, name)
        dest = target / name
        if src.is_dir():
            for path in src.rglob("*"):
                if is_redirect(path):
                    raise ValueError(f"Unexpected redirect in package entry: {name}")
            shutil.copytree(src, dest)
        else:
            shutil.copyfile(src, dest)


def install(skills_dir, vault, sessions, runtime, entries, restricted, supplement_sessions=None, notes_dir=DEFAULT_NOTES_DIR):
    skills_dir, vault, sessions, runtime = map(local_path, (skills_dir, vault, sessions, runtime))
    roots = (skills_dir, vault, sessions, runtime)
    if supplement_sessions is not None:
        supplement_sessions = local_path(supplement_sessions)
        if not supplement_sessions.is_dir():
            raise ValueError("The optional supplemental Session directory must exist")
        roots += (supplement_sessions,)
    for index, root in enumerate(roots):
        if root == REPO or REPO in root.parents:
            raise ValueError(f"Use a location outside the source checkout: {root}")
        if any(overlaps(root, other) for other in roots[index + 1:]):
            raise ValueError("Skills, vault, Session input and runtime must be separate directories")
    if not sessions.is_dir():
        raise ValueError("Session source must be an existing directory you chose")
    if os.path.lexists(runtime) or any(os.path.lexists(skills_dir / name) for name in SKILLS):
        raise ValueError("Runtime or same-name Skill already exists; choose a new scope or reconcile it first")
    if vault.exists() and not vault.is_dir():
        raise ValueError("Vault path is not a directory")
    for relative in [*entries, *restricted, notes_dir]:
        relative_parts(relative)
    managed = Path(*relative_parts(notes_dir))
    if any(part.startswith(".") for part in managed.parts):
        raise ValueError("Choose a visible folder inside your Wiki for reviewed notes")
    notes_target = inside(vault, notes_dir)
    if notes_target.exists() and not notes_target.is_dir():
        raise ValueError("Reviewed note folder is an existing file")
    for path in restricted:
        if Path(*relative_parts(path)) in (managed, *managed.parents):
            raise ValueError("The reviewed note folder cannot be inside a restricted path")

    with tempfile.TemporaryDirectory(prefix="pde-suite-install-") as temp:
        staging = Path(temp)
        qa_source, recall_source = COMPONENTS / "qa", COMPONENTS / SKILLS[2]

        pde_skill = staging / SKILLS[0]
        copy_files(REPO, pde_skill, ("SKILL.md", "LICENSE", "agents", "assets", "examples/minimal-project", "references", "scripts"))
        qa_skill = staging / SKILLS[1]
        copy_files(qa_source / "skills" / SKILLS[1], qa_skill, ("SKILL.md", "agents"))
        shutil.copyfile(qa_source / "LICENSE", qa_skill / "LICENSE")
        # Replace the upstream host-specific usage text with the suite's scoped
        # entry, while retaining its canonical name, trigger and UI metadata.
        upstream = (qa_skill / "SKILL.md").read_text(encoding="utf-8")
        frontmatter, separator, _ = upstream.removeprefix("---\n").partition("\n---\n")
        if not separator or f"name: {SKILLS[1]}" not in frontmatter:
            raise ValueError("Unexpected upstream QA Skill format")
        entry = (SUITE / "qa-entry.md").read_text(encoding="utf-8")
        (qa_skill / "SKILL.md").write_text(f"---\n{frontmatter}\n---\n\n# Codex QA Diary Recall\n\n{entry}", encoding="utf-8")
        save_json(qa_skill / "local-config.json", {"workflow": str(runtime / "workflow.py"), "runtime": str(runtime)})
        (qa_skill / ".gitignore").write_text("/local-config.json\n", encoding="utf-8")

        recall_skill = staging / SKILLS[2]
        copy_files(recall_source, recall_skill, ("SKILL.md", "LICENSE", "agents", "references", "scripts", "config.example.json", ".gitignore"))
        started_vault = not vault.exists()
        if started_vault:
            shutil.copytree(EXAMPLE / "vault", vault)
        recall_args = [sys.executable, "-B", recall_skill / "scripts" / "configure.py", "--vault", vault, "--json"]
        for entry in entries:
            recall_args.extend(["--entry", entry])
        for directory in restricted:
            recall_args.extend(["--restricted", directory])
        run(*recall_args, stdout=subprocess.DEVNULL)

        staged_runtime = staging / "runtime"
        copy_files(SUITE, staged_runtime, ("workflow.py", "storage.py"))
        copy_files(qa_source, staged_runtime / "qa", ("qa-logger/src", "LICENSE"))
        save_json(staged_runtime / "suite-config.json", {
            "schema_version": 1, "vault": str(vault), "sessions": str(sessions),
            "restricted": restricted, "notes_dir": notes_dir,
            "supplement_sessions": str(supplement_sessions) if supplement_sessions else None,
        })
        # Validate the contained public packages before installing any Skill.
        shutil.copytree(staged_runtime, runtime)
        for name in SKILLS:
            shutil.copytree(staging / name, skills_dir / name)
    return {"skills": str(skills_dir), "vault": str(vault), "runtime": str(runtime), "starter_created": started_vault}


def create_project(project, runtime, tool):
    project.mkdir(exist_ok=False)
    template_root = REPO / "examples" / "minimal-project"
    example = json.loads((EXAMPLE / "project.json").read_text(encoding="utf-8"))
    actions = []
    for source in sorted(template_root.rglob("*.md")):
        relative = source.relative_to(template_root).as_posix()
        content = source.read_text(encoding="utf-8")
        for previous, replacement in example.get(relative, []):
            if content.count(previous) != 1:
                raise ValueError(f"The existing project template changed: {relative}")
            content = content.replace(previous, replacement)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        content = content.replace("<复制后填写真实时间>", stamp).replace("DEMO_SESSION_ID", DEMO_ID)
        actions.append({"kind": "write_file", "path": relative, "content": content, "overwrite": False})
    operation = runtime / "demo-operation.json"
    plan = project / ".project-gov" / "plans" / "demo-init.json"
    save_json(operation, {
        "schema_version": 2, "plan_id": "demo_init",
        "knowledge_review": {"status": "none", "basis": "合成示例只初始化项目接续记录。"},
        "actions": actions,
    })
    for args in (
        ("propose", "--root", project, "--plan", operation, "--out", plan),
        ("apply", "--plan", plan),
        ("startup", "--root", project),
    ):
        result = subprocess.run(
            ["node", str(tool), *map(str, args), "--json"],
            capture_output=True, text=True, encoding="utf-8",
        )
        if not result.stdout.strip():
            raise ValueError(f"Project {args[0]} produced no report. Check Node and the source checkout.")
        payload = json.loads(result.stdout)
        if result.returncode or not payload.get("ok"):
            issues = payload.get("violations") or payload.get("blocking_reasons") or payload.get("errors") or []
            raise ValueError(f"Project {args[0]} rejected the demo: {issues[:5]}")
    return payload


def write_demo_session(folder, session_id, project, events):
    folder.mkdir(exist_ok=False)
    fixture = folder / f"rollout-2025-05-13T20-00-00-{session_id}.jsonl"
    meta = ("20:00:00", "session_meta", {"id": session_id, "cwd": str(project), "source": "cli", "thread_source": "user"})
    with fixture.open("x", encoding="utf-8") as stream:
        for at, kind, payload in [meta, *events]:
            stream.write(json.dumps({"timestamp": f"2025-05-13T{at}+00:00", "type": kind, "payload": payload}, ensure_ascii=False) + "\n")


def demo(root):
    root = local_path(root)
    if REPO == root or REPO in root.parents:
        raise ValueError("Make the demo in a new directory outside the source checkout")
    root.mkdir(parents=True, exist_ok=False)
    project, vault, sessions, archived, runtime = (
        root / name for name in ("报名工具", "wiki", "sample-sessions", "sample-archive", "runtime")
    )
    write_demo_session(sessions, DEMO_ID, project, [
        ("20:01:00", "event_msg", {"type": "user_message", "message": "现场可能断网，为什么首版先做 CSV 导出？"}),
        ("20:02:00", "event_msg", {"type": "agent_message", "phase": "final_answer", "message": "因为签到点可能断网，先提供本机生成的 CSV，现场仍能离线核对名单。在线共享等网络条件明确后再验收。"}),
        ("20:03:00", "event_msg", {"type": "user_message", "message": "收到，谢谢。"}),
        ("20:04:00", "event_msg", {"type": "agent_message", "phase": "final_answer", "message": "好的。"}),
    ])
    write_demo_session(archived, DEMO_ARCHIVED_ID, project, [
        ("20:08:00", "response_item", {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "怎么验证断网时的 CSV 名单还能核对？"}],
        }),
        ("20:09:00", "response_item", {
            "type": "message",
            "role": "assistant",
            "phase": "final_answer",
            "content": [{
                "type": "output_text",
                "text": "先导出本机 CSV，再关闭网络，使用导出文件现场核对一条测试报名。核对能读到快照且清楚标明导出时间。",
            }],
        }),
    ])
    # The project is not writable until the controlled initialization runs.
    startup = create_project(project, root, REPO / "scripts" / "project-gov.mjs")
    installed = install(project / ".agents" / "skills", vault, sessions, runtime, [], list(DEFAULT_RESTRICTED), archived)
    config_path = runtime / "suite-config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    save_json(config_path, {**config, "demo_session": DEMO_ID})
    return {
        **installed, "project": str(project), "startup_ok": startup.get("ok"),
        "demo_session": DEMO_ID,
    }


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Use Python 3.10 or newer for this suite.")
    if shutil.which("node") is None:
        raise SystemExit("Node.js is required. Install it and check that node --version works.")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("demo", help="create a new demo directory with synthetic data")
    init.add_argument("--root", type=Path, help="new directory (default: a fresh system temp directory)")
    init.add_argument("--json", action="store_true", help="return machine-readable output")
    regular = commands.add_parser("install", help="install in explicitly selected directories")
    for name in ("skills-dir", "vault", "sessions", "runtime"):
        regular.add_argument("--" + name, type=Path, required=True)
    regular.add_argument("--entry", action="append", default=[])
    regular.add_argument("--restricted", action="append", default=[])
    regular.add_argument("--supplement-sessions", type=Path, help="optional separate directory for targeted Session fallback")
    regular.add_argument("--notes-dir", default=DEFAULT_NOTES_DIR, help="relative Wiki folder for reviewed new notes")
    regular.add_argument("--json", action="store_true", help="return machine-readable output")
    args = parser.parse_args()
    if args.command == "demo":
        root = args.root or (Path(tempfile.gettempdir()).resolve() / f"pde-demo-{uuid4().hex[:12]}")
        result = demo(root)
        check = subprocess.run(
            [sys.executable, "-B", str(SUITE / "verify-demo.py"), "--root", str(root)],
            capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if check.returncode:
            raise ValueError(f"示例目录位于 {root}\n{check.stderr.strip()}")
        proof = json.loads(check.stdout)
        if args.json:
            print(json.dumps({**result, "verification": proof}, ensure_ascii=False))
        else:
            print("项目交接包示例已通过自检。")
            print(f"示例项目  {result['project']}")
            print(f"示例笔记库  {result['vault']}")
            print(
                f"查到 {proof['qa_turns']} 条日记问答，补回 {proof['session_supplements']} 条，"
                f"整理出 {proof['wiki_notes_created']} 条经验。"
            )
            print(
                f"重跑待处理 {proof['incremental_pending']} 条。"
                f"周检覆盖 {proof['weekly_pages_reviewed']} 页，发现 {proof['weekly_source_gaps']} 处示例缺证。"
            )
            print("在 Codex 打开示例项目，照 README 里的两段提示试用。")
    else:
        restricted = list(dict.fromkeys((*DEFAULT_RESTRICTED, *args.restricted)))
        result = install(
            args.skills_dir, args.vault, args.sessions, args.runtime, args.entry,
            restricted, args.supplement_sessions, args.notes_dir,
        )
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print("项目交接包已安装。")
            print(f"Skill 目录  {result['skills']}")
            print(f"笔记库  {result['vault']}")
            print(f"运行目录  {result['runtime']}")
            print("按 README 的安装说明手动试采集后，再设置计划任务。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"Setup stopped: {exc}") from None
