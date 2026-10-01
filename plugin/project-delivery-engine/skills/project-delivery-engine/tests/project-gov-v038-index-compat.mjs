import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDeterministicLegacyScanScope,
  buildPathManifest,
  canonicalDigest,
  collectSignalStrings,
  createProject,
  enumerateLegacyOccurrences,
  findDecisionSnapshots,
  findObjects,
  hasSignal,
  ids,
  inspect,
  loadMigrationEvidenceGate,
  normalizeRel,
  removeProject,
  sha256,
  sha256File,
  startHttpProbe,
  validate,
  verifyLegacyFreezeEnumeration,
  verifyLegacyScopeSnapshotDocument,
  verifyAffectedMigrationManifests,
  verifyDeterministicLegacyScanScope,
  verifyCurrentLegacyMetadataOnly,
  verifyFinalLegacyMetadataOnly,
  verifyLegacyMappingCoverage,
  verifyPathManifest,
  verifyRealProjectWithCurrentSource,
  verifyMaterials,
  write,
  writeIndex,
} from "./helpers/project-gov-v038-harness.mjs";

const registered = new Set();
const expected = new Set(["LR45", "LR46", ...Array.from({ length: 26 }, (_, index) => `LR${57 + index}`), "LR115"]);
const MIGRATION_EVIDENCE_ENV_KEYS = [
  "PDE_V038_REAL_PROJECT_ROOT",
  "PDE_V038_PROJECT_DATA_FREEZE_DIR",
  "PDE_V038_PROJECT_DATA_MIGRATION_MANIFEST",
];

function migrationEvidenceIsRequired(env = process.env) {
  return String(env.PDE_V038_REQUIRE_MIGRATION_GATE || "").trim() === "1"
    || MIGRATION_EVIDENCE_ENV_KEYS.some((key) => String(env[key] || "").trim().length > 0);
}

const migrationGate = loadMigrationEvidenceGate();
const migrationGateRequired = migrationEvidenceIsRequired();

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

test("[migration-gate-fixture] manifest 必须由文件系统现场重算，不接受 JSON 自报", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-v038-manifest-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "nested/a.md", "before\n");
  const manifest = buildPathManifest(root);
  assert.doesNotThrow(() => verifyPathManifest(manifest, root, "fixture-manifest"));

  write(root, "nested/a.md", "tampered\n");
  assert.throws(
    () => verifyPathManifest(manifest, root, "fixture-manifest"),
    /byte count mismatch|SHA-256 mismatch/,
  );

  write(root, "nested/a.md", "before\n");
  write(root, "unreported.md", "extra\n");
  assert.throws(
    () => verifyPathManifest(manifest, root, "fixture-manifest"),
    /path set does not match filesystem/,
  );
});

test("[migration-gate-fixture] legacy scan 使用确定性范围、排除项和 4 MiB 完整性门", (t) => {
  const root = fixture(t, "deterministic-legacy-scan-scope");
  write(root, "README.md", "# Root markdown\nD-202608-001\n");
  write(root, "历史记录/专题/00-专题总目录.md", "# 专题目录\nE-202608-001\n");
  write(root, "证据库/总索引/采纳关系.md", "# 采纳关系\n");
  write(root, ".git/ignored.md", "D-202608-999\n");
  write(root, ".project-gov/ignored.md", "D-202608-998\n");
  write(root, "node_modules/ignored.md", "D-202608-997\n");
  write(root, "项目物料/输出产物/ignored.md", "D-202608-996\n");
  write(root, "历史记录/current-evidence/00-本轮总目录.md", "D-202608-995\n");
  writeIndex(
    root,
    "历史记录/00-历史总目录.md",
    "历史总目录",
    ["history-id", "日期", "标题", "路径", "状态"],
    [["M-20260828-001", "2026-08-28", "typed", "历史记录/typed.md", "active"]],
  );
  write(root, "历史记录/typed.md", "# Typed\nD-202608-002\n");

  const scoped = buildDeterministicLegacyScanScope(root, {
    currentEvidenceRoot: path.join(root, "历史记录/current-evidence"),
  });
  assert.equal(scoped.scope_complete, true, JSON.stringify(scoped.errors));
  for (const expectedPath of [
    "README.md",
    "历史记录/专题/00-专题总目录.md",
    "证据库/总索引/采纳关系.md",
    "历史记录/typed.md",
  ]) assert.ok(scoped.paths.includes(expectedPath), `${expectedPath} missing from deterministic scope`);
  assert.equal(scoped.paths.some((rel) => rel.includes("ignored.md")), false);
  assert.equal(scoped.paths.some((rel) => rel.includes("current-evidence")), false);
  assert.match(scoped.path_set_digest, /^[a-f0-9]{64}$/);
  assert.match(scoped.manifest_digest, /^[a-f0-9]{64}$/);

  write(root, "oversized.md", Buffer.alloc((4 * 1024 * 1024) + 1, 0x61));
  const oversized = buildDeterministicLegacyScanScope(root);
  assert.equal(oversized.scope_complete, false);
  assert.ok(oversized.errors.some((item) => item.path === "oversized.md" && item.code === "text_file_too_large"));
  fs.unlinkSync(path.join(root, "oversized.md"));

  const redirect = path.join(root, "redirect.md");
  try {
    fs.symlinkSync(path.join(root, "README.md"), redirect, "file");
    const redirected = buildDeterministicLegacyScanScope(root);
    assert.equal(redirected.scope_complete, false);
    assert.ok(redirected.errors.some((item) => item.path === "redirect.md" && item.code === "redirect_not_followed"));
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  }
});

