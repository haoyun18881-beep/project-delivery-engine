import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionScript = path.join(skillRoot, "scripts", "project-gov.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v038-transaction-"));
const injectedScript = createInjectedScript();
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

function statusText(marker = "baseline") {
  return `# STATUS.md

## 当前状态

| 项目 | 状态 | 依据 |
| --- | --- | --- |
| transaction | ${marker} | fixture |

## 验证

| 验证项 | 结果 | 层级 |
| --- | --- | --- |
| baseline | pass | 主线 |

## 风险

- 无

## 关键引用

- 无
`;
}

function todoText(marker = "baseline") {
  return `# TODO.md

## 下一步

| 优先级 | 事项 | 完成条件 |
| --- | --- | --- |
| P1 | transaction | ${marker} |

## 待确认

| 事项 | 影响 |
| --- | --- |
| 无 | 无 |
`;
}

function createProject(name) {
  sequence += 1;
  const root = path.join(sandbox, `${String(sequence).padStart(2, "0")}-${name}`);
  write(root, "AGENTS.md", "# AGENTS.md\n");
  write(
    root,
    "PROJECT_START_HERE.md",
    "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 事务完整性夹具。\n\n## 启动入口\n\n1. 读取五件套。\n",
  );
  write(root, "STATUS.md", statusText());
  write(root, "TODO.md", todoText());
  write(
    root,
    "HANDOFF.md",
    "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-08-28 08:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n\n## 未决上下文\n\n- 无\n",
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

function defaultKnowledgeReview() {
  return {
    status: "none",
    basis: "事务完整性夹具未产生可跨任务复用的已核实知识。",
  };
}

function parseChildResult(result) {
  const raw = result.stdout.trim() || result.stderr.trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (error) {
    throw new Error(`child did not return JSON (status=${result.status}): ${raw.slice(0, 2000)}`, { cause: error });
  }
  return { ...result, json };
}

function runScript(script, args, options = {}) {
  return parseChildResult(spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  }));
}

function propose(root, name, actions) {
  const operation = write(root, `${name}.operation.json`, `${JSON.stringify({
    schema_version: 2,
    plan_id: name,
    knowledge_review: defaultKnowledgeReview(),
    actions,
  }, null, 2)}\n`);
  const out = path.join(root, ".project-gov", "plans", `${name}.json`);
  const result = runScript(productionScript, [
    "propose",
    "--root",
    root,
    "--plan",
    operation,
    "--out",
    out,
    "--json",
  ]);
  return { ...result, out };
}

function apply(compiledPlan, options = {}) {
  return runScript(options.script || productionScript, [
    "apply",
    "--plan",
    compiledPlan,
    "--json",
  ], options);
}

function assertProposed(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  assert.equal(result.json?.ok, true, `${label}: ${result.stdout || result.stderr}`);
  assert.equal(fs.existsSync(result.out), true, `${label}: compiled plan missing`);
}

function assertRejected(result, label) {
  assert.notEqual(result.status, 0, `${label}: expected rejection`);
  assert.equal(result.json?.ok, false, `${label}: ${result.stdout || result.stderr}`);
}

function assertRollbackComplete(result, label) {
  assertRejected(result, label);
  assert.equal(result.json.rollback_attempted, true, `${label}: rollback was not attempted`);
  assert.equal(result.json.rolled_back, true, `${label}: rolled_back only means verified restoration`);
  assert.equal(result.json.rollback_complete, true, `${label}: rollback_complete`);
  assert.equal(result.json.rollback_incomplete, false, `${label}: rollback_incomplete`);
}

function assertRollbackIncomplete(result, label) {
  assertRejected(result, label);
  assert.equal(result.json.rollback_attempted, true, `${label}: rollback was not attempted`);
  assert.equal(result.json.rolled_back, false, `${label}: incomplete rollback cannot report rolled_back`);
  assert.equal(result.json.rollback_complete, false, `${label}: rollback_complete`);
  assert.equal(result.json.rollback_incomplete, true, `${label}: rollback_incomplete`);
}

function mutate(root, rel, transform) {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, transform(fs.readFileSync(abs, "utf8")), "utf8");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fingerprint(abs) {
  const stat = lstatIfPresent(abs);
  if (!stat) return { exists: false, kind: "absent", bytes: null, sha256: null };
  if (stat.isSymbolicLink()) return { exists: true, kind: "symlink", bytes: null, sha256: null };
  if (stat.isDirectory()) return { exists: true, kind: "directory", bytes: null, sha256: null };
  if (!stat.isFile()) return { exists: true, kind: "other", bytes: null, sha256: null };
  const content = fs.readFileSync(abs);
  return { exists: true, kind: "file", bytes: content.length, sha256: sha256(content) };
}

