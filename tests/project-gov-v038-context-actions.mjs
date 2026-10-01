import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectSignalStrings,
  createProject,
  findDecisionSnapshots,
  findObjects,
  removeProject,
  write,
  writeIndex,
} from "./helpers/project-gov-v038-harness.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionScript = path.join(skillRoot, "scripts", "project-gov.mjs");
const runtimeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v038-context-actions-"));
const instrumentedScript = createInstrumentedScript();
const TWO_MIB = 2 * 1024 * 1024;
const expected = new Set([
  "LR39", "LR40", "LR41", "LR42", "LR43", "LR44", "LR47",
  "LR49", "LR50", "LR51", "LR52", "LR53", "LR54", "LR55", "LR56",
]);
const registered = new Set();

function lr(id, name, fn) {
  assert.ok(expected.has(id), `unexpected LR registration: ${id}`);
  assert.equal(registered.has(id), false, `duplicate LR registration: ${id}`);
  registered.add(id);
  test(`[${id}] ${name}`, { concurrency: false }, fn);
}

function fixture(t, name) {
  const root = createProject(name);
  t.after(() => removeProject(root));
  return root;
}

function parseJsonOutput(result) {
  const candidates = [String(result.stdout || "").trim(), String(result.stderr || "").trim()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { json: JSON.parse(candidate), raw: candidate };
    } catch {
      // Assertions report the bounded raw process output below.
    }
  }
  return { json: null, raw: candidates.join("\n") };
}

function runScript(script, command, root, extra = [], options = {}) {
  const result = spawnSync(
    process.execPath,
    [script, command, "--root", root, ...extra, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout || 60_000,
      env: { ...process.env, ...(options.env || {}) },
    },
  );
  const parsed = parseJsonOutput(result);
  return { ...result, ...parsed };
}

function inspect(root, options = {}) {
  return runScript(options.script || productionScript, "inspect", root, [], options);
}

function propose(root, planId, actions, knowledgeReview = null, options = {}) {
  const operation = write(root, `${planId}.operation.json`, `${JSON.stringify({
    schema_version: 2,
    plan_id: planId,
    knowledge_review: knowledgeReview || {
      status: "none",
      basis: "该验收夹具没有产生需要沉淀的跨任务知识。",
    },
    actions,
  }, null, 2)}\n`);
  const out = path.join(root, ".project-gov", "plans", `${planId}.json`);
  return {
    ...runScript(options.script || productionScript, "propose", root, ["--plan", operation, "--out", out], options),
    operation,
    out,
  };
}