test("[migration-gate-fixture] 非法 UTF-8 必须把 legacy 扫描标成不完整", (t) => {
  const root = fixture(t, "invalid-utf8-completeness");
  write(root, "invalid.md", Buffer.from([0xc3, 0x28]));
  write(root, "invalid-with-nul.md", Buffer.from([0x00, 0xc3, 0x28]));
  write(root, "valid-utf8-with-nul.md", Buffer.from([0x00, 0x61]));

  const deterministic = buildDeterministicLegacyScanScope(root);
  assert.equal(deterministic.scope_complete, false);
  assert.ok(deterministic.errors.some((item) => item.path === "invalid.md" && item.code === "invalid_utf8"));
  assert.ok(deterministic.errors.some((item) => item.path === "invalid-with-nul.md" && item.code === "invalid_utf8"));
  assert.ok(deterministic.errors.some((item) => item.path === "valid-utf8-with-nul.md" && item.code === "nul_byte_in_text_file"));

  const enumerated = enumerateLegacyOccurrences(root);
  assert.equal(enumerated.scope_complete, false);
  assert.ok(enumerated.errors.some((item) => item.path === "invalid.md" && item.code === "invalid_utf8"));
  assert.ok(enumerated.errors.some((item) => item.path === "invalid-with-nul.md" && item.code === "invalid_utf8"));
  assert.ok(enumerated.errors.some((item) => item.path === "valid-utf8-with-nul.md" && item.code === "nul_byte_in_text_file"));
});

test("[migration-gate-fixture] required migration Gate 必须显式识别", () => {
  assert.equal(migrationEvidenceIsRequired({}), false);
  assert.equal(migrationEvidenceIsRequired({ PDE_V038_REQUIRE_MIGRATION_GATE: "1" }), true);
  assert.equal(migrationEvidenceIsRequired({ PDE_V038_REAL_PROJECT_ROOT: "C:/fixture" }), true);
  assert.equal(migrationEvidenceIsRequired({ PDE_V038_PROJECT_DATA_FREEZE_DIR: "C:/fixture" }), true);
  assert.equal(migrationEvidenceIsRequired({ PDE_V038_PROJECT_DATA_MIGRATION_MANIFEST: "C:/fixture.json" }), true);
});

test("[migration-gate-fixture] 历史 scope 只校验冻结时间点且拒绝自相矛盾", (t) => {
  const root = fixture(t, "historical-scope-timepoint");
  const frozen = buildDeterministicLegacyScanScope(root);
  write(root, "历史记录/checkpoint/00-checkpoint总目录.md", "# later checkpoint\n");
  const current = buildDeterministicLegacyScanScope(root);
  assert.ok(current.path_count > frozen.path_count);
  assert.doesNotThrow(() => verifyLegacyScopeSnapshotDocument(frozen));
  assert.throws(() => verifyLegacyScopeSnapshotDocument({ ...frozen, path_count: frozen.path_count + 1 }));
});

test("[migration-gate-fixture] 当前 legacy 回归必须独立于历史迁移闭环拒绝", (t) => {
  const root = fixture(t, "current-legacy-regression");
  write(root, "历史记录/x.md", "# migrated history\n");
  write(root, "历史记录/00-历史总目录.md", [
    "# 历史总目录",
    "",
    "| history-id | legacy-id | 日期 | 标题 | 路径 | 状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| M-20260705-005 | D-202607-001 | 2026-07-05 | migrated | `历史记录/x.md` | active |",
    "",
  ].join("\n"));
  const gate = {
    status: "ready",
    paths: { projectRoot: root, freezeDir: path.join(os.tmpdir(), "outside-current-legacy-evidence") },
    legacyOccurrencesBefore: { occurrences: [{ legacy_id: "D-202607-001" }] },
  };
  assert.doesNotThrow(() => verifyCurrentLegacyMetadataOnly(gate));
  write(root, "STATUS.md", "# STATUS.md\n\nactive reference D-202607-001\n");
  assert.throws(() => verifyCurrentLegacyMetadataOnly(gate), /current active legacy reference/u);
});

function assertRejected(result, message) {
  assert.notEqual(result.status, 0, `${message}\n${result.raw || result.stderr}`);
  assert.equal(result.json?.ok, false, `${message}\n${result.raw || result.stderr}`);
}

