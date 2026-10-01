import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionScript = path.join(skillRoot, "scripts", "project-gov.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v038-schema-edge-"));
const instrumentedScript = createInstrumentedScript();
const EXPECTED_LR_IDS = new Set(["LR10", "LR18", "LR19", "LR20", "LR21", "LR22", "LR23", "LR101"]);
const MAX_PLAN_ID_BYTES = 1024;
const MAX_TOTAL_ACTION_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_WORKFLOW_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TRANSACTION_PATH_BYTES = 4096;
const TRANSACTION_TEMP_REL_SUFFIX_BYTES = Buffer.byteLength(".tmp-project-gov-", "utf8") + 36;
const completedLrIds = new Set();
let sequence = 0;

const COMPILED_PLAN_FIELDS = [
  "tool",
  "command",
  "compiled_schema_version",
  "operation_schema_version",
  "skill_version",
  "project_structure_version",
  "decision_policy_version",
  "compiled_at",
  "root",
  "plan_id",
  "before_fingerprints",
  "baseline_validation",
  "baseline_validation_digest",
  "knowledge_review",
  "actions",
  "predicted_target_fingerprints",
  "predicted_validation",
  "predicted_validation_digest",
  "predicted_transition",
  "compiled_content_digest",
].sort();

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeJson(abs, value) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return abs;
}

function createProject(name) {
  sequence += 1;
  const root = path.join(sandbox, `${String(sequence).padStart(2, "0")}-${name}`);
  write(root, "AGENTS.md", "# AGENTS.md\n");
  write(
    root,
    "PROJECT_START_HERE.md",
    "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- Schema 边界验收夹具。\n\n## 启动入口\n\n1. 读取五件套。\n",
  );
  write(
    root,
    "STATUS.md",
    "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n| schema-edge | stable | fixture |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n| baseline | pass | 主线 |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n",
  );
  write(
    root,
    "TODO.md",
    "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n| P1 | schema-edge | pass |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |\n",
  );
  write(
    root,
    "HANDOFF.md",
    "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-08-28 08:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n| 状态 | `STATUS.md` | 当前状态 |\n\n## 未决上下文\n\n- 无\n",
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

function defaultOperation(planId, actions) {
  return {
    schema_version: 2,
    plan_id: planId,
    knowledge_review: {
      status: "none",
      basis: "Schema 边界夹具未产生可跨任务复用的已核实知识。",
    },
    actions,
  };
}

function runScript(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
    timeout: options.timeout ?? 25_000,
    killSignal: "SIGKILL",
    env: { ...process.env, ...(options.env || {}) },
  });
  assert.equal(result.error?.code, undefined, `child process failed: ${result.error?.message || "unknown"}`);
  const raw = result.stdout.trim() || result.stderr.trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (error) {
    throw new Error(`child did not return JSON (status=${result.status}): ${raw.slice(0, 2000)}`, { cause: error });
  }
  return { ...result, json, raw };
}

function propose(root, planId, actions, options = {}) {
  const operation = options.operation || defaultOperation(planId, actions);
  const operationPath = writeJson(
    path.join(root, `${planId}.${options.suffix || "operation"}.json`),
    operation,
  );
  const out = options.out || path.join(root, ".project-gov", "plans", `${planId}.json`);
  const result = runScript(options.script || productionScript, [
    "propose",
    "--root",
    root,
    "--plan",
    operationPath,
    "--out",
    out,
    "--json",
  ], options);
  return { ...result, out, operationPath };
}

function apply(planPath, options = {}) {
  return runScript(options.script || productionScript, ["apply", "--plan", planPath, "--json"], options);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonical_json_unsupported_type:${typeof value}`);
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function recomputeCompiledDigest(compiled) {
  const payload = structuredClone(compiled);
  delete payload.compiled_at;
  delete payload.compiled_content_digest;
  compiled.compiled_content_digest = digest(payload);
  return compiled;
}

function readCompiled(planPath) {
  return JSON.parse(fs.readFileSync(planPath, "utf8"));
}

function assertProposed(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.raw}`);
  assert.equal(result.json?.ok, true, `${label}: ${result.raw}`);
  assert.equal(fs.existsSync(result.out), true, `${label}: compiled plan missing`);
}

