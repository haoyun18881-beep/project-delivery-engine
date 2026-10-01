import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(skillRoot, "scripts", "project-gov.mjs");
const expectedSkillVersion = "0.3.8-rc7";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v027-"));
let sequence = 0;

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function createProject(name) {
  sequence += 1;
  const root = path.join(sandbox, `${String(sequence).padStart(2, "0")}-${name}`);
  write(root, "AGENTS.md", "# AGENTS.md\n");
  write(
    root,
    "PROJECT_START_HERE.md",
    "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 当前项目根目录。\n\n## 启动入口\n\n1. 读取五件套。\n",
  );
  write(
    root,
    "STATUS.md",
    "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n| 回归 | 正常 | 本地夹具 |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n| 基线 | 通过 | 主线 |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n",
  );
  write(
    root,
    "TODO.md",
    "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n| P1 | 回归 | 通过 |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |\n",
  );
  write(
    root,
    "HANDOFF.md",
    "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-07-28 08:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n| 状态 | `STATUS.md` | 当前状态 |\n\n## 未决上下文\n\n- 无\n",
  );
  write(
    root,
    "历史记录/00-历史总目录.md",
    "# 历史总目录\n\n| history-id | 日期 | 标题 | 路径 | 状态 |\n| --- | --- | --- | --- | --- |\n",
  );
  write(
    root,
    "证据库/总索引/证据总目录.md",
    "# 证据总目录\n\n| evidence-id | run_id | task_id | 来源 | 摘要 | 路径 | 采纳状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n",
  );
  write(
    root,
    "项目物料/INDEX.md",
    "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n",
  );
  return root;
}

function run(command, root, extra = [], maxBuffer = 8 * 1024 * 1024) {
  const result = spawnSync(
    process.execPath,
    [script, command, "--root", root, ...extra, "--json"],
    { encoding: "utf8", maxBuffer },
  );
  const raw = result.stdout.trim() || result.stderr.trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // Some output-size regressions are asserted before JSON details are needed.
  }
  return { ...result, json };
}

function defaultKnowledgeReview() {
  return {
    status: "none",
    basis: "回归夹具未产生可跨任务复用的已核实知识。",
  };
}

function propose(root, name, actions, knowledgeReview = defaultKnowledgeReview()) {
  const operation = write(root, `${name}.operation.json`, `${JSON.stringify({
    schema_version: 2,
    plan_id: name,
    knowledge_review: knowledgeReview,
    actions,
  }, null, 2)}\n`);
  const out = path.join(root, ".project-gov", "plans", `${name}.json`);
  return {
    ...run("propose", root, ["--plan", operation, "--out", out]),
    out,
  };
}