function assertSignal(result, expectedSignal, message = expectedSignal) {
  assert.ok(hasSignal(result.json, expectedSignal), `${message}\n${result.raw || result.stderr}`);
}

function assertAnySignal(result, expectedSignals, message) {
  assert.ok(
    expectedSignals.some((item) => hasSignal(result.json, item)),
    `${message}: expected one of ${expectedSignals.join(", ")}\n${result.raw || result.stderr}`,
  );
}

function decisionSnapshot(result) {
  const snapshots = findDecisionSnapshots(result.json);
  assert.ok(snapshots.length > 0, `Decision Snapshot missing\n${result.raw || result.stderr}`);
  return snapshots[0];
}

function markdownScan(result) {
  const scans = findObjects(result.json, (item) => (
    Number.isInteger(item.files_scanned)
    && Number.isInteger(item.files_discovered)
    && Object.hasOwn(item, "scanned_bytes")
  ));
  assert.ok(scans.length > 0, `managed Markdown scan summary missing\n${result.raw || result.stderr}`);
  return scans[0];
}

function reasonRecords(result, reason) {
  return findObjects(result.json, (item) => (
    item.reason === reason
    || (Array.isArray(item.reasons) && item.reasons.includes(reason))
    || item.path_kind === reason
    || item.locator_kind === reason
  ));
}

function writeEvidenceIndex(root, rows, headers = null) {
  writeIndex(
    root,
    "证据库/总索引/证据总目录.md",
    "证据总目录",
    headers || ["evidence-id", "run_id", "task_id", "来源", "摘要", "路径", "采纳状态"],
    rows,
  );
}

function writeMaterialIndex(root, rows, withLocatorKind = true) {
  writeIndex(
    root,
    "项目物料/INDEX.md",
    "项目物料索引",
    withLocatorKind
      ? ["material-id", "路径", "hash", "来源", "用途", "状态", "locator-kind"]
      : ["material-id", "路径", "hash", "来源", "用途", "状态"],
    rows,
  );
}

function materialRow(id, locator, hash, locatorKind = "") {
  return [id, locator, hash, "本地回归", "v0.3.8 兼容测试", "active", locatorKind];
}

lr("LR45", "非文件 locator 不属于普通 managed Markdown 承诺", (t) => {
  const root = fixture(t, "lr45-intentional-non-files");
  write(root, "项目物料/archive/nested/ignored.md", "x".repeat((2 * 1024 * 1024) + 1));
  writeMaterialIndex(root, [
    materialRow("MAT-20260828-001", "https://127.0.0.1:9/not-requested", "-", "external_uri"),
    materialRow("MAT-20260828-002", "C:\\Historical\\archive.zip", "-", "absolute_reference"),
    materialRow("MAT-20260828-003", "legacy host upload bundle #42", "-", "historical_identity"),
    materialRow("MAT-20260828-004", "项目物料/archive", "-", "directory"),
  ]);

  const inspected = inspect(root);
  assert.equal(inspected.status, 0, inspected.raw);
  const snapshot = decisionSnapshot(inspected);
  assert.equal(snapshot.hard_issues_complete, true);
  assert.equal(snapshot.coverage_issues_complete, true);
  assert.equal(hasSignal(snapshot, "managed_file_not_checked"), false);

  const verified = verifyMaterials(root);
  assertRejected(verified, "intentional non-file locators are unverifiable, not matched files");
  for (const reason of ["external", "absolute", "intentional_unverifiable", "directory_not_hashable"]) {
    assert.ok(reasonRecords(verified, reason).length > 0 || hasSignal(verified.json, reason), `${reason}\n${verified.raw}`);
  }
});

lr("LR46", "安全本地 Markdown 超限必须降低 completeness", (t) => {
  const root = fixture(t, "lr46-local-markdown-too-large");
  const rel = "项目物料/oversized.md";
  write(root, rel, "x".repeat((2 * 1024 * 1024) + 1));
  writeMaterialIndex(root, [materialRow("MAT-20260828-046", rel, sha256File(path.join(root, rel)), "file")]);

  const result = inspect(root);
  assertRejected(result, "registered local Markdown over the read limit must be incomplete");
  const snapshot = decisionSnapshot(result);
  assert.equal(snapshot.hard_issues_complete, false);
  assert.ok(hasSignal(snapshot, "file_too_large"), result.raw);
});

lr("LR57", "摘要中的 EV 文本不能补齐空正式编号", (t) => {
  const root = fixture(t, "lr57-summary-is-not-definition");
  const id = "EV-20260828-057";
  writeEvidenceIndex(root, [["", "run", "task", "本地", `摘要提到 ${id}`, "证据库/lr57.md", "active"]]);
  write(root, "证据库/lr57.md", "# LR57\n");
  fs.appendFileSync(path.join(root, "TODO.md"), `\n- 引用 ${id}\n`, "utf8");

  const result = validate(root);
  assertRejected(result, "empty evidence-id must not be defined by summary text");
  assertSignal(result, "index_id_required");
  assertSignal(result, id, "unresolved reference must retain the canonical ID");
  assertSignal(result, "unresolved", "reference must remain unresolved");
});