function lstatIfPresent(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function sortedKeys(value) {
  return Object.keys(value || {}).sort();
}

function jsonText(value) {
  return JSON.stringify(value);
}

function findDeep(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDeep(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function assertRollbackBaselineRestored(result, label) {
  const before = findDeep(result.json, "baseline_digest_locked");
  const after = findDeep(result.json, "baseline_digest_after");
  assert.equal(typeof before, "string", `${label}: locked baseline digest missing`);
  assert.equal(after, before, `${label}: rollback baseline digest drifted`);
}

function faultEnv(root, config) {
  const env = {
    PDE_V038_FAULTS: (config.faults || []).join(","),
    PDE_V038_ROOT: root,
  };
  for (const [key, value] of Object.entries({
    PDE_V038_TARGET: config.target,
    PDE_V038_SECOND_TARGET: config.secondTarget,
    PDE_V038_NON_TARGET: config.nonTarget,
    PDE_V038_READY: config.ready,
    PDE_V038_TRACE: config.trace,
    PDE_V038_DIRECTORY: config.directory,
    PDE_V038_DURABILITY_TRACE: config.durabilityTrace,
  })) {
    if (value) env[key] = value;
  }
  if (config.traceTargets) env.PDE_V038_TRACE_TARGETS = JSON.stringify(config.traceTargets);
  return env;
}

function replaceStatus(marker) {
  return {
    kind: "replace_line_contains",
    path: "STATUS.md",
    contains: "| transaction | baseline | fixture |",
    replacement: `| transaction | ${marker} | fixture |`,
  };
}

function replaceTodo(marker) {
  return {
    kind: "replace_line_contains",
    path: "TODO.md",
    contains: "| P1 | transaction | baseline |",
    replacement: `| P1 | transaction | ${marker} |`,
  };
}

function createInjectedScript() {
  const source = fs.readFileSync(productionScript, "utf8");
  const anchor = 'import { fileURLToPath } from "node:url";';
  assert.equal(source.includes(anchor), true, "fault-injection import anchor missing");
  const prelude = String.raw`

// Test-only fault injection. This block exists only in the temporary script copy.
const __pdeTestFaults = new Set(String(process.env.PDE_V038_FAULTS || "").split(",").filter(Boolean));
const __pdeTestRoot = process.env.PDE_V038_ROOT ? path.resolve(process.env.PDE_V038_ROOT) : null;
const __pdeTestTarget = process.env.PDE_V038_TARGET ? path.resolve(process.env.PDE_V038_TARGET) : null;
const __pdeTestSecond = process.env.PDE_V038_SECOND_TARGET ? path.resolve(process.env.PDE_V038_SECOND_TARGET) : null;
const __pdeTestNonTarget = process.env.PDE_V038_NON_TARGET ? path.resolve(process.env.PDE_V038_NON_TARGET) : null;
const __pdeTestReady = process.env.PDE_V038_READY ? path.resolve(process.env.PDE_V038_READY) : null;
const __pdeTestTrace = process.env.PDE_V038_TRACE ? path.resolve(process.env.PDE_V038_TRACE) : null;
const __pdeTestDirectory = process.env.PDE_V038_DIRECTORY ? path.resolve(process.env.PDE_V038_DIRECTORY) : null;
const __pdeTestDurabilityTrace = process.env.PDE_V038_DURABILITY_TRACE
  ? path.resolve(process.env.PDE_V038_DURABILITY_TRACE)
  : null;
const __pdeTestTraceTargets = new Set(JSON.parse(process.env.PDE_V038_TRACE_TARGETS || "[]").map((item) => path.resolve(item)));
const __pdeTestOriginal = {
  appendFileSync: fs.appendFileSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  copyFileSync: fs.copyFileSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  linkSync: fs.linkSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
};
const __pdeTestState = {
  backupCorrupted: false,
  backupCleanupFailed: false,
  directoryJournalExitTriggered: false,
  driftedAfterBackup: false,
  held: false,
  journalExitTriggered: false,
  postwriteEpochDrifted: false,
  postwriteReadFailed: false,
  restoreFailed: false,
  rollbackReadFailed: false,
  rollbackRestored: false,
  secondTargetDrifted: false,
  secondWriteFailed: false,
  targetWriteCount: 0,
  tempReplacementTriggered: false,
  thirdPartyTargetMutated: false,
};
const __pdeTestFdPaths = new Map();
const __pdeTestNonTargetBefore = __pdeTestNonTarget && fs.existsSync(__pdeTestNonTarget)
  ? __pdeTestOriginal.readFileSync(__pdeTestNonTarget)
  : null;
function __pdeTestSame(left, right) {
  if (!left || !right) return false;
  if (typeof left === "number" || typeof right === "number") return false;
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
function __pdeTestDurabilityEvent(event) {
  if (!__pdeTestDurabilityTrace) return;
  __pdeTestOriginal.appendFileSync(
    __pdeTestDurabilityTrace,
    JSON.stringify({ ...event, path: event.path ? path.resolve(event.path) : undefined }) + "\n",
    "utf8",
  );
}
function __pdeTestTransactionMetadataPath(value) {
  if (typeof value !== "string") return false;
  const base = path.basename(value);
  return base === "apply.lock"
    || base.startsWith("apply.lock.candidate-")
    || base.startsWith("apply.lock.state-")
    || base === ".project-gov-owner.json"
    || base.startsWith(".project-gov-owner.json.tmp-")
    || base === "backup-manifest.json"
    || base.startsWith("backup-manifest.json.tmp-");
}
function __pdeTestBackupSource(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return normalized.includes("/.project-gov/backups/");
}
function __pdeTestTargetOrTemp(value, target) {
  if (!value || !target) return false;
  const resolved = path.resolve(value);
  return __pdeTestSame(resolved, target) || resolved.startsWith(target + ".tmp-");
}
function __pdeTestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function __pdeTestMutateNonTarget() {
  if (!__pdeTestNonTarget) return;
  const original = __pdeTestOriginal.readFileSync(__pdeTestNonTarget);
  __pdeTestOriginal.writeFileSync(__pdeTestNonTarget, Buffer.concat([original, Buffer.from("\nEV-20991231-999\n")]));
}
function __pdeTestRestoreNonTarget() {
  if (__pdeTestNonTarget && __pdeTestNonTargetBefore) {
    __pdeTestOriginal.writeFileSync(__pdeTestNonTarget, __pdeTestNonTargetBefore);
  }
}
fs.mkdirSync = function __pdeTestMkdir(target, ...args) {
  const result = __pdeTestOriginal.mkdirSync(target, ...args);
  __pdeTestDurabilityEvent({ op: "mkdir", path: target });
  const normalized = String(target).replaceAll("\\", "/");
  if (
    __pdeTestFaults.has("hold_after_lock")
    && !__pdeTestState.held
    && normalized.includes("/.project-gov/backups")
  ) {
    __pdeTestState.held = true;
    if (__pdeTestReady) __pdeTestOriginal.writeFileSync(__pdeTestReady, "ready\n", "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  }
  if (
    __pdeTestFaults.has("hard_exit_after_directory_mkdir")
    && __pdeTestSame(target, __pdeTestDirectory)
  ) process.exit(91);
  return result;
};
fs.linkSync = function __pdeTestLink(from, to) {
  const publishingApplyLock = path.basename(String(to)) === "apply.lock";
  if (__pdeTestFaults.has("hard_exit_before_apply_lock_publish") && publishingApplyLock) process.exit(91);
  const result = __pdeTestOriginal.linkSync(from, to);
  __pdeTestDurabilityEvent({ op: "link", from: path.resolve(from), path: to });
  if (__pdeTestFaults.has("hard_exit_after_apply_lock_publish") && publishingApplyLock) process.exit(91);
  return result;
};
fs.renameSync = function __pdeTestRename(from, to) {
  const atomicTarget = String(from).includes(".tmp-") && __pdeTestTraceTargets.has(path.resolve(to));
  if (
    __pdeTestFaults.has("second_write_failure")
    && !__pdeTestState.secondWriteFailed
    && __pdeTestTargetOrTemp(to, __pdeTestSecond)
  ) {
    __pdeTestState.secondWriteFailed = true;
    if (
      __pdeTestFaults.has("third_party_target_before_rollback")
      && !__pdeTestState.thirdPartyTargetMutated
      && __pdeTestTarget
    ) {
      __pdeTestState.thirdPartyTargetMutated = true;
      __pdeTestOriginal.writeFileSync(__pdeTestTarget, "third-party-state-must-survive\n", "utf8");
    }
    throw __pdeTestError("EIO", "pde_test_second_write_failure");
  }
  if (
    __pdeTestFaults.has("replace_target_temp_before_quarantine")
    && !__pdeTestState.tempReplacementTriggered
    && __pdeTestTarget
    && path.resolve(String(from)).startsWith(__pdeTestTarget + ".tmp-project-gov-")
    && __pdeTestSame(to, String(from) + ".quarantine")
  ) {
    __pdeTestState.tempReplacementTriggered = true;
    __pdeTestOriginal.unlinkSync(from);
    __pdeTestOriginal.writeFileSync(from, "third-party-replacement\n", "utf8");
  }
  const result = __pdeTestOriginal.renameSync(from, to);
  __pdeTestDurabilityEvent({ op: "rename", from: path.resolve(from), path: to });
  if (
    __pdeTestFaults.has("hard_exit_after_metadata_quarantine")
    && (String(to) === String(from) + ".cleanup" || String(to).startsWith(String(from) + ".cleanup-"))
    && /(?:backup-manifest\.json|\.project-gov-owner\.json)\.tmp-/.test(path.basename(String(from)))
  ) process.exit(91);
  if (
    __pdeTestFaults.has("hard_exit_after_target_temp_quarantine")
    && __pdeTestTarget
    && path.resolve(String(from)).startsWith(__pdeTestTarget + ".tmp-project-gov-")
    && __pdeTestSame(to, String(from) + ".quarantine")
  ) process.exit(91);
  if (
    __pdeTestFaults.has("hard_exit_after_commit_verified")
    && !__pdeTestState.journalExitTriggered
    && path.basename(String(to)) === "backup-manifest.json"
  ) {
    const journal = JSON.parse(__pdeTestOriginal.readFileSync(to, "utf8"));
    if (journal.state === "commit_verified") {
      __pdeTestState.journalExitTriggered = true;
      process.exit(91);
    }
  }
  if (
    __pdeTestFaults.has("hard_exit_after_directory_identity_journal")
    && !__pdeTestState.directoryJournalExitTriggered
    && __pdeTestDirectory
    && path.basename(String(to)) === "backup-manifest.json"
  ) {
    const journal = JSON.parse(__pdeTestOriginal.readFileSync(to, "utf8"));
    const recorded = (journal.directory_records || []).some((record) => (
      record.state === "created"
      && __pdeTestSame(path.join(__pdeTestRoot, record.rel), __pdeTestDirectory)
    ));
    if (recorded) {
      __pdeTestState.directoryJournalExitTriggered = true;
      process.exit(91);
    }
  }
  if (atomicTarget && __pdeTestTrace) {
    __pdeTestOriginal.appendFileSync(__pdeTestTrace, JSON.stringify({ path: path.resolve(to) }) + "\n", "utf8");
  }
  if (String(from).includes(".tmp-") && __pdeTestSame(to, __pdeTestTarget)) {
    __pdeTestState.targetWriteCount += 1;
    if (__pdeTestState.targetWriteCount === 1) {
      if (
        __pdeTestFaults.has("second_target_drift_after_first_write")
        && !__pdeTestState.secondTargetDrifted
        && __pdeTestSecond
      ) {
        __pdeTestState.secondTargetDrifted = true;
        const value = __pdeTestOriginal.readFileSync(__pdeTestSecond, "utf8");
        const drifted = value.replace("baseline", "external-change");
        if (drifted === value) throw __pdeTestError("EINVAL", "pde_test_second_target_drift_anchor_missing");
        __pdeTestOriginal.writeFileSync(__pdeTestSecond, drifted, "utf8");
      }
      if (__pdeTestFaults.has("sha_mismatch")) {
        const value = __pdeTestOriginal.readFileSync(to);
        const next = Buffer.from(value);
        next[Math.max(0, next.length - 2)] = next[Math.max(0, next.length - 2)] === 65 ? 66 : 65;
        __pdeTestOriginal.writeFileSync(to, next);
      }
      if (__pdeTestFaults.has("bytes_mismatch")) {
        const value = __pdeTestOriginal.readFileSync(to);
        __pdeTestOriginal.writeFileSync(to, Buffer.concat([value, Buffer.from("X")]));
      }
      if (__pdeTestFaults.has("kind_mismatch")) {
        __pdeTestOriginal.unlinkSync(to);
        __pdeTestOriginal.mkdirSync(to);
      }
      if (__pdeTestFaults.has("actual_transition_failure")) __pdeTestMutateNonTarget();
      if (__pdeTestFaults.has("hard_exit_after_first_target")) process.exit(91);
    } else {
      __pdeTestState.rollbackRestored = true;
      if (__pdeTestFaults.has("actual_transition_failure")) __pdeTestRestoreNonTarget();
      if (__pdeTestFaults.has("baseline_drift_on_restore")) __pdeTestMutateNonTarget();
    }
  }
  return result;
};
fs.copyFileSync = function __pdeTestCopy(from, to, ...args) {
  const restoringTarget = __pdeTestBackupSource(from) && __pdeTestTargetOrTemp(to, __pdeTestTarget);
  const creatingTargetBackup = __pdeTestSame(from, __pdeTestTarget) && __pdeTestBackupSource(to);
  if (restoringTarget && __pdeTestFaults.has("restore_failure") && !__pdeTestState.restoreFailed) {
    __pdeTestState.restoreFailed = true;
    throw __pdeTestError("EIO", "pde_test_restore_failure");
  }
  const result = __pdeTestOriginal.copyFileSync(from, to, ...args);
  if (
    creatingTargetBackup
    && __pdeTestFaults.has("backup_copy_corruption")
    && !__pdeTestState.backupCorrupted
  ) {
    __pdeTestState.backupCorrupted = true;
    const value = __pdeTestOriginal.readFileSync(to);
    const next = Buffer.from(value);
    next[0] = next[0] === 35 ? 36 : 35;
    __pdeTestOriginal.writeFileSync(to, next);
  }
  if (
    creatingTargetBackup
    && __pdeTestFaults.has("target_drift_after_backup")
    && !__pdeTestState.driftedAfterBackup
  ) {
    __pdeTestState.driftedAfterBackup = true;
    const value = __pdeTestOriginal.readFileSync(from, "utf8");
    const drifted = value.replace("baseline", "baselinx");
    if (drifted === value) throw __pdeTestError("EINVAL", "pde_test_target_drift_anchor_missing");
    __pdeTestOriginal.writeFileSync(from, drifted, "utf8");
  }
  if (restoringTarget) {
    __pdeTestState.rollbackRestored = true;
    if (__pdeTestFaults.has("actual_transition_failure")) __pdeTestRestoreNonTarget();
    if (__pdeTestFaults.has("baseline_drift_on_restore")) __pdeTestMutateNonTarget();
  }
  return result;
};
function __pdeTestMaybeReadFailure(target) {
  if (!__pdeTestSame(target, __pdeTestTarget)) return;
  if (
    __pdeTestFaults.has("postwrite_read_failure")
    && __pdeTestState.targetWriteCount > 0
    && !__pdeTestState.rollbackRestored
    && !__pdeTestState.postwriteReadFailed
  ) {
    __pdeTestState.postwriteReadFailed = true;
    throw __pdeTestError("EIO", "pde_test_postwrite_read_failure");
  }
  if (
    __pdeTestFaults.has("rollback_verification_read_failure")
    && __pdeTestState.rollbackRestored
  ) {
    throw __pdeTestError("EIO", "pde_test_rollback_verification_read_failure");
  }
}
fs.openSync = function __pdeTestOpen(target, ...args) {
  __pdeTestMaybeReadFailure(target);
  __pdeTestDurabilityEvent({ op: "open", path: target, flags: String(args[0] ?? "") });
  const fd = __pdeTestOriginal.openSync(target, ...args);
  if (typeof target === "string") __pdeTestFdPaths.set(fd, path.resolve(target));
  return fd;
};
fs.closeSync = function __pdeTestClose(fd) {
  try {
    return __pdeTestOriginal.closeSync(fd);
  } finally {
    __pdeTestFdPaths.delete(fd);
  }
};
fs.fsyncSync = function __pdeTestFsync(fd) {
  __pdeTestDurabilityEvent({ op: "fsync", path: __pdeTestFdPaths.get(fd) || "<unknown-fd>" });
  return __pdeTestOriginal.fsyncSync(fd);
};
fs.writeSync = function __pdeTestWrite(fd, buffer, offset, length, position) {
  const fdPath = __pdeTestFdPaths.get(fd) || "";
  const base = path.basename(fdPath);
  const partialFault = (
    (__pdeTestFaults.has("hard_exit_partial_apply_lock_candidate") && base.startsWith("apply.lock.candidate-"))
    || (__pdeTestFaults.has("hard_exit_partial_owner_temp") && base.startsWith(".project-gov-owner.json.tmp-"))
    || (__pdeTestFaults.has("hard_exit_partial_journal_temp") && base.startsWith("backup-manifest.json.tmp-"))
    || (
      __pdeTestFaults.has("hard_exit_partial_target_temp")
      && __pdeTestTarget
      && fdPath.startsWith(__pdeTestTarget + ".tmp-project-gov-")
    )
  );
  if (partialFault) {
    const available = Number.isInteger(length) ? length : Buffer.byteLength(buffer);
    __pdeTestOriginal.writeSync(fd, buffer, Number.isInteger(offset) ? offset : 0, Math.min(17, available), position);
    process.exit(91);
  }
  return __pdeTestOriginal.writeSync(fd, buffer, offset, length, position);
};
fs.lstatSync = function __pdeTestLstat(target, ...args) {
  const stack = String(new Error().stack || "");
  if (
    __pdeTestFaults.has("postwrite_epoch_drift")
    && !__pdeTestState.postwriteEpochDrifted
    && __pdeTestState.targetWriteCount > 0
    && !__pdeTestState.rollbackRestored
    && __pdeTestSame(target, __pdeTestNonTarget)
    && stack.includes("context.seal")
  ) {
    __pdeTestState.postwriteEpochDrifted = true;
    __pdeTestMutateNonTarget();
  }
  return __pdeTestOriginal.lstatSync(target, ...args);
};
fs.readFileSync = function __pdeTestReadFile(target, ...args) {
  if (
    __pdeTestFaults.has("forbid_path_transaction_metadata_read")
    && __pdeTestTransactionMetadataPath(target)
  ) throw __pdeTestError("EIO", "pde_test_path_transaction_metadata_read_forbidden");
  __pdeTestMaybeReadFailure(target);
  return __pdeTestOriginal.readFileSync(target, ...args);
};
fs.readdirSync = function __pdeTestReaddir(target, ...args) {
  if (
    __pdeTestFaults.has("forbid_unbounded_transaction_readdir")
    && __pdeTestBackupSource(target)
    && path.basename(String(target)).startsWith("txn-")
  ) throw __pdeTestError("EIO", "pde_test_unbounded_transaction_readdir_forbidden");
  return __pdeTestOriginal.readdirSync(target, ...args);
};
fs.unlinkSync = function __pdeTestUnlink(target, ...args) {
  const result = __pdeTestOriginal.unlinkSync(target, ...args);
  __pdeTestDurabilityEvent({ op: "unlink", path: target });
  return result;
};
fs.rmSync = function __pdeTestRm(target, ...args) {
  const normalized = String(target).replaceAll("\\", "/");
  if (
    __pdeTestFaults.has("backup_cleanup_failure")
    && !__pdeTestState.backupCleanupFailed
    && normalized.includes("/.project-gov/backups/")
  ) {
    __pdeTestState.backupCleanupFailed = true;
    throw __pdeTestError("EBUSY", "pde_test_backup_cleanup_failure");
  }
  return __pdeTestOriginal.rmSync(target, ...args);
};
`;
  const injected = source.replace(anchor, `${anchor}${prelude}`);
  const target = path.join(sandbox, "injected-script", "project-gov.mjs");
  write(sandbox, "injected-script/project-gov.mjs", injected);
  return target;
}

function readTrace(trace) {
  if (!fs.existsSync(trace)) return [];
  return fs.readFileSync(trace, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).path);
}

function readEventTrace(trace) {
  if (!fs.existsSync(trace)) return [];
  return fs.readFileSync(trace, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function crashApply(compiledPlan, env) {
  return spawnSync(process.execPath, [injectedScript, "apply", "--plan", compiledPlan, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function transactionBackupRoots(root) {
  const base = path.join(root, ".project-gov", "backups");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((name) => name.startsWith("txn-"))
    .map((name) => path.join(base, name));
}

function onlyTransactionBackupRoot(root, label) {
  const roots = transactionBackupRoots(root);
  assert.equal(roots.length, 1, `${label}: expected one transaction backup, observed ${roots.length}`);
  return roots[0];
}

function readApplyLock(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".project-gov", "apply.lock"), "utf8"));
}

function spawnCapture(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve(parseChildResult({ status, stdout, stderr })));
  });
}

async function waitForFile(abs, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(abs)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${abs}`);
}

function testSchema5ContractGate() {
  const root = createProject("schema5-contract-gate");
  const prepared = propose(root, "schema5-contract-gate", [replaceStatus("schema-five")]);
  assertProposed(prepared, "schema5 contract propose");
  const compiled = JSON.parse(fs.readFileSync(prepared.out, "utf8"));
  assert.equal(
    compiled.compiled_schema_version,
    5,
    `v0.3.8 transaction tests require compiled schema 5; observed ${compiled.compiled_schema_version}`,
  );
  assert.equal(
    compiled.operation_schema_version,
    2,
    "schema5 compiled plan must bind operation_schema_version=2",
  );
  assert.equal(
    compiled.project_structure_version,
    2,
    "schema5 compiled plan must bind project_structure_version=2",
  );
  assert.equal(
    compiled.decision_policy_version,
    2,
    "schema5 compiled plan must bind decision_policy_version=2",
  );
  assert.deepEqual(Object.keys(compiled).sort(), COMPILED_PLAN_FIELDS, "compiled plan top-level schema drifted");
}

function testTargetSetInvariantAndLR27() {
  const root = createProject("target-set-invariant");
  const actions = [
    replaceStatus("stage-one"),
    {
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: "| transaction | stage-one | fixture |",
      replacement: "| transaction | final-one | fixture |",
    },
    replaceTodo("final-two"),
  ];
  const prepared = propose(root, "target-set-invariant", actions);
  assertProposed(prepared, "target-set invariant propose");
  const compiled = JSON.parse(fs.readFileSync(prepared.out, "utf8"));
  const touched = [...new Set(actions.map((action) => action.path))].sort();
  assert.deepEqual(sortedKeys(compiled.before_fingerprints), touched, "T != before fingerprints");
  assert.deepEqual(sortedKeys(compiled.predicted_target_fingerprints), touched, "T != predicted fingerprints");

  const trace = path.join(root, "prepared-write-trace.jsonl");
  const absoluteTargets = touched.map((rel) => path.join(root, rel));
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, { trace, traceTargets: absoluteTargets }),
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.json.ok, true, applied.stdout);

  const traced = readTrace(trace).map((abs) => path.relative(root, abs).replaceAll("\\", "/"));
  assert.deepEqual([...new Set(traced)].sort(), touched, "T != executed PreparedWrite targets");
  assert.equal(traced.length, touched.length, "multiple actions on one path must execute one final PreparedWrite");
  for (const rel of touched) {
    assert.deepEqual(
      fingerprint(path.join(root, rel)),
      compiled.predicted_target_fingerprints[rel],
      `T != actual fingerprint for ${rel}`,
    );
  }
  assert.match(fs.readFileSync(path.join(root, "STATUS.md"), "utf8"), /final-one/);
}

function testBeforeFirstWriteBackupAndDriftGates() {
  {
    const root = createProject("backup-copy-verification-gate");
    const target = path.join(root, "STATUS.md");
    const before = fingerprint(target);
    const prepared = propose(root, "backup-copy-verification-gate", [replaceStatus("must-not-write")]);
    assertProposed(prepared, "backup-copy verification propose");
    const trace = path.join(root, "backup-copy-write-trace.jsonl");
    const applied = apply(prepared.out, {
      script: injectedScript,
      env: faultEnv(root, {
        faults: ["backup_copy_corruption"],
        target,
        trace,
        traceTargets: [target],
      }),
    });
    assertRejected(applied, "backup-copy verification gate");
    assert.match(jsonText(applied.json), /backup_copy_verification_failed:STATUS\.md/);
    assert.equal(applied.json.rollback_attempted, false, "backup corruption happened before first write");
    assert.equal(applied.json.backup_cleanup?.ok, true, "failed backup must be cleaned before first write");
    assert.deepEqual(readTrace(trace), [], "backup-copy failure must not perform the first target write");
    assert.deepEqual(fingerprint(target), before, "backup-copy failure changed the target");
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);
    assert.equal(fs.existsSync(prepared.out), true, "compiled plan must remain after backup-copy rejection");
  }

  {
    const root = createProject("locked-before-write-drift-gate");
    const target = path.join(root, "STATUS.md");
    const before = fingerprint(target);
    const prepared = propose(root, "locked-before-write-drift-gate", [replaceStatus("must-not-write")]);
    assertProposed(prepared, "locked-before-write drift propose");
    const trace = path.join(root, "locked-before-write-trace.jsonl");
    const applied = apply(prepared.out, {
      script: injectedScript,
      env: faultEnv(root, {
        faults: ["target_drift_after_backup"],
        target,
        trace,
        traceTargets: [target],
      }),
    });
    assertRejected(applied, "locked-before-write drift gate");
    assert.match(jsonText(applied.json), /locked_before_write_target_drift:STATUS\.md/);
    assert.equal(applied.json.rollback_attempted, false, "locked-before-write drift happened before first write");
    assert.equal(applied.json.backup_cleanup?.ok, true, "pre-write drift backup must be cleaned");
    assert.deepEqual(readTrace(trace), [], "locked-before-write drift must not perform the first target write");
    assert.notDeepEqual(fingerprint(target), before, "fault injection did not create target drift");
    assert.match(fs.readFileSync(target, "utf8"), /baselinx/);
    assert.doesNotMatch(fs.readFileSync(target, "utf8"), /must-not-write/);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);
    assert.equal(fs.existsSync(prepared.out), true, "compiled plan must remain after locked-before-write rejection");
  }
}

function runPostwriteMismatchCase(name, fault, differingField) {
  const root = createProject(name);
  const target = path.join(root, "STATUS.md");
  const before = fingerprint(target);
  const prepared = propose(root, name, [replaceStatus("final-A")]);
  assertProposed(prepared, `${name} propose`);
  const predicted = JSON.parse(fs.readFileSync(prepared.out, "utf8")).predicted_target_fingerprints["STATUS.md"];
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, { faults: [fault], target }),
  });
  assertRollbackIncomplete(applied, name);
  assert.match(jsonText(applied.json), /postwrite_target_mismatch|atomic_target_kind_changed_after_rename/);
  assert.match(jsonText(applied.json), new RegExp(differingField));
  assert.match(jsonText(applied.json), /rollback_target_third_party_state/);
  assert.notDeepEqual(fingerprint(target), before, `${name}: unknown state was overwritten with the baseline`);
  assert.notDeepEqual(fingerprint(target), predicted, `${name}: fixture did not create a third-party state`);
  assert.ok((applied.json.backups_retained || []).length > 0, `${name}: recovery backup was not retained`);
  assert.equal(fs.existsSync(prepared.out), true, `${name}: compiled plan was not retained`);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true, `${name}: transaction fence was not retained`);
}

function testLR24LR25LR26LR28LR37() {
  // LR24 + LR37: same-size harmless content drift keeps project decision facts stable but must fail target SHA.
  runPostwriteMismatchCase("lr24-lr37-sha-mismatch", "sha_mismatch", "sha256");
  runPostwriteMismatchCase("lr25-bytes-mismatch", "bytes_mismatch", "bytes");
  runPostwriteMismatchCase("lr26-kind-mismatch", "kind_mismatch", "kind");

  const root = createProject("lr28-postwrite-read-failure");
  const target = path.join(root, "STATUS.md");
  const before = fingerprint(target);
  const prepared = propose(root, "lr28-postwrite-read-failure", [replaceStatus("read-failure")]);
  assertProposed(prepared, "LR28 propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, { faults: ["postwrite_read_failure"], target }),
  });
  assertRollbackComplete(applied, "LR28");
  assert.match(jsonText(applied.json), /postwrite_(?:target_mismatch|verification_failed)/);
  assert.deepEqual(fingerprint(target), before);
}

function multiTargetFailureFixture(name, faults, options = {}) {
  const root = createProject(name);
  const first = path.join(root, "STATUS.md");
  const second = path.join(root, "TODO.md");
  const nonTarget = path.join(root, "AGENTS.md");
  const before = {
    "STATUS.md": fingerprint(first),
    "TODO.md": fingerprint(second),
  };
  const prepared = propose(root, name, [replaceStatus("first-written"), replaceTodo("second-written")]);
  assertProposed(prepared, `${name} propose`);
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults,
      target: first,
      secondTarget: second,
      nonTarget,
    }),
  });
  return { root, first, second, nonTarget, before, prepared, applied, ...options };
}

function testLR29VerifiedMultiTargetRollback() {
  const fixture = multiTargetFailureFixture("lr29-multi-target-rollback", ["second_write_failure"]);
  assertRollbackComplete(fixture.applied, "LR29");
  assert.deepEqual(fingerprint(fixture.first), fixture.before["STATUS.md"]);
  assert.deepEqual(fingerprint(fixture.second), fixture.before["TODO.md"]);
  assertRollbackBaselineRestored(fixture.applied, "LR29");
}

function testImmediateRollbackRefusesThirdPartyStateWithoutTouchingAnyTarget() {
  const root = createProject("immediate-rollback-third-party-state");
  const first = path.join(root, "STATUS.md");
  const second = path.join(root, "TODO.md");
  const nonTarget = path.join(root, "AGENTS.md");
  const beforeSecond = fingerprint(second);
  const beforeNonTarget = fingerprint(nonTarget);
  const prepared = propose(root, "immediate-rollback-third-party-state", [
    replaceStatus("first-written"),
    replaceTodo("second-written"),
  ]);
  assertProposed(prepared, "immediate rollback third-party propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults: ["second_write_failure", "third_party_target_before_rollback"],
      target: first,
      secondTarget: second,
      nonTarget,
    }),
  });
  assertRollbackIncomplete(applied, "immediate rollback third-party state");
  assert.match(jsonText(applied.json), /rollback_target_third_party_state/);
  assert.equal(fs.readFileSync(first, "utf8"), "third-party-state-must-survive\n", "third-party target was overwritten");
  assert.deepEqual(fingerprint(second), beforeSecond, "a different touched target was modified during refused rollback");
  assert.deepEqual(fingerprint(nonTarget), beforeNonTarget, "non-target changed during refused rollback");
  assert.ok((applied.json.backups_retained || []).length > 0, "recovery backup was not retained");
  assert.equal(fs.existsSync(prepared.out), true, "compiled plan was not retained");
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true, "transaction fence was not retained");
}

function testPerTargetPrewriteGatePreservesLateExternalChange() {
  const root = createProject("per-target-prewrite-gate");
  const first = path.join(root, "STATUS.md");
  const second = path.join(root, "TODO.md");
  const trace = path.join(root, "prewrite-target-writes.jsonl");
  const prepared = propose(root, "per-target-prewrite-gate", [
    replaceStatus("first-written"),
    replaceTodo("second-written"),
  ]);
  assertProposed(prepared, "per-target prewrite gate propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults: ["second_target_drift_after_first_write"],
      target: first,
      secondTarget: second,
      trace,
      traceTargets: [first, second],
    }),
  });
  assertRollbackIncomplete(applied, "per-target prewrite gate");
  assert.equal(applied.json.ok, false, "late drift was reported as a successful commit");
  assert.match(applied.json.error, /prewrite_target_drift:TODO\.md/);
  assert.match(jsonText(applied.json), /rollback_target_third_party_state/);
  assert.match(fs.readFileSync(first, "utf8"), /first-written/, "first tool-owned write did not remain fenced as predicted state");
  assert.match(fs.readFileSync(second, "utf8"), /external-change/, "late external content was overwritten");
  assert.doesNotMatch(fs.readFileSync(second, "utf8"), /second-written/, "second target was written after its prewrite gate failed");
  assert.deepEqual(readTrace(trace), [path.resolve(first)], "a target write occurred after the late-drift gate failed");
  assert.ok((applied.json.backups_retained || []).length > 0, "recovery backup was not retained");
  assert.equal(fs.existsSync(prepared.out), true, "compiled plan was not retained");
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true, "transaction fence was not retained");
  assert.notEqual(applied.json.transaction_verification?.rollback?.complete, true, "partial physical state was claimed as committed or fully rolled back");
}

function testLR30AbsentAndCreatedDirectoryRollback() {
  const root = createProject("lr30-absent-created-directory");
  const directory = path.join(root, "历史记录", "transaction-created");
  const createdFile = path.join(directory, "new.md");
  const second = path.join(root, "TODO.md");
  const prepared = propose(root, "lr30-absent-created-directory", [
    { kind: "mkdir", path: "历史记录/transaction-created" },
    {
      kind: "write_file",
      path: "历史记录/transaction-created/new.md",
      content: "# transaction-created\n",
      overwrite: false,
    },
    replaceTodo("second-written"),
  ]);
  assertProposed(prepared, "LR30 propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, { faults: ["second_write_failure"], secondTarget: second }),
  });
  assertRollbackComplete(applied, "LR30");
  assert.equal(fs.existsSync(createdFile), false, "LR30 absent file was not restored to absent");
  assert.equal(fs.existsSync(directory), false, "LR30 transaction-created directory was not removed");
  assertRollbackBaselineRestored(applied, "LR30");
}

function testLR31AndLR33RollbackIncomplete() {
  const fixture = multiTargetFailureFixture(
    "lr31-lr33-restore-failure",
    ["second_write_failure", "restore_failure"],
  );
  assertRollbackIncomplete(fixture.applied, "LR31/LR33");
  assert.match(jsonText(fixture.applied.json), /STATUS\.md/);
  assert.ok((fixture.applied.json.backups_retained || []).length > 0, "LR31 backup must be retained");
  assert.equal(fs.existsSync(fixture.prepared.out), true, "LR31 compiled plan must be retained");
  assert.equal(fixture.applied.json.lock_cleanup?.ok, true, "LR33 retained lock state must be explicit");
  assert.equal(fixture.applied.json.lock_cleanup?.released, false);
  assert.equal(fixture.applied.json.lock_cleanup?.method, "retained_for_interrupted_recovery");
  assert.equal(fs.existsSync(path.join(fixture.root, ".project-gov", "apply.lock")), true);
}

function testLR32BaselineDigestDrift() {
  const fixture = multiTargetFailureFixture(
    "lr32-rollback-baseline-drift",
    ["second_write_failure", "baseline_drift_on_restore"],
  );
  assertRollbackIncomplete(fixture.applied, "LR32");
  assert.deepEqual(fingerprint(fixture.first), fixture.before["STATUS.md"], "LR32 target restored");
  assert.deepEqual(fingerprint(fixture.second), fixture.before["TODO.md"], "LR32 second target restored");
  assert.match(jsonText(fixture.applied.json), /baseline_(?:digest_)?(?:drift|mismatch)/);
  assert.ok((fixture.applied.json.backups_retained || []).length > 0);
}

function testLR34BackupCleanupFailureIsIndependent() {
  const fixture = multiTargetFailureFixture(
    "lr34-backup-cleanup-failure",
    ["second_write_failure", "backup_cleanup_failure"],
  );
  assertRollbackComplete(fixture.applied, "LR34");
  assert.equal(fixture.applied.json.backup_cleanup?.ok, false);
  assert.match(jsonText(fixture.applied.json), /backup_cleanup|transaction_backup/);
}

function testLR35OversizedTargetRestoration() {
  const root = createProject("lr35-oversized-restoration");
  const target = path.join(root, "STATUS.md");
  const second = path.join(root, "TODO.md");
  const oversized = Buffer.from(`${statusText()}\n${"x".repeat((2 * 1024 * 1024) + 64)}\n`, "utf8");
  fs.writeFileSync(target, oversized);
  const before = fingerprint(target);
  const prepared = propose(root, "lr35-oversized-restoration", [
    {
      kind: "write_file",
      path: "STATUS.md",
      content: statusText("shrunk"),
      overwrite: true,
    },
    replaceTodo("second-written"),
  ]);
  assertProposed(prepared, "LR35 oversized shrink propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults: ["second_write_failure"],
      target,
      secondTarget: second,
    }),
  });
  assertRollbackComplete(applied, "LR35");
  assert.deepEqual(fingerprint(target), before, "LR35 oversized file bytes/SHA were not restored");
  assertRollbackBaselineRestored(applied, "LR35");
}

function testLR36ActualTransitionFailureAfterTargetMatch() {
  const root = createProject("lr36-actual-transition-failure");
  const target = path.join(root, "STATUS.md");
  const nonTarget = path.join(root, "AGENTS.md");
  const beforeTarget = fingerprint(target);
  const beforeNonTarget = fingerprint(nonTarget);
  const prepared = propose(root, "lr36-actual-transition-failure", [replaceStatus("target-matches")]);
  assertProposed(prepared, "LR36 propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults: ["actual_transition_failure"],
      target,
      nonTarget,
    }),
  });
  assertRollbackComplete(applied, "LR36");
  assert.doesNotMatch(jsonText(applied.json), /postwrite_target_mismatch/);
  assert.match(jsonText(applied.json), /transition|unresolved_references/);
  assert.deepEqual(fingerprint(target), beforeTarget);
  assert.deepEqual(fingerprint(nonTarget), beforeNonTarget);
}

function testPostwriteInspectionEpochSealRejectsNonTargetDrift() {
  const root = createProject("postwrite-inspection-epoch-drift");
  const target = path.join(root, "STATUS.md");
  const nonTarget = path.join(root, "AGENTS.md");
  const beforeTarget = fingerprint(target);
  const beforeNonTarget = fingerprint(nonTarget);
  const prepared = propose(root, "postwrite-inspection-epoch-drift", [replaceStatus("epoch-seal")]);
  assertProposed(prepared, "postwrite Inspection Epoch propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, {
      faults: ["postwrite_epoch_drift"],
      target,
      nonTarget,
    }),
  });
  assertRejected(applied, "postwrite Inspection Epoch seal");
  assert.match(jsonText(applied.json), /inspection_epoch_drift/);
  assert.equal(applied.json.rollback_attempted, true);
  assert.deepEqual(fingerprint(target), beforeTarget, "owned target must be restored after epoch drift");
  assert.notDeepEqual(fingerprint(nonTarget), beforeNonTarget, "fault injection did not drift the non-target");
  assert.notEqual(applied.json.rollback_complete, true, "external non-target drift cannot be claimed as a complete rollback");
  assert.equal(fs.existsSync(prepared.out), true, "failed epoch seal must retain the compiled plan");
}

function testLR38RollbackVerificationReadFailure() {
  const fixture = multiTargetFailureFixture(
    "lr38-rollback-verification-read-failure",
    ["second_write_failure", "rollback_verification_read_failure"],
  );
  assertRollbackIncomplete(fixture.applied, "LR38");
  assert.match(jsonText(fixture.applied.json), /rollback.*(?:read|verification)|pde_test_rollback_verification_read_failure/);
  assert.ok((fixture.applied.json.backups_retained || []).length > 0);
  assert.equal(fs.existsSync(fixture.prepared.out), true);
  assert.equal(fs.existsSync(path.join(fixture.root, ".project-gov", "apply.lock")), true);
  assert.equal(fixture.applied.json.lock_cleanup?.released, false);
  assert.equal(fixture.applied.json.lock_cleanup?.method, "retained_for_interrupted_recovery");
  assert.equal(fixture.applied.json.validation, null, "LR38 unavailable rollback validation must stay structured");
}

function testHardExitRecoveryBeforeRetry() {
  const root = createProject("hard-exit-recovery-before-retry");
  const first = path.join(root, "STATUS.md");
  const second = path.join(root, "TODO.md");
  const prepared = propose(root, "hard-exit-recovery-before-retry", [
    replaceStatus("first-written"),
    replaceTodo("second-written"),
  ]);
  assertProposed(prepared, "hard-exit recovery propose");

  const crashed = spawnSync(
    process.execPath,
    [injectedScript, "apply", "--plan", prepared.out, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...faultEnv(root, { faults: ["hard_exit_after_first_target"], target: first }),
      },
    },
  );
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  assert.match(fs.readFileSync(first, "utf8"), /first-written/);
  assert.match(fs.readFileSync(second, "utf8"), /baseline/);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);

  const retried = apply(prepared.out);
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  assert.equal(retried.json.ok, true, retried.stdout);
  assert.equal(retried.json.interrupted_recovery?.recovered, true, retried.stdout);
  assert.equal(retried.json.interrupted_recovery?.terminal_state, "rollback_verified", retried.stdout);
  assert.match(fs.readFileSync(first, "utf8"), /first-written/);
  assert.match(fs.readFileSync(second, "utf8"), /second-written/);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);
  assert.equal(fs.existsSync(prepared.out), false);
}

function testHardExitRecoveryRemovesCreatedDirectories() {
  const root = createProject("hard-exit-created-directory-recovery");
  const createdDirectory = path.join(root, "历史记录", "hard-exit-created");
  const createdFile = path.join(createdDirectory, "new.md");
  const crashPlan = propose(root, "hard-exit-created-directory", [{
    kind: "write_file",
    path: "历史记录/hard-exit-created/new.md",
    content: "# interrupted\n",
    overwrite: false,
  }]);
  const probePlan = propose(root, "hard-exit-recovery-probe", [replaceStatus("probe-applied")]);
  assertProposed(crashPlan, "created-directory crash propose");
  assertProposed(probePlan, "created-directory probe propose");

  const crashed = spawnSync(
    process.execPath,
    [injectedScript, "apply", "--plan", crashPlan.out, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...faultEnv(root, { faults: ["hard_exit_after_first_target"], target: createdFile }),
      },
    },
  );
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  assert.equal(fs.existsSync(createdFile), true);

  const recovered = apply(probePlan.out);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(recovered.json.interrupted_recovery?.recovered, true, recovered.stdout);
  assert.equal(fs.existsSync(createdFile), false, "interrupted target must return to absent");
  assert.equal(fs.existsSync(createdDirectory), false, "transaction-created directory must be removed");
  assert.match(fs.readFileSync(path.join(root, "STATUS.md"), "utf8"), /probe-applied/);
}

function testCommitVerifiedHardExitIsNotRolledBack() {
  const root = createProject("commit-verified-hard-exit");
  const target = path.join(root, "STATUS.md");
  const prepared = propose(root, "commit-verified-hard-exit", [replaceStatus("committed")]);
  assertProposed(prepared, "commit-verified crash propose");

  const crashed = spawnSync(
    process.execPath,
    [injectedScript, "apply", "--plan", prepared.out, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...faultEnv(root, { faults: ["hard_exit_after_commit_verified"], target }),
      },
    },
  );
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  assert.match(fs.readFileSync(target, "utf8"), /committed/);
  const backupRoot = onlyTransactionBackupRoot(root, "commit-verified terminal recovery");
  const backup = path.join(backupRoot, "STATUS.md");
  fs.unlinkSync(backup);
  fs.symlinkSync(target, backup, "file");
  assert.equal(fs.lstatSync(backup).isSymbolicLink(), true, "terminal-state adversarial backup was not installed");

  const retried = apply(prepared.out);
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  assert.equal(retried.json.ok, true, retried.stdout);
  assert.equal(retried.json.already_applied, true, retried.stdout);
  assert.equal(retried.json.interrupted_recovery?.terminal_state, "commit_verified", retried.stdout);
  assert.match(fs.readFileSync(target, "utf8"), /committed/);
  assert.equal(fs.existsSync(backupRoot), false, "terminal transaction backup should be cleaned independently");
  assert.equal(fs.existsSync(prepared.out), false);
}

function testHardExitRecoveryRefusesThirdPartyDrift() {
  const root = createProject("hard-exit-third-party-drift");
  const target = path.join(root, "STATUS.md");
  const prepared = propose(root, "hard-exit-third-party-drift", [replaceStatus("interrupted")]);
  assertProposed(prepared, "third-party drift propose");
  const crashed = spawnSync(
    process.execPath,
    [injectedScript, "apply", "--plan", prepared.out, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...faultEnv(root, { faults: ["hard_exit_after_first_target"], target }),
      },
    },
  );
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  fs.writeFileSync(target, statusText("external-change"), "utf8");
  const beforeRetry = fingerprint(target);

  const rejected = apply(prepared.out);
  assertRejected(rejected, "third-party drift recovery");
  assert.match(jsonText(rejected.json), /stale_transaction_target_drift|interrupted_transaction_target_drift/);
  assert.deepEqual(fingerprint(target), beforeRetry, "recovery must not overwrite a third-party edit");
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), true);
  assert.equal(fs.existsSync(prepared.out), true);
}

function testDurableNoClobberLockPublicationCrashEdges() {
  {
    const root = createProject("partial-lock-candidate");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "partial-lock-candidate", [replaceStatus("candidate-recovered")]);
    assertProposed(prepared, "partial lock candidate propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_apply_lock_candidate"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    assert.equal(
      fs.existsSync(path.join(root, ".project-gov", "apply.lock")),
      false,
      "a partial candidate must never become the canonical lock",
    );
    assert.match(fs.readFileSync(target, "utf8"), /baseline/);

    const retried = apply(prepared.out);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.match(fs.readFileSync(target, "utf8"), /candidate-recovered/);
  }

  {
    const root = createProject("published-lock-crash");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "published-lock-crash", [replaceStatus("published-recovered")]);
    assertProposed(prepared, "published lock crash propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_apply_lock_publish"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    const lock = readApplyLock(root);
    assert.match(lock.owner_id, /^[0-9a-f-]{36}$/i);
    assert.equal(lock.phase_state, `apply.lock.state-${lock.owner_id}`);
    assert.equal(transactionBackupRoots(root).length, 0, "crash at lock publish must precede backup creation");

    const retried = apply(prepared.out);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(retried.json.interrupted_recovery?.terminal_state, "no_transaction_backup");
    assert.match(fs.readFileSync(target, "utf8"), /published-recovered/);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false);
  }
}

function testAcquiredPhaseDoesNotClaimPreexistingBackupRoot() {
  const root = createProject("acquired-phase-preexisting-backup");
  const target = path.join(root, "STATUS.md");
  const prepared = propose(root, "acquired-phase-preexisting-backup", [replaceStatus("must-not-apply")]);
  assertProposed(prepared, "acquired phase preexisting backup propose");
  const crashed = crashApply(prepared.out, faultEnv(root, {
    faults: ["hard_exit_after_apply_lock_publish"],
    target,
  }));
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  const lock = readApplyLock(root);
  const preexisting = path.join(root, ".project-gov", "backups", `txn-${lock.owner_id}`);
  fs.mkdirSync(preexisting, { recursive: true });

  const rejected = apply(prepared.out);
  assertRejected(rejected, "acquired phase preexisting backup root");
  assert.match(jsonText(rejected.json), /stale_transaction_backup_occupied_before_backup_start/);
  assert.equal(fs.existsSync(preexisting), true, "unowned exact-path directory must not be claimed or deleted");
  assert.equal(fs.readdirSync(preexisting).length, 0, "recovery must not add an owner marker to an unowned directory");
  assert.match(fs.readFileSync(target, "utf8"), /baseline/);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
}

function testPartialTransactionTempsAndQuarantineRecovery() {
  {
    const root = createProject("partial-owner-temp-quarantine");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "partial-owner-temp-quarantine", [replaceStatus("owner-recovered")]);
    assertProposed(prepared, "partial owner temp propose");
    const firstCrash = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_owner_temp"],
      target,
    }));
    assert.equal(firstCrash.status, 91, firstCrash.stderr || firstCrash.stdout);
    const backupRoot = onlyTransactionBackupRoot(root, "partial owner temp");
    const ownerTemp = path.join(
      backupRoot,
      fs.readdirSync(backupRoot).find((name) => name.startsWith(".project-gov-owner.json.tmp-")),
    );
    assert.ok(fs.statSync(ownerTemp).size > 0 && fs.statSync(ownerTemp).size <= 17);

    const cleanupCrash = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_metadata_quarantine"],
      target,
    }));
    assert.equal(cleanupCrash.status, 91, cleanupCrash.stderr || cleanupCrash.stdout);
    assert.equal(fs.existsSync(`${ownerTemp}.cleanup`), true, "metadata cleanup quarantine was not published");

    const retried = apply(prepared.out);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(retried.json.interrupted_recovery?.terminal_state, "preparing_no_journal");
    assert.match(fs.readFileSync(target, "utf8"), /owner-recovered/);
  }

  {
    const root = createProject("partial-journal-temp");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "partial-journal-temp", [replaceStatus("journal-recovered")]);
    assertProposed(prepared, "partial journal temp propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_journal_temp"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    const retried = apply(prepared.out);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(retried.json.interrupted_recovery?.terminal_state, "preparing_no_journal");
    assert.match(fs.readFileSync(target, "utf8"), /journal-recovered/);
  }

  {
    const root = createProject("partial-target-temp-quarantine");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "partial-target-temp-quarantine", [replaceStatus("target-recovered")]);
    assertProposed(prepared, "partial target temp propose");
    const firstCrash = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_target_temp"],
      target,
    }));
    assert.equal(firstCrash.status, 91, firstCrash.stderr || firstCrash.stdout);
    const lock = readApplyLock(root);
    const temp = `${target}.tmp-project-gov-${lock.owner_id}`;
    assert.equal(fs.existsSync(temp), true);

    const cleanupCrash = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_target_temp_quarantine"],
      target,
    }));
    assert.equal(cleanupCrash.status, 91, cleanupCrash.stderr || cleanupCrash.stdout);
    assert.equal(fs.existsSync(temp), false);
    assert.equal(fs.existsSync(`${temp}.quarantine`), true);

    const retried = apply(prepared.out);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(retried.json.interrupted_recovery?.terminal_state, "rollback_verified");
    assert.match(fs.readFileSync(target, "utf8"), /target-recovered/);
    assert.equal(fs.existsSync(`${temp}.quarantine`), false);
  }

  {
    const root = createProject("target-temp-identity-race");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "target-temp-identity-race", [replaceStatus("must-not-apply")]);
    assertProposed(prepared, "target temp identity race propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_target_temp"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    const lock = readApplyLock(root);
    const temp = `${target}.tmp-project-gov-${lock.owner_id}`;
    const raced = apply(prepared.out, {
      script: injectedScript,
      env: faultEnv(root, { faults: ["replace_target_temp_before_quarantine"], target }),
    });
    assertRejected(raced, "target temp cleanup identity race");
    assert.match(jsonText(raced.json), /identity_changed|rollback_incomplete/);
    const retained = [temp, `${temp}.quarantine`]
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => fs.readFileSync(candidate, "utf8"));
    assert.ok(retained.includes("third-party-replacement\n"), "replacement object must be quarantined, not deleted");
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
  }
}

function testDirectoryIntentAndIdentityCrashRecovery() {
  {
    const root = createProject("directory-intent-crash");
    const directory = path.join(root, "历史记录", "intent-crash");
    const target = path.join(directory, "new.md");
    const prepared = propose(root, "directory-intent-crash", [{
      kind: "write_file",
      path: "历史记录/intent-crash/new.md",
      content: "# intent crash\n",
      overwrite: false,
    }]);
    assertProposed(prepared, "directory intent crash propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_directory_mkdir"],
      directory,
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.existsSync(target), false);

    const rejected = apply(prepared.out);
    assertRejected(rejected, "directory mkdir-before-identity recovery");
    assert.match(jsonText(rejected.json), /intent_directory_exists|directory_creation_ambiguous/);
    assert.equal(fs.existsSync(directory), true, "ambiguous directory must not be removed");
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
  }

  {
    const root = createProject("directory-identity-replacement");
    const directory = path.join(root, "历史记录", "identity-replacement");
    const target = path.join(directory, "new.md");
    const prepared = propose(root, "directory-identity-replacement", [{
      kind: "write_file",
      path: "历史记录/identity-replacement/new.md",
      content: "# identity replacement\n",
      overwrite: false,
    }]);
    assertProposed(prepared, "directory identity replacement propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_directory_identity_journal"],
      directory,
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.existsSync(target), false);
    fs.renameSync(directory, `${directory}.original-object`);
    fs.mkdirSync(directory);

    const rejected = apply(prepared.out);
    assertRejected(rejected, "directory identity replacement recovery");
    assert.match(jsonText(rejected.json), /created_directory_identity_changed|directory_creation_ambiguous/);
    assert.equal(fs.existsSync(directory), true, "replacement directory must not be deleted");
    assert.equal(fs.existsSync(`${directory}.original-object`), true);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
  }
}

function testBackupStartedMissingBackupRetainsFence() {
  const root = createProject("backup-started-missing-backup");
  const target = path.join(root, "STATUS.md");
  const prepared = propose(root, "backup-started-missing-backup", [replaceStatus("interrupted")]);
  assertProposed(prepared, "backup-started missing backup propose");
  const crashed = crashApply(prepared.out, faultEnv(root, {
    faults: ["hard_exit_after_first_target"],
    target,
  }));
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  const lock = readApplyLock(root);
  const phase = JSON.parse(fs.readFileSync(path.join(root, ".project-gov", lock.phase_state), "utf8"));
  assert.equal(phase.phase, "backup_started");
  const backupRoot = onlyTransactionBackupRoot(root, "backup-started missing backup");
  fs.rmSync(backupRoot, { recursive: true, force: false });

  const rejected = apply(prepared.out);
  assertRejected(rejected, "backup-started missing backup recovery");
  assert.match(jsonText(rejected.json), /stale_transaction_backup_missing_after_backup_start/);
  assert.match(fs.readFileSync(target, "utf8"), /interrupted/);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
}

function testLockMetadataPathBindingRejectsTraversal() {
  for (const [name, ownerId, phaseState] of [
    ["invalid-owner-id", "../../escape-owned", "apply.lock.state-../../escape-owned"],
    ["invalid-phase-binding", crypto.randomUUID(), "../../escape-owned"],
  ]) {
    const root = createProject(`lock-binding-${name}`);
    const target = path.join(root, "STATUS.md");
    const escape = path.join(root, "escape-owned");
    write(root, "escape-owned/sentinel.txt", "third-party\n");
    const prepared = propose(root, `lock-binding-${name}`, [replaceStatus("must-not-apply")]);
    assertProposed(prepared, `lock binding ${name} propose`);
    const lockPath = path.join(root, ".project-gov", "apply.lock");
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: 2,
      tool: "project-gov",
      kind: "apply_lock",
      owner_id: ownerId,
      pid: 2147483647,
      plan_id: `lock-binding-${name}`,
      created_at: new Date().toISOString(),
      phase_state: phaseState,
    }, null, 2)}\n`, "utf8");

    const rejected = apply(prepared.out);
    assertRejected(rejected, `lock binding ${name}`);
    assert.match(jsonText(rejected.json), /Existing lock metadata is invalid|Existing lock cannot be validated/);
    assert.equal(fs.readFileSync(path.join(escape, "sentinel.txt"), "utf8"), "third-party\n");
    assert.equal(fs.readdirSync(escape).length, 1, "invalid binding must perform zero cleanup outside its namespace");
    assert.match(fs.readFileSync(target, "utf8"), /baseline/);
    assert.equal(fs.existsSync(lockPath), true);
  }
}

