import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(skillRoot, "scripts", "project-gov.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v038-adversarial-"));
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
  write(root, "PROJECT_START_HERE.md", "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 当前项目根目录。\n\n## 启动入口\n\n1. 读取五件套。\n");
  write(root, "STATUS.md", "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n| 回归 | 正常 | 本地夹具 |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n| 基线 | 通过 | 主线 |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n");
  write(root, "TODO.md", "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n| P1 | 回归 | 通过 |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |\n");
  write(root, "HANDOFF.md", "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-08-28 08:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n| 状态 | `STATUS.md` | 当前状态 |\n\n## 未决上下文\n\n- 无\n");
  write(root, "历史记录/00-历史总目录.md", "# 历史总目录\n\n| history-id | 日期 | 标题 | 路径 | 状态 |\n| --- | --- | --- | --- | --- |\n");
  write(root, "证据库/总索引/证据总目录.md", "# 证据总目录\n\n| evidence-id | run_id | task_id | 来源 | 摘要 | 路径 | 采纳状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
  write(root, "项目物料/INDEX.md", "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n");
  return root;
}

function run(command, root, extra = []) {
  const result = spawnSync(process.execPath, [script, command, "--root", root, ...extra, "--json"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = result.stdout.trim() || result.stderr.trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // Assertions below report the raw output when JSON is unexpectedly absent.
  }
  return { ...result, json, raw };
}

function propose(root, planId, actions = []) {
  const operation = write(root, `${planId}.operation.json`, `${JSON.stringify({
    schema_version: 2,
    plan_id: planId,
    knowledge_review: {
      status: "none",
      basis: "回归夹具未产生可跨任务复用的已核实知识。",
    },
    actions,
  }, null, 2)}\n`);
  const out = path.join(root, ".project-gov", "plans", `${planId}.json`);
  return { ...run("propose", root, ["--plan", operation, "--out", out]), out };
}

function apply(planPath) {
  const result = spawnSync(process.execPath, [script, "apply", "--plan", planPath, "--json"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = result.stdout.trim() || result.stderr.trim();
  return { ...result, json: raw ? JSON.parse(raw) : null, raw };
}

function assertRejected(result, message) {
  assert.notEqual(result.status, 0, `${message}\n${result.raw || result.stderr}`);
  assert.equal(result.json?.ok, false, `${message}\n${result.raw || result.stderr}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function recomputeCompiledContentDigest(compiled) {
  const payload = { ...compiled };
  delete payload.compiled_at;
  delete payload.compiled_content_digest;
  compiled.compiled_content_digest = digest(payload);
}

function rewriteCompiled(planPath, transform) {
  const compiled = JSON.parse(fs.readFileSync(planPath, "utf8"));
  transform(compiled);
  fs.writeFileSync(planPath, `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
  return compiled;
}

function assertNoTransactionArtifacts(root, label) {
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "apply.lock")), false, `${label}: apply lock remained`);
  assert.equal(fs.existsSync(path.join(root, ".project-gov", "backups")), false, `${label}: backup was created`);
}

try {
  // LR18 plus the base schema-5 envelope contract.
  {
    const root = createProject("strict-compiled-envelope");
    const proposed = propose(root, "strict-envelope", [{
      kind: "write_file",
      path: "历史记录/strict-envelope.md",
      content: "# strict envelope\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    const compiled = JSON.parse(fs.readFileSync(proposed.out, "utf8"));
    assert.equal(compiled.compiled_schema_version, 5);
    assert.equal(compiled.skill_version, "0.3.8-rc7");
    assert.equal(compiled.operation_schema_version, 2);
    assert.equal(compiled.project_structure_version, 2);
    assert.equal(compiled.decision_policy_version, 2);
    assert.equal(typeof compiled.baseline_validation_digest, "string");
    assert.equal(typeof compiled.predicted_validation_digest, "string");
    assert.equal(typeof compiled.compiled_content_digest, "string");
    for (const forbidden of ["ok", "violations", "warnings", "current", "predicted", "before_hashes"]) {
      assert.equal(Object.hasOwn(compiled, forbidden), false, `compiled plan leaked behavior field: ${forbidden}`);
    }

    const digestPayload = { ...compiled };
    delete digestPayload.compiled_at;
    delete digestPayload.compiled_content_digest;
    assert.equal(compiled.compiled_content_digest, digest(digestPayload));

    const targetSet = compiled.actions.map((action) => action.path).sort();
    assert.deepEqual(Object.keys(compiled.before_fingerprints).sort(), targetSet);
    assert.deepEqual(Object.keys(compiled.predicted_target_fingerprints).sort(), targetSet);

    const tampered = { ...compiled, unexpected_behavior: true };
    const tamperedPath = write(root, "tampered-extra-field.json", `${JSON.stringify(tampered, null, 2)}\n`);
    const rejected = apply(tamperedPath);
    assertRejected(rejected, "unknown compiled fields must fail before touching the project");
    assert.match(rejected.raw, /compiled_plan_unknown_field/);
    assertNoTransactionArtifacts(root, "LR18");
  }

  // LR07: mutating an action body without updating the compiled digest is rejected before lock/backup.
  {
    const root = createProject("lr07-action-body-tamper");
    const target = path.join(root, "历史记录", "lr07.md");
    const proposed = propose(root, "lr07-action-body-tamper", [{
      kind: "write_file",
      path: "历史记录/lr07.md",
      content: "# original\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    rewriteCompiled(proposed.out, (compiled) => {
      compiled.actions[0].content = "# tampered\n";
    });
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR07 action-body tamper");
    assert.match(rejected.raw, /compiled_content_digest_mismatch/);
    assert.equal(fs.existsSync(target), false, "LR07 target changed");
    assertNoTransactionArtifacts(root, "LR07");
  }

  // LR08: baseline body + total digest are changed, but the nested baseline digest remains stale.
  {
    const root = createProject("lr08-baseline-digest-tamper");
    const target = path.join(root, "历史记录", "lr08.md");
    const proposed = propose(root, "lr08-baseline-digest-tamper", [{
      kind: "write_file",
      path: "历史记录/lr08.md",
      content: "# lr08\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    rewriteCompiled(proposed.out, (compiled) => {
      compiled.baseline_validation.five_piece.total_bytes += 1;
      recomputeCompiledContentDigest(compiled);
    });
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR08 stale nested baseline digest");
    assert.match(rejected.raw, /baseline_validation_digest_mismatch/);
    assert.doesNotMatch(rejected.raw, /compiled_content_digest_mismatch/);
    assert.equal(fs.existsSync(target), false, "LR08 target changed");
    assertNoTransactionArtifacts(root, "LR08");
  }

  // LR09: predicted body + total digest are changed, but the nested predicted digest remains stale.
  {
    const root = createProject("lr09-predicted-digest-tamper");
    const target = path.join(root, "历史记录", "lr09.md");
    const proposed = propose(root, "lr09-predicted-digest-tamper", [{
      kind: "write_file",
      path: "历史记录/lr09.md",
      content: "# lr09\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    rewriteCompiled(proposed.out, (compiled) => {
      compiled.predicted_validation.five_piece.total_bytes += 1;
      recomputeCompiledContentDigest(compiled);
    });
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR09 stale nested predicted digest");
    assert.match(rejected.raw, /predicted_validation_digest_mismatch/);
    assert.doesNotMatch(rejected.raw, /compiled_content_digest_mismatch/);
    assert.equal(fs.existsSync(target), false, "LR09 target changed");
    assertNoTransactionArtifacts(root, "LR09");
  }

  // LR11: a non-target governed-file mutation changes the baseline decision after propose.
  {
    const root = createProject("lr11-nontarget-baseline-drift");
    const target = path.join(root, "历史记录", "lr11.md");
    const proposed = propose(root, "lr11-nontarget-baseline-drift", [{
      kind: "write_file",
      path: "历史记录/lr11.md",
      content: "# lr11\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    fs.appendFileSync(path.join(root, "AGENTS.md"), "\nEV-20991231-999\n", "utf8");
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR11 apply-preflight baseline drift");
    assert.match(rejected.raw, /baseline_validation_drift/);
    assert.equal(fs.existsSync(target), false, "LR11 target changed");
    assert.equal(fs.existsSync(proposed.out), true, "LR11 compiled plan was removed");
    assertNoTransactionArtifacts(root, "LR11");
  }

  // LR12: same-size target drift keeps the Decision Snapshot stable but changes its fingerprint.
  {
    const root = createProject("lr12-target-fingerprint-drift");
    const target = path.join(root, "STATUS.md");
    const proposed = propose(root, "lr12-target-fingerprint-drift", [{
      kind: "replace_line_contains",
      path: "STATUS.md",
      contains: "| 回归 | 正常 | 本地夹具 |",
      replacement: "| 回归 | 完成 | 本地夹具 |",
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    const beforeBytes = fs.statSync(target).size;
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("| 回归 | 正常 |", "| 回归 | 正好 |"), "utf8");
    assert.equal(fs.statSync(target).size, beforeBytes, "LR12 fixture must remain same-size");
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR12 target fingerprint drift");
    assert.match(rejected.raw, /before_fingerprint_drift/);
    assert.doesNotMatch(rejected.raw, /baseline_validation_(?:digest_)?drift/);
    assert.match(fs.readFileSync(target, "utf8"), /\| 回归 \| 正好 \|/);
    assert.equal(fs.existsSync(proposed.out), true, "LR12 compiled plan was removed");
    assertNoTransactionArtifacts(root, "LR12");
  }

  // LR13: a self-consistent outer digest cannot authorize a forged stored transition.
  {
    const root = createProject("lr13-forged-transition");
    const target = path.join(root, "历史记录", "lr13.md");
    const proposed = propose(root, "lr13-forged-transition", [{
      kind: "write_file",
      path: "历史记录/lr13.md",
      content: "# lr13\n",
      overwrite: false,
    }]);
    assert.equal(proposed.status, 0, proposed.raw);
    rewriteCompiled(proposed.out, (compiled) => {
      compiled.predicted_transition.five_piece_delta_bytes += 1;
      recomputeCompiledContentDigest(compiled);
    });
    const rejected = apply(proposed.out);
    assertRejected(rejected, "LR13 forged stored transition");
    assert.match(rejected.raw, /predicted_transition_drift/);
    assert.doesNotMatch(rejected.raw, /compiled_content_digest_mismatch/);
    assert.equal(fs.existsSync(target), false, "LR13 target changed");
    assert.equal(fs.existsSync(proposed.out), true, "LR13 compiled plan was removed");
    assertNoTransactionArtifacts(root, "LR13");
  }

  // LR01-LR06, LR15-LR17: one shared transition policy governs propose and apply.
  {
    const root = createProject("transition-policy");
    fs.appendFileSync(
      path.join(root, "HANDOFF.md"),
      "\n未解析引用：M-20260828-OPS-001\n",
      "utf8",
    );
    const noImprovement = propose(root, "repair-no-improvement", [{
      kind: "write_file",
      path: "历史记录/unrelated.md",
      content: "# unrelated\n",
      overwrite: false,
    }]);
    assertRejected(noImprovement, "repair mode must reject an unchanged issue multiset");
    assert.ok(
      (noImprovement.json?.violations || []).some((item) => String(item).includes("transition")),
      noImprovement.raw,
    );
    assert.equal(fs.existsSync(noImprovement.out), false);
  }

  console.log("project-gov v0.3.8 adversarial tests: PASS");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