lr("LR58", "evidence-id 的前缀和格式必须严格", (t) => {
  const roots = [];
  t.after(() => roots.forEach(removeProject));
  for (const [name, badId] of [["wrong-prefix", "M-20260828-058"], ["wrong-format", "EV-20260828-58"]]) {
    const root = createProject(`lr58-${name}`);
    roots.push(root);
    writeEvidenceIndex(root, [[badId, "run", "task", "本地", "错误编号", "证据库/lr58.md", "active"]]);
    write(root, "证据库/lr58.md", "# LR58\n");
    const result = validate(root);
    assertRejected(result, `${badId} must be rejected`);
    assertSignal(result, "index_id_invalid");
  }
});

lr("LR59", "重复正式 ID 必须保留 multiset 计数并阻断", (t) => {
  const root = fixture(t, "lr59-duplicate-formal-id");
  const id = "EV-20260828-059";
  writeEvidenceIndex(root, [
    [id, "run-a", "task-a", "本地", "A", "证据库/a.md", "active"],
    [id, "run-b", "task-b", "本地", "B", "证据库/b.md", "active"],
  ]);
  write(root, "证据库/a.md", "# A\n");
  write(root, "证据库/b.md", "# B\n");

  const result = validate(root);
  assertRejected(result, "duplicate canonical definitions must block validation");
  assertAnySignal(result, ["index_id_duplicate", "definition_id_collision"], "duplicate ID code missing");
  const records = findObjects(result.json, (item) => item.id === id || item.definition_id === id);
  assert.ok(records.some((item) => (
    item.count === 2
    || item.occurrence_count === 2
    || item.locations?.length === 2
    || item.rows?.length === 2
  )), `duplicate multiset count was lost\n${result.raw}`);
});

lr("LR60", "两个安全 <br> 路径必须分别登记和扫描", (t) => {
  const root = fixture(t, "lr60-two-safe-paths");
  const baseline = inspect(root);
  assert.equal(baseline.status, 0, baseline.raw);
  const baselineCount = markdownScan(baseline).files_scanned;
  write(root, "证据库/lr60-a.md", "# A\n");
  write(root, "证据库/lr60-b.md", "# B\n");
  writeEvidenceIndex(root, [[
    "EV-20260828-060", "run", "task", "本地", "双路径",
    "`证据库/lr60-a.md`<br>`证据库/lr60-b.md`", "active",
  ]]);

  const result = inspect(root);
  assert.equal(result.status, 0, result.raw);
  assert.equal(markdownScan(result).files_scanned, baselineCount + 2, result.raw);
});