function testDurableDirectoryAndLockFlushOrdering() {
  const root = createProject("durability-ordering");
  const firstDirectory = path.join(root, "历史记录", "durability-chain");
  const secondDirectory = path.join(firstDirectory, "leaf");
  const target = path.join(secondDirectory, "new.md");
  const trace = path.join(root, "durability-events.jsonl");
  const prepared = propose(root, "durability-ordering", [{
    kind: "write_file",
    path: "历史记录/durability-chain/leaf/new.md",
    content: "# durable\n",
    overwrite: false,
  }]);
  assertProposed(prepared, "durability ordering propose");
  const applied = apply(prepared.out, {
    script: injectedScript,
    env: faultEnv(root, { durabilityTrace: trace, target }),
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const events = readEventTrace(trace);
  const findAfter = (start, predicate) => events.findIndex((event, index) => index > start && predicate(event));

  let lastDirectoryFlush = -1;
  for (const directory of [firstDirectory, secondDirectory]) {
    const mkdirIndex = events.findIndex((event) => event.op === "mkdir" && samePath(event.path, directory));
    assert.ok(mkdirIndex >= 0, `missing mkdir trace for ${directory}`);
    const parentFsync = findAfter(mkdirIndex, (event) => event.op === "fsync" && samePath(event.path, path.dirname(directory)));
    const directoryFsync = findAfter(parentFsync, (event) => event.op === "fsync" && samePath(event.path, directory));
    assert.ok(parentFsync > mkdirIndex, `parent fsync must follow mkdir for ${directory}`);
    assert.ok(directoryFsync > parentFsync, `directory fsync must follow parent fsync for ${directory}`);
    lastDirectoryFlush = directoryFsync;
  }
  const targetRename = findAfter(lastDirectoryFlush, (event) => event.op === "rename" && samePath(event.path, target));
  assert.ok(targetRename > lastDirectoryFlush, "target publish must follow durable ancestor creation");

  const lockPath = path.join(root, ".project-gov", "apply.lock");
  const lockLink = events.findIndex((event) => event.op === "link" && samePath(event.path, lockPath));
  assert.ok(lockLink >= 0, "canonical lock hard-link publish missing");
  const candidateFsync = events.findIndex((event, index) => (
    index < lockLink && event.op === "fsync" && samePath(event.path, events[lockLink].from)
  ));
  const publishedFsync = findAfter(lockLink, (event) => event.op === "fsync" && samePath(event.path, lockPath));
  assert.ok(candidateFsync >= 0 && candidateFsync < lockLink, "candidate must be fsynced before no-clobber publish");
  assert.ok(publishedFsync > lockLink, "published canonical lock must be durably verified");

  const releaseRename = events.findIndex((event) => (
    event.op === "rename"
    && samePath(event.from, lockPath)
    && path.basename(event.path).startsWith("apply.lock.release-")
  ));
  assert.ok(releaseRename >= 0, "lock quarantine rename missing");
  const releasePath = events[releaseRename].path;
  const releaseUnlink = findAfter(releaseRename, (event) => event.op === "unlink" && samePath(event.path, releasePath));
  const governanceRoot = path.dirname(lockPath);
  const renameFlush = events.findIndex((event, index) => (
    index > releaseRename && index < releaseUnlink && event.op === "fsync" && samePath(event.path, governanceRoot)
  ));
  assert.ok(renameFlush > releaseRename, "lock rename must flush its parent before unlink");
  const phaseCleanupRename = findAfter(releaseUnlink, (event) => (
    event.op === "rename" && path.basename(String(event.from)).startsWith("apply.lock.state-")
  ));
  const unlinkFlush = events.findIndex((event, index) => (
    index > releaseUnlink
    && (phaseCleanupRename < 0 || index < phaseCleanupRename)
    && event.op === "fsync"
    && samePath(event.path, governanceRoot)
  ));
  assert.ok(unlinkFlush > releaseUnlink, "lock unlink must flush its parent before phase cleanup");
}

function testTransactionMetadataBoundsAndBoundedReads() {
  {
    const root = createProject("oversized-lock-metadata");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "oversized-lock-metadata", [replaceStatus("must-not-apply")]);
    assertProposed(prepared, "oversized lock metadata propose");
    const lockPath = path.join(root, ".project-gov", "apply.lock");
    fs.writeFileSync(lockPath, Buffer.alloc((32 * 1024) + 1, 0x7b));
    const rejected = apply(prepared.out);
    assertRejected(rejected, "oversized lock metadata");
    assert.match(jsonText(rejected.json), /Existing lock cannot be validated/);
    assert.equal(fs.statSync(lockPath).size, (32 * 1024) + 1);
    assert.match(fs.readFileSync(target, "utf8"), /baseline/);
  }

  {
    const root = createProject("oversized-journal-metadata");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "oversized-journal-metadata", [replaceStatus("interrupted")]);
    assertProposed(prepared, "oversized journal metadata propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_after_first_target"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    const backupRoot = onlyTransactionBackupRoot(root, "oversized journal metadata");
    const journal = path.join(backupRoot, "backup-manifest.json");
    fs.writeFileSync(journal, Buffer.alloc((4 * 1024 * 1024) + 1, 0x7b));
    const rejected = apply(prepared.out);
    assertRejected(rejected, "oversized journal metadata");
    assert.match(jsonText(rejected.json), /transaction_journal_too_large/);
    assert.match(fs.readFileSync(target, "utf8"), /interrupted/);
    assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), true);
  }

  {
    const root = createProject("fd-bounded-metadata-read");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "fd-bounded-metadata-read", [replaceStatus("fd-read")]);
    assertProposed(prepared, "fd bounded metadata propose");
    const applied = apply(prepared.out, {
      script: injectedScript,
      env: faultEnv(root, { faults: ["forbid_path_transaction_metadata_read"], target }),
    });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(fs.readFileSync(target, "utf8"), /fd-read/);
  }

  {
    const root = createProject("bounded-transaction-directory-read");
    const target = path.join(root, "STATUS.md");
    const prepared = propose(root, "bounded-transaction-directory-read", [replaceStatus("bounded-directory")]);
    assertProposed(prepared, "bounded directory read propose");
    const crashed = crashApply(prepared.out, faultEnv(root, {
      faults: ["hard_exit_partial_owner_temp"],
      target,
    }));
    assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
    const recovered = apply(prepared.out, {
      script: injectedScript,
      env: faultEnv(root, { faults: ["forbid_unbounded_transaction_readdir"], target }),
    });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.match(fs.readFileSync(target, "utf8"), /bounded-directory/);
  }
}