function assertRejected(result, expectedFragment, label) {
  assert.notEqual(result.status, 0, `${label}: expected rejection`);
  assert.equal(result.json?.ok, false, `${label}: ${result.raw}`);
  assert.match(String(result.json?.error || result.raw), new RegExp(escapeRegExp(expectedFragment)), `${label}: ${result.raw}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listFilesRecursive(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const abs = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(abs);
      else files.push(path.relative(root, abs).replace(/\\/g, "/"));
    }
  };
  visit(root);
  return files.sort();
}

function backupArtifacts(root) {
  return listFilesRecursive(path.join(root, ".project-gov", "backups"));
}

function readEvents(eventLog) {
  if (!fs.existsSync(eventLog)) return [];
  return fs.readFileSync(eventLog, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoLockOrBackup(root, eventLog, label) {
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false, `${label}: lock remained`);
  assert.deepEqual(backupArtifacts(root), [], `${label}: backup artifacts were created`);
  assert.equal(readEvents(eventLog).some((item) => item.event === "lock_acquired"), false, `${label}: project lock was acquired`);
}

function assertLockedPreflightRejected(root, eventLog, planPath, targetPath, label) {
  const events = readEvents(eventLog).map((item) => item.event);
  assert.deepEqual(events, ["lock_acquired", "lock_released"], `${label}: lock lifecycle was not exact`);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false, `${label}: lock remained`);
  assert.deepEqual(backupArtifacts(root), [], `${label}: backup artifacts were created`);
  assert.equal(fs.existsSync(planPath), true, `${label}: rejected plan was not retained`);
  assert.equal(fs.existsSync(targetPath), false, `${label}: target changed before backup gate`);
}

function planWithSingleWrite(root, planId, options = {}) {
  const rel = options.rel || `历史记录/${planId}.md`;
  const result = propose(root, planId, [{
    kind: "write_file",
    path: rel,
    content: options.content || `# ${planId}\n`,
    overwrite: false,
  }], options);
  assertProposed(result, `${planId} propose`);
  return { ...result, rel, target: path.join(root, rel) };
}

function createInstrumentedScript() {
  const source = fs.readFileSync(productionScript, "utf8");
  const importBoundary = source.indexOf("const FIVE_PIECE = [");
  assert.notEqual(importBoundary, -1, "instrumentation import boundary missing");
  const prelude = `

const __pdeEdgeFlags = new Set(String(process.env.PDE_EDGE_FLAGS || "").split(",").filter(Boolean));
const __pdeEdgeEventLog = process.env.PDE_EDGE_EVENT_LOG || "";
const __pdeEdgeAppendFileSync = fs.appendFileSync.bind(fs);
const __pdeEdgeLinkSync = fs.linkSync.bind(fs);
const __pdeEdgeOpenSync = fs.openSync.bind(fs);
const __pdeEdgeRenameSync = fs.renameSync.bind(fs);
const __pdeEdgeUnlinkSync = fs.unlinkSync.bind(fs);
const __pdeEdgeMkdirSync = fs.mkdirSync.bind(fs);
function __pdeEdgeLog(event, target) {
  if (!__pdeEdgeEventLog) return;
  __pdeEdgeAppendFileSync(__pdeEdgeEventLog, JSON.stringify({ event, target: String(target) }) + "\\n", "utf8");
}
fs.openSync = function __pdeEdgeOpen(target, flags, ...rest) {
  const fd = __pdeEdgeOpenSync(target, flags, ...rest);
  return fd;
};
fs.linkSync = function __pdeEdgeLink(from, to) {
  const result = __pdeEdgeLinkSync(from, to);
  if (path.basename(String(to)) === "apply.lock") __pdeEdgeLog("lock_acquired", to);
  return result;
};
fs.renameSync = function __pdeEdgeRename(from, to) {
  const result = __pdeEdgeRenameSync(from, to);
  if (path.basename(String(from)) === "apply.lock" && path.basename(String(to)).startsWith("apply.lock.release-")) {
    __pdeEdgeLog("lock_released", from);
  }
  return result;
};
fs.unlinkSync = function __pdeEdgeUnlink(target, ...rest) {
  const result = __pdeEdgeUnlinkSync(target, ...rest);
  return result;
};
fs.mkdirSync = function __pdeEdgeMkdir(target, options) {
  const result = __pdeEdgeMkdirSync(target, options);
  const normalized = String(target).replace(/\\\\/g, "/");
  if (normalized.includes("/.project-gov/backups")) __pdeEdgeLog("backup_created", target);
  return result;
};`;
  let injected = `${source.slice(0, importBoundary)}${prelude}${source.slice(importBoundary)}`;
  const predictedMarker = "  const predictedReport = inspectProject(root, {";
  const preflightIndex = injected.indexOf("function preflightCompiledPlan(");
  const predictedIndex = injected.indexOf(predictedMarker, preflightIndex);
  assert.notEqual(preflightIndex, -1, "preflight function marker missing");
  assert.notEqual(predictedIndex, -1, "predicted preflight marker missing");
  const faultPrelude = `  if (__pdeEdgeFlags.has("lr101_predicted_incomplete")) {
    predictedContext.markIncomplete("managed_file_not_checked", "STATUS.md", {
      reason: "read_failed",
      coverage: false,
    });
  }
`;
  injected = `${injected.slice(0, predictedIndex)}${faultPrelude}${injected.slice(predictedIndex)}`;
  return write(sandbox, "instrumented-project-gov.mjs", injected);
}