lr("LR61", "混合安全和越界 token 时只登记安全项且整行 degraded", (t) => {
  const root = fixture(t, "lr61-mixed-safe-unsafe");
  const baseline = inspect(root);
  const baselineCount = markdownScan(baseline).files_scanned;
  write(root, "证据库/lr61-safe.md", "# SAFE\n");
  const outside = path.join(path.dirname(root), "outside.md");
  fs.writeFileSync(outside, "OUTSIDE_LR61_SECRET\n", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  writeEvidenceIndex(root, [[
    "EV-20260828-061", "run", "task", "本地", "混合路径",
    "`证据库/lr61-safe.md`<br>`../outside.md`", "active",
  ]]);

  const result = inspect(root);
  assertRejected(result, "unsafe token must degrade the row");
  assertSignal(result, "index_entry_path_invalid");
  assertSignal(result, "index_entry_path_degraded");
  assert.equal(markdownScan(result).files_scanned, baselineCount + 1, result.raw);
  assert.doesNotMatch(result.raw, /OUTSIDE_LR61_SECRET/);
});

lr("LR62", "历史或证据绝对路径必须脱敏且不能 fully resolved", (t) => {
  const root = fixture(t, "lr62-absolute-index-path");
  const outside = path.join(os.tmpdir(), "LR62-Sensitive-Customer-Evidence.md");
  fs.writeFileSync(outside, "LR62_ABSOLUTE_SECRET\n", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  writeEvidenceIndex(root, [["EV-20260828-062", "run", "task", "本地", "绝对路径", outside, "active"]]);

  const result = inspect(root);
  assertRejected(result, "absolute index path must be degraded");
  assertSignal(result, "index_entry_path_invalid");
  assertSignal(result, "index_entry_path_degraded");
  assert.doesNotMatch(result.raw, /LR62-Sensitive-Customer-Evidence|LR62_ABSOLUTE_SECRET/);
  assert.equal(hasSignal(result.json, "fully_resolved"), false, result.raw);
});

lr("LR63", "索引路径经 symlink 或 junction 时拒绝且不读取", (t) => {
  const root = fixture(t, "lr63-index-junction");
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-lr63-external-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  write(external, "secret.md", "LR63_REDIRECT_SECRET\n");
  fs.mkdirSync(path.join(root, "证据库"), { recursive: true });
  const link = path.join(root, "证据库", "linked");
  try {
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`PENDING: symlink/junction fixture unavailable: ${error.code || error.message}`);
    return;
  }
  writeEvidenceIndex(root, [[
    "EV-20260828-063", "run", "task", "本地", "重定向", "证据库/linked/secret.md", "active",
  ]]);

  const result = inspect(root);
  assertRejected(result, "redirected index token must be rejected");
  assertSignal(result, "index_entry_path_invalid");
  assertSignal(result, "index_entry_path_degraded");
  assert.doesNotMatch(result.raw, /LR63_REDIRECT_SECRET/);
});

lr("LR64", "未知 locator-kind 必须结构化拒绝", (t) => {
  const root = fixture(t, "lr64-unknown-locator-kind");
  writeMaterialIndex(root, [materialRow("MAT-20260828-064", "项目物料/a.bin", "-", "mystery_kind")]);
  const result = verifyMaterials(root);
  assertRejected(result, "unknown locator-kind must fail");
  assertSignal(result, "material_locator_kind_invalid");
});

lr("LR65", "显式 file 的正确 hash 匹配且 Markdown 进入 managed scan", (t) => {
  const root = fixture(t, "lr65-file-locator");
  const baseline = inspect(root);
  const baselineCount = markdownScan(baseline).files_scanned;
  const rel = "项目物料/lr65.md";
  const payload = "# LR65\nfile locator\n";
  write(root, rel, payload);
  writeMaterialIndex(root, [materialRow("MAT-20260828-065", rel, sha256(payload), "file")]);

  const verified = verifyMaterials(root);
  assert.equal(verified.status, 0, verified.raw);
  assert.equal(verified.json.matched_count, 1, verified.raw);
  const inspected = inspect(root);
  assert.equal(inspected.status, 0, inspected.raw);
  assert.equal(markdownScan(inspected).files_scanned, baselineCount + 1, inspected.raw);
});

lr("LR115", "非法 material-id 不得凭正确文件和 hash 冒充完整核验", (t) => {
  const root = fixture(t, "lr115-invalid-material-id");
  const rel = "项目物料/lr115.bin";
  const payload = "LR115\n";
  write(root, rel, payload);
  writeMaterialIndex(root, [materialRow("BAD-ID", rel, sha256(payload), "file")]);
  const result = verifyMaterials(root);
  assertRejected(result, "invalid material-id must block verify-materials");
  assert.equal(result.json?.complete, false, result.raw);
  assert.equal(result.json?.matched_count, 0, result.raw);
  assertSignal(result, "material_id_invalid");
});

lr("LR66", "存在目录不递归 hash 或扫描", (t) => {
  const root = fixture(t, "lr66-directory-locator");
  const baseline = inspect(root);
  const baselineCount = markdownScan(baseline).files_scanned;
  write(root, "项目物料/lr66-dir/nested/ignored.md", "x".repeat((2 * 1024 * 1024) + 1));
  writeMaterialIndex(root, [materialRow("MAT-20260828-066", "项目物料/lr66-dir", "-", "directory")]);

  const verified = verifyMaterials(root);
  assertRejected(verified, "directory locator is intentionally not hashable");
  assertSignal(verified, "directory_not_hashable");
  assertSignal(verified, "project_relative_directory");
  const inspected = inspect(root);
  assert.equal(inspected.status, 0, inspected.raw);
  assert.equal(markdownScan(inspected).files_scanned, baselineCount, inspected.raw);
});

lr("LR67", "缺失的显式目录按 directory_missing 报告", (t) => {
  const root = fixture(t, "lr67-missing-directory");
  writeMaterialIndex(root, [materialRow("MAT-20260828-067", "项目物料/missing-dir", "-", "directory")]);
  const result = verifyMaterials(root);
  assertRejected(result, "missing declared directory must not be guessed as a file");
  assertSignal(result, "directory_missing");
  assertSignal(result, "project_relative_missing_directory");
});

lr("LR68", "目录 locator 指向 symlink 或 junction 时不遍历", (t) => {
  const root = fixture(t, "lr68-directory-junction");
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-lr68-external-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  write(external, "secret.md", "LR68_DIRECTORY_REDIRECT_SECRET\n");
  const link = path.join(root, "项目物料", "redirected-dir");
  try {
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`PENDING: symlink/junction fixture unavailable: ${error.code || error.message}`);
    return;
  }
  writeMaterialIndex(root, [materialRow("MAT-20260828-068", "项目物料/redirected-dir", "-", "directory")]);

  const result = verifyMaterials(root);
  assertRejected(result, "redirected directory must be rejected");
  assertAnySignal(result, ["symlink", "junction", "redirect"], "directory redirect code missing");
  assert.doesNotMatch(result.raw, /LR68_DIRECTORY_REDIRECT_SECRET/);
});