async function testLR14ConcurrentApply() {
  const root = createProject("lr14-concurrent-apply");
  const first = propose(root, "lr14-first", [replaceStatus("winner-A")]);
  const second = propose(root, "lr14-second", [replaceStatus("loser-B")]);
  assertProposed(first, "LR14 first propose");
  assertProposed(second, "LR14 second propose");

  const ready = path.join(root, "lr14-lock-held.txt");
  const firstPromise = spawnCapture(injectedScript, ["apply", "--plan", first.out, "--json"], faultEnv(root, {
    faults: ["hold_after_lock"],
    ready,
  }));
  await waitForFile(ready);
  const backupBase = path.join(root, ".project-gov", "backups");
  const backupEntriesBefore = fs.existsSync(backupBase) ? fs.readdirSync(backupBase).sort() : [];

  const blocked = apply(second.out);
  assertRejected(blocked, "LR14 concurrent apply B");
  assert.match(jsonText(blocked.json), /project_lock_busy|Apply lock is active/);
  const backupEntriesAfter = fs.existsSync(backupBase) ? fs.readdirSync(backupBase).sort() : [];
  assert.deepEqual(backupEntriesAfter, backupEntriesBefore, "LR14 blocked B created a backup");

  const winner = await firstPromise;
  assert.equal(winner.status, 0, winner.stderr || winner.stdout);
  assert.equal(winner.json.ok, true);

  const staleRetry = apply(second.out);
  assertRejected(staleRetry, "LR14 stale B retry");
  assert.match(jsonText(staleRetry.json), /fingerprint|drift|precondition/i);
}