function apply(script, compiledPlan, options = {}) {
  const result = spawnSync(process.execPath, [script, "apply", "--plan", compiledPlan, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 60_000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const parsed = parseJsonOutput(result);
  return { ...result, ...parsed };
}

function assertProcessCompleted(result, label) {
  assert.notEqual(result.error?.code, "ETIMEDOUT", `${label}: child process timed out`);
  assert.equal(result.signal, null, `${label}: child terminated by ${result.signal}\n${result.raw}`);
  assert.ok(result.json && typeof result.json === "object", `${label}: structured JSON missing\n${result.raw}`);
}

function assertRejected(result, label) {
  assertProcessCompleted(result, label);
  assert.notEqual(result.status, 0, `${label}: command unexpectedly succeeded\n${result.raw}`);
  assert.equal(result.json?.ok, false, `${label}: rejection did not return ok=false\n${result.raw}`);
}

function signalStrings(result) {
  return collectSignalStrings(result.json);
}

function assertSignal(result, matcher, label) {
  const strings = signalStrings(result);
  const matched = typeof matcher === "string"
    ? strings.some((item) => item.includes(matcher))
    : strings.some((item) => matcher.test(item));
  assert.ok(matched, `${label}: missing signal ${String(matcher)}\n${result.raw}`);
}

function decisionSnapshot(result) {
  const snapshots = findDecisionSnapshots(result.json);
  assert.ok(snapshots.length > 0, `Decision Snapshot missing\n${result.raw}`);
  return snapshots[0];
}

function hasStableIssue(snapshot, code, subjectMatcher = null) {
  return [...(snapshot.hard_issues || []), ...(snapshot.coverage_issues || [])].some((item) => (
    item?.code === code
    && (subjectMatcher === null || subjectMatcher.test(String(item.subject_key || "")))
  ));
}

function statusText(marker = "基线") {
  return `# STATUS.md

## 当前状态

| 项目 | 状态 | 依据 |
| --- | --- | --- |
| 验收 | ${marker} | 本地夹具 |

## 验证

| 验证项 | 结果 | 层级 |
| --- | --- | --- |
| 基线 | 通过 | 主线 |

## 风险

- 无

## 关键引用

- 无
`;
}

function exactSizedStatus(bytes) {
  const prefix = statusText("超大待恢复");
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  assert.ok(bytes > prefixBytes + 1);
  return `${prefix}${"x".repeat(bytes - prefixBytes - 1)}\n`;
}

function writeMaterialIndex(root, rows) {
  writeIndex(
    root,
    "项目物料/INDEX.md",
    "项目物料索引",
    ["material-id", "路径", "hash", "来源", "用途", "状态", "locator-kind"],
    rows,
  );
}

function materialRow(id, rel) {
  return [id, rel, "-", "本地验收", "完整性对抗", "active", "file"];
}

function instrumentationEnv(root, rel, counterFile, extra = {}) {
  return {
    PDE_TEST_COUNT_TARGET: path.join(root, rel),
    PDE_TEST_COUNTER_FILE: counterFile,
    ...extra,
  };
}

function readCounter(counterFile, label) {
  assert.equal(fs.existsSync(counterFile), true, `${label}: instrumentation counter missing`);
  return JSON.parse(fs.readFileSync(counterFile, "utf8"));
}

function createInstrumentedScript() {
  const source = fs.readFileSync(productionScript, "utf8");
  const anchor = 'import { fileURLToPath } from "node:url";';
  assert.equal(source.includes(anchor), true, "instrumentation import anchor missing");
  const instrumentation = String.raw`

const __pdeOriginalOpenSync = fs.openSync.bind(fs);
const __pdeOriginalLstatSync = fs.lstatSync.bind(fs);
const __pdeOriginalWriteFileSync = fs.writeFileSync.bind(fs);
const __pdeOriginalAlloc = Buffer.alloc.bind(Buffer);
const __pdeOriginalAllocUnsafe = Buffer.allocUnsafe.bind(Buffer);
const __pdeCountTarget = process.env.PDE_TEST_COUNT_TARGET ? path.resolve(process.env.PDE_TEST_COUNT_TARGET) : null;
const __pdeFailExact = process.env.PDE_TEST_FAIL_READ_EXACT ? path.resolve(process.env.PDE_TEST_FAIL_READ_EXACT) : null;
const __pdeFailPrefix = process.env.PDE_TEST_FAIL_READ_PREFIX ? path.resolve(process.env.PDE_TEST_FAIL_READ_PREFIX) : null;
const __pdeRewriteOnBodyOpen = process.env.PDE_TEST_REWRITE_ON_BODY_OPEN
  ? path.resolve(process.env.PDE_TEST_REWRITE_ON_BODY_OPEN)
  : null;
const __pdeDriftOnSeal = process.env.PDE_TEST_DRIFT_ON_SEAL
  ? path.resolve(process.env.PDE_TEST_DRIFT_ON_SEAL)
  : null;
let __pdeRewriteCompleted = false;
let __pdeSealDriftCompleted = false;
const __pdeCounter = { body_open_count: 0, stream_open_count: 0, other_open_count: 0 };
const __pdeSame = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;
const __pdeInside = (target, prefix) => {
  const relative = path.relative(prefix, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
fs.openSync = function __pdeInstrumentedOpenSync(target, ...args) {
  const resolved = typeof target === "string" || Buffer.isBuffer(target) || target instanceof URL
    ? path.resolve(String(target))
    : null;
  if (resolved && ((__pdeFailExact && __pdeSame(resolved, __pdeFailExact)) || (__pdeFailPrefix && __pdeInside(resolved, __pdeFailPrefix)))) {
    const error = new Error("injected_read_denied");
    error.code = "EACCES";
    throw error;
  }
  const stack = String(new Error().stack || "");
  if (
    resolved
    && __pdeRewriteOnBodyOpen
    && !__pdeRewriteCompleted
    && __pdeSame(resolved, __pdeRewriteOnBodyOpen)
    && stack.includes("getBoundedBuffer")
  ) {
    __pdeRewriteCompleted = true;
    const bytes = fs.statSync(resolved).size;
    __pdeOriginalWriteFileSync(resolved, Buffer.alloc(bytes, 0x78));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(resolved, future, future);
  }
  if (resolved && __pdeCountTarget && __pdeSame(resolved, __pdeCountTarget)) {
    if (stack.includes("getBoundedBuffer")) __pdeCounter.body_open_count += 1;
    else if (stack.includes("sha256FileChunked")) __pdeCounter.stream_open_count += 1;
    else __pdeCounter.other_open_count += 1;
  }
  return __pdeOriginalOpenSync(target, ...args);
};
fs.lstatSync = function __pdeInstrumentedLstatSync(target, ...args) {
  const resolved = typeof target === "string" || Buffer.isBuffer(target) || target instanceof URL
    ? path.resolve(String(target))
    : null;
  const stack = String(new Error().stack || "");
  if (
    resolved
    && __pdeDriftOnSeal
    && !__pdeSealDriftCompleted
    && __pdeSame(resolved, __pdeDriftOnSeal)
    && stack.includes("context.seal")
  ) {
    __pdeSealDriftCompleted = true;
    const original = fs.readFileSync(resolved);
    __pdeOriginalWriteFileSync(
      resolved,
      Buffer.concat([original, Buffer.from("\n<!-- injected inspection epoch drift -->\n")]),
    );
  }
  return __pdeOriginalLstatSync(target, ...args);
};
const __pdeAllocationLimit = Number(process.env.PDE_TEST_MAX_SINGLE_ALLOCATION || 0);
if (__pdeAllocationLimit > 0) {
  Buffer.alloc = function __pdeGuardedAlloc(size, ...args) {
    if (Number(size) > __pdeAllocationLimit) throw new Error("whole_file_allocation_blocked:" + size);
    return __pdeOriginalAlloc(size, ...args);
  };
  Buffer.allocUnsafe = function __pdeGuardedAllocUnsafe(size, ...args) {
    if (Number(size) > __pdeAllocationLimit) throw new Error("whole_file_allocation_blocked:" + size);
    return __pdeOriginalAllocUnsafe(size, ...args);
  };
}
process.once("exit", () => {
  if (process.env.PDE_TEST_COUNTER_FILE) {
    __pdeOriginalWriteFileSync(process.env.PDE_TEST_COUNTER_FILE, JSON.stringify(__pdeCounter), "utf8");
  }
});
`;
  const injected = source.replace(anchor, `${anchor}${instrumentation}`);
  const abs = path.join(runtimeSandbox, "project-gov-instrumented.mjs");
  fs.writeFileSync(abs, injected, "utf8");
  return abs;
}

lr("LR39", "核心文件被目录替代时返回可修复的结构化问题", (t) => {
  const root = fixture(t, "lr39-core-directory");
  const target = path.join(root, "TODO.md");
  fs.rmSync(target);
  fs.mkdirSync(target);

  const result = inspect(root);
  assertRejected(result, "LR39 inspect");
  const records = findObjects(result.json, (item) => item?.code === "core_path_not_regular_file");
  const record = records.find((item) => (
    item.rel === "TODO.md"
    && item.kind === "directory"
    && [item.recovery_hint, item.repair_hint, item.recovery].some((value) => typeof value === "string" && value.trim())
  ));
  assert.ok(record, `LR39 structured recovery record missing\n${result.raw}`);
});

lr("LR40", "超限核心索引不整读且进程正常返回不完整状态", (t) => {
  const root = fixture(t, "lr40-oversized-index");
  const rel = "项目物料/INDEX.md";
  const header = "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n";
  write(root, rel, `${header}${"x".repeat(TWO_MIB + 4096)}\n`);
  const counterFile = path.join(runtimeSandbox, "lr40-counter.json");
  const result = inspect(root, {
    script: instrumentedScript,
    env: instrumentationEnv(root, rel, counterFile, { PDE_TEST_MAX_SINGLE_ALLOCATION: String(TWO_MIB) }),
  });

  assertRejected(result, "LR40 inspect");
  const snapshot = decisionSnapshot(result);
  assert.equal(snapshot.hard_issues_complete, false);
  assert.ok(hasStableIssue(snapshot, "managed_file_not_checked", /\u9879\u76ee\u7269\u6599\/INDEX\.md#file_too_large/), result.raw);
  const counter = readCounter(counterFile, "LR40");
  assert.equal(counter.body_open_count, 0, "LR40 oversized index was opened for a whole-text read");
  assert.ok(counter.stream_open_count >= 1, "LR40 oversized index fingerprint was not streamed");
});

lr("LR41", "受管 Markdown 读取失败保留稳定 subject 并降低 hard completeness", (t) => {
  const root = fixture(t, "lr41-managed-read-failure");
  const rel = "项目物料/read-failure.md";
  write(root, rel, "# managed read failure\n");
  writeMaterialIndex(root, [materialRow("MAT-20260828-READ-041", rel)]);
  const result = inspect(root, {
    script: instrumentedScript,
    env: { PDE_TEST_FAIL_READ_EXACT: path.join(root, rel) },
  });

  assertRejected(result, "LR41 inspect");
  const snapshot = decisionSnapshot(result);
  assert.equal(snapshot.hard_issues_complete, false);
  assert.equal(snapshot.coverage_issues_complete, false);
  assert.ok(hasStableIssue(snapshot, "managed_file_not_checked", /\u9879\u76ee\u7269\u6599\/read-failure\.md#(?:EACCES|read_failed)/), result.raw);
  const stableSubjects = snapshot.coverage_issues.map((item) => String(item.subject_key || ""));
  assert.equal(stableSubjects.some((item) => item.includes(root)), false, "LR41 leaked a temporary absolute path into stable subjects");
});

lr("LR42", "总字节预算耗尽但剩余对象可枚举时 coverage issue 集仍完整", (t) => {
  const root = fixture(t, "lr42-total-budget");
  const rows = [];
  const payload = Buffer.alloc(TWO_MIB - 4096, 0x61);
  for (let index = 1; index <= 17; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const rel = `项目物料/budget/scan-${suffix}.md`;
    write(root, rel, payload);
    rows.push(materialRow(`MAT-20260828-BUDGET-${suffix}`, rel));
  }
  writeMaterialIndex(root, rows);

  const result = inspect(root, { timeout: 90_000 });
  assertRejected(result, "LR42 inspect");
  const snapshot = decisionSnapshot(result);
  assert.equal(result.json?.typed_indexes?.managed_markdown_path_count, 17, "LR42 remaining managed paths were not enumerable");
  assert.equal(result.json?.markdown_scan?.total_bytes_exceeded, true, result.raw);
  assert.equal(snapshot.hard_issues_complete, false);
  assert.equal(snapshot.coverage_issues_complete, false);
  assert.ok(hasStableIssue(snapshot, "managed_scan_budget_exhausted", /managed-files#total-bytes/), result.raw);
});

lr("LR43", "索引无法解析时 hard 和 coverage completeness 均为 false", (t) => {
  const root = fixture(t, "lr43-index-parse-incomplete");
  write(root, "项目物料/INDEX.md", "# 项目物料索引\n\n损坏的索引没有表格。\n");

  const result = inspect(root);
  assertRejected(result, "LR43 inspect");
  const snapshot = decisionSnapshot(result);
  assert.equal(snapshot.hard_issues_complete, false);
  assert.equal(snapshot.coverage_issues_complete, false);
  assert.ok(hasStableIssue(snapshot, "index_parse_incomplete", /^项目物料\/INDEX\.md$/), result.raw);

  const counterFile = path.join(runtimeSandbox, "lr43-migrate-counter.json");
  const migration = runScript(instrumentedScript, "migrate-check", root, [], {
    env: instrumentationEnv(root, "项目物料/INDEX.md", counterFile),
  });
  assertRejected(migration, "LR43 migrate-check");
  assert.equal(migration.json?.up_to_date, false, migration.raw);
  assertSignal(migration, "structure_table_missing:项目物料/INDEX.md:root", "LR43 migrate-check");
  const checked = (migration.json?.checked || []).find((item) => item.rel === "项目物料/INDEX.md");
  assert.equal(checked?.ok, false, `LR43 checked result remained green\n${migration.raw}`);
  assert.equal(readCounter(counterFile, "LR43 migrate-check").body_open_count, 1, "LR43 index parsed more than once in one Epoch");
});

lr("LR44", "展示截断不等于内部不完整，真实读取失败仍保持 incomplete", (t) => {
  const hardRoot = fixture(t, "lr44-hard-truncation");
  const malformedRows = Array.from({ length: 120 }, (_, index) => `| P1 | malformed-${index + 1} |`).join("\n");
  write(hardRoot, "TODO.md", `# TODO.md

## 下一步

| 优先级 | 事项 | 完成条件 |
| --- | --- | --- |
${malformedRows}

## 待确认

| 事项 | 影响 |
| --- | --- |
| 无 | 无 |
`);
  const hardResult = inspect(hardRoot);
  assertRejected(hardResult, "LR44 hard collector");
  assert.equal(hardResult.json?.structure?.issues_truncated, true, hardResult.raw);
  const hardSnapshot = decisionSnapshot(hardResult);
  assert.equal(hardSnapshot.hard_issue_count, 120, hardResult.raw);
  assert.equal(hardSnapshot.hard_issues.length, 100, hardResult.raw);
  assert.equal(hardSnapshot.hard_issues_truncated, true, hardResult.raw);
  assert.equal(hardSnapshot.hard_issues_complete, true, hardResult.raw);

  const coverageRoot = fixture(t, "lr44-coverage-truncation");
  const rows = [];
  for (let index = 1; index <= 21; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const rel = `项目物料/faults/read-${suffix}.md`;
    write(coverageRoot, rel, `# fault ${suffix}\n`);
    rows.push(materialRow(`MAT-20260828-FAULT-${suffix}`, rel));
  }
  writeMaterialIndex(coverageRoot, rows);
  const coverageResult = inspect(coverageRoot, {
    script: instrumentedScript,
    env: { PDE_TEST_FAIL_READ_PREFIX: path.join(coverageRoot, "项目物料", "faults") },
  });
  assertRejected(coverageResult, "LR44 coverage collector");
  assert.equal(coverageResult.json?.markdown_scan?.read_error_count, 21, coverageResult.raw);
  assert.equal(coverageResult.json?.markdown_scan?.read_errors_truncated, true, coverageResult.raw);
  assert.equal(decisionSnapshot(coverageResult).coverage_issues_complete, false);

  const typedRoot = fixture(t, "lr44-typed-index-truncation");
  writeMaterialIndex(typedRoot, Array.from({ length: 120 }, (_, index) => {
    const suffix = String(index + 100).padStart(3, "0");
    return [
      `BAD-${suffix}`,
      `https://example.invalid/material-${suffix}`,
      "-",
      "本地验收",
      "typed issue 截断",
      "active",
      "external_uri",
    ];
  }));
  const typedResult = inspect(typedRoot);
  assertRejected(typedResult, "LR44 typed issue collector");
  assert.equal(typedResult.json?.typed_indexes?.hard_issue_count, 120, typedResult.raw);
  assert.ok((typedResult.json?.typed_indexes?.hard_issues || []).length <= 100, typedResult.raw);
  assert.equal(typedResult.json?.typed_indexes?.hard_issues_truncated, true, typedResult.raw);
  const typedSnapshot = decisionSnapshot(typedResult);
  assert.equal(typedSnapshot.hard_issue_count, 120, typedResult.raw);
  assert.equal(typedSnapshot.hard_issues.length, 100, typedResult.raw);
  assert.equal(typedSnapshot.hard_issues_truncated, true, typedResult.raw);
  assert.equal(typedSnapshot.hard_issues_complete, true, typedResult.raw);
  const typedMigration = runScript(productionScript, "migrate-check", typedRoot);
  assertRejected(typedMigration, "LR44 typed migrate-check");
  assert.equal(typedMigration.json?.up_to_date, false, typedMigration.raw);
  const typedIds = runScript(productionScript, "ids", typedRoot, ["--date", "20260829"]);
  assertRejected(typedIds, "LR44 ids output cap");
  assert.ok((typedIds.json?.errors || []).length <= 100, typedIds.raw);
  assert.equal(typedIds.json?.error_count, 120, typedIds.raw);
  assert.equal(typedIds.json?.errors_truncated, true, typedIds.raw);
  assert.match(typedIds.json?.error_multiset_digest || "", /^[a-f0-9]{64}$/, typedIds.raw);

  const hardMigration = runScript(productionScript, "migrate-check", hardRoot);
  assertRejected(hardMigration, "LR44 hard migrate-check");
  assert.ok((hardMigration.json?.migration_items || []).length <= 100, hardMigration.raw);
  assert.equal(hardMigration.json?.migration_items_truncated, true, hardMigration.raw);
  assert.equal(hardMigration.json?.indeterminate, false, hardMigration.raw);

  const placeholderRoot = fixture(t, "lr44-placeholder-output-cap");
  const placeholders = Array.from({ length: 120 }, (_, index) => `TODO_FILL_${String(index + 1).padStart(3, "0")}`).join("\n");
  fs.appendFileSync(path.join(placeholderRoot, "STATUS.md"), `\n${placeholders}\n`, "utf8");
  const placeholderResult = inspect(placeholderRoot);
  assertRejected(placeholderResult, "LR44 placeholder output cap");
  assert.equal(placeholderResult.json?.placeholder_count, 120, placeholderResult.raw);
  assert.equal(placeholderResult.json?.placeholders?.length, 100, placeholderResult.raw);
  assert.equal(placeholderResult.json?.placeholders_truncated, true, placeholderResult.raw);
  assert.equal(decisionSnapshot(placeholderResult).hard_issue_count, 120, placeholderResult.raw);
  assert.equal(decisionSnapshot(placeholderResult).hard_issues_complete, true, placeholderResult.raw);

  const indexedPlaceholderRoot = fixture(t, "lr44-indexed-placeholder");
  write(indexedPlaceholderRoot, "历史记录/registered.md", "# registered\nTODO_FILL_INDEXED_DOCUMENT\n");
  writeIndex(
    indexedPlaceholderRoot,
    "历史记录/00-历史总目录.md",
    "历史总目录",
    ["history-id", "日期", "标题", "路径", "状态"],
    [["M-20260831-999", "2026-08-31", "registered", "`历史记录/registered.md`", "active"]],
  );
  const indexedPlaceholder = inspect(indexedPlaceholderRoot);
  assertRejected(indexedPlaceholder, "LR44 indexed Markdown placeholder");
  assert.equal(indexedPlaceholder.json?.placeholder_count, 1, indexedPlaceholder.raw);
  assert.ok(collectSignalStrings(indexedPlaceholder.json).some((value) => value.includes("template_placeholder_found")), indexedPlaceholder.raw);

  const unindexedPlaceholderRoot = fixture(t, "lr44-unindexed-placeholder");
  write(unindexedPlaceholderRoot, "notes.md", "TODO_FILL_UNMANAGED_DOCUMENT\n");
  const unindexedPlaceholder = inspect(unindexedPlaceholderRoot);
  assert.equal(unindexedPlaceholder.status, 0, unindexedPlaceholder.raw);
  assert.equal(unindexedPlaceholder.json?.placeholder_count, 0, unindexedPlaceholder.raw);

  const collisionRoot = fixture(t, "lr44-definition-collision-output-cap");
  const collisionRows = Array.from({ length: 120 }, (_, index) => {
    const suffix = String(index + 100).padStart(3, "0");
    const id = `MAT-20260828-COLLIDE-${suffix}`;
    return [
      [id, `https://example.invalid/a-${suffix}`, "-", "本地验收", "collision A", "active", "external_uri"],
      [id, `https://example.invalid/b-${suffix}`, "-", "本地验收", "collision B", "active", "external_uri"],
    ];
  }).flat();
  writeMaterialIndex(collisionRoot, collisionRows);
  const collisionResult = inspect(collisionRoot);
  assertRejected(collisionResult, "LR44 definition collision output cap");
  assert.equal(collisionResult.json?.ids?.definition_collision_count, 120, collisionResult.raw);
  assert.equal(collisionResult.json?.ids?.definition_collisions?.length, 100, collisionResult.raw);
  assert.equal(collisionResult.json?.ids?.definition_collisions_truncated, true, collisionResult.raw);
  assert.equal(decisionSnapshot(collisionResult).hard_issues_complete, false, collisionResult.raw);

  const longPathRoot = fixture(t, "lr44-long-missing-path-output-cap");
  const longRel = `历史记录/${Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(90)}`).join("/")}.md`;
  fs.appendFileSync(
    path.join(longPathRoot, "历史记录", "00-历史总目录.md"),
    `| M-20260828-099 | 2026-08-28 | long missing path | \`${longRel}\` | active |\n`,
    "utf8",
  );
  const longPathResult = inspect(longPathRoot);
  assertRejected(longPathResult, "LR44 long missing path output cap");
  assert.equal(longPathResult.json?.markdown_scan?.missing_indexed_file_count, 1, longPathResult.raw);
  assert.ok(longPathResult.json?.markdown_scan?.missing_indexed_files?.[0]?.length <= 512, longPathResult.raw);
  assert.equal(decisionSnapshot(longPathResult).coverage_issues_complete, false, longPathResult.raw);

  const longMaterialRoot = fixture(t, "lr44-long-material-path-output-cap");
  writeMaterialIndex(longMaterialRoot, [[
    "MAT-20260828-LONG-001",
    longRel,
    "-",
    "本地验收",
    "long material path",
    "active",
    "file",
  ]]);
  const longMaterialResult = runScript(productionScript, "verify-materials", longMaterialRoot);
  assertRejected(longMaterialResult, "LR44 long material path output cap");
  assert.equal(longMaterialResult.json?.missing_count, 1, longMaterialResult.raw);
  assert.ok(longMaterialResult.json?.missing?.[0]?.path?.length <= 512, longMaterialResult.raw);

  const longCollisionRoot = fixture(t, "lr44-long-collision-path-output-cap");
  const longPrefix = (label) => `历史记录/${Array.from({ length: 7 }, (_, index) => `${label}${index}-${"y".repeat(72)}`).join("/")}`;
  const collisionRelA = `${longPrefix("a")}/M-20260829-999.md`;
  const collisionRelB = `${longPrefix("b")}/M-20260829-999.md`;
  write(longCollisionRoot, collisionRelA, "# collision A\n");
  write(longCollisionRoot, collisionRelB, "# collision B\n");
  fs.appendFileSync(
    path.join(longCollisionRoot, "历史记录", "00-历史总目录.md"),
    `| M-20260829-001 | 2026-08-29 | collision A | \`${collisionRelA}\` | active |\n| M-20260829-002 | 2026-08-29 | collision B | \`${collisionRelB}\` | active |\n`,
    "utf8",
  );
  const longCollisionResult = inspect(longCollisionRoot);
  assertRejected(longCollisionResult, "LR44 long collision path output cap");
  const longCollision = longCollisionResult.json?.ids?.definition_collisions?.find(
    (item) => item.id === "M-20260829-999",
  );
  assert.ok(longCollision, longCollisionResult.raw);
  assert.ok(longCollision.files.every((rel) => rel.length <= 512), longCollisionResult.raw);
  assert.ok(longCollision.locations.every((item) => item.rel.length <= 512), longCollisionResult.raw);

  const missingDigestResults = [];
  for (const variant of ["a", "b"]) {
    const missingRoot = fixture(t, `lr44-ids-missing-digest-${variant}`);
    const missingRows = Array.from({ length: 120 }, (_, index) => {
      const suffix = String(index + 100).padStart(3, "0");
      const tail = variant === "b" && index === 119 ? "changed-tail" : `missing-${suffix}`;
      return `| M-20260829-${suffix} | 2026-08-29 | ${tail} | \`历史记录/${tail}.md\` | active |`;
    }).join("\n");
    fs.appendFileSync(
      path.join(missingRoot, "历史记录", "00-历史总目录.md"),
      `${missingRows}\n`,
      "utf8",
    );
    const idsResult = runScript(productionScript, "ids", missingRoot, ["--date", "20260829"]);
    assertRejected(idsResult, `LR44 ids missing digest ${variant}`);
    assert.equal(idsResult.json?.error_count, 120, idsResult.raw);
    assert.ok((idsResult.json?.errors || []).length <= 100, idsResult.raw);
    assert.equal(idsResult.json?.errors_truncated, true, idsResult.raw);
    assert.match(idsResult.json?.error_multiset_digest || "", /^[a-f0-9]{64}$/, idsResult.raw);
    missingDigestResults.push(idsResult.json.error_multiset_digest);
  }
  assert.notEqual(missingDigestResults[0], missingDigestResults[1]);
});

lr("LR47", "同一 Epoch 内多个消费者对同一核心正文只触发一次物理读取", (t) => {
  const root = fixture(t, "lr47-one-body-read");
  const counterFile = path.join(runtimeSandbox, "lr47-counter.json");
  const result = propose(root, "lr47-cache", [{
    kind: "append_after",
    path: "STATUS.md",
    after: "# STATUS.md",
    match: "exact",
    content: "LR47 epoch cache marker",
  }], null, {
    script: instrumentedScript,
    env: instrumentationEnv(root, "STATUS.md", counterFile),
  });

  assertProcessCompleted(result, "LR47 propose");
  assert.equal(result.status, 0, result.raw);
  assert.equal(result.json?.ok, true, result.raw);
  const counter = readCounter(counterFile, "LR47");
  assert.equal(counter.body_open_count, 1, `LR47 STATUS.md body opens: ${JSON.stringify(counter)}`);
  assert.ok(counter.stream_open_count >= 1, "LR47 fingerprint did not use the streaming path");

  const driftRoot = fixture(t, "lr47-same-size-identity-drift");
  const drift = inspect(driftRoot, {
    script: instrumentedScript,
    env: { PDE_TEST_REWRITE_ON_BODY_OPEN: path.join(driftRoot, "STATUS.md") },
  });
  assertRejected(drift, "LR47 same-size identity drift");
  assertSignal(drift, "file_changed_during_read", "LR47 same-size identity drift");
  assert.equal(decisionSnapshot(drift).hard_issues_complete, false);
});

test("[Inspection Epoch] seal 前已读非目标漂移不得让检查或 propose 假绿", { concurrency: false }, (t) => {
  for (const command of ["inspect", "validate", "migrate-check", "propose"]) {
    const root = fixture(t, `inspection-epoch-seal-${command}`);
    const nonTargetRel = "AGENTS.md";
    const counterFile = path.join(runtimeSandbox, `inspection-epoch-seal-${command}-counter.json`);
    const options = {
      script: instrumentedScript,
      env: instrumentationEnv(root, nonTargetRel, counterFile, {
        PDE_TEST_DRIFT_ON_SEAL: path.join(root, nonTargetRel),
      }),
    };
    const result = command === "propose"
      ? propose(root, "inspection-epoch-seal-propose", [{
        kind: "append_after",
        path: "STATUS.md",
        after: "# STATUS.md",
        match: "exact",
        content: "inspection epoch seal marker",
      }], null, options)
      : runScript(instrumentedScript, command, root, [], options);

    assertRejected(result, `${command} inspection Epoch drift`);
    const counter = readCounter(counterFile, `${command} inspection Epoch drift`);
    assert.equal(counter.body_open_count, 1, `${command}: non-target was not read exactly once before seal`);

    if (command === "migrate-check") {
      assert.equal(result.json?.up_to_date, false, result.raw);
      assert.equal(result.json?.indeterminate, true, result.raw);
      assertSignal(result, "inspection_epoch_drift", `${command} inspection Epoch drift`);
    } else if (command === "propose") {
      assert.equal(result.json?.compiled_plan_path, null, result.raw);
      assert.equal(fs.existsSync(result.out), false, "propose emitted a compiled plan after Epoch drift");
      assertSignal(result, /inspection_epoch_drift|transition_incomplete_issue_set/, `${command} inspection Epoch drift`);
    } else {
      assertSignal(result, "inspection_epoch_drift", `${command} inspection Epoch drift`);
      assert.equal(decisionSnapshot(result).hard_issues_complete, false, result.raw);
    }
  }
});

lr("LR49", "超大 STATUS 可通过严格 shrink 恢复为完全合规小文件", (t) => {
  const root = fixture(t, "lr49-large-shrink");
  const oldBytes = TWO_MIB + 8192;
  write(root, "STATUS.md", exactSizedStatus(oldBytes));
  const proposeCounter = path.join(runtimeSandbox, "lr49-propose-counter.json");
  const proposed = propose(root, "lr49-shrink", [{
    kind: "write_file",
    path: "STATUS.md",
    content: statusText("已恢复"),
    overwrite: true,
  }], null, {
    script: instrumentedScript,
    env: instrumentationEnv(root, "STATUS.md", proposeCounter, { PDE_TEST_MAX_SINGLE_ALLOCATION: String(TWO_MIB) }),
    timeout: 90_000,
  });

  assertProcessCompleted(proposed, "LR49 propose");
  assert.equal(proposed.status, 0, proposed.raw);
  const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
  assert.equal(compiled.before_fingerprints["STATUS.md"].bytes, oldBytes);
  assert.match(compiled.before_fingerprints["STATUS.md"].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(root, "STATUS.md")).size, oldBytes, "LR49 propose changed disk");
  const counter = readCounter(proposeCounter, "LR49 propose");
  assert.equal(counter.body_open_count, 0, "LR49 whole oversized STATUS body was read");
  assert.ok(counter.stream_open_count >= 1, "LR49 old STATUS fingerprint was not streamed");

  const applied = apply(instrumentedScript, proposed.out, {
    env: { PDE_TEST_MAX_SINGLE_ALLOCATION: String(TWO_MIB) },
    timeout: 90_000,
  });
  assertProcessCompleted(applied, "LR49 apply");
  assert.equal(applied.status, 0, applied.raw);
  assert.equal(applied.json?.ok, true, applied.raw);
  assert.ok(fs.statSync(path.join(root, "STATUS.md")).size < TWO_MIB);
  const after = inspect(root);
  assertProcessCompleted(after, "LR49 after inspect");
  assert.equal(after.status, 0, after.raw);
  const afterSnapshot = decisionSnapshot(after);
  assert.equal(afterSnapshot.hard_issues_complete, true);
  assert.equal(afterSnapshot.coverage_issues_complete, true);
});

lr("LR50", "超大目标的锚点类动作在不整读旧正文的前提下拒绝", (t) => {
  const cases = [
    ["append", { kind: "append_after", path: "STATUS.md", after: "# STATUS.md", match: "exact", content: "blocked" }],
    ["line", { kind: "replace_line_contains", path: "STATUS.md", contains: "# STATUS.md", replacement: "# STATUS.md" }],
    ["block", { kind: "replace_block_exact", path: "STATUS.md", old_block: "# STATUS.md", replacement: "# STATUS.md" }],
  ];
  for (const [name, action] of cases) {
    const root = fixture(t, `lr50-${name}`);
    write(root, "STATUS.md", exactSizedStatus(TWO_MIB + 4096));
    const counterFile = path.join(runtimeSandbox, `lr50-${name}-counter.json`);
    const result = propose(root, `lr50-${name}`, [action], null, {
      script: instrumentedScript,
      env: instrumentationEnv(root, "STATUS.md", counterFile, { PDE_TEST_MAX_SINGLE_ALLOCATION: String(TWO_MIB) }),
    });
    assertRejected(result, `LR50 ${name}`);
    assertSignal(result, /file_too_large|target_exceeds_2097152_bytes/, `LR50 ${name}`);
    assert.equal(readCounter(counterFile, `LR50 ${name}`).body_open_count, 0, `LR50 ${name} read the oversized body`);
    assert.equal(fs.existsSync(result.out), false, `LR50 ${name} emitted a compiled plan`);
  }
});

lr("LR51", "超大 write_file 只允许 overwrite:true 且严格缩小", (t) => {
  const cases = [
    ["same", true, (old) => old],
    ["larger", true, (old) => `${old}x\n`],
    ["overwrite-string", "true", () => statusText("缩小")],
    ["overwrite-false", false, () => statusText("缩小")],
  ];
  for (const [name, overwrite, makeContent] of cases) {
    const root = fixture(t, `lr51-${name}`);
    const old = exactSizedStatus(TWO_MIB + 2048);
    write(root, "STATUS.md", old);
    const counterFile = path.join(runtimeSandbox, `lr51-${name}-counter.json`);
    const result = propose(root, `lr51-${name}`, [{
      kind: "write_file",
      path: "STATUS.md",
      content: makeContent(old),
      overwrite,
    }], null, {
      script: instrumentedScript,
      env: instrumentationEnv(root, "STATUS.md", counterFile),
      timeout: 90_000,
    });
    assertRejected(result, `LR51 ${name}`);
    assertSignal(result, "write_target_exceeds_2097152_bytes_without_strict_shrink", `LR51 ${name}`);
    if (name === "overwrite-string") assertSignal(result, "overwrite_must_be_boolean", "LR51 overwrite string");
    if (name === "overwrite-false") assertSignal(result, "target_exists_without_overwrite", "LR51 overwrite false");
    assert.equal(readCounter(counterFile, `LR51 ${name}`).body_open_count, 0, `LR51 ${name} read the oversized old body`);
    assert.equal(fs.existsSync(result.out), false, `LR51 ${name} emitted a compiled plan`);
  }
});

lr("LR52", "append_after 的拼写错误 match 必须返回 match_invalid", (t) => {
  const root = fixture(t, "lr52-match-invalid");
  const result = propose(root, "lr52-match-invalid", [{
    kind: "append_after",
    path: "STATUS.md",
    after: "# STATUS.md",
    match: "contians",
    content: "must be rejected",
  }]);
  assertRejected(result, "LR52 propose");
  assertSignal(result, "match_invalid", "LR52 propose");
  assert.equal(fs.existsSync(result.out), false);
});

lr("LR53", "action 未知字段拒绝信号同时带 action index 和 field", (t) => {
  const root = fixture(t, "lr53-unknown-action-field");
  const result = propose(root, "lr53-unknown-field", [{
    kind: "write_file",
    path: "历史记录/lr53.md",
    content: "# LR53\n",
    overwrite: false,
    surprise: true,
  }]);
  assertRejected(result, "LR53 propose");
  assertSignal(result, /^actions\[0\]\.unknown_field:surprise$/, "LR53 propose");
  assert.equal(fs.existsSync(result.out), false);
});

lr("LR54", "write_file.overwrite 必须是 boolean", (t) => {
  const root = fixture(t, "lr54-overwrite-boolean");
  const result = propose(root, "lr54-overwrite-boolean", [{
    kind: "write_file",
    path: "历史记录/lr54.md",
    content: "# LR54\n",
    overwrite: "true",
  }]);
  assertRejected(result, "LR54 propose");
  assertSignal(result, /^actions\[0\]\.overwrite_must_be_boolean$/, "LR54 propose");
  assert.equal(fs.existsSync(result.out), false);
});

lr("LR55", "未被计划触碰的现有知识文档标记为 declaration_only", (t) => {
  const root = fixture(t, "lr55-declaration-only");
  write(root, "docs/architecture.md", "# Architecture\n");
  const result = propose(root, "lr55-declaration-only", [{
    kind: "write_file",
    path: "历史记录/lr55-operation.md",
    content: "# unrelated operation record\n",
    overwrite: false,
  }], {
    status: "updated",
    basis: "已复核现有架构知识文档。",
    paths: ["docs/architecture.md"],
  });

  assertProcessCompleted(result, "LR55 propose");
  assert.equal(result.status, 0, result.raw);
  const compiled = JSON.parse(fs.readFileSync(result.out, "utf8"));
  assert.deepEqual(compiled.knowledge_review.roles, [{ path: "docs/architecture.md", role: "declaration_only" }]);
  assert.equal(compiled.knowledge_review.roles.some((item) => item.role === "planned_write"), false);
});

lr("LR56", "本计划写入的知识路径标记为 planned_write", (t) => {
  const root = fixture(t, "lr56-planned-write");
  const rel = "历史记录/lr56-knowledge.md";
  write(root, rel, "# old knowledge\n");
  const result = propose(root, "lr56-planned-write", [{
    kind: "write_file",
    path: rel,
    content: "# updated knowledge\n",
    overwrite: true,
  }], {
    status: "updated",
    basis: "本轮计划将更新已核实的知识文档。",
    paths: [rel],
  });

  assertProcessCompleted(result, "LR56 propose");
  assert.equal(result.status, 0, result.raw);
  const compiled = JSON.parse(fs.readFileSync(result.out, "utf8"));
  assert.deepEqual(compiled.knowledge_review.roles, [{ path: rel, role: "planned_write" }]);
});

assert.deepEqual([...registered].sort(), [...expected].sort(), "LR39-44/LR47/LR49-56 registration is incomplete");

test.after(() => {
  fs.rmSync(runtimeSandbox, { recursive: true, force: true });
});