lr("LR69", "historical_identity 保留单个 MAT ID 且 intentional_unverifiable", (t) => {
  const root = fixture(t, "lr69-historical-identity");
  const id = "MAT-20260828-069";
  writeMaterialIndex(root, [materialRow(id, "legacy upload bundle #2024-09", "-", "historical_identity")]);
  const result = verifyMaterials(root);
  assertRejected(result, "historical identity is intentionally unverifiable");
  assertSignal(result, "intentional_unverifiable");
  const records = findObjects(result.json, (item) => item.material_id === id);
  assert.equal(records.length, 1, result.raw);
  assert.equal((result.json.indexed_count ?? 1), 1, result.raw);
});

lr("LR70", "未标记的多个独立 locator 必须 ambiguous_multiple", (t) => {
  const root = fixture(t, "lr70-ambiguous-multiple");
  write(root, "项目物料/lr70-a.bin", "A");
  write(root, "项目物料/lr70-b.bin", "B");
  writeMaterialIndex(root, [[
    "MAT-20260828-070",
    "`项目物料/lr70-a.bin`<br>`项目物料/lr70-b.bin`",
    "-", "本地回归", "歧义", "active",
  ]], false);
  const result = verifyMaterials(root);
  assertRejected(result, "multiple unmarked locators must not be guessed");
  assertSignal(result, "ambiguous_multiple");
  assert.equal(result.json.checked_count ?? 0, 0, result.raw);
});

lr("LR71", "external URI 不得联网", async (t) => {
  const root = fixture(t, "lr71-no-network");
  const probe = await startHttpProbe(root);
  t.after(() => probe.stop());
  writeMaterialIndex(root, [materialRow("MAT-20260828-071", probe.url, "-", "external_uri")]);
  const result = verifyMaterials(root);
  assertRejected(result, "external URI is not locally verifiable");
  assertAnySignal(result, ["external", "unverifiable"], "external classification missing");
  assert.equal(probe.hits(), 0, "verify-materials made a network request");
});