function apply(compiledPlan) {
  const result = spawnSync(process.execPath, [script, "apply", "--plan", compiledPlan, "--json"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = result.stdout.trim() || result.stderr.trim();
  return { ...result, json: JSON.parse(raw) };
}

function mutate(root, rel, transform) {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, transform(fs.readFileSync(abs, "utf8")), "utf8");
}

function indexMaterialMarkdown(root, rel, id) {
  mutate(root, "项目物料/INDEX.md", (source) => {
    let text = source;
    if (!text.includes("locator-kind")) {
      text = text
        .replace(
          "| material-id | 路径 | hash | 来源 | 用途 | 状态 |",
          "| material-id | 路径 | hash | 来源 | 用途 | 状态 | locator-kind |",
        )
        .replace(
          "| --- | --- | --- | --- | --- | --- |",
          "| --- | --- | --- | --- | --- | --- | --- |",
        );
    }
    return `${text}| ${id} | \`${rel}\` | ${"0".repeat(64)} | 本地 | 扫描边界回归 | active | file |\n`;
  });
}

function age(abs, days = 40) {
  const old = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(abs, old, old);
}

function rels(items) {
  return (items || []).map((item) => typeof item === "string" ? item : item.rel);
}

function assertRejected(result, message) {
  assert.notEqual(result.status, 0, message);
  assert.equal(result.json?.ok, false, result.stdout || result.stderr);
}

function assertCrLfOnly(text, label) {
  assert.match(text, /\r\n/, `${label} lost CRLF`);
  assert.equal(/(^|[^\r])\n/.test(text), false, `${label} introduced bare LF`);
}

function physicalCount(layout, nestedKey, flatKey) {
  const nested = layout?.[nestedKey];
  if (typeof nested === "number") return nested;
  if (typeof nested?.count === "number") return nested.count;
  return layout?.[flatKey];
}

try {
  // 1. A junction into a non-governance part of the same project is still an escape.
  {
    const root = createProject("junction-boundary");
    const ordinary = path.join(root, "ordinary-output");
    fs.mkdirSync(ordinary);
    fs.symlinkSync(ordinary, path.join(root, "历史记录", "linked-output"), "junction");
    const escaped = propose(root, "junction-escape", [
      { kind: "write_file", path: "历史记录/linked-output/probe.md", content: "# probe\n", overwrite: false },
    ]);
    assertRejected(escaped, "same-project junction must be rejected during propose");
    assert.equal(fs.existsSync(escaped.out), false);

    const normal = propose(root, "normal-governance-child", [
      { kind: "write_file", path: "历史记录/正常目录/probe.md", content: "# probe\n", overwrite: false },
    ]);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(normal.json.ok, true);
  }

  // 2. Cache inventory is read-only and never deletes project data.
  {
    const root = createProject("read-only-cache-inventory");
    const compiled = propose(root, "compiled-plan", [{
      kind: "write_file",
      path: "历史记录/prune-fixture.md",
      content: "# prune fixture\n",
      overwrite: false,
    }]);
    assert.equal(compiled.status, 0, compiled.stderr);
    age(compiled.out);
    const backup = path.join(root, ".project-gov", "backups", "legacy-backup");
    fs.mkdirSync(backup, { recursive: true });
    write(backup, "probe.txt", "old\n");
    age(path.join(backup, "probe.txt"));
    age(backup);
    const preview = run("prune", root, ["--older-than-days", "30"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.json.mode, "read_only_inventory");
    assert.equal(preview.json.automatic_delete, false);
    assert.ok(rels(preview.json.items).some((rel) => rel.endsWith("compiled-plan.json")), preview.stdout);
    assert.ok(rels(preview.json.items).some((rel) => rel.endsWith("legacy-backup")), preview.stdout);
    const applied = run("prune", root, ["--older-than-days", "30", "--apply"]);
    assertRejected(applied, "cache inventory must reject delete mode");
    assert.equal(fs.existsSync(compiled.out), true);
    assert.equal(fs.existsSync(backup), true);
  }

  // 3. Table contracts use exact aliases and reject ambiguity or duplicate IDs.
  {
    const aliases = createProject("table-exact-aliases");
    mutate(aliases, "历史记录/00-历史总目录.md", (text) => text
      .replace("history-id", "历史编号")
      .replace("路径", "原件路径"));
    mutate(aliases, "证据库/总索引/证据总目录.md", (text) => text
      .replace("evidence-id", "证据编号")
      .replace("run_id", "执行批次")
      .replace("task_id", "任务编号")
      .replace("路径", "原件路径"));
    mutate(aliases, "项目物料/INDEX.md", (text) => text
      .replace("material-id", "物料编号")
      .replace("路径", "原件路径")
      .replace("hash", "哈希"));
    assert.equal(run("validate", aliases).status, 0, "supported exact aliases must pass");

    const fuzzy = createProject("table-fuzzy-alias");
    mutate(fuzzy, "历史记录/00-历史总目录.md", (text) => text.replace("history-id", "历史编号值"));
    assertRejected(run("validate", fuzzy), "fuzzy alias must not pass");

    const duplicateColumn = createProject("table-duplicate-column");
    mutate(duplicateColumn, "STATUS.md", (text) => text
      .replace("| 项目 | 状态 | 依据 |", "| 项目 | 状态 | 状态 | 依据 |")
      .replace("| --- | --- | --- |", "| --- | --- | --- | --- |"));
    assertRejected(run("validate", duplicateColumn), "duplicate required column must fail");

    const duplicateId = createProject("table-duplicate-index-id");
    mutate(duplicateId, "历史记录/00-历史总目录.md", (text) => `${text}| M-20260728-001 | 2026-07-28 | A | a.md | active |\n| M-20260728-001 | 2026-07-28 | B | b.md | active |\n`);
    assertRejected(run("validate", duplicateId), "duplicate index ID must fail");

    const secondCandidate = createProject("table-second-contract-candidate");
    mutate(secondCandidate, "STATUS.md", (text) => text.replace(
      "| 回归 | 正常 | 本地夹具 |",
      "| 回归 | 正常 | 本地夹具 |\n\n说明。\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n| 重复 | 正常 | 不允许 |",
    ));
    assertRejected(run("validate", secondCandidate), "second contract-candidate table must fail");

    const prelude = createProject("table-non-contract-prelude");
    mutate(prelude, "STATUS.md", (text) => text.replace(
      "## 当前状态\n\n| 项目 |",
      "## 当前状态\n\n| 说明 | 值 |\n| --- | --- |\n| 范围 | 回归 |\n\n| 项目 |",
    ));
    assert.equal(run("validate", prelude).status, 0, "non-contract explanatory table must not be mistaken for contract");
  }

  // 4. Unrelated Markdown files are outside the managed governance scan.
  {
    const root = createProject("markdown-scan-limit");
    for (let index = 0; index < 5010; index += 1) {
      write(root, `bulk/${String(index).padStart(4, "0")}.md`, "\n");
    }
    const migration = run("migrate-check", root);
    assert.equal(migration.status, 0, migration.stderr);
    assert.equal(migration.json?.up_to_date, true, migration.stdout);
    assert.equal(migration.json?.indeterminate, false, migration.stdout);
    assert.equal(migration.json?.markdown_scan?.scope, "managed_governance_records", migration.stdout);
    assert.equal(migration.json?.markdown_scan?.file_count_limit_exceeded, false, migration.stdout);
    assert.equal(run("startup", root).status, 0, "unrelated Markdown must not block startup");
  }

  // 4b. An unrelated oversized Markdown file cannot block normal governance commands.
  {
    const root = createProject("markdown-single-file-byte-limit");
    write(root, "bulk/oversized.md", "x".repeat((2 * 1024 * 1024) + 1));
    write(root, ".rgignore", "项目物料/registered.md\n");
    write(root, "项目物料/registered.md", "# Registered\n");
    indexMaterialMarkdown(root, "项目物料/registered.md", "MAT-20260728-901");
    const inspected = run("inspect", root);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.json?.mechanical_ok, true, inspected.stdout);
    assert.equal(inspected.json?.coverage_complete, true, inspected.stdout);
    assert.equal(inspected.json?.indeterminate, false, inspected.stdout);
    assert.deepEqual(inspected.json?.errors, [], inspected.stdout);
    assert.deepEqual(inspected.json?.coverage_issues, [], inspected.stdout);
    assert.equal(inspected.json?.markdown_scan?.oversized_file_count, 0, inspected.stdout);
    assert.equal(inspected.json?.markdown_scan?.files_discovered, 9, inspected.stdout);
    assert.equal(inspected.json?.markdown_scan?.files_scanned, 9, inspected.stdout);

    const migration = run("migrate-check", root);
    assert.equal(migration.status, 0, migration.stderr);
    assert.equal(migration.json?.indeterminate, false, migration.stdout);
    assert.equal(migration.json?.up_to_date, true, migration.stdout);
    assert.equal(run("startup", root).status, 0, "unrelated oversized Markdown must not block startup");

    const ids = run("ids", root);
    assert.equal(ids.status, 0, ids.stderr);
    assert.ok(ids.json?.ids, ids.stdout);

    const prepared = propose(root, "unrelated-oversized-apply", [{
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 通过 |",
      replacement: "| P1 | 回归 | 核心治理写入通过 |",
    }]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const applied = apply(prepared.out);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.json?.validation?.mechanical_ok, true, applied.stdout);
    assert.equal(applied.json?.validation?.coverage_complete, true, applied.stdout);
    assert.equal(applied.json?.validation?.indeterminate, false, applied.stdout);
  }

  // 4c. A Markdown file explicitly registered by an index cannot disappear silently.
  {
    const root = createProject("indexed-markdown-missing");
    indexMaterialMarkdown(root, "项目物料/missing.md", "MAT-20260728-902");
    const inspected = run("inspect", root);
    assertRejected(inspected, "missing indexed Markdown must make coverage incomplete");
    assert.equal(inspected.json?.mechanical_ok, false, inspected.stdout);
    assert.equal(inspected.json?.decision_snapshot?.scan_complete, false, inspected.stdout);
    assert.equal(inspected.json?.coverage_complete, false, inspected.stdout);
    assert.ok(inspected.json?.coverage_issues?.includes("indexed_markdown_missing"), inspected.stdout);
    assert.deepEqual(inspected.json?.markdown_scan?.missing_indexed_files, ["项目物料/missing.md"], inspected.stdout);
    const migration = run("migrate-check", root);
    assertRejected(migration, "missing indexed Markdown must make migration indeterminate");
    assert.equal(migration.json?.indeterminate, true, migration.stdout);
  }

  // 4d. Managed indexed Markdown remains bounded, and dangling IDs always roll back.
  {
    const root = createProject("managed-markdown-single-file-byte-limit");
    const rel = "项目物料/oversized.md";
    write(root, rel, "x".repeat((2 * 1024 * 1024) + 1));
    indexMaterialMarkdown(root, rel, "MAT-20260728-900");

    const inspected = run("inspect", root);
    assertRejected(inspected, "oversized managed Markdown must make coverage incomplete");
    assert.equal(inspected.json?.mechanical_ok, false, inspected.stdout);
    assert.equal(inspected.json?.coverage_complete, false, inspected.stdout);
    assert.ok(inspected.json?.coverage_issues?.includes("markdown_scan_file_too_large"), inspected.stdout);

    const migration = run("migrate-check", root);
    assertRejected(migration, "oversized managed Markdown must make migration indeterminate");
    assert.equal(migration.json?.indeterminate, true, migration.stdout);
    assert.equal(migration.json?.markdown_scan?.oversized_file_count, 1, migration.stdout);

    const ids = run("ids", root);
    assertRejected(ids, "ID allocation must stop when managed Markdown coverage is incomplete");
    assert.equal(ids.json?.ids, null, ids.stdout);

    const safePrepared = propose(root, "managed-coverage-incomplete-safe-apply", [{
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 通过 |",
      replacement: "| P1 | 回归 | 核心治理写入通过 |",
    }]);
    assertRejected(safePrepared, "an incomplete issue set cannot authorize an incremental commit");
    assert.equal(fs.existsSync(safePrepared.out), false);

    const beforeDangling = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    const danglingPrepared = propose(root, "managed-coverage-dangling-id", [{
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 核心治理写入通过 |",
      replacement: "| P1 | 回归 | MAT-20260728-999 |",
    }]);
    assertRejected(danglingPrepared, "dangling managed ID must fail during propose when coverage is incomplete");
    assert.equal(fs.existsSync(danglingPrepared.out), false);
    assert.equal(fs.readFileSync(path.join(root, "TODO.md"), "utf8"), beforeDangling);
  }

  // 4e. Aggregate bytes remain bounded for Markdown explicitly registered by an index.
  {
    const root = createProject("markdown-total-byte-limit");
    const twoMiB = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 17; index += 1) {
      const rel = `项目物料/bulk/${String(index).padStart(2, "0")}.md`;
      write(root, rel, twoMiB);
      indexMaterialMarkdown(root, rel, `MAT-20260728-${String(800 + index).padStart(3, "0")}`);
    }
    const migration = run("migrate-check", root);
    assertRejected(migration, "aggregate Markdown input must remain within the byte budget");
    assert.equal(migration.json?.indeterminate, true, migration.stdout);
    assert.equal(migration.json?.up_to_date, false, migration.stdout);
    assert.equal(migration.json?.markdown_scan?.total_bytes_exceeded, true, migration.stdout);
    assert.ok(migration.json?.markdown_scan?.scanned_bytes <= migration.json?.markdown_scan?.max_total_bytes, migration.stdout);
    assert.ok(migration.json?.migration_items?.some((item) => item.code === "markdown_scan_total_bytes_exceeded"), migration.stdout);
  }

  // 5. IDs hidden in comments or fenced code cannot resolve a live reference.
  {
    const root = createProject("hidden-id-reference");
    mutate(root, "STATUS.md", (text) => text.replace("- 无\n", "- EV-20260728-001\n- EV-20260728-002\n"));
    mutate(root, "证据库/总索引/证据总目录.md", (text) => `${text}\n<!-- EV-20260728-001 -->\n\n\`\`\`text\nEV-20260728-002\n\`\`\`\n`);
    const result = run("validate", root);
    assertRejected(result, "comment/fence IDs must not satisfy references");
    const unresolved = result.json.report.references.unresolved.map((item) => item.id);
    assert.ok(unresolved.includes("EV-20260728-001"), result.stdout);
    assert.ok(unresolved.includes("EV-20260728-002"), result.stdout);
  }

  // 6. Every text-edit action preserves CRLF, including the existing block action.
  for (const test of [
    {
      name: "crlf-append",
      action: { kind: "append_after", path: "STATUS.md", after: "# STATUS.md", match: "exact", content: "\n说明：追加。" },
    },
    {
      name: "crlf-line-replace",
      action: { kind: "replace_line_contains", path: "STATUS.md", contains: "## 风险", replacement: "## 风险" },
    },
    {
      name: "crlf-block-replace",
      action: { kind: "replace_block_exact", path: "STATUS.md", old_block: "- 无\n\n## 关键引用", replacement: "- 风险已核对\n\n## 关键引用" },
    },
  ]) {
    const root = createProject(test.name);
    const target = path.join(root, "STATUS.md");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/\n/g, "\r\n"), "utf8");
    const prepared = propose(root, test.name, [test.action]);
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
    const applied = apply(prepared.out);
    assert.equal(applied.status, 0, applied.stderr);
    assertCrLfOnly(fs.readFileSync(target, "utf8"), test.name);
  }

  // 7. Invalid 1 MiB enum input is rejected without echoing the payload.
  {
    const root = createProject("bounded-invalid-enum");
    const huge = "非法层级".repeat(Math.ceil((1024 * 1024) / Buffer.byteLength("非法层级", "utf8")));
    mutate(root, "STATUS.md", (text) => text.replace("| 基线 | 通过 | 主线 |", `| 基线 | 通过 | ${huge} |`));
    const result = run("validate", root, [], 4 * 1024 * 1024);
    assert.notEqual(result.status, 0);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") < 128 * 1024, `stdout was ${Buffer.byteLength(result.stdout, "utf8")} bytes`);
    assert.equal(result.stdout.includes(huge.slice(0, 4096)), false, "invalid value was echoed verbatim");
  }

  // 8. A mkdir must have a same-plan write descendant.
  {
    const orphanRoot = createProject("orphan-mkdir");
    const orphan = propose(orphanRoot, "orphan-mkdir", [
      { kind: "mkdir", path: "历史记录/空治理目录" },
    ]);
    assertRejected(orphan, "orphan governance mkdir must fail");

    const populatedRoot = createProject("populated-mkdir");
    const populated = propose(populatedRoot, "populated-mkdir", [
      { kind: "mkdir", path: "历史记录/有内容" },
      { kind: "write_file", path: "历史记录/有内容/记录.md", content: "# 记录\n", overwrite: false },
    ]);
    assert.equal(populated.status, 0, populated.stderr);
  }

  // 9. Migration check gives a shallow legacy-root hint without deep directory scanning.
  {
    const root = createProject("physical-layout");
    write(root, "01-遗留说明.md", "# 遗留说明\n");
    const migration = run("migrate-check", root);
    assert.ok(migration.json?.physical_layout, "migrate-check must expose shallow physical_layout");
    assert.ok(physicalCount(migration.json.physical_layout, "root_numbered_markdown", "root_numbered_markdown_count") >= 1);
    assert.ok(!(migration.json.migration_items || []).some((item) => item.code.includes("root_numbered_markdown")));
  }

  // 10. Entry/handoff coverage is mandatory and migrate-check states its scope.
  {
    const missingEntry = createProject("missing-start-entry");
    mutate(missingEntry, "PROJECT_START_HERE.md", () => "# PROJECT_START_HERE.md\n");
    assertRejected(run("migrate-check", missingEntry), "project path/start entry are required");

    const missingHandoff = createProject("missing-handoff-context");
    mutate(missingHandoff, "HANDOFF.md", (text) => text
      .replace(/## 接手顺序[\s\S]*?(?=## 已证伪路线)/, "")
      .replace(/## 未决上下文[\s\S]*$/, ""));
    assertRejected(run("migrate-check", missingHandoff), "handoff order/pending context are required");

    const scoped = run("migrate-check", createProject("migrate-coverage"));
    assert.ok(scoped.json && Object.hasOwn(scoped.json, "checked"), "migrate-check must report checked");
    assert.ok(scoped.json && Object.hasOwn(scoped.json, "not_checked"), "migrate-check must report not_checked");
    assert.ok(scoped.json && Object.hasOwn(scoped.json, "coverage_scope"), "migrate-check must report coverage_scope");
    assert.ok(Array.isArray(scoped.json.checked));
    assert.ok(Array.isArray(scoped.json.not_checked));
    assert.ok(scoped.json.coverage_scope !== null && scoped.json.coverage_scope !== "");
    assert.equal(scoped.json.project_knowledge_checked_by_tool, false);
    assert.ok(scoped.json.not_checked.includes("project_knowledge_completeness"));
    assert.deepEqual(scoped.json.knowledge_review, {
      status: "not_checked",
      blocking: false,
      affects_structural_up_to_date: false,
      automatic_backfill: false,
    });
    assert.equal(scoped.json.up_to_date, true, "knowledge semantics must not block structural freshness");
  }

  // 10b. Every governed write declares a bounded knowledge review without creating a persistent form.
  {
    const root = createProject("knowledge-review-gate");
    const action = {
      kind: "write_file",
      path: "历史记录/知识审查门回归.md",
      content: "# 知识审查门回归\n",
      overwrite: false,
    };

    const missingOperation = write(root, "missing-review.operation.json", `${JSON.stringify({
      schema_version: 2,
      plan_id: "missing-review",
      actions: [action],
    }, null, 2)}\n`);
    const missingOut = path.join(root, ".project-gov", "plans", "missing-review.json");
    const missing = run("propose", root, ["--plan", missingOperation, "--out", missingOut]);
    assertRejected(missing, "missing knowledge review must block propose");
    assert.ok(missing.json.violations.includes("knowledge_review_object_required"), missing.stdout);
    assert.equal(fs.existsSync(missingOut), false);

    const legacyOperation = write(root, "legacy-operation-schema.operation.json", `${JSON.stringify({
      schema_version: 1,
      plan_id: "legacy-operation-schema",
      knowledge_review: defaultKnowledgeReview(),
      actions: [action],
    }, null, 2)}\n`);
    const legacyOut = path.join(root, ".project-gov", "plans", "legacy-operation-schema.json");
    const legacy = run("propose", root, ["--plan", legacyOperation, "--out", legacyOut]);
    assertRejected(legacy, "operation schema v1 must be regenerated");
    assert.ok(legacy.json.violations.includes("schema_version_must_be_2"), legacy.stdout);

    const noneWithoutBasis = propose(root, "knowledge-review-none-without-basis", [action], {
      status: "none",
    });
    assertRejected(noneWithoutBasis, "none review still needs a concrete one-line basis");
    assert.ok(noneWithoutBasis.json.violations.includes("knowledge_review_basis_required"));

    const unknownStatus = propose(root, "knowledge-review-unknown-status", [action], {
      status: "skipped",
      basis: "非法状态不能静默通过。",
      extra: true,
    });
    assertRejected(unknownStatus, "unknown review status and fields must fail");
    assert.ok(unknownStatus.json.violations.includes("knowledge_review_status_invalid"));
    assert.ok(unknownStatus.json.violations.includes("knowledge_review_unknown_field:extra"));

    const none = propose(root, "knowledge-review-none", [action]);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(none.json.knowledge_review, { status: "none" });
    const noneCompiled = JSON.parse(fs.readFileSync(none.out, "utf8"));
    assert.deepEqual(noneCompiled.knowledge_review, defaultKnowledgeReview());
    assert.doesNotMatch(none.stdout, /回归夹具未产生/);

    const created = propose(root, "knowledge-review-created", [{
      kind: "write_file",
      path: "项目物料/可复用方法.md",
      content: "# 可复用方法\n",
      overwrite: false,
    }], {
      status: "created",
      basis: "本轮形成并核实了可跨任务复用的方法。",
      paths: ["项目物料/可复用方法.md"],
    });
    assert.equal(created.status, 0, created.stderr);
    assert.deepEqual(created.json.knowledge_review, { status: "created" });

    const createdWithoutPath = propose(root, "knowledge-review-created-without-path", [action], {
      status: "created",
      basis: "声称创建知识但没有给出权威入口。",
    });
    assertRejected(createdWithoutPath, "created knowledge review must name its authority path");
    assert.ok(createdWithoutPath.json.violations.includes("knowledge_review_paths_required"));

    const createdWithUnsafePath = propose(root, "knowledge-review-created-unsafe-path", [action], {
      status: "created",
      basis: "权威入口路径必须留在项目根内。",
      paths: ["C:\\outside.md"],
    });
    assertRejected(createdWithUnsafePath, "knowledge authority paths must remain project-relative");
    assert.ok(createdWithUnsafePath.json.violations.some((item) => item.includes("absolute_path_not_allowed")));

    const docsAuthority = write(root, "docs/knowledge.md", "# 已按正常工程流程更新的知识源\n");
    const docsAuthorityBefore = fs.readFileSync(docsAuthority);
    const updatedExistingAuthority = propose(root, "knowledge-review-updated-existing-authority", [{
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 通过 |",
      replacement: "| P1 | 回归 | 通过并记录 |",
    }], {
      status: "updated",
      basis: "权威入口已经由本轮正常工程编辑更新，不需要治理计划重复触碰。",
      paths: ["docs/knowledge.md"],
    });
    assert.equal(updatedExistingAuthority.status, 0, updatedExistingAuthority.stderr);
    assert.equal(updatedExistingAuthority.json.knowledge_review.status, "updated");
    const updatedCompiled = JSON.parse(fs.readFileSync(updatedExistingAuthority.out, "utf8"));
    assert.deepEqual(updatedCompiled.knowledge_review.roles, [{ path: "docs/knowledge.md", role: "declaration_only" }]);
    const updatedApplied = apply(updatedExistingAuthority.out);
    assert.equal(updatedApplied.status, 0, updatedApplied.stderr);
    assert.deepEqual(fs.readFileSync(docsAuthority), docsAuthorityBefore, "declaration_only must not rewrite docs authority");

    const writeDocsThroughGovernance = propose(root, "knowledge-review-write-docs-rejected", [{
      kind: "write_file",
      path: "docs/knowledge.md",
      content: "# 不应由治理 CLI 改写\n",
      overwrite: true,
    }]);
    assertRejected(writeDocsThroughGovernance, "docs authority remains outside governance write whitelist");
    assert.ok(writeDocsThroughGovernance.json.violations.some((item) => item.includes("path_not_allowed")));

    const deferredWithoutTracking = propose(root, "knowledge-review-deferred-untracked", [action], {
      status: "deferred",
      basis: "证据冲突，当前无法完成知识判断。",
      recheck: "用户裁决冲突来源后重新判断。",
    });
    assertRejected(deferredWithoutTracking, "deferred review must remain visible in current governance state");
    assert.ok(deferredWithoutTracking.json.violations.includes("knowledge_review_deferred_requires_todo_or_handoff_action"));

    const deferredWithoutDetails = propose(root, "knowledge-review-deferred-without-details", [{
      kind: "replace_line_contains",
      path: "HANDOFF.md",
      contains: "- 检查点后变化：",
      replacement: "- 检查点后变化：待确认",
    }], {
      status: "deferred",
      basis: "证据冲突，当前无法完成知识判断。",
      recheck: "用户裁决冲突来源后重新判断。",
    });
    assertRejected(deferredWithoutDetails, "deferred details cannot disappear with the temporary plan");
    assert.ok(deferredWithoutDetails.json.violations.includes("knowledge_review_deferred_details_not_persisted"));

    const borrowedBasis = "旧记录里的暂缓依据。";
    const borrowedRecheck = "旧记录里的重新判断条件。";
    mutate(root, "TODO.md", (text) => `${text}\n${borrowedBasis}\n${borrowedRecheck}\n`);
    const borrowedDeferred = propose(root, "knowledge-review-deferred-borrowed-old-text", [{
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 通过 |",
      replacement: "| P1 | 回归 | 已观察 |",
    }], {
      status: "deferred",
      basis: borrowedBasis,
      recheck: borrowedRecheck,
    });
    assertRejected(borrowedDeferred, "deferred review cannot borrow old text from the target file");
    assert.ok(borrowedDeferred.json.violations.includes("knowledge_review_deferred_details_not_written_by_plan"));

    const splitRoot = createProject("knowledge-review-deferred-split-files");
    const splitBasis = "本轮写入 TODO 的暂缓依据。";
    const splitRecheck = "本轮写入 HANDOFF 的复查条件。";
    const splitDeferred = propose(splitRoot, "knowledge-review-deferred-split-files", [
      {
        kind: "replace_block_exact",
        path: "TODO.md",
        old_block: "| 无 | 无 |\n",
        replacement: `| ${splitBasis} | 无 |\n`,
      },
      {
        kind: "replace_line_contains",
        path: "HANDOFF.md",
        contains: "- 无",
        replacement: `- ${splitRecheck}`,
      },
    ], {
      status: "deferred",
      basis: splitBasis,
      recheck: splitRecheck,
    });
    assertRejected(splitDeferred, "deferred basis and recheck must be written to the same file");
    assert.ok(splitDeferred.json.violations.includes("knowledge_review_deferred_details_not_written_by_plan"));
    assert.ok(splitDeferred.json.violations.includes("knowledge_review_deferred_details_not_persisted"));

    const removedRoot = createProject("knowledge-review-deferred-written-then-removed");
    const removedBasis = "计划中短暂出现的依据。";
    const removedRecheck = "计划中短暂出现的复查条件。";
    mutate(removedRoot, "HANDOFF.md", (text) => `${text}\n${removedBasis}\n${removedRecheck}\n`);
    const removedDeferred = propose(removedRoot, "knowledge-review-deferred-written-then-removed", [
      {
        kind: "replace_block_exact",
        path: "TODO.md",
        old_block: "| 无 | 无 |\n",
        replacement: `| ${removedBasis} | ${removedRecheck} |\n`,
      },
      {
        kind: "replace_block_exact",
        path: "TODO.md",
        old_block: `| ${removedBasis} | ${removedRecheck} |\n`,
        replacement: "| 无 | 已处理 |\n",
      },
    ], {
      status: "deferred",
      basis: removedBasis,
      recheck: removedRecheck,
    });
    assertRejected(removedDeferred, "deferred details removed later in the same plan cannot borrow old text elsewhere");
    assert.ok(removedDeferred.json.violations.includes("knowledge_review_deferred_details_not_persisted"));

    const deferred = propose(root, "knowledge-review-deferred", [
      {
        kind: "replace_block_exact",
        path: "TODO.md",
        old_block: "| 无 | 无 |\n",
        replacement: "| 证据冲突，当前无法完成知识判断。 | 用户裁决冲突来源后重新判断。 |\n",
      },
    ], {
      status: "deferred",
      basis: "证据冲突，当前无法完成知识判断。",
      recheck: "用户裁决冲突来源后重新判断。",
    });
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.ok(deferred.json.warnings.includes("knowledge_review_deferred"));
    const deferredApply = apply(deferred.out);
    assert.equal(deferredApply.status, 0, deferredApply.stderr);
    const resumableStartup = run("startup", root);
    assert.equal(resumableStartup.status, 0, resumableStartup.stderr);
    assert.notEqual(resumableStartup.json.startup, null);

    const tampered = propose(root, "knowledge-review-tampered", [action]);
    assert.equal(tampered.status, 0, tampered.stderr);
    const tamperedCompiled = JSON.parse(fs.readFileSync(tampered.out, "utf8"));
    delete tamperedCompiled.knowledge_review;
    fs.writeFileSync(tampered.out, `${JSON.stringify(tamperedCompiled, null, 2)}\n`, "utf8");
    const tamperedApply = apply(tampered.out);
    assertRejected(tamperedApply, "apply must reject a compiled plan with a removed knowledge review");
    assert.match(tamperedApply.json.error, /knowledge_review_object_required/);
    assert.equal(fs.existsSync(path.join(root, action.path)), false);
  }

  // 10c. The review declaration follows the existing temporary-plan lifecycle.
  {
    const root = createProject("knowledge-review-lifecycle");
    const operation = write(root, ".project-gov/operations/review.operation.json", `${JSON.stringify({
      schema_version: 2,
      plan_id: "knowledge-review-lifecycle",
      knowledge_review: defaultKnowledgeReview(),
      actions: [{
        kind: "write_file",
        path: "历史记录/knowledge-review-lifecycle.md",
        content: "# lifecycle\n",
        overwrite: false,
      }],
    }, null, 2)}\n`);
    const out = path.join(root, ".project-gov", "plans", "knowledge-review-lifecycle.json");
    const prepared = run("propose", root, ["--plan", operation, "--out", out]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(fs.existsSync(operation), false, "successful managed operation must be removed");
    assert.equal(fs.existsSync(out), true);
    const applied = apply(out);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(fs.existsSync(out), false, "successful managed compiled plan must be removed");

    const failedOperation = write(root, ".project-gov/operations/review-failed.operation.json", `${JSON.stringify({
      schema_version: 2,
      plan_id: "knowledge-review-lifecycle-failed",
      actions: [{
        kind: "write_file",
        path: "历史记录/knowledge-review-lifecycle-failed.md",
        content: "# lifecycle failed\n",
        overwrite: false,
      }],
    }, null, 2)}\n`);
    const failedOut = path.join(root, ".project-gov", "plans", "knowledge-review-lifecycle-failed.json");
    const failed = run("propose", root, ["--plan", failedOperation, "--out", failedOut]);
    assertRejected(failed, "failed managed operation must remain available for correction");
    assert.equal(fs.existsSync(failedOperation), true);
    assert.equal(fs.existsSync(failedOut), false);
  }

  // 11. Material verification checks file content, not merely the presence of a hash column.
  {
    const root = createProject("material-hash-truth");
    const material = Buffer.from("first material payload\n", "utf8");
    write(root, "项目物料/原件/sample.txt", material);
    const expected = crypto.createHash("sha256").update(material).digest("hex");
    mutate(root, "项目物料/INDEX.md", (text) => `${text}| MAT-20260728-001 | 项目物料/原件/sample.txt | ${expected} | 本地 | 回归 | active |\n`);

    const verified = run("verify-materials", root);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.json.complete, true, verified.stdout);
    assert.equal(verified.json.matched_count, 1, verified.stdout);
    assert.equal(verified.json.matched_sample[0].path, "项目物料/原件/sample.txt", verified.stdout);

    write(root, "项目物料/原件/sample.txt", "changed material payload\n");
    const stale = run("verify-materials", root);
    assertRejected(stale, "stale material hash must fail verification");
    assert.equal(stale.json.mismatch_count, 1, stale.stdout);
  }

  // 12. Reordered/custom index columns cannot bypass duplicate IDs or second-table ambiguity.
  {
    const duplicate = createProject("reordered-index-duplicate");
    mutate(duplicate, "历史记录/00-历史总目录.md", () => [
      "# 历史总目录",
      "",
      "| 分类 | 日期 | history-id | 标题 | 路径 | 状态 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| A | 2026-07-28 | M-20260728-001 | A | a.md | active |",
      "| B | 2026-07-28 | M-20260728-001 | B | b.md | active |",
      "",
    ].join("\n"));
    assertRejected(run("validate", duplicate), "reordered ID column must still be unique");

    const ambiguous = createProject("reordered-second-table");
    mutate(ambiguous, "STATUS.md", (text) => text.replace(
      "| 回归 | 正常 | 本地夹具 |",
      "| 回归 | 正常 | 本地夹具 |\n\n说明。\n\n| 状态 | 依据 | 项目 |\n| --- | --- | --- |\n| 正常 | 第二张 | 重复 |",
    ));
    assertRejected(run("validate", ambiguous), "reordered second contract table must be ambiguous");
  }

  // 13. Material verification refuses discontinuous or structurally invalid index data.
  {
    const root = createProject("material-discontinuous");
    const first = Buffer.from("first\n", "utf8");
    const second = Buffer.from("second\n", "utf8");
    write(root, "项目物料/原件/first.txt", first);
    write(root, "项目物料/原件/second.txt", second);
    const firstHash = crypto.createHash("sha256").update(first).digest("hex");
    const secondHash = crypto.createHash("sha256").update(second).digest("hex");
    mutate(root, "项目物料/INDEX.md", (text) => `${text}| MAT-20260728-001 | 项目物料/原件/first.txt | ${firstHash} | 本地 | 回归 | active |\n\n| MAT-20260728-002 | 项目物料/原件/second.txt | ${secondHash} | 本地 | 回归 | active |\n`);
    assertRejected(run("verify-materials", root), "discontinuous material rows must not be silently ignored");
  }

  // 14. Migration readiness includes semantic declarations and physical-scan completeness.
  {
    const semantic = createProject("migrate-semantic-invalid");
    mutate(semantic, "HANDOFF.md", (text) => text.replace("2026-07-28 08:00 +08:00", "not-a-date"));
    const semanticResult = run("migrate-check", semantic);
    assertRejected(semanticResult, "invalid semantic checkpoint must block migration freshness");
    assert.equal(semanticResult.json.up_to_date, false, semanticResult.stdout);

  }

  // 15. The tool cache itself cannot be redirected through a same-project junction.
  {
    const root = createProject("governance-cache-junction");
    const ordinary = path.join(root, "ordinary-cache");
    fs.mkdirSync(ordinary);
    fs.symlinkSync(ordinary, path.join(root, ".project-gov"), "junction");
    const redirected = propose(root, "cache-junction", [{
      kind: "write_file",
      path: "历史记录/cache-junction-probe.md",
      content: "# cache junction probe\n",
      overwrite: false,
    }]);
    assertRejected(redirected, ".project-gov junction must block propose output");
    assert.equal(fs.existsSync(path.join(ordinary, "plans", "cache-junction.json")), false);
  }

  // 16. A line-replacement action rejects multiline content; block replacement handles it.
  {
    const root = createProject("multiline-line-replacement");
    const rejected = propose(root, "multiline-line-replacement", [{
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: "## 风险",
      replacement: "## 风险\n\n- 新增",
    }]);
    assertRejected(rejected, "replace_line_contains must remain single-line");
  }

  // 17. Material report fields are bounded and Windows alternate data streams are rejected.
  {
    const root = createProject("material-output-bound");
    const payload = Buffer.from("bounded\n", "utf8");
    write(root, "项目物料/原件/bounded.txt", payload);
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    const hugeId = "M".repeat(1024 * 1024);
    mutate(root, "项目物料/INDEX.md", (text) => `${text}| ${hugeId} | 项目物料/原件/bounded.txt | ${hash} | 本地 | 回归 | active |\n`);
    const bounded = run("verify-materials", root, [], 4 * 1024 * 1024);
    assertRejected(bounded, "invalid material-id must not pass verify-materials");
    assert.ok(JSON.stringify(bounded.json).includes("material_id_invalid"), bounded.stdout || bounded.stderr);
    assert.ok(Buffer.byteLength(bounded.stdout, "utf8") < 128 * 1024, `material stdout was ${Buffer.byteLength(bounded.stdout, "utf8")} bytes`);

    if (process.platform === "win32") {
      const ads = createProject("material-ads");
      const base = write(ads, "项目物料/原件/base.txt", "base\n");
      const adsPath = `${base}:hidden`;
      fs.writeFileSync(adsPath, "hidden\n", "utf8");
      const adsHash = crypto.createHash("sha256").update(fs.readFileSync(adsPath)).digest("hex");
      mutate(ads, "项目物料/INDEX.md", (text) => `${text}| MAT-20260728-009 | 项目物料/原件/base.txt:hidden | ${adsHash} | 本地 | 回归 | active |\n`);
      assertRejected(run("verify-materials", ads), "NTFS alternate data stream must not be verified as a regular file");
    }
  }

  // 18. Version, help text and reference documentation describe the same cache behavior.
  {
    const help = spawnSync(process.execPath, [script, "--help"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Read-only cache inventory:/);
    assert.match(help.stdout, /prune only inventories old \.project-gov cache; it never deletes files\./);
    assert.doesNotMatch(help.stdout, /project-gov prune[^\r\n]*--apply/);

    const cliDoc = fs.readFileSync(path.join(skillRoot, "references", "project-gov-cli.md"), "utf8");
    const stateDoc = fs.readFileSync(path.join(skillRoot, "references", "project-state.md"), "utf8");
    const skillSource = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    assert.match(cliDoc, /`prune` 是只读盘点命令/);
    assert.match(cliDoc, /符号链接和目录联接不会被跟随或展开/);
    assert.doesNotMatch(cliDoc, /prune[^\r\n]*--apply/);
    assert.doesNotMatch(cliDoc, /专用所有权标记/);
    assert.doesNotMatch(cliDoc, /`inspect`[^\r\n]*physical_layout/);
    assert.match(cliDoc, /`migrate-check（迁移检查）`[^\r\n]*`physical_layout（物理布局）`/);
    assert.match(cliDoc, /"schema_version": 2/);
    assert.match(cliDoc, /"knowledge_review"/);
    assert.match(cliDoc, /不得为填写它而额外创建知识库、知识卡、索引或空 checkpoint/);
    assert.match(stateDoc, /`migrate-check` 只浅层列出根目录编号文档/);
    // Agent authority is reviewed in Skill scenarios, not by freezing its wording in CLI tests.

    const inspected = run("inspect", createProject("inspect-contract"));
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.json.skill_version, expectedSkillVersion, inspected.stdout);
    assert.equal(Object.hasOwn(inspected.json, "physical_layout"), false, inspected.stdout);

    const troubleshooting = fs.readFileSync(path.join(skillRoot, "references", "troubleshooting.md"), "utf8");
    assert.match(skillSource, /references\/troubleshooting\.md/);
    assert.equal(fs.existsSync(path.join(skillRoot, "references", "quickstart-faq.md")), false);
    assert.match(troubleshooting, /## 出错时怎么处理/);
    assert.match(troubleshooting, /before_hash_missing/);
    assert.match(troubleshooting, /Hash precondition failed/);
    assert.match(troubleshooting, /不得把机械校验通过说成业务语义已经正确/);

    const cacheRoot = createProject("prune-link-contract");
    const cacheTarget = path.join(cacheRoot, "cache-target");
    fs.mkdirSync(cacheTarget, { recursive: true });
    write(cacheRoot, "cache-target/sentinel.txt", "keep\n");
    fs.mkdirSync(path.join(cacheRoot, ".project-gov", "plans"), { recursive: true });
    fs.symlinkSync(cacheTarget, path.join(cacheRoot, ".project-gov", "plans", "redirected"), "junction");
    const inventory = run("prune", cacheRoot, ["--older-than-days", "0"]);
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.equal((inventory.json.items || []).some((item) => item.rel.endsWith("/redirected")), false);
    assert.equal(fs.readFileSync(path.join(cacheTarget, "sentinel.txt"), "utf8"), "keep\n");
  }

  // 19. Empty material indexes state their narrow verification scope without failing an empty project.
  {
    const root = createProject("material-empty-scope");
    const empty = run("verify-materials", root);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.json.ok, true, empty.stdout);
    assert.equal(empty.json.complete, true, empty.stdout);
    assert.equal(empty.json.verification_scope, "indexed_rows_only", empty.stdout);
    assert.equal(empty.json.indexed_count, 0, empty.stdout);
    assert.equal(empty.json.checked_count, 0, empty.stdout);
    assert.ok(empty.json.warnings.includes("material_index_empty_no_files_verified"), empty.stdout);
  }

  // 20. External paths are redacted and independent hash/path failures are reported together.
  {
    const root = createProject("material-redacted-reasons");
    const sensitivePath = "C:\\Synthetic Sensitive\\customer-video.mp4";
    mutate(root, "项目物料/INDEX.md", (text) => `${text}| MAT-20260728-010 | ${sensitivePath} | not-a-sha256 | 外部 | 回归 | active |\n`);
    const result = run("verify-materials", root);
    assertRejected(result, "invalid hash and external path must both be reported");
    assert.doesNotMatch(result.stdout, /Synthetic Sensitive|customer-video\.mp4/);
    assert.equal(result.json.unverifiable.length, 1, result.stdout);
    const record = result.json.unverifiable[0];
    assert.equal(record.path, null, result.stdout);
    assert.equal(record.path_kind, "absolute", result.stdout);
    assert.equal(record.path_redacted, true, result.stdout);
    assert.equal(record.reason, "hash_not_sha256", result.stdout);
    assert.deepEqual(record.reasons, ["hash_not_sha256", "absolute_path_not_verified"], result.stdout);
  }

  // 21. Every structured result is versioned, compiled plans bind the version, and old plans fail before locking.
  {
    const root = createProject("versioned-json-contract");
    for (const [command, extra] of [
      ["inspect", []],
      ["validate", []],
      ["ids", ["--date", "20260728"]],
      ["startup", []],
      ["migrate-check", []],
      ["verify-materials", []],
      ["prune", ["--older-than-days", "0"]],
    ]) {
      const result = run(command, root, extra);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.skill_version, expectedSkillVersion, `${command}: ${result.stdout || result.stderr}`);
      if (command === "startup") {
        assert.doesNotMatch(result.json.startup, /执行记录/, "startup must not route ordinary execution into governance records");
        assert.match(result.json.startup, /只有持久状态发生实质变化时才写正式治理记录/, "startup must preserve the material-state-change gate");
        assert.match(result.json.startup, /中间进度沿用轻量进度账/, "startup must preserve the intermediate progress route");
      }
    }

    const proposed = propose(root, "versioned-plan", [{
      kind: "write_file",
      path: "历史记录/versioned-plan.md",
      content: "# versioned plan\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.stderr);
    assert.equal(proposed.json.skill_version, expectedSkillVersion, proposed.stdout);
    const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
    assert.equal(compiled.compiled_schema_version, 5);
    assert.equal(compiled.skill_version, expectedSkillVersion);

    const applied = apply(proposed.out);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.json.skill_version, expectedSkillVersion, applied.stdout);

    const stalePlan = write(root, "stale-version.plan.json", `${JSON.stringify({
      ...compiled,
      skill_version: "0.3.1",
    }, null, 2)}\n`);
    const staleApply = apply(stalePlan);
    assertRejected(staleApply, "stale skill plans must be rejected");
    assert.equal(staleApply.json.skill_version, expectedSkillVersion, staleApply.stdout || staleApply.stderr);
    assert.match(staleApply.json.error, /compiled_skill_version_mismatch/);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);

    const staleSchemaPlan = write(root, "stale-schema.plan.json", `${JSON.stringify({
      ...compiled,
      compiled_schema_version: 2,
    }, null, 2)}\n`);
    const staleSchemaApply = apply(staleSchemaPlan);
    assertRejected(staleSchemaApply, "stale compiled schema plans must be rejected independently");
    assert.equal(staleSchemaApply.json.skill_version, expectedSkillVersion, staleSchemaApply.stdout || staleSchemaApply.stderr);
    assert.match(staleSchemaApply.json.error, /compiled_schema_version_must_be_5/);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);

    const failed = run("inspect", root, ["--unsupported", "value"]);
    assertRejected(failed, "error JSON must carry the running skill version");
    assert.equal(failed.json.skill_version, expectedSkillVersion, failed.stdout || failed.stderr);
  }

  // 22. Literal material paths preserve legal leading underscores instead of verifying a decoy file.
  {
    const root = createProject("material-literal-path");
    const decoy = Buffer.from("decoy payload\n", "utf8");
    write(root, "artifact.txt", decoy);
    const decoyHash = crypto.createHash("sha256").update(decoy).digest("hex");
    mutate(root, "项目物料/INDEX.md", (text) => `${text
      .replace(
        "| material-id | 路径 | hash | 来源 | 用途 | 状态 |",
        "| material-id | 路径 | hash | 来源 | 用途 | 状态 | locator-kind |",
      )
      .replace(
        "| --- | --- | --- | --- | --- | --- |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      )}| MAT-20260728-011 | \`_artifact.txt\` | ${decoyHash} | 本地 | 回归 | active | file |\n`);

    const result = run("verify-materials", root);
    assertRejected(result, "a missing underscored path must not verify the undecorated decoy");
    assert.equal(result.json.matched_count, 0, result.stdout);
    assert.equal(result.json.missing_count, 1, result.stdout);
    assert.equal(result.json.missing[0].path, "_artifact.txt", result.stdout);
    assert.ok(result.json.missing[0].reasons.includes("file_missing"), result.stdout);
  }

  // 23. Managed project files cannot be read through a directory junction outside the project.
  {
    const root = createProject("managed-core-junction");
    const external = path.join(sandbox, `external-managed-${sequence}`);
    write(
      external,
      "INDEX.md",
      "# EXTERNAL_INDEX_MARKER\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n",
    );
    fs.rmSync(path.join(root, "项目物料"), { recursive: true, force: true });
    fs.symlinkSync(external, path.join(root, "项目物料"), "junction");

    for (const command of ["inspect", "verify-materials"]) {
      const result = run(command, root);
      assertRejected(result, `${command} must reject a redirected managed index`);
      assert.match(result.json.error, /managed_project_path_redirected:项目物料\/INDEX\.md/);
      assert.doesNotMatch(result.stdout || result.stderr, /EXTERNAL_INDEX_MARKER/);
    }
  }

  // 24. Apply preserves a pre-existing backup base and refuses a redirected backup base before locking or writing.
  {
    const preservedRoot = createProject("backup-base-preserved");
    const preservedPlan = propose(preservedRoot, "backup-base-preserved", [{
      kind: "write_file",
      path: "历史记录/backup-base-preserved.md",
      content: "# backup base preserved\n",
      overwrite: false,
    }]);
    assert.equal(preservedPlan.status, 0, preservedPlan.stderr);
    const preservedBase = path.join(preservedRoot, ".project-gov", "backups");
    fs.mkdirSync(preservedBase);
    const preservedApply = apply(preservedPlan.out);
    assert.equal(preservedApply.status, 0, preservedApply.stderr);
    assert.equal(fs.existsSync(preservedBase), true);
    assert.deepEqual(fs.readdirSync(preservedBase), []);

    const redirectedRoot = createProject("backup-base-junction");
    const redirectedPlan = propose(redirectedRoot, "backup-base-junction", [{
      kind: "write_file",
      path: "历史记录/backup-base-junction.md",
      content: "# backup base junction\n",
      overwrite: false,
    }]);
    assert.equal(redirectedPlan.status, 0, redirectedPlan.stderr);
    const external = path.join(sandbox, `external-backups-${sequence}`);
    fs.mkdirSync(external);
    write(external, "sentinel.txt", "keep\n");
    const redirectedBase = path.join(redirectedRoot, ".project-gov", "backups");
    fs.symlinkSync(external, redirectedBase, "junction");

    const redirectedApply = apply(redirectedPlan.out);
    assertRejected(redirectedApply, "a redirected backup base must block apply");
    assert.match(redirectedApply.json.error, /managed_project_path_redirected:\.project-gov\/backups/);
    assert.equal(fs.lstatSync(redirectedBase).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(external), ["sentinel.txt"]);
    assert.equal(fs.existsSync(path.join(redirectedRoot, ".project-gov", "apply.lock")), false);
  }

  console.log("project-gov regression tests: PASS");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
