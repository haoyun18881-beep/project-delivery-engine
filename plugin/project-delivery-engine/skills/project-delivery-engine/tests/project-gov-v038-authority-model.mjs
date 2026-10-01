import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildTypedIndexModel,
  createInspectionContext,
  inspectProject,
} from "../scripts/project-gov.mjs";
import {
  createProject,
  removeProject,
  write,
  writeIndex,
} from "./helpers/project-gov-v038-harness.mjs";

const root = createProject("typed-index-single-authority");
const indexPaths = new Set([
  "历史记录/00-历史总目录.md",
  "证据库/总索引/证据总目录.md",
  "项目物料/INDEX.md",
]);
const bodyOpenCounts = new Map([...indexPaths].map((rel) => [rel, 0]));

try {
  const formalId = "M-20260828-001";
  const filenameId = "M-20260828-002";
  const degradedId = "EV-20260828-001";
  const unresolvedId = "EV-20991231-999";
  const formalRel = `历史记录/记录/${formalId}-正式定义.md`;
  const filenameRel = `docs/${filenameId}.md`;

  write(root, formalRel, `# 正式定义\n\n${formalId}\n`);
  write(root, filenameRel, `# 文件名定义\n\n${filenameId}\n`);
  write(
    root,
    "STATUS.md",
    fs.readFileSync(path.join(root, "STATUS.md"), "utf8")
      .replace("- 无\n", `- ${formalId}\n- ${filenameId}\n- ${degradedId}\n- ${unresolvedId}\n`),
  );
  writeIndex(
    root,
    "历史记录/00-历史总目录.md",
    "历史总目录",
    ["history-id", "日期", "标题", "路径", "状态"],
    [[formalId, "2026-08-28", "正式定义", formalRel, "active"]],
  );
  writeIndex(
    root,
    "证据库/总索引/证据总目录.md",
    "证据总目录",
    ["evidence-id", "run_id", "task_id", "来源", "摘要", "路径", "采纳状态"],
    [[degradedId, "run-1", "task-1", "fixture", "降级路径", "../outside.md", "pending"]],
  );
  writeIndex(
    root,
    "项目物料/INDEX.md",
    "项目物料索引",
    ["material-id", "路径", "hash", "来源", "用途", "状态", "locator-kind"],
    [["MAT-20260828-001", filenameRel, "-", "fixture", "文件名定义", "active", "file"]],
  );

  const io = Object.create(fs);
  io.openSync = (target, ...args) => {
    const rel = path.relative(root, path.resolve(String(target))).replaceAll("\\", "/");
    if (bodyOpenCounts.has(rel)) bodyOpenCounts.set(rel, bodyOpenCounts.get(rel) + 1);
    return fs.openSync(target, ...args);
  };
  const context = createInspectionContext(root, { phase: "typed-index-authority-test", io });
  const firstModel = buildTypedIndexModel(context);
  assert.equal(buildTypedIndexModel(context), firstModel, "Typed Index Model must be cached per Epoch");
  inspectProject(root, { context, phase: "typed-index-authority-test" });

  assert.equal(firstModel.managedScanEnriched, true);
  assert.equal(firstModel.referenceStatuses.get(formalId)?.status, "resolved");
  assert.equal(firstModel.referenceStatuses.get(formalId)?.definition_source, "formal_id_column");
  assert.equal(firstModel.referenceStatuses.get(filenameId)?.status, "resolved");
  assert.equal(firstModel.referenceStatuses.get(filenameId)?.definition_source, "canonical_filename");
  assert.equal(firstModel.referenceStatuses.get(degradedId)?.status, "resolved_with_invalid_entry_path");
  assert.equal(firstModel.referenceStatuses.get(unresolvedId)?.status, "unresolved");
  assert.equal(firstModel.definitionOccurrences.get(filenameId)?.[0]?.source, "canonical_filename");
  assert.equal(firstModel.definitionOccurrences.get(formalId)?.[0]?.source, "formal_id_column");
  for (const [rel, count] of bodyOpenCounts.entries()) {
    assert.equal(count, 1, `${rel} must be physically parsed once in one Epoch`);
  }

  console.log("project-gov v0.3.8 Typed Index single-authority test: PASS");
} finally {
  removeProject(root);
}
