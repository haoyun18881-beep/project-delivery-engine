import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { evaluateValidationTransition } from "../scripts/project-gov.mjs";
import {
  apply,
  createProject,
  hasSignal,
  inspect,
  propose,
  removeProject,
  runProjectGov,
} from "./helpers/project-gov-v038-harness.mjs";

const FIVE_PIECE = ["AGENTS.md", "PROJECT_START_HERE.md", "STATUS.md", "TODO.md", "HANDOFF.md"];
const roots = [];
let passed = 0;

const DIGEST_ALGORITHM = "sha256-canonical-json-utf8-bytewise-v1";

function test(id, name, fn) {
  fn();
  passed += 1;
  console.log(`${id} PASS ${name}`);
}

function issue(code, subjectKey) {
  return { code, subject_key: subjectKey };
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}

function issueSummary(items, domain) {
  const counts = new Map();
  for (const item of items) {
    const key = canonicalJson([item.code, item.subject_key]);
    const current = counts.get(key) || { item, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const entries = [...counts.values()]
    .map(({ item, count }) => [item.code, item.subject_key, count])
    .sort((left, right) => Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right))));
  return {
    count: items.length,
    digest: digest({ domain, algorithm: DIGEST_ALGORITHM, entries }),
  };
}

function emptyRelationshipSummary() {
  const definitionDomain = "project-gov/definition-occurrences/v1";
  const referenceDomain = "project-gov/reference-occurrences/v1";
  const resolutionDomain = "project-gov/reference-resolution-statuses/v1";
  return {
    complete: true,
    definition_occurrence_count: 0,
    definition_digest: digest({ domain: definitionDomain, algorithm: DIGEST_ALGORITHM, entries: [] }),
    reference_occurrence_count: 0,
    reference_digest: digest({ domain: referenceDomain, algorithm: DIGEST_ALGORITHM, entries: [] }),
    resolution_status_count: 0,
    resolution_status_digest: digest({ domain: resolutionDomain, algorithm: DIGEST_ALGORITHM, entries: [] }),
  };
}

function snapshot({
  hard = [],
  coverage = [],
  totalBytes = 40 * 1024,
  hardComplete = true,
  coverageComplete = true,
} = {}) {
  const hardSummary = issueSummary(hard, "project-gov/hard-issues/v1");
  const coverageSummary = issueSummary(coverage, "project-gov/coverage-issues/v1");
  return {
    schema_version: 2,
    decision_policy_version: 2,
    digest_algorithm: DIGEST_ALGORITHM,
    scan_complete: hardComplete && coverageComplete,
    hard_issues_complete: hardComplete,
    coverage_issues_complete: coverageComplete,
    hard_issue_count: hardSummary.count,
    hard_issue_sample_count: Math.min(hardSummary.count, 100),
    hard_issues_truncated: hardSummary.count > 100,
    hard_issue_multiset_digest: hardSummary.digest,
    hard_issues: hard.slice(0, 100),
    coverage_issue_count: coverageSummary.count,
    coverage_issue_sample_count: Math.min(coverageSummary.count, 100),
    coverage_issues_truncated: coverageSummary.count > 100,
    coverage_issue_multiset_digest: coverageSummary.digest,
    coverage_issues: coverage.slice(0, 100),
    relationships: emptyRelationshipSummary(),
    core_index_fingerprints: {},
    five_piece: {
      total_bytes: totalBytes,
      limit_bytes: 45 * 1024,
      over_limit: totalBytes > 45 * 1024,
    },
  };
}

function checkpointActions(marker = "已更新") {
  return [
    {
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: "| 回归 | 正常 | 本地夹具 |",
      replacement: `| 回归 | ${marker} | 本地夹具 |`,
    },
    {
      kind: "replace_line_contains",
      path: "TODO.md",
      contains: "| P1 | 回归 | 通过 |",
      replacement: `| P1 | 回归 | ${marker} |`,
    },
    {
      kind: "replace_line_contains",
      path: "HANDOFF.md",
      contains: "- 最后语义检查点：",
      replacement: "- 最后语义检查点：2026-08-29 01:45 +08:00",
    },
  ];
}

function addUnresolvedIds(root, count, rel = "AGENTS.md") {
  const ids = Array.from({ length: count }, (_, index) => `M-20990101-${String(index + 1).padStart(3, "0")}`);
  fs.appendFileSync(path.join(root, rel), `${ids.join("\n")}\n`, "utf8");
  return ids;
}