async function testLR10() {
  const root = createProject("lr10-stable-snapshot-digest");
  const actions = [{
    kind: "write_file",
    path: "历史记录/lr10.md",
    content: "# LR10\n",
    overwrite: false,
  }];
  const first = propose(root, "lr10-stable", actions, {
    out: path.join(root, ".project-gov", "plans", "lr10-first.json"),
    suffix: "first",
  });
  assertProposed(first, "LR10 first propose");
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = propose(root, "lr10-stable", actions, {
    out: path.join(root, ".project-gov", "plans", "lr10-second.json"),
    suffix: "second",
  });
  assertProposed(second, "LR10 second propose");
  const left = readCompiled(first.out);
  const right = readCompiled(second.out);
  assert.notEqual(left.compiled_at, right.compiled_at, "LR10 generated times did not differ");
  assert.deepEqual(left.baseline_validation, right.baseline_validation, "LR10 baseline snapshots drifted");
  assert.equal(left.baseline_validation_digest, digest(left.baseline_validation));
  assert.equal(right.baseline_validation_digest, digest(right.baseline_validation));
  assert.equal(left.baseline_validation_digest, right.baseline_validation_digest, "LR10 generated time entered baseline digest");
  assert.equal(left.compiled_content_digest, right.compiled_content_digest, "LR10 generated time entered compiled digest");
}

