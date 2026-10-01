import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "project-gov.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-write-edge-"));

function write(rel, content) {
  const abs = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function createValidProject() {
  write("AGENTS.md", "# AGENTS.md\n");
  write("PROJECT_START_HERE.md", "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 当前夹具。\n\n## 启动入口\n\n1. 读取五件套。\n");
  write(
    "STATUS.md",
    "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n",
  );
  write(
    "TODO.md",
    "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n",
  );
  write(
    "HANDOFF.md",
    "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-07-27 16:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n\n## 未决上下文\n\n- 无\n",
  );
  write("历史记录/00-历史总目录.md", "# 历史总目录\n\n| history-id | 日期 | 标题 | 路径 | 状态 |\n| --- | --- | --- | --- | --- |\n");
  write("证据库/总索引/证据总目录.md", "# 证据总目录\n\n| evidence-id | run_id | task_id | 来源 | 摘要 | 路径 | 采纳状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
  write("项目物料/INDEX.md", "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n");
}

function writePlan(name, plan) {
  const planPath = path.join(sandbox, `${name}.operation.json`);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return planPath;
}

function propose(name, plan, outName, options = {}) {
  const normalizedPlan = Object.hasOwn(plan, "knowledge_review")
    ? plan
    : {
      ...plan,
      knowledge_review: {
        status: "none",
        basis: "回归夹具未产生可跨任务复用的已核实知识。",
      },
    };
  const planPath = writePlan(name, normalizedPlan);
  const outPath = path.join(sandbox, ".project-gov", "plans", outName);
  const result = spawnSync(
    process.execPath,
    [script, "propose", "--root", sandbox, "--plan", planPath, "--out", outPath, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    },
  );
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : JSON.parse(result.stderr),
    outPath,
  };
}

function apply(planPath, options = {}) {
  const result = spawnSync(process.execPath, [script, "apply", "--plan", planPath, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : JSON.parse(result.stderr),
  };
}

function prune(args = []) {
  const result = spawnSync(process.execPath, [script, "prune", "--root", sandbox, ...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : JSON.parse(result.stderr),
  };
}

function spawnCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function testWindowsLockedCleanup() {
  if (process.platform !== "win32") return;

  const actions = Array.from({ length: 200 }, (_, index) => ({
    kind: "write_file",
    path: `历史记录/锁清理回归/${String(index + 1).padStart(3, "0")}.md`,
    content: `# ${index + 1}\n${"x".repeat(8192)}\n`,
    overwrite: false,
  }));
  const prepared = propose(
    "locked-cleanup",
    { schema_version: 2, plan_id: "locked_cleanup", actions },
    "locked-cleanup.json",
  );
  assert.equal(prepared.status, 0, prepared.stderr);

  const ready = path.join(sandbox, "lock-helper-ready.txt");
  const held = path.join(sandbox, "lock-helper-held.txt");
  const release = path.join(sandbox, "lock-helper-release.txt");
  const lock = path.join(sandbox, ".project-gov", "apply.lock");
  const ps = [
    `$lock = '${lock.replaceAll("'", "''")}'`,
    `$ready = '${ready.replaceAll("'", "''")}'`,
    `$held = '${held.replaceAll("'", "''")}'`,
    `$release = '${release.replaceAll("'", "''")}'`,
    "[IO.File]::WriteAllText($ready, 'ready')",
    "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
    "while (!(Test-Path -LiteralPath $lock) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 1 }",
    "if (!(Test-Path -LiteralPath $lock)) { exit 2 }",
    "$handle = [IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
    "[IO.File]::WriteAllText($held, 'held')",
    "$releaseDeadline = [DateTime]::UtcNow.AddSeconds(20)",
    "while (!(Test-Path -LiteralPath $release) -and [DateTime]::UtcNow -lt $releaseDeadline) { Start-Sleep -Milliseconds 5 }",
    "$handle.Dispose()",
  ].join("; ");
  const helperPromise = spawnCapture("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps]);
  await waitForFile(ready);

  const applyPromise = spawnCapture(process.execPath, [script, "apply", "--plan", prepared.outPath, "--json"]);
  const firstApply = await applyPromise;
  fs.writeFileSync(release, "release\n", "utf8");
  const helper = await helperPromise;
  assert.equal(helper.status, 0, helper.stderr);
  assert.equal(fs.existsSync(held), true, "helper did not hold apply.lock");
  assert.equal(firstApply.status, 0, firstApply.stderr);
  const firstJson = JSON.parse(firstApply.stdout);
  assert.equal(firstJson.ok, true);
  assert.equal(firstJson.lock_cleanup.ok, false);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(path.join(sandbox, "历史记录", "锁清理回归", "200.md")), true);

  const retry = propose(
    "dead-lock-retry",
    {
      schema_version: 2,
      plan_id: "dead_lock_retry",
      actions: [{
        kind: "write_file",
        path: "历史记录/锁清理回归/retry.md",
        content: "# retry\n",
        overwrite: false,
      }],
    },
    "dead-lock-retry.json",
  );
  assert.equal(retry.status, 0, retry.stderr);
  const retryApply = apply(retry.outPath);
  assert.equal(retryApply.status, 0, retryApply.stderr);
  assert.equal(retryApply.json.ok, true);
  assert.equal(fs.existsSync(lock), false);
}

function createCleanupReplacementHook() {
  return write("test-hooks/cache-cleanup-replacement.mjs", String.raw`import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.env.PDE_CACHE_REPLACE_TARGET || "");
const originalRename = fs.renameSync.bind(fs);
const originalUnlink = fs.unlinkSync.bind(fs);
const originalWrite = fs.writeFileSync.bind(fs);
let injected = false;

function same(left, right) {
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(String(value)).toLowerCase()
    : path.resolve(String(value));
  return normalize(left) === normalize(right);
}

function replaceTarget() {
  if (injected) return;
  injected = true;
  originalRename(target, target + ".read-original");
  originalWrite(target, "USER_SENTINEL\n", "utf8");
}

fs.unlinkSync = function injectedUnlink(value, ...args) {
  if (same(value, target)) replaceTarget();
  return originalUnlink(value, ...args);
};

fs.renameSync = function injectedRename(from, to, ...args) {
  if (same(from, target)) replaceTarget();
  return originalRename(from, to, ...args);
};
`);
}

function testWorkflowCleanupBinding() {
  const hook = createCleanupReplacementHook();
  const nodeOptions = `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(hook).href}`.trim();

  const operationPath = path.join(sandbox, ".project-gov", "operations", "replace.operation.json");
  fs.mkdirSync(path.dirname(operationPath), { recursive: true });
  fs.writeFileSync(operationPath, `${JSON.stringify({
    schema_version: 2,
    plan_id: "operation_cleanup_binding",
    knowledge_review: { status: "none", basis: "清理绑定夹具不产生项目知识。" },
    actions: [{
      kind: "write_file",
      path: "历史记录/cleanup-operation.md",
      content: "# operation cleanup\n",
      overwrite: false,
    }],
  }, null, 2)}\n`, "utf8");
  const operationOut = path.join(sandbox, ".project-gov", "plans", "operation-cleanup-binding.json");
  const proposed = spawnSync(
    process.execPath,
    [script, "propose", "--root", sandbox, "--plan", operationPath, "--out", operationOut, "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: nodeOptions, PDE_CACHE_REPLACE_TARGET: operationPath },
    },
  );
  const proposedJson = JSON.parse(proposed.stdout.trim() || proposed.stderr.trim());
  assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);
  assert.equal(proposedJson.ok, true);
  assert.equal(proposedJson.operation_cleanup?.ok, false, proposed.stdout);
  assert.match(JSON.stringify(proposedJson.operation_cleanup), /workflow_artifact_replaced_since_read/);
  assert.equal(fs.readFileSync(operationPath, "utf8"), "USER_SENTINEL\n");

  const planPrepared = propose(
    "compiled-cleanup-binding",
    {
      schema_version: 2,
      plan_id: "compiled_cleanup_binding",
      actions: [{
        kind: "write_file",
        path: "历史记录/cleanup-compiled.md",
        content: "# compiled cleanup\n",
        overwrite: false,
      }],
    },
    "compiled-cleanup-binding.json",
  );
  assert.equal(planPrepared.status, 0, planPrepared.stderr);
  const applied = apply(planPrepared.outPath, {
    env: { NODE_OPTIONS: nodeOptions, PDE_CACHE_REPLACE_TARGET: planPrepared.outPath },
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.json.ok, true);
  assert.equal(applied.json.plan_cleanup?.ok, false, applied.stdout);
  assert.match(JSON.stringify(applied.json.plan_cleanup), /workflow_artifact_replaced_since_read/);
  assert.equal(fs.readFileSync(planPrepared.outPath, "utf8"), "USER_SENTINEL\n");
}

function testCompiledPlanOutputMustBeDirectChild() {
  const nested = propose(
    "nested-plan-output",
    {
      schema_version: 2,
      plan_id: "nested_plan_output",
      actions: [{
        kind: "write_file",
        path: "历史记录/nested-plan-output.md",
        content: "# nested\n",
        overwrite: false,
      }],
    },
    "nested/plan.json",
  );
  assert.notEqual(nested.status, 0, nested.stdout || nested.stderr);
  assert.match(nested.stdout + nested.stderr, /compiled_plan_output_not_direct_child_of_plans/);
  assert.equal(fs.existsSync(nested.outPath), false);
}

function testCanonicalParentChildConflicts() {
  for (const [name, actions] of [
    ["parent-first", [
      { kind: "write_file", path: "历史记录/conflict-node", content: "parent\n", overwrite: false },
      { kind: "write_file", path: "历史记录/conflict-node/child.md", content: "child\n", overwrite: false },
    ]],
    ["child-first", [
      { kind: "write_file", path: "历史记录/conflict-node-2/child.md", content: "child\n", overwrite: false },
      { kind: "write_file", path: "历史记录/conflict-node-2", content: "parent\n", overwrite: false },
    ]],
  ]) {
    const result = propose(
      `path-conflict-${name}`,
      { schema_version: 2, plan_id: `path_conflict_${name}`, actions },
      `path-conflict-${name}.json`,
    );
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stdout + result.stderr, /canonical_action_parent_path_not_directory/);
    assert.equal(fs.existsSync(result.outPath), false);
  }

  const segmentBoundary = propose(
    "path-segment-boundary",
    {
      schema_version: 2,
      plan_id: "path_segment_boundary",
      actions: [
        { kind: "write_file", path: "历史记录/a", content: "a\n", overwrite: false },
        { kind: "write_file", path: "历史记录/ab/child.md", content: "ab\n", overwrite: false },
      ],
    },
    "path-segment-boundary.json",
  );
  assert.equal(segmentBoundary.status, 0, segmentBoundary.stderr || segmentBoundary.stdout);
}

function testEmptyActionsRejected() {
  const empty = propose(
    "empty-actions",
    { schema_version: 2, plan_id: "empty_actions", actions: [] },
    "empty-actions.json",
  );
  assert.notEqual(empty.status, 0, empty.stdout || empty.stderr);
  assert.match(empty.stdout + empty.stderr, /actions_non_empty_required/);
  assert.equal(fs.existsSync(empty.outPath), false);
}

try {
  createValidProject();

  const invalid = propose(
    "invalid-roots",
    {
      schema_version: 2,
      plan_id: "invalid_roots",
      actions: [
        { kind: "mkdir", path: "历史记录" },
        { kind: "mkdir", path: "项目物料" },
        { kind: "mkdir", path: "证据库/总索引/诊断" },
      ],
    },
    "retry.json",
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.json.ok, false);
  assert.ok(invalid.json.violations.includes(
    "actions[0].mkdir_top_level_governance_directory_not_allowed_use_index_file_or_subdirectory",
  ));
  assert.equal(fs.existsSync(invalid.outPath), false, "failed propose must not reserve --out");

  const corrected = propose(
    "corrected-roots",
    {
      schema_version: 2,
      plan_id: "corrected_roots",
      actions: [
        { kind: "mkdir", path: "历史记录/变更记录" },
        { kind: "write_file", path: "历史记录/变更记录/README.md", content: "# 变更记录\n", overwrite: false },
        { kind: "mkdir", path: "项目物料/输出产物" },
        { kind: "write_file", path: "项目物料/输出产物/README.md", content: "# 输出产物\n", overwrite: false },
        { kind: "mkdir", path: "证据库/总索引/诊断" },
        { kind: "write_file", path: "证据库/总索引/诊断/README.md", content: "# 诊断\n", overwrite: false },
      ],
    },
    "retry.json",
  );
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(corrected.json.ok, true);
  assert.equal(fs.existsSync(corrected.outPath), true);
  const correctedApply = apply(corrected.outPath);
  assert.equal(correctedApply.status, 0, correctedApply.stderr);
  assert.equal(correctedApply.json.ok, true);

  const plaintextConfig = propose(
    "plaintext-config",
    {
      schema_version: 2,
      plan_id: "plaintext_config",
      actions: [
        {
          kind: "append_after",
          path: "STATUS.md",
          after: "# STATUS.md",
          match: "exact",
          content: "api_key = plain_text_configuration_value",
        },
      ],
    },
    "plaintext-config.json",
  );
  assert.equal(plaintextConfig.status, 0, plaintextConfig.stderr);
  assert.equal(plaintextConfig.json.ok, true);
  assert.doesNotMatch(plaintextConfig.stdout, /plain_text_configuration_value/);
  assert.match(fs.readFileSync(plaintextConfig.outPath, "utf8"), /plain_text_configuration_value/);
  const plaintextConfigApply = apply(plaintextConfig.outPath);
  assert.equal(plaintextConfigApply.status, 0, plaintextConfigApply.stderr);
  assert.equal(plaintextConfigApply.json.ok, true);
  assert.deepEqual(plaintextConfigApply.json.backups_retained, []);
  assert.equal(plaintextConfigApply.json.backup_cleanup.ok, true);
  assert.equal(plaintextConfigApply.json.backup_cleanup.removed, true);
  assert.match(fs.readFileSync(path.join(sandbox, "STATUS.md"), "utf8"), /plain_text_configuration_value/);

  const todoPath = path.join(sandbox, "TODO.md");
  fs.writeFileSync(
    todoPath,
    fs.readFileSync(todoPath, "utf8").replace(/\n/g, "\r\n").replace("# TODO.md\r\n", "# TODO.md\r\n\r\n临时说明\r\n"),
    "utf8",
  );
  const blockReplace = propose(
    "block-replace",
    {
      schema_version: 2,
      plan_id: "block_replace",
      actions: [
        {
          kind: "replace_block_exact",
          path: "TODO.md",
          old_block: "临时说明\n",
          replacement: "",
        },
        {
          kind: "replace_block_exact",
          path: "TODO.md",
          old_block: "| 事项 | 影响 |\n| --- | --- |",
          replacement: "| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |",
        },
      ],
    },
    "block-replace.json",
  );
  assert.equal(blockReplace.status, 0, blockReplace.stderr);
  assert.equal(blockReplace.json.action_counts.replace_block_exact, 2);
  const blockApply = apply(blockReplace.outPath);
  assert.equal(blockApply.status, 0, blockApply.stderr);
  const todoAfter = fs.readFileSync(todoPath, "utf8");
  assert.doesNotMatch(todoAfter, /临时说明/);
  assert.match(todoAfter, /\r\n/);
  assert.match(todoAfter, /\| 无 \| 无 \|/);

  const rollbackProbe = propose(
    "rollback-cleanup",
    {
      schema_version: 2,
      plan_id: "rollback_cleanup",
      actions: [
        {
          kind: "replace_block_exact",
          path: "TODO.md",
          old_block: "## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |\n",
          replacement: "",
        },
      ],
    },
    "rollback-cleanup.json",
  );
  assert.notEqual(rollbackProbe.status, 0);
  assert.equal(rollbackProbe.json.ok, false);
  assert.match(JSON.stringify(rollbackProbe.json), /predicted_transition|transition/i);
  assert.equal(fs.existsSync(rollbackProbe.outPath), false);
  assert.match(fs.readFileSync(todoPath, "utf8"), /## 待确认/);

  const ownedPrunePlan = propose(
    "owned-prune-plan",
    {
      schema_version: 2,
      plan_id: "owned_prune_plan",
      actions: [{
        kind: "write_file",
        path: "历史记录/prune-owned-plan.md",
        content: "# prune inventory\n",
        overwrite: false,
      }],
    },
    "old.json",
  );
  assert.equal(ownedPrunePlan.status, 0, ownedPrunePlan.stderr);
  const oldPlan = ownedPrunePlan.outPath;
  const manualPlan = path.join(sandbox, ".project-gov", "plans", "manual.json");
  const oldBackup = path.join(sandbox, ".project-gov", "backups", "old-backup");
  const unownedBackup = path.join(sandbox, ".project-gov", "backups", "manual-backup");
  fs.mkdirSync(oldBackup, { recursive: true });
  fs.mkdirSync(unownedBackup, { recursive: true });
  fs.writeFileSync(manualPlan, "{}\n", "utf8");
  fs.writeFileSync(path.join(oldBackup, ".project-gov-owner.json"), `${JSON.stringify({
    schema_version: 1,
    tool: "project-gov",
    kind: "transaction_backup",
    root: sandbox,
    plan_id: "old-backup",
    created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
  })}\n`, "utf8");
  fs.writeFileSync(path.join(oldBackup, "probe.txt"), "old\n", "utf8");
  fs.writeFileSync(path.join(unownedBackup, "probe.txt"), "old\n", "utf8");
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPlan, oldTime, oldTime);
  fs.utimesSync(manualPlan, oldTime, oldTime);
  fs.utimesSync(path.join(oldBackup, ".project-gov-owner.json"), oldTime, oldTime);
  fs.utimesSync(path.join(oldBackup, "probe.txt"), oldTime, oldTime);
  fs.utimesSync(oldBackup, oldTime, oldTime);
  fs.utimesSync(path.join(unownedBackup, "probe.txt"), oldTime, oldTime);
  fs.utimesSync(unownedBackup, oldTime, oldTime);
  const prunePreview = prune(["--older-than-days", "30"]);
  assert.equal(prunePreview.status, 0, prunePreview.stderr);
  assert.equal(prunePreview.json.mode, "read_only_inventory");
  assert.equal(prunePreview.json.automatic_delete, false);
  assert.ok(prunePreview.json.items.some((item) => item.rel.endsWith("old.json")));
  assert.ok(prunePreview.json.items.some((item) => item.rel.endsWith("old-backup")));
  assert.ok(prunePreview.json.items.some((item) => item.rel.endsWith("manual.json")));
  assert.ok(prunePreview.json.items.some((item) => item.rel.endsWith("manual-backup")));
  assert.equal(fs.existsSync(oldPlan), true);
  const pruneApply = prune(["--older-than-days", "30", "--apply"]);
  assert.notEqual(pruneApply.status, 0);
  assert.equal(fs.existsSync(oldPlan), true);
  assert.equal(fs.existsSync(oldBackup), true);
  assert.equal(fs.existsSync(manualPlan), true);
  assert.equal(fs.existsSync(unownedBackup), true);

  testWorkflowCleanupBinding();
  testCompiledPlanOutputMustBeDirectChild();
  testCanonicalParentChildConflicts();
  testEmptyActionsRejected();
  await testWindowsLockedCleanup();
  console.log("project-gov write edge regression tests: PASS");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