function createTrackedProject(name) {
  const root = createProject(name);
  roots.push(root);
  return root;
}

function setFivePieceTotal(root, totalBytes) {
  const statusPath = path.join(root, "STATUS.md");
  const original = fs.readFileSync(statusPath, "utf8");
  const otherBytes = FIVE_PIECE
    .filter((rel) => rel !== "STATUS.md")
    .reduce((sum, rel) => sum + fs.statSync(path.join(root, rel)).size, 0);
  const desiredStatusBytes = totalBytes - otherBytes;
  const originalBytes = Buffer.byteLength(original, "utf8");
  assert.ok(desiredStatusBytes >= originalBytes, "fixture target is too small for STATUS.md");
  const paddingBytes = desiredStatusBytes - originalBytes;
  const content = paddingBytes === 0
    ? original
    : `${original}${"x".repeat(paddingBytes - 1)}\n`;
  assert.equal(Buffer.byteLength(content, "utf8"), desiredStatusBytes);
  fs.writeFileSync(statusPath, content, "utf8");
  const actual = FIVE_PIECE.reduce((sum, rel) => sum + fs.statSync(path.join(root, rel)).size, 0);
  assert.equal(actual, totalBytes);
  return content;
}

function assertRejected(result, code) {
  assert.equal(result.transition_ok, false);
  assert.equal(result.commit_state, "rejected");
  assert.ok(result.rejection_codes.includes(code), JSON.stringify(result));
}