function testLR48EpochIsolation() {
  // Overlay: propose predicts the target without changing disk.
  const root = createProject("lr48-epoch-isolation");
  const target = path.join(root, "STATUS.md");
  const before = fingerprint(target);
  const prepared = propose(root, "lr48-preflight-epoch", [replaceStatus("predicted-only")]);
  assertProposed(prepared, "LR48 propose");
  const compiled = JSON.parse(fs.readFileSync(prepared.out, "utf8"));
  assert.deepEqual(fingerprint(target), before, "LR48 propose wrote the Overlay to disk");
  assert.notDeepEqual(compiled.predicted_target_fingerprints["STATUS.md"], before);

  // Lock preflight must use a new Epoch even when the Decision Snapshot remains otherwise unchanged.
  mutate(root, "STATUS.md", (text) => text.replace("baseline", "baselinx"));
  const preflight = apply(prepared.out);
  assertRejected(preflight, "LR48 fresh lock-preflight Epoch");
  assert.match(jsonText(preflight.json), /fingerprint|drift|precondition/i);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false);

  // Post-write and post-rollback Epoch freshness are exercised by LR24/LR28 and LR38.
}

try {
  testSchema5ContractGate();
  testTargetSetInvariantAndLR27();
  testBeforeFirstWriteBackupAndDriftGates();
  testLR24LR25LR26LR28LR37();
  testLR29VerifiedMultiTargetRollback();
  testImmediateRollbackRefusesThirdPartyStateWithoutTouchingAnyTarget();
  testPerTargetPrewriteGatePreservesLateExternalChange();
  testLR30AbsentAndCreatedDirectoryRollback();
  testLR31AndLR33RollbackIncomplete();
  testLR32BaselineDigestDrift();
  testLR34BackupCleanupFailureIsIndependent();
  testLR35OversizedTargetRestoration();
  testLR36ActualTransitionFailureAfterTargetMatch();
  testPostwriteInspectionEpochSealRejectsNonTargetDrift();
  testLR38RollbackVerificationReadFailure();
  testHardExitRecoveryBeforeRetry();
  testHardExitRecoveryRemovesCreatedDirectories();
  testCommitVerifiedHardExitIsNotRolledBack();
  testHardExitRecoveryRefusesThirdPartyDrift();
  testDurableNoClobberLockPublicationCrashEdges();
  testAcquiredPhaseDoesNotClaimPreexistingBackupRoot();
  testPartialTransactionTempsAndQuarantineRecovery();
  testDirectoryIntentAndIdentityCrashRecovery();
  testBackupStartedMissingBackupRetainsFence();
  testLockMetadataPathBindingRejectsTraversal();
  testDurableDirectoryAndLockFlushOrdering();
  testTransactionMetadataBoundsAndBoundedReads();
  await testLR14ConcurrentApply();
  testLR48EpochIsolation();
  console.log("project-gov v0.3.8 transaction integrity tests: PASS");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