async function testLR18() {
  const root = createProject("lr18-unknown-top-field");
  const prepared = planWithSingleWrite(root, "lr18-unknown-top");
  const compiled = readCompiled(prepared.out);
  compiled.behavior_backdoor = { enabled: true };
  recomputeCompiledDigest(compiled);
  const tampered = writeJson(path.join(root, ".project-gov", "plans", "lr18-tampered.json"), compiled);
  const eventLog = path.join(sandbox, "lr18-events.jsonl");
  const result = apply(tampered, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
  assertRejected(result, "compiled_plan_unknown_field:behavior_backdoor", "LR18");
  assert.equal(fs.existsSync(tampered), true, "LR18 rejected plan was not retained");
  assert.equal(fs.existsSync(prepared.target), false, "LR18 target changed");
  assertNoLockOrBackup(root, eventLog, "LR18");
}

async function testLR19() {
  const root = createProject("lr19-display-only");
  const prepared = planWithSingleWrite(root, "lr19-display-only", { content: "# LR19 display only\n" });
  const compiled = readCompiled(prepared.out);
  assert.deepEqual(Object.keys(compiled).sort(), COMPILED_PLAN_FIELDS, "LR19 compiled field set drifted");
  const originalDigest = compiled.compiled_content_digest;
  const originalTime = compiled.compiled_at;
  compiled.compiled_at = "2099-12-31T23:59:59.999Z";
  assert.notEqual(compiled.compiled_at, originalTime);
  const payload = structuredClone(compiled);
  delete payload.compiled_at;
  delete payload.compiled_content_digest;
  assert.equal(digest(payload), originalDigest, "LR19 compiled_at changed the bound payload");
  const behaviorControl = structuredClone(compiled);
  behaviorControl.plan_id = `${behaviorControl.plan_id}-changed`;
  const behaviorPayload = structuredClone(behaviorControl);
  delete behaviorPayload.compiled_at;
  delete behaviorPayload.compiled_content_digest;
  assert.notEqual(digest(behaviorPayload), originalDigest, "LR19 a behavior field was accidentally display-only");
  writeJson(prepared.out, compiled);
  const result = apply(prepared.out);
  assert.equal(result.status, 0, `LR19 apply failed: ${result.raw}`);
  assert.equal(result.json?.ok, true, `LR19 apply failed: ${result.raw}`);
  assert.equal(fs.readFileSync(prepared.target, "utf8"), "# LR19 display only\n");
}

async function testLR20() {
  for (const scenario of [
    { name: "missing-operation-input", mutate: (operation) => { delete operation.schema_version; } },
    { name: "wrong-operation-input", mutate: (operation) => { operation.schema_version = 999; } },
  ]) {
    const root = createProject(`lr20-${scenario.name}`);
    const operation = defaultOperation(`lr20-${scenario.name}`, []);
    scenario.mutate(operation);
    const out = path.join(root, ".project-gov", "plans", `${scenario.name}.json`);
    const result = propose(root, `lr20-${scenario.name}`, [], { operation, out });
    assertRejected(result, "schema_version_must_be_2", `LR20 ${scenario.name}`);
    assert.equal(fs.existsSync(out), false, `LR20 ${scenario.name}: invalid operation produced a plan`);
  }

  const root = createProject("lr20-compiled-operation-schema");
  const prepared = planWithSingleWrite(root, "lr20-compiled-schema");
  for (const scenario of [
    { name: "missing", mutate: (compiled) => { delete compiled.operation_schema_version; }, expected: "compiled_plan_field_missing:operation_schema_version" },
    { name: "wrong", mutate: (compiled) => { compiled.operation_schema_version = 999; }, expected: "compiled_operation_schema_version_must_be_2" },
  ]) {
    const compiled = readCompiled(prepared.out);
    scenario.mutate(compiled);
    recomputeCompiledDigest(compiled);
    const planPath = writeJson(path.join(root, ".project-gov", "plans", `lr20-${scenario.name}.json`), compiled);
    const eventLog = path.join(sandbox, `lr20-${scenario.name}-events.jsonl`);
    const result = apply(planPath, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(result, scenario.expected, `LR20 ${scenario.name}`);
    assertNoLockOrBackup(root, eventLog, `LR20 ${scenario.name}`);
    assert.equal(fs.existsSync(planPath), true, `LR20 ${scenario.name}: rejected plan was not retained`);
  }
}

async function testLR21() {
  const root = createProject("lr21-predicted-fingerprint-rederive");
  const prepared = planWithSingleWrite(root, "lr21-predicted-fingerprint");
  const compiled = readCompiled(prepared.out);
  const rel = Object.keys(compiled.predicted_target_fingerprints)[0];
  const predicted = compiled.predicted_target_fingerprints[rel];
  assert.equal(predicted.kind, "file");
  predicted.sha256 = predicted.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  recomputeCompiledDigest(compiled);
  writeJson(prepared.out, compiled);
  const eventLog = path.join(sandbox, "lr21-events.jsonl");
  const result = apply(prepared.out, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
  assertRejected(result, "predicted_target_fingerprint_drift", "LR21");
  assertLockedPreflightRejected(root, eventLog, prepared.out, prepared.target, "LR21");
}

async function testLR22() {
  const root = createProject("lr22-strict-nested-schema");
  const prepared = planWithSingleWrite(root, "lr22-strict-nested");
  const rel = prepared.rel;
  const scenarios = [
    {
      name: "decision-snapshot",
      expected: "baseline_validation_unknown_field:intruder",
      mutate: (compiled) => {
        compiled.baseline_validation.intruder = true;
        compiled.baseline_validation_digest = digest(compiled.baseline_validation);
      },
    },
    {
      name: "decision-five-piece",
      expected: "predicted_validation_five_piece_unknown_field:intruder",
      mutate: (compiled) => {
        compiled.predicted_validation.five_piece.intruder = true;
        compiled.predicted_validation_digest = digest(compiled.predicted_validation);
      },
    },
    {
      name: "stable-issue",
      expected: "baseline_validation_hard_issues[0]_unknown_field:intruder",
      mutate: (compiled) => {
        compiled.baseline_validation.hard_issues.push({ code: "fixture_issue", subject_key: "fixture#issue", intruder: true });
        compiled.baseline_validation_digest = digest(compiled.baseline_validation);
      },
    },
    {
      name: "fingerprint",
      expected: `before_fingerprints:${rel}_unknown_field:intruder`,
      mutate: (compiled) => { compiled.before_fingerprints[rel].intruder = true; },
    },
    {
      name: "action",
      expected: "compiled_actions[0]_unknown_field:intruder",
      mutate: (compiled) => { compiled.actions[0].intruder = true; },
    },
    {
      name: "knowledge-review",
      expected: "compiled_knowledge_review_unknown_field:intruder",
      mutate: (compiled) => { compiled.knowledge_review.intruder = true; },
    },
    {
      name: "transition",
      expected: "predicted_transition_unknown_field:intruder",
      mutate: (compiled) => { compiled.predicted_transition.intruder = true; },
    },
  ];

  for (const scenario of scenarios) {
    const compiled = readCompiled(prepared.out);
    scenario.mutate(compiled);
    recomputeCompiledDigest(compiled);
    const planPath = writeJson(path.join(root, ".project-gov", "plans", `lr22-${scenario.name}.json`), compiled);
    const eventLog = path.join(sandbox, `lr22-${scenario.name}-events.jsonl`);
    const result = apply(planPath, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(result, scenario.expected, `LR22 ${scenario.name}`);
    assertNoLockOrBackup(root, eventLog, `LR22 ${scenario.name}`);
    assert.equal(fs.existsSync(planPath), true, `LR22 ${scenario.name}: rejected plan was not retained`);
  }
  assert.equal(fs.existsSync(prepared.target), false, "LR22 target changed");
}

async function testLR23() {
  const root = createProject("lr23-target-key-invariant");
  const prepared = planWithSingleWrite(root, "lr23-target-key-invariant");
  const extraFingerprint = { exists: false, kind: "absent", bytes: null, sha256: null };
  const scenarios = [
    {
      name: "before-missing",
      expected: "before_fingerprints_target_set_mismatch",
      mutate: (compiled) => { delete compiled.before_fingerprints[prepared.rel]; },
    },
    {
      name: "before-extra",
      expected: "before_fingerprints_target_set_mismatch",
      mutate: (compiled) => { compiled.before_fingerprints["历史记录/extra-before.md"] = extraFingerprint; },
    },
    {
      name: "predicted-missing",
      expected: "predicted_target_fingerprints_target_set_mismatch",
      mutate: (compiled) => { delete compiled.predicted_target_fingerprints[prepared.rel]; },
    },
    {
      name: "predicted-extra",
      expected: "predicted_target_fingerprints_target_set_mismatch",
      mutate: (compiled) => { compiled.predicted_target_fingerprints["历史记录/extra-predicted.md"] = extraFingerprint; },
    },
  ];
  for (const scenario of scenarios) {
    const compiled = readCompiled(prepared.out);
    scenario.mutate(compiled);
    recomputeCompiledDigest(compiled);
    const planPath = writeJson(path.join(root, ".project-gov", "plans", `lr23-${scenario.name}.json`), compiled);
    const eventLog = path.join(sandbox, `lr23-${scenario.name}-events.jsonl`);
    const result = apply(planPath, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(result, scenario.expected, `LR23 ${scenario.name}`);
    assertNoLockOrBackup(root, eventLog, `LR23 ${scenario.name}`);
    assert.equal(fs.existsSync(planPath), true, `LR23 ${scenario.name}: rejected plan was not retained`);
  }
  assert.equal(fs.existsSync(prepared.target), false, "LR23 target changed");
}

function testRc7AdmissionBounds() {
  const oneWrite = (name) => [{
    kind: "write_file",
    path: `历史记录/${name}.md`,
    content: `# ${name}\n`,
    overwrite: false,
  }];
  const ascii1024 = "a".repeat(MAX_PLAN_ID_BYTES);
  const ascii1025 = "a".repeat(MAX_PLAN_ID_BYTES + 1);
  const chinese1024 = `${"界".repeat(341)}a`;
  const chinese1025 = `${"界".repeat(341)}ab`;
  assert.equal(Buffer.byteLength(chinese1024, "utf8"), MAX_PLAN_ID_BYTES);
  assert.equal(Buffer.byteLength(chinese1025, "utf8"), MAX_PLAN_ID_BYTES + 1);

  for (const [label, planId] of [["ascii-1024", ascii1024], ["chinese-1024", chinese1024]]) {
    const root = createProject(`plan-id-${label}`);
    const actions = oneWrite(`plan-id-${label}`);
    const prepared = propose(root, `plan-id-${label}`, actions, {
      operation: defaultOperation(planId, actions),
      out: path.join(root, ".project-gov", "plans", `plan-id-${label}.json`),
      timeout: 40_000,
    });
    assertProposed(prepared, `plan_id ${label}`);
    assert.equal(Buffer.byteLength(readCompiled(prepared.out).plan_id, "utf8"), MAX_PLAN_ID_BYTES);
    const applied = apply(prepared.out, { timeout: 40_000 });
    assert.equal(applied.status, 0, `plan_id ${label} apply failed: ${applied.raw}`);
    assert.equal(applied.json?.ok, true, `plan_id ${label} apply failed: ${applied.raw}`);
  }

  for (const [label, planId] of [["ascii-1025", ascii1025], ["chinese-1025", chinese1025]]) {
    const root = createProject(`plan-id-${label}`);
    const actions = oneWrite(`plan-id-${label}`);
    const out = path.join(root, ".project-gov", "plans", `plan-id-${label}.json`);
    const rejected = propose(root, `plan-id-${label}`, actions, {
      operation: defaultOperation(planId, actions),
      out,
    });
    assertRejected(rejected, `plan_id_exceeds_${MAX_PLAN_ID_BYTES}_bytes`, `plan_id ${label}`);
    assert.equal(fs.existsSync(out), false, `plan_id ${label}: compiled plan was created`);
  }

  {
    const root = createProject("compiled-plan-id-1025");
    const prepared = planWithSingleWrite(root, "compiled-plan-id-1025-source");
    const compiled = readCompiled(prepared.out);
    compiled.plan_id = ascii1025;
    recomputeCompiledDigest(compiled);
    const rejectedPlan = writeJson(path.join(root, ".project-gov", "plans", "compiled-plan-id-1025.json"), compiled);
    const eventLog = path.join(sandbox, "compiled-plan-id-1025-events.jsonl");
    const rejected = apply(rejectedPlan, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(rejected, `compiled_plan_id_exceeds_${MAX_PLAN_ID_BYTES}_bytes`, "compiled plan_id 1025");
    assertNoLockOrBackup(root, eventLog, "compiled plan_id 1025");
    assert.equal(fs.existsSync(prepared.target), false, "compiled plan_id 1025 changed its target");
  }

  const asciiHistoryPath = (totalBytes) => {
    const prefix = "历史记录/";
    const suffix = ".md";
    const fillBytes = totalBytes - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
    assert.ok(fillBytes > 0, "ASCII path fixture has no payload room");
    const rel = `${prefix}${"a".repeat(fillBytes)}${suffix}`;
    assert.equal(Buffer.byteLength(rel, "utf8"), totalBytes, "ASCII path fixture byte count drifted");
    return rel;
  };
  const remapCompiledTarget = (compiled, nextRel) => {
    const previousRel = compiled.actions[0].path;
    compiled.actions[0].path = nextRel;
    for (const field of ["before_fingerprints", "predicted_target_fingerprints"]) {
      const fingerprint = compiled[field][previousRel];
      delete compiled[field][previousRel];
      compiled[field][nextRel] = fingerprint;
    }
    recomputeCompiledDigest(compiled);
  };
  const maxTemporaryCompatiblePathBytes = MAX_TRANSACTION_PATH_BYTES - TRANSACTION_TEMP_REL_SUFFIX_BYTES;
  assert.equal(TRANSACTION_TEMP_REL_SUFFIX_BYTES, 53, "transaction temp suffix byte contract drifted");

  {
    const root = createProject("operation-temp-path-overflow");
    const rel = asciiHistoryPath(maxTemporaryCompatiblePathBytes + 1);
    const actions = [{ kind: "write_file", path: rel, content: "# temp overflow\n", overwrite: false }];
    const out = path.join(root, ".project-gov", "plans", "operation-temp-path-overflow.json");
    const eventLog = path.join(sandbox, "operation-temp-path-overflow-events.jsonl");
    const rejected = propose(root, "operation-temp-path-overflow", actions, {
      out,
      script: instrumentedScript,
      env: { PDE_EDGE_EVENT_LOG: eventLog },
    });
    assertRejected(
      rejected,
      `actions[0].transaction_temp_path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`,
      "operation derived temp path overflow",
    );
    assert.equal(fs.existsSync(out), false, "operation temp overflow produced a compiled plan");
    assertNoLockOrBackup(root, eventLog, "operation derived temp path overflow");
  }

  {
    const root = createProject("operation-multibyte-path-overflow");
    const rel = `历史记录/${"界".repeat(1361)}.md`;
    assert.ok(Buffer.byteLength(rel, "utf8") > MAX_TRANSACTION_PATH_BYTES);
    const actions = [{ kind: "write_file", path: rel, content: "# path overflow\n", overwrite: false }];
    const out = path.join(root, ".project-gov", "plans", "operation-multibyte-path-overflow.json");
    const rejected = propose(root, "operation-multibyte-path-overflow", actions, { out });
    assertRejected(
      rejected,
      `actions[0].path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`,
      "operation multibyte target path overflow",
    );
    assert.equal(fs.existsSync(out), false, "operation multibyte overflow produced a compiled plan");
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false, "operation multibyte overflow acquired a lock");
    assert.deepEqual(backupArtifacts(root), [], "operation multibyte overflow created a backup");
  }

  {
    const root = createProject("compiled-target-path-overflow");
    const prepared = planWithSingleWrite(root, "compiled-target-path-overflow-source");
    const compiled = readCompiled(prepared.out);
    remapCompiledTarget(compiled, asciiHistoryPath(MAX_TRANSACTION_PATH_BYTES + 1));
    const rejectedPlan = writeJson(path.join(root, ".project-gov", "plans", "compiled-target-path-overflow.json"), compiled);
    const eventLog = path.join(sandbox, "compiled-target-path-overflow-events.jsonl");
    const rejected = apply(rejectedPlan, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(
      rejected,
      `compiled_actions[0]_path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`,
      "compiled target path overflow",
    );
    assertNoLockOrBackup(root, eventLog, "compiled target path overflow");
    assert.equal(fs.existsSync(prepared.target), false, "compiled target path overflow changed its target");
  }

  {
    const root = createProject("compiled-multibyte-temp-overflow");
    const prepared = planWithSingleWrite(root, "compiled-multibyte-temp-overflow-source");
    const compiled = readCompiled(prepared.out);
    const rel = `历史记录/${"界".repeat(1360)}.md`;
    assert.equal(Buffer.byteLength(rel, "utf8"), MAX_TRANSACTION_PATH_BYTES);
    remapCompiledTarget(compiled, rel);
    const rejectedPlan = writeJson(path.join(root, ".project-gov", "plans", "compiled-multibyte-temp-overflow.json"), compiled);
    const eventLog = path.join(sandbox, "compiled-multibyte-temp-overflow-events.jsonl");
    const rejected = apply(rejectedPlan, { script: instrumentedScript, env: { PDE_EDGE_EVENT_LOG: eventLog } });
    assertRejected(
      rejected,
      `compiled_actions[0]_transaction_temp_path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`,
      "compiled multibyte derived temp path overflow",
    );
    assertNoLockOrBackup(root, eventLog, "compiled multibyte derived temp path overflow");
    assert.equal(fs.existsSync(prepared.target), false, "compiled multibyte temp overflow changed its target");
  }

  const actionPayload = "x".repeat(512 * 1024);
  const overBudgetActions = Array.from({ length: 17 }, (_, index) => ({
    kind: "write_file",
    path: `历史记录/action-budget-${String(index).padStart(2, "0")}.md`,
    content: actionPayload,
    overwrite: false,
  }));
  assert.ok(overBudgetActions.reduce((total, action) => total + Buffer.byteLength(action.content, "utf8"), 0) > MAX_TOTAL_ACTION_TEXT_BYTES);
  {
    const root = createProject("operation-action-text-budget");
    const out = path.join(root, ".project-gov", "plans", "operation-action-text-budget.json");
    const rejected = propose(root, "operation-action-text-budget", overBudgetActions, { out, timeout: 40_000 });
    assertRejected(rejected, `actions_total_text_exceeds_${MAX_TOTAL_ACTION_TEXT_BYTES}_bytes`, "operation action text budget");
    assert.equal(fs.existsSync(out), false, "over-budget operation produced a compiled plan");
  }
  {
    const root = createProject("compiled-action-text-budget");
    const prepared = planWithSingleWrite(root, "compiled-action-text-budget-source");
    const compiled = readCompiled(prepared.out);
    compiled.actions = Array.from({ length: 17 }, () => ({ ...compiled.actions[0], content: actionPayload }));
    recomputeCompiledDigest(compiled);
    const rejectedPlan = writeJson(path.join(root, ".project-gov", "plans", "compiled-action-text-budget.json"), compiled);
    const eventLog = path.join(sandbox, "compiled-action-text-budget-events.jsonl");
    const rejected = apply(rejectedPlan, {
      script: instrumentedScript,
      env: { PDE_EDGE_EVENT_LOG: eventLog },
      timeout: 40_000,
    });
    assertRejected(rejected, `compiled_actions_total_text_exceeds_${MAX_TOTAL_ACTION_TEXT_BYTES}_bytes`, "compiled action text budget");
    assertNoLockOrBackup(root, eventLog, "compiled action text budget");
    assert.equal(fs.existsSync(prepared.target), false, "over-budget compiled plan changed its target");
  }

  for (const [label, headroom, expectAccepted] of [["compiled-overflow", 500, false], ["compiled-roundtrip", 64 * 1024, true]]) {
    const root = createProject(label);
    const actions = Array.from({ length: 16 }, (_, index) => ({
      kind: "write_file",
      path: `历史记录/${label}-${index}.md`,
      content: "\n".repeat(512 * 1024),
      overwrite: false,
    }));
    const operation = defaultOperation(label, actions);
    const excess = Buffer.byteLength(JSON.stringify(operation), "utf8") - (MAX_WORKFLOW_JSON_BYTES - headroom);
    actions.at(-1).content = actions.at(-1).content.slice(0, -Math.ceil(excess / 2));
    const input = JSON.stringify(operation);
    assert.ok(Buffer.byteLength(input, "utf8") < MAX_WORKFLOW_JSON_BYTES);
    assert.ok(actions.reduce((total, action) => total + Buffer.byteLength(action.content, "utf8"), 0) < MAX_TOTAL_ACTION_TEXT_BYTES);
    const operationPath = write(root, `.project-gov/operations/${label}.json`, input);
    const out = path.join(root, ".project-gov", "plans", `${label}.json`);
    const proposed = runScript(productionScript, ["propose", "--root", root, "--plan", operationPath, "--out", out, "--json"], { timeout: 40_000 });
    if (expectAccepted) {
      assertProposed({ ...proposed, out }, label);
      assert.ok(fs.statSync(out).size <= MAX_WORKFLOW_JSON_BYTES);
      const applied = apply(out, { timeout: 40_000 });
      assert.equal(applied.status, 0, `${label}: ${applied.raw}`);
      assert.equal(applied.json.ok, true);
      for (const action of actions) assert.equal(fs.readFileSync(path.join(root, action.path), "utf8"), action.content);
    } else {
      assertRejected(proposed, "compiled_workflow_artifact_too_large", label);
      assert.equal(fs.existsSync(out), false, "oversized compiled artifact must not be published");
      assert.equal(fs.readFileSync(operationPath, "utf8"), input, "rejected operation must be retained byte-exact");
      assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false);
      assert.deepEqual(backupArtifacts(root), []);
      for (const action of actions) assert.equal(fs.existsSync(path.join(root, action.path)), false);
    }
  }

  const oversizedWorkflow = Buffer.alloc(MAX_WORKFLOW_JSON_BYTES + 1, 0x7b);
  for (const [command, viaStdin] of [
    ["propose", false],
    ["propose", true],
    ["apply", false],
    ["apply", true],
  ]) {
    const root = createProject(`${command}-workflow-${viaStdin ? "stdin" : "file"}`);
    const artifact = viaStdin
      ? "-"
      : (() => {
        const abs = path.join(root, `${command}-oversized-workflow.json`);
        fs.writeFileSync(abs, oversizedWorkflow);
        return abs;
      })();
    const args = command === "propose"
      ? ["propose", "--root", root, "--plan", artifact, "--out", path.join(root, ".project-gov", "plans", "must-not-exist.json"), "--json"]
      : ["apply", "--plan", artifact, "--json"];
    const rejected = runScript(productionScript, args, {
      input: viaStdin ? oversizedWorkflow : undefined,
      timeout: 40_000,
    });
    assertRejected(rejected, "workflow_artifact_too_large", `${command} oversized workflow ${viaStdin ? "stdin" : "file"}`);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false, "oversized workflow acquired a lock");
    assert.deepEqual(backupArtifacts(root), [], "oversized workflow created a backup");
  }
}

async function testLR101() {
  const root = createProject("lr101-preflight-incomplete");
  const prepared = planWithSingleWrite(root, "lr101-preflight-incomplete");
  const compiled = readCompiled(prepared.out);
  assert.equal(compiled.predicted_transition.transition_ok, true, "LR101 propose did not produce an admissible plan");
  assert.equal(compiled.predicted_validation.hard_issues_complete, true, "LR101 proposed after snapshot was incomplete");
  assert.equal(compiled.predicted_validation.coverage_issues_complete, true, "LR101 proposed after coverage was incomplete");
  const eventLog = path.join(sandbox, "lr101-events.jsonl");
  const result = apply(prepared.out, {
    script: instrumentedScript,
    env: {
      PDE_EDGE_EVENT_LOG: eventLog,
      PDE_EDGE_FLAGS: "lr101_predicted_incomplete",
    },
  });
  assert.notEqual(result.status, 0, "LR101 expected lock-preflight rejection");
  assert.equal(result.json?.ok, false, `LR101 expected structured rejection: ${result.raw}`);
  assertLockedPreflightRejected(root, eventLog, prepared.out, prepared.target, "LR101");
  assert.equal(readEvents(eventLog).some((item) => item.event === "backup_created"), false, "LR101 created a backup");
  assertRejected(result, "transition_incomplete_issue_set", "LR101");
}

try {
  testRc7AdmissionBounds();
  const registry = [
    ["LR10", testLR10],
    ["LR18", testLR18],
    ["LR19", testLR19],
    ["LR20", testLR20],
    ["LR21", testLR21],
    ["LR22", testLR22],
    ["LR23", testLR23],
    ["LR101", testLR101],
  ];
  const registeredIds = registry.map(([id]) => id);
  assert.equal(new Set(registeredIds).size, registeredIds.length, "duplicate LR id registration");
  assert.deepEqual([...registeredIds].sort(), [...EXPECTED_LR_IDS].sort(), "LR registry did not close exactly");
  for (const [id, test] of registry) {
    await test();
    completedLrIds.add(id);
  }
  assert.deepEqual([...completedLrIds].sort(), [...EXPECTED_LR_IDS].sort(), "LR id set did not close exactly");
  console.log(`project-gov v0.3.8 schema edge tests: PASS (${[...completedLrIds].sort().join(", ")})`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