try {
  test("LR01", "60 KiB 到 49 KiB 是允许提交的严格改善", () => {
    const transition = evaluateValidationTransition(
      snapshot({ totalBytes: 60 * 1024 }),
      snapshot({ totalBytes: 49 * 1024 }),
    );
    assert.equal(transition.transition_ok, true);
    assert.equal(transition.commit_state, "improved_but_noncompliant");
    assert.equal(transition.five_piece_delta_bytes, -11 * 1024);

    const root = createTrackedProject("lr01-60k-to-49k");
    const smallerStatus = setFivePieceTotal(root, 49 * 1024);
    setFivePieceTotal(root, 60 * 1024);

    const proposed = propose(root, "lr01-shrink", [{
      kind: "write_file",
      path: "STATUS.md",
      content: smallerStatus,
      overwrite: true,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    assert.equal(fs.existsSync(proposed.out), true);
    assert.equal(proposed.json?.predicted_transition?.commit_state, "improved_but_noncompliant", proposed.raw);
    const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
    assert.equal(compiled.predicted_transition?.commit_state, "improved_but_noncompliant");

    const applied = apply(proposed.out);
    assert.equal(applied.status, 0, applied.raw);
    assert.equal(applied.json?.transaction_verification?.transition_ok, true, applied.raw);
    assert.deepEqual(applied.json?.changed, ["STATUS.md"], applied.raw);

    const inspected = inspect(root);
    assert.equal(inspected.status, 1, inspected.raw);
    assert.equal(inspected.json?.five_piece?.total_bytes, 49 * 1024, inspected.raw);
    assert.equal(inspected.json?.five_piece?.over_limit, true, inspected.raw);

    const startup = runProjectGov("startup", root);
    assert.notEqual(startup.status, 0, startup.raw);
    assert.equal(startup.json?.ok, false, startup.raw);
    assert.equal(startup.json?.startup, null, startup.raw);
    assert.ok(hasSignal(startup.json || startup.raw, "five_piece_over_45kb"), startup.raw);
  });

  test("LR02", "超限后字节数不变且无问题改善必须拒绝", () => {
    const result = evaluateValidationTransition(
      snapshot({ totalBytes: 60 * 1024 }),
      snapshot({ totalBytes: 60 * 1024 }),
    );
    assertRejected(result, "transition_no_strict_improvement");
    assert.ok(result.rejection_codes.includes("transition_five_piece_not_reduced"));
  });

  test("LR03", "超限后继续变大必须拒绝 size regression", () => {
    const result = evaluateValidationTransition(
      snapshot({ totalBytes: 60 * 1024 }),
      snapshot({ totalBytes: 61 * 1024 }),
    );
    assertRejected(result, "transition_five_piece_not_reduced");
    assert.equal(result.five_piece_delta_bytes, 1024);
  });

  test("LR04", "两个 hard issues 消除一个且不新增时允许分步修复", () => {
    const first = issue("broken_reference", "HANDOFF.md#M-1");
    const second = issue("missing_index", "项目物料/INDEX.md");
    const result = evaluateValidationTransition(
      snapshot({ hard: [first, second] }),
      snapshot({ hard: [second] }),
    );
    assert.equal(result.transition_ok, true);
    assert.equal(result.commit_state, "improved_but_noncompliant");
    assert.deepEqual(result.removed_hard_issues, [first]);
    assert.deepEqual(result.remaining_hard_issues, [second]);
  });

  test("LR05", "消除旧 hard issue 但新增另一个必须拒绝", () => {
    const oldIssue = issue("broken_reference", "HANDOFF.md#M-1");
    const newIssue = issue("missing_index", "项目物料/INDEX.md");
    const result = evaluateValidationTransition(
      snapshot({ hard: [oldIssue] }),
      snapshot({ hard: [newIssue] }),
    );
    assertRejected(result, "transition_new_hard_issue");
  });

  test("LR06", "合规基线出现 hard、coverage 或新超限都必须拒绝", () => {
    const compliant = snapshot();
    const regressions = [
      snapshot({ hard: [issue("broken_reference", "HANDOFF.md#M-1")] }),
      snapshot({ coverage: [issue("managed_file_not_checked", "docs/large.md")] }),
      snapshot({ totalBytes: 46 * 1024 }),
    ];
    for (const after of regressions) {
      assertRejected(
        evaluateValidationTransition(compliant, after),
        "transition_compliant_baseline_regressed",
      );
    }
  });

  test("LR15", "截断且仍不合规的问题集合不得进入 Repair Mode", () => {
    const result = evaluateValidationTransition(
      snapshot({
        hard: [issue("broken_reference", "HANDOFF.md#M-1")],
        hardComplete: false,
      }),
      snapshot({ hardComplete: false }),
    );
    assertRejected(result, "transition_incomplete_issue_set");
  });

  test("LR16", "不完整 before 经整文件修复达到完全合规时允许提交", () => {
    const result = evaluateValidationTransition(
      snapshot({
        coverage: [issue("managed_file_not_checked", "历史记录/oversized.md#file_too_large")],
        hardComplete: false,
        totalBytes: 40 * 1024,
      }),
      snapshot(),
    );
    assert.equal(result.transition_ok, true);
    assert.equal(result.commit_state, "compliant");
    assert.deepEqual(result.remaining_hard_issues, []);
    assert.deepEqual(result.remaining_coverage_issues, []);
  });

  test("LR17", "propose 的 before/after 均不完整时拒绝且不生成 plan", () => {
    const direct = evaluateValidationTransition(
      snapshot({ hardComplete: false }),
      snapshot({ hardComplete: false }),
    );
    assertRejected(direct, "transition_incomplete_issue_set");

    const root = createTrackedProject("lr17-propose-incomplete");
    const oversized = path.join(root, "历史记录", "oversized.md");
    fs.writeFileSync(oversized, Buffer.alloc((2 * 1024 * 1024) + 1, 0x78));
    fs.appendFileSync(
      path.join(root, "历史记录", "00-历史总目录.md"),
      "| M-20260828-001 | 2026-08-28 | oversized | `历史记录/oversized.md` | active |\n",
      "utf8",
    );
    const proposed = propose(root, "lr17-incomplete", [{
      kind: "write_file",
      path: "历史记录/unrelated.md",
      content: "# unrelated\n",
      overwrite: false,
    }]);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_incomplete_issue_set"), proposed.raw);
    assert.equal(fs.existsSync(proposed.out), false);
  });

  test("LR102", "完整核对超过 100 个旧问题后允许纯三件套 checkpoint", () => {
    const root = createTrackedProject("lr102-legacy-neutral-checkpoint");
    addUnresolvedIds(root, 120);
    const before = inspect(root);
    assert.notEqual(before.status, 0, before.raw);
    assert.equal(before.json?.decision_snapshot?.hard_issue_count, 120, before.raw);
    assert.equal(before.json?.decision_snapshot?.hard_issues?.length, 100, before.raw);
    assert.equal(before.json?.decision_snapshot?.hard_issues_truncated, true, before.raw);
    assert.equal(before.json?.decision_snapshot?.hard_issues_complete, true, before.raw);

    const proposed = propose(root, "lr102-legacy-neutral", checkpointActions());
    assert.equal(proposed.status, 0, proposed.raw);
    assert.equal(proposed.json?.predicted_transition?.policy_path, "legacy_neutral_checkpoint", proposed.raw);
    assert.equal(proposed.json?.predicted_transition?.semantic_checked_by_tool, false, proposed.raw);
    assert.equal(fs.existsSync(proposed.out), true);

    const applied = apply(proposed.out);
    assert.equal(applied.status, 0, applied.raw);
    assert.equal(applied.json?.transaction_verification?.transition_ok, true, applied.raw);
  });

  test("LR116", "legacy checkpoint 必须真实更新 HANDOFF 语义声明而不是任意正文", () => {
    const arbitraryRoot = createTrackedProject("lr116-arbitrary-handoff-change");
    addUnresolvedIds(arbitraryRoot, 1);
    const arbitrary = propose(arbitraryRoot, "lr116-arbitrary-handoff-change", [{
      kind: "replace_line_contains",
      path: "HANDOFF.md",
      contains: "- 无",
      replacement: "- 无。",
    }]);
    assert.notEqual(arbitrary.status, 0, arbitrary.raw);
    assert.ok(hasSignal(arbitrary.json || arbitrary.raw, "transition_no_strict_improvement"), arbitrary.raw);

    const semanticRoot = createTrackedProject("lr116-semantic-status-change");
    addUnresolvedIds(semanticRoot, 1);
    const semantic = propose(semanticRoot, "lr116-semantic-status-change", [{
      kind: "replace_line_contains",
      path: "HANDOFF.md",
      contains: "- 检查点后变化：",
      replacement: "- 检查点后变化：待确认",
    }]);
    assert.equal(semantic.status, 0, semantic.raw);
    assert.equal(semantic.json?.predicted_transition?.policy_path, "legacy_neutral_checkpoint", semantic.raw);
    const applied = apply(semantic.out);
    assert.equal(applied.status, 0, applied.raw);
    assert.equal(applied.json?.transaction_verification?.transition_ok, true, applied.raw);
  });

  test("LR103", "第 101 条以后的旧问题被新问题替换时必须拒绝", () => {
    const root = createTrackedProject("lr103-tail-issue-replacement");
    const ids = addUnresolvedIds(root, 101, "STATUS.md");
    const actions = checkpointActions("尾项被替换");
    actions[0] = {
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: ids[100],
      replacement: "M-20990101-999",
    };
    const proposed = propose(root, "lr103-tail-replacement", actions);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_new_hard_issue"), proposed.raw);
    assert.equal(fs.existsSync(proposed.out), false);
  });

  test("LR104", "两个已解析 ID 互换不能伪装成 legacy-neutral checkpoint", () => {
    const root = createTrackedProject("lr104-resolved-id-swap");
    addUnresolvedIds(root, 101);
    const first = "M-20260829-001";
    const second = "M-20260829-002";
    fs.writeFileSync(path.join(root, "历史记录", "one.md"), `# ${first}\n`, "utf8");
    fs.writeFileSync(path.join(root, "历史记录", "two.md"), `# ${second}\n`, "utf8");
    fs.appendFileSync(
      path.join(root, "历史记录", "00-历史总目录.md"),
      `| ${first} | 2026-08-29 | one | \`历史记录/one.md\` | active |\n| ${second} | 2026-08-29 | two | \`历史记录/two.md\` | active |\n`,
      "utf8",
    );
    fs.appendFileSync(path.join(root, "STATUS.md"), `\n- 当前依据：${first}\n`, "utf8");
    const actions = checkpointActions("已切换依据");
    actions[0] = {
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: `- 当前依据：${first}`,
      replacement: `- 当前依据：${second}`,
    };
    const proposed = propose(root, "lr104-resolved-swap", actions);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_no_strict_improvement"), proposed.raw);
    assert.equal(proposed.json?.predicted_transition?.policy_path, "strict", proposed.raw);
  });

  test("LR105", "propose 后核心索引漂移时 apply 必须拒绝且不写三件套", () => {
    const root = createTrackedProject("lr105-core-index-drift");
    addUnresolvedIds(root, 120);
    const proposed = propose(root, "lr105-index-drift", checkpointActions("准备应用"));
    assert.equal(proposed.status, 0, proposed.raw);
    const statusBefore = fs.readFileSync(path.join(root, "STATUS.md"), "utf8");
    const historyIndex = path.join(root, "历史记录", "00-历史总目录.md");
    const original = fs.readFileSync(historyIndex, "utf8");
    const changed = original.replace("# 历史总目录", "# 历史总目彔");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    fs.writeFileSync(historyIndex, changed, "utf8");

    const applied = apply(proposed.out);
    assert.notEqual(applied.status, 0, applied.raw);
    assert.ok(hasSignal(applied.json || applied.raw, "baseline_validation_digest_drift"), applied.raw);
    assert.equal(fs.readFileSync(path.join(root, "STATUS.md"), "utf8"), statusBefore);
  });

  test("LR106", "机械 checkpoint 永远不得标记为已做语义核实", () => {
    const root = createTrackedProject("lr106-semantic-boundary");
    addUnresolvedIds(root, 120);
    const actions = checkpointActions("全部测试和部署均已完成");
    const proposed = propose(root, "lr106-semantic-boundary", actions);
    assert.equal(proposed.status, 0, proposed.raw);
    assert.equal(proposed.json?.predicted_transition?.semantic_checked_by_tool, false, proposed.raw);
    const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
    assert.equal(compiled.predicted_transition?.semantic_checked_by_tool, false);
  });

  test("LR107", "结构问题的显示截断不得掩盖完整问题身份变化", () => {
    const root = createTrackedProject("lr107-structure-detail-collision");
    const oldValue = `${"x".repeat(600)}A`;
    const newValue = `${"x".repeat(600)}B`;
    const statusPath = path.join(root, "STATUS.md");
    fs.writeFileSync(
      statusPath,
      fs.readFileSync(statusPath, "utf8").replace("| 基线 | 通过 | 主线 |", `| 基线 | 通过 | ${oldValue} |`),
      "utf8",
    );
    const proposed = propose(root, "lr107-structure-detail-collision", [
      {
        kind: "replace_line_contains",
        path: "STATUS.md",
        contains: `| 基线 | 通过 | ${oldValue} |`,
        replacement: `| 基线 | 通过 | ${newValue} |`,
      },
      checkpointActions()[2],
    ]);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_new_hard_issue"), proposed.raw);
  });

  test("LR108", "非法 UTF-8 索引必须令问题集合不完整并拒绝 checkpoint", () => {
    const root = createTrackedProject("lr108-invalid-utf8-index");
    addUnresolvedIds(root, 120);
    fs.appendFileSync(path.join(root, "历史记录", "00-历史总目录.md"), Buffer.from([0xff]));
    const before = inspect(root);
    assert.equal(before.json?.decision_snapshot?.scan_complete, false, before.raw);
    assert.equal(before.json?.decision_snapshot?.hard_issues_complete, false, before.raw);
    const proposed = propose(root, "lr108-invalid-utf8", checkpointActions());
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_incomplete_issue_set"), proposed.raw);
  });

  test("LR109", "HANDOFF 仅声明无变化动作不得冒充正式 checkpoint", () => {
    const root = createTrackedProject("lr109-handoff-noop");
    addUnresolvedIds(root, 120);
    const actions = checkpointActions("只改状态");
    actions[2] = {
      kind: "replace_line_contains",
      path: "HANDOFF.md",
      contains: "- 最后语义检查点：",
      replacement: "- 最后语义检查点：2026-08-28 08:00 +08:00",
    };
    const proposed = propose(root, "lr109-handoff-noop", actions);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.equal(proposed.json?.predicted_transition?.policy_path, "strict", proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_no_strict_improvement"), proposed.raw);
  });

  test("LR110", "索引登记 Markdown 缺失时不得进入 legacy checkpoint", () => {
    const root = createTrackedProject("lr110-missing-indexed-markdown");
    fs.appendFileSync(
      path.join(root, "历史记录", "00-历史总目录.md"),
      "| M-20260829-001 | 2026-08-29 | missing | `历史记录/missing.md` | active |\n",
      "utf8",
    );
    const before = inspect(root);
    assert.equal(before.json?.markdown_scan?.missing_indexed_file_count, 1, before.raw);
    assert.equal(before.json?.decision_snapshot?.scan_complete, false, before.raw);
    const proposed = propose(root, "lr110-missing-indexed-markdown", checkpointActions());
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_incomplete_issue_set"), proposed.raw);
  });

  test("LR111", "索引路径降级或歧义时不得声称关系集合完整", () => {
    const root = createTrackedProject("lr111-degraded-index-path");
    fs.appendFileSync(
      path.join(root, "历史记录", "00-历史总目录.md"),
      "| M-20260829-001 | 2026-08-29 | degraded | `历史记录/one.md; 历史记录/two.md` | active |\n",
      "utf8",
    );
    const before = inspect(root);
    assert.equal(before.json?.decision_snapshot?.relationships?.complete, false, before.raw);
    const proposed = propose(root, "lr111-degraded-index-path", checkpointActions());
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_incomplete_issue_set"), proposed.raw);
  });

  test("LR112", "严格改善输出不得泄出超长问题身份原文", () => {
    const root = createTrackedProject("lr112-bounded-removed-issue");
    const secretTail = "SECRET_TAIL_LR112";
    const oldValue = `${"x".repeat(600)}${secretTail}`;
    const statusPath = path.join(root, "STATUS.md");
    fs.writeFileSync(
      statusPath,
      fs.readFileSync(statusPath, "utf8").replace("| 基线 | 通过 | 主线 |", `| 基线 | 通过 | ${oldValue} |`),
      "utf8",
    );
    const proposed = propose(root, "lr112-bounded-removed-issue", [{
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: `| 基线 | 通过 | ${oldValue} |`,
      replacement: "| 基线 | 通过 | 主线 |",
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    const removed = proposed.json?.predicted_transition?.removed_hard_issues || [];
    assert.equal(removed.length, 1, proposed.raw);
    assert.ok(removed[0].subject_key.length <= 512, proposed.raw);
    assert.equal(JSON.stringify(proposed.json?.predicted_transition).includes(secretTail), false, proposed.raw);
    const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
    assert.equal(JSON.stringify(compiled.predicted_transition).includes(secretTail), false);
  });

  test("LR113", "同宽畸形表格行替换内容必须改变完整问题身份", () => {
    const root = createTrackedProject("lr113-row-width-identity");
    const todoPath = path.join(root, "TODO.md");
    fs.writeFileSync(
      todoPath,
      fs.readFileSync(todoPath, "utf8").replace("| P1 | 回归 | 通过 |", "| P1 | old-malformed |"),
      "utf8",
    );
    const proposed = propose(root, "lr113-row-width-identity", [
      {
        kind: "replace_line_contains",
        path: "TODO.md",
        contains: "| P1 | old-malformed |",
        replacement: "| P1 | new-malformed |",
      },
      checkpointActions()[2],
    ]);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_new_hard_issue"), proposed.raw);
  });

  test("LR114", "显示用哈希串反填不得冒充原始问题身份", () => {
    const root = createTrackedProject("lr114-display-identity-forgery");
    const oldValue = `${"x".repeat(600)}A`;
    const statusPath = path.join(root, "STATUS.md");
    fs.writeFileSync(
      statusPath,
      fs.readFileSync(statusPath, "utf8").replace("| 基线 | 通过 | 主线 |", `| 基线 | 通过 | ${oldValue} |`),
      "utf8",
    );
    const before = inspect(root);
    const marker = "#层级:";
    const displayed = before.json?.decision_snapshot?.hard_issues?.find(
      (item) => item.subject_key.includes(marker),
    );
    assert.ok(displayed, before.raw);
    const markerIndex = displayed.subject_key.indexOf(marker);
    assert.ok(markerIndex >= 0, displayed.subject_key);
    const forgedValue = displayed.subject_key.slice(markerIndex + marker.length);
    assert.notEqual(forgedValue, oldValue);

    const proposed = propose(root, "lr114-display-identity-forgery", [
      {
        kind: "replace_line_contains",
        path: "STATUS.md",
        contains: `| 基线 | 通过 | ${oldValue} |`,
        replacement: `| 基线 | 通过 | ${forgedValue} |`,
      },
      checkpointActions()[2],
    ]);
    assert.notEqual(proposed.status, 0, proposed.raw);
    assert.ok(hasSignal(proposed.json || proposed.raw, "transition_new_hard_issue"), proposed.raw);
  });

  console.log(`project-gov v0.3.8 transition binding tests: PASS (${passed}/23)`);
} finally {
  for (const root of roots) removeProject(root);
}