lr("LR72", "absolute_reference 不读取并脱敏", (t) => {
  const root = fixture(t, "lr72-absolute-reference");
  const outside = path.join(os.tmpdir(), "LR72-Private-Archive.bin");
  fs.writeFileSync(outside, "LR72_PRIVATE_BYTES", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  writeMaterialIndex(root, [materialRow("MAT-20260828-072", outside, "-", "absolute_reference")]);
  const result = verifyMaterials(root);
  assertRejected(result, "absolute reference is not read");
  assertAnySignal(result, ["absolute_reference", "absolute_path_not_verified"], "absolute classification missing");
  assert.doesNotMatch(result.raw, /LR72-Private-Archive|LR72_PRIVATE_BYTES/);
  assert.ok(findObjects(result.json, (item) => item.path_redacted === true).length > 0, result.raw);
});

lr("LR73", "unsafe relative locator 永不读取", (t) => {
  const root = fixture(t, "lr73-unsafe-relative");
  const outside = path.join(path.dirname(root), "secret.bin");
  fs.writeFileSync(outside, "LR73_SECRET_BYTES", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  writeMaterialIndex(root, [[
    "MAT-20260828-073", "../secret.bin", sha256("LR73_SECRET_BYTES"), "本地回归", "越界", "active",
  ]], false);
  const result = verifyMaterials(root);
  assertRejected(result, "unsafe relative path must be rejected");
  assertSignal(result, "unsafe_relative_path");
  assert.doesNotMatch(result.raw, /LR73_SECRET_BYTES/);
});

lr("LR74", "非文件 locator 的 hash '-' 不误报 hash_missing", (t) => {
  const root = fixture(t, "lr74-non-file-hash-dash");
  writeMaterialIndex(root, [materialRow("MAT-20260828-074", "legacy package identity", "-", "historical_identity")]);
  const result = verifyMaterials(root);
  assertRejected(result, "historical identity remains intentionally unverifiable");
  assertSignal(result, "intentional_unverifiable");
  assert.equal(hasSignal(result.json, "hash_missing"), false, result.raw);
});

lr("LR75", "历史复合行保留单 ID，但明显当前多 locator 不能借 historical_identity 放行", (t) => {
  const root = fixture(t, "lr75-classification-evidence");
  write(root, "项目物料/current-a.bin", "A");
  write(root, "项目物料/current-b.bin", "B");
  writeMaterialIndex(root, [
    materialRow("MAT-20260828-075", "legacy release bundle #75", "-", "historical_identity"),
    materialRow(
      "MAT-20260828-076",
      "`项目物料/current-a.bin`<br>`项目物料/current-b.bin`",
      sha256("A"),
      "historical_identity",
    ),
  ]);
  const result = verifyMaterials(root);
  assertRejected(result, "current independently addressable files remain ambiguous");
  assertSignal(result, "intentional_unverifiable");
  assertSignal(result, "ambiguous_multiple");
  const historical = findObjects(result.json, (item) => item.material_id === "MAT-20260828-075");
  assert.equal(historical.length, 1, result.raw);
});

lr("LR76", "真实 legacy ID freeze 必须与冻结现场逐 occurrence 一致", (t) => {
  const gate = migrationGate;
  if (gate.status !== "ready") {
    t.skip(gate.reason);
    return;
  }
  const summary = verifyLegacyFreezeEnumeration(gate);
  const scope = verifyDeterministicLegacyScanScope(gate);
  const mapping = verifyLegacyMappingCoverage(gate);
  assert.ok(summary.unique_id_count >= 0);
  assert.ok(summary.occurrence_count >= summary.unique_id_count);
  assert.equal(mapping.occurrence_count, summary.occurrence_count);
  assert.ok(scope.before.path_count >= scope.occurrence_files.length);
});

lr("LR77", "canonical 迁移使用正式 M/EV/MAT 并保留 legacy-id", (t) => {
  const root = fixture(t, "lr77-canonical-with-legacy-metadata");
  writeIndex(
    root,
    "历史记录/00-历史总目录.md",
    "历史总目录",
    ["history-id", "legacy-id", "日期", "标题", "路径", "状态"],
    [["M-20260828-001", "D-20260701-001", "2026-08-28", "迁移", "历史记录/M-20260828-001.md", "active"]],
  );
  write(root, "历史记录/M-20260828-001.md", "# M-20260828-001\n\n旧编号 D-20260701-001。\n");
  writeEvidenceIndex(root, [[
    "EV-20260828-001", "run", "task", "本地", "迁移证据", "证据库/EV-20260828-001.md", "active",
    "E-20260701-001",
  ]], ["evidence-id", "run_id", "task_id", "来源", "摘要", "路径", "采纳状态", "legacy-id"]);
  write(root, "证据库/EV-20260828-001.md", "# EV-20260828-001\n");
  write(root, "项目物料/lr77.bin", "LR77");
  writeMaterialIndex(root, [materialRow("MAT-20260828-001", "项目物料/lr77.bin", sha256("LR77"), "file")]);
  const result = validate(root);
  assert.equal(result.status, 0, result.raw);
  const allocated = ids(root);
  assert.equal(allocated.status, 0, allocated.raw);
  assert.doesNotMatch(JSON.stringify(allocated.json.ids), /[DE]-\d{8}/);
});

lr("LR78", "legacy-id、摘要和旧文件名不参与 definitions 或 max ID", (t) => {
  const root = fixture(t, "lr78-legacy-text-is-metadata");
  writeIndex(
    root,
    "历史记录/00-历史总目录.md",
    "历史总目录",
    ["history-id", "legacy-id", "日期", "标题", "路径", "状态"],
    [["M-20260828-001", "D-20991231-999", "2026-08-28", "摘要 E-20991231-999", "历史记录/D-20991231-999.md", "active"]],
  );
  write(root, "历史记录/D-20991231-999.md", "# 历史文件名\n\nD-20991231-999 E-20991231-999\n");
  const result = ids(root, "20260828");
  assert.equal(result.status, 0, result.raw);
  const values = collectSignalStrings(result.json.ids);
  assert.ok(values.includes("M-20260828-002"), result.raw);
  assert.equal(values.some((item) => /^[DE]-/.test(item)), false, result.raw);
});

lr("LR79", "运行时不猜逗号或分号多路径，迁移后只接受 <br>", (t) => {
  const root = fixture(t, "lr79-no-legacy-path-guessing");
  const baseline = inspect(root);
  const baselineCount = markdownScan(baseline).files_scanned;
  write(root, "证据库/lr79-a.md", "# A\n");
  write(root, "证据库/lr79-b.md", "# B\n");
  writeEvidenceIndex(root, [[
    "EV-20260828-079", "run", "task", "本地", "旧分隔",
    "证据库/lr79-a.md, 证据库/lr79-b.md", "active",
  ]]);
  const result = inspect(root);
  assertRejected(result, "legacy comma separator must be migrated, not guessed at runtime");
  assertAnySignal(
    result,
    ["legacy_multi_path_separator_not_supported", "legacy_multi_path_separator", "ambiguous_multiple"],
    "legacy path separator rejection missing",
  );
  assert.equal(markdownScan(result).files_scanned, baselineCount, result.raw);
});

lr("LR80", "真实迁移前必须有冻结副本演练证据", (t) => {
  const gate = migrationGate;
  if (gate.status !== "ready") {
    t.skip(gate.reason);
    return;
  }
  const rehearsal = gate.migrationPlan.rehearsal;
  assert.ok(rehearsal && typeof rehearsal === "object", "migration-plan.json rehearsal evidence missing");
  for (const field of [
    "completed", "used_frozen_copy", "validate_ok", "references_ok",
    "material_classification_ok", "rollback_ok", "completed_before_live_migration",
  ]) {
    assert.equal(rehearsal[field], true, `rehearsal.${field} must be true`);
  }
  const observed = verifyAffectedMigrationManifests(gate);
  assert.equal(rehearsal.rollback_ok, observed.before.manifest_digest === observed.failureRestore.manifest_digest);
});

lr("LR81", "真实迁移失败注入必须由独立项目数据备份完整恢复", (t) => {
  const gate = migrationGate;
  if (gate.status !== "ready") {
    t.skip(gate.reason);
    return;
  }
  const recovery = gate.migrationPlan.failure_injection;
  assert.ok(recovery && typeof recovery === "object", "migration failure injection evidence missing");
  assert.equal(recovery.attempted, true);
  assert.equal(recovery.restored_from_project_data_backup, true);
  assert.equal(recovery.source_freeze_used, false);
  assert.match(recovery.before_manifest_digest || "", /^[a-f0-9]{64}$/);
  assert.equal(recovery.after_restore_manifest_digest, recovery.before_manifest_digest);
  assert.match(recovery.baseline_digest_before || "", /^[a-f0-9]{64}$/);
  assert.equal(recovery.baseline_digest_after, recovery.baseline_digest_before);
  const observed = verifyAffectedMigrationManifests(gate);
  assert.equal(recovery.before_manifest_digest, observed.before.manifest_digest);
  assert.equal(recovery.after_restore_manifest_digest, observed.failureRestore.manifest_digest);
});

lr("LR82", "真实迁移完成证据必须闭合 mapping、manifest、引用与最终验证", (t) => {
  const gate = migrationGate;
  if (gate.status !== "ready") {
    t.skip(gate.reason);
    return;
  }
  const manifest = gate.migrationManifest;
  const observed = verifyAffectedMigrationManifests(gate);
  const mapping = verifyLegacyMappingCoverage(gate);
  assert.equal(manifest.schema_version, 1);
  assert.equal(normalizeRel(path.resolve(manifest.project_root)).toLowerCase(), normalizeRel(gate.paths.projectRoot).toLowerCase());
  for (const field of [
    "baseline_digest_before", "affected_files_before_digest",
    "affected_files_after_digest", "baseline_digest_after",
  ]) {
    assert.match(manifest[field] || "", /^[a-f0-9]{64}$/, `${field} missing or invalid`);
  }
  assert.equal(manifest.affected_files_before_digest, observed.before.manifest_digest);
  assert.equal(manifest.affected_files_after_digest, observed.after.manifest_digest);
  assert.ok(Array.isArray(manifest.legacy_ids));
  for (const item of manifest.legacy_ids) {
    assert.match(item.legacy_id || "", /^[DE]-/);
    assert.match(item.canonical_id || "", /^(?:M|EV|MAT)-\d{8}(?:-[A-Z0-9]+)*-\d{3}$/);
    assert.ok(Array.isArray(item.definition_locations));
    assert.ok(Array.isArray(item.reference_locations));
    assert.ok(Array.isArray(item.renamed_files));
  }
  const actual = gate.migrationPlan.actual_migration;
  assert.ok(actual && typeof actual === "object", "actual migration evidence missing");
  for (const field of [
    "completed", "before_after_manifest_complete", "legacy_mapping_complete",
    "reference_scan_ok", "material_classification_ok", "final_inspect_ok", "final_validate_ok",
  ]) {
    assert.equal(actual[field], true, `actual_migration.${field} must be true`);
  }
  assert.ok(Array.isArray(actual.project_gov_scope_paths));
  assert.ok(Array.isArray(actual.ordinary_editor_scope_paths));
  for (const rel of [...actual.project_gov_scope_paths, ...actual.ordinary_editor_scope_paths]) {
    assert.doesNotMatch(normalizeRel(rel), /(^|\/)\.workbuddy(\/|$)|workbuddy/i);
  }
  const finalLegacy = verifyFinalLegacyMetadataOnly(gate);
  assert.deepEqual(finalLegacy.unique_ids, mapping.legacy_ids);
  const currentLegacy = verifyCurrentLegacyMetadataOnly(gate);
  assert.ok(currentLegacy.path_count >= currentLegacy.occurrence_count);
  const live = verifyRealProjectWithCurrentSource(gate);
  assert.equal(live.inspected.json?.ok, true);
  const refresh = manifest.post_migration_evidence_refresh;
  if (refresh) {
    assert.equal(refresh.original_migration_snapshot_preserved, true);
    assert.equal(refresh.migration_mapping_changed, false);
    assert.deepEqual(actual.post_migration_evidence_refresh, {
      reason: refresh.reason,
      original_migration_snapshot_preserved: true,
      migration_mapping_changed: false,
    });
  }
});

assert.deepEqual([...registered].sort(), [...expected].sort(), "LR45-46/LR57-82 registration is incomplete");

if (migrationGateRequired && migrationGate.status !== "ready") {
  process.stderr.write(`${JSON.stringify({
    suite: "project-gov-v038-index-compat",
    overall: "PENDING",
    reason: migrationGate.reason,
    required_migration_gate: true,
  })}\n`);
  process.exitCode = 2;
}
