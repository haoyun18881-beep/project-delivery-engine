import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import {
  buildTypedIndexModel,
  createInspectionContext,
} from "../../scripts/project-gov.mjs";

export const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const projectGovScript = path.join(skillRoot, "scripts", "project-gov.mjs");

const LEGACY_ID_SOURCE = String.raw`(?<![A-Za-z0-9_])([DE]-(?:\d{6}|\d{8})(?:-[A-Z0-9]+)*-\d{3})(?![A-Za-z0-9_-])`;
const LEGACY_TEXT_EXTENSIONS = new Set([
  ".cjs", ".js", ".json", ".jsonl", ".md", ".mjs", ".ps1", ".toml", ".txt", ".yaml", ".yml",
]);
const ENUMERATION_SKIP_DIRECTORIES = new Set([".git", ".project-gov", "node_modules"]);
const MAX_ENUMERATED_TEXT_BYTES = 4 * 1024 * 1024;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LEGACY_SCAN_FIXED_PATHS = [
  "AGENTS.md",
  "PROJECT_START_HERE.md",
  "STATUS.md",
  "TODO.md",
  "HANDOFF.md",
  "历史记录/00-历史总目录.md",
  "证据库/总索引/证据总目录.md",
  "项目物料/INDEX.md",
];
const LEGACY_SCAN_EXCLUDED_SEGMENTS = new Set([".git", ".project-gov", "node_modules"]);
const LEGACY_SCAN_EXCLUDED_PREFIXES = ["项目物料/输出产物"];

function sanitizeName(value) {
  return String(value || "fixture").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

export function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, Buffer.isBuffer(content) ? undefined : "utf8");
  return abs;
}

export function mutate(root, rel, transform) {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, transform(fs.readFileSync(abs, "utf8")), "utf8");
}

export function createProject(name = "fixture") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `project-gov-v038-${sanitizeName(name)}-`));
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

export function removeProject(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function markdownTable(headers, rows) {
  const separator = headers.map(() => "---");
  return [headers, separator, ...rows]
    .map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`)
    .join("\n") + "\n";
}

export function writeIndex(root, rel, title, headers, rows) {
  write(root, rel, `# ${title}\n\n${markdownTable(headers, rows)}`);
}

function parseJsonOutput(result) {
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const candidates = [stdout, stderr].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { json: JSON.parse(candidate), raw: candidate };
    } catch {
      // Return the raw process output below so the assertion reports the real signal.
    }
  }
  return { json: null, raw: candidates.join("\n") };
}

export function runProjectGov(command, root, extra = [], options = {}) {
  const result = spawnSync(
    process.execPath,
    [projectGovScript, command, "--root", root, ...extra, "--json"],
    {
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      timeout: options.timeout || 30_000,
    },
  );
  const parsed = parseJsonOutput(result);
  return { ...result, ...parsed };
}

export function inspect(root) {
  return runProjectGov("inspect", root);
}

export function validate(root) {
  return runProjectGov("validate", root);
}

export function ids(root, date = "20260828") {
  return runProjectGov("ids", root, ["--date", date]);
}

export function verifyMaterials(root) {
  return runProjectGov("verify-materials", root);
}

export function propose(root, planId, actions = [], knowledgeReview = null) {
  const operation = write(root, `${planId}.operation.json`, `${JSON.stringify({
    schema_version: 2,
    plan_id: planId,
    knowledge_review: knowledgeReview || {
      status: "none",
      basis: "回归夹具未产生可跨任务复用的已核实知识。",
    },
    actions,
  }, null, 2)}\n`);
  const out = path.join(root, ".project-gov", "plans", `${planId}.json`);
  return {
    ...runProjectGov("propose", root, ["--plan", operation, "--out", out]),
    operation,
    out,
  };
}

export function apply(compiledPlan) {
  const result = spawnSync(process.execPath, [projectGovScript, "apply", "--plan", compiledPlan, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  const parsed = parseJsonOutput(result);
  return { ...result, ...parsed };
}

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(abs) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

export function collectSignalStrings(value, target = []) {
  if (typeof value === "string") {
    target.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSignalStrings(item, target);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSignalStrings(item, target);
  }
  return target;
}

export function hasSignal(value, expected) {
  return collectSignalStrings(value).some((item) => item.includes(expected));
}

export function findObjects(value, predicate, target = []) {
  if (Array.isArray(value)) {
    for (const item of value) findObjects(item, predicate, target);
  } else if (value && typeof value === "object") {
    if (predicate(value)) target.push(value);
    for (const item of Object.values(value)) findObjects(item, predicate, target);
  }
  return target;
}

export function findDecisionSnapshots(value) {
  return findObjects(value, (item) => (
    item.schema_version === 2
    && item.decision_policy_version === 2
    && Array.isArray(item.hard_issues)
    && Array.isArray(item.coverage_issues)
    && item.five_piece
  ));
}

export function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function assertNoWorkBuddyPath(value, label = "path") {
  assert.doesNotMatch(normalizeRel(value), /(^|\/)\.workbuddy(\/|$)|workbuddy/i, `${label} entered forbidden WorkBuddy scope`);
}

function walkFiles(root) {
  const files = [];
  const errors = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: normalizeRel(path.relative(root, dir)), code: error.code || "read_failed" });
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (ENUMERATION_SKIP_DIRECTORIES.has(entry.name) && entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(root, abs));
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch (error) {
        errors.push({ path: rel, code: error.code || "lstat_failed" });
        continue;
      }
      if (stat.isSymbolicLink()) {
        errors.push({ path: rel, code: "redirect_not_followed" });
      } else if (stat.isDirectory()) {
        stack.push(abs);
      } else if (stat.isFile()) {
        files.push({ abs, rel, bytes: stat.size });
      }
    }
  }
  return { files, errors };
}

function legacyScanPathExcluded(rel, extraPrefixes = []) {
  const normalized = normalizeRel(rel);
  const segments = normalized.split("/");
  if (segments.some((segment) => LEGACY_SCAN_EXCLUDED_SEGMENTS.has(segment))) return true;
  return [...LEGACY_SCAN_EXCLUDED_PREFIXES, ...extraPrefixes]
    .some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function validateLegacyScanRel(rel, extraPrefixes = []) {
  const normalized = normalizeRel(rel);
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) return null;
  if (!normalized.toLowerCase().endsWith(".md") || legacyScanPathExcluded(normalized, extraPrefixes)) return null;
  return normalized;
}

function checkNoRedirect(root, rel, expectedKind = "file") {
  const normalized = normalizeRel(rel);
  let current = path.resolve(root);
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return { ok: false, code: error.code || "lstat_failed" };
    }
    if (stat.isSymbolicLink()) return { ok: false, code: "redirect_not_followed" };
  }
  const stat = fs.lstatSync(current);
  if (expectedKind === "file" && !stat.isFile()) return { ok: false, code: "not_regular_file" };
  if (expectedKind === "directory" && !stat.isDirectory()) return { ok: false, code: "not_directory" };
  return { ok: true, abs: current, stat };
}

function collectDirectoryCatalogs(projectRoot, relRoot, matcher, candidates, errors, extraPrefixes = []) {
  const start = path.join(projectRoot, ...normalizeRel(relRoot).split("/"));
  const startCheck = checkNoRedirect(projectRoot, relRoot, "directory");
  if (!startCheck.ok) {
    errors.push({ path: normalizeRel(relRoot), code: startCheck.code });
    return;
  }
  const stack = [start];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
    } catch (error) {
      errors.push({ path: normalizeRel(path.relative(projectRoot, dir)), code: error.code || "read_failed" });
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(projectRoot, abs));
      if (legacyScanPathExcluded(rel, extraPrefixes)) continue;
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch (error) {
        errors.push({ path: rel, code: error.code || "lstat_failed" });
        continue;
      }
      if (stat.isSymbolicLink()) {
        errors.push({ path: rel, code: "redirect_not_followed" });
        continue;
      }
      if (stat.isDirectory()) stack.push(abs);
      else if (stat.isFile() && matcher(entry.name, rel)) candidates.add(rel);
    }
  }
}

function collectOneLevelMarkdown(projectRoot, relRoot, candidates, errors, extraPrefixes = []) {
  const absRoot = relRoot ? path.join(projectRoot, ...normalizeRel(relRoot).split("/")) : projectRoot;
  if (relRoot) {
    const rootCheck = checkNoRedirect(projectRoot, relRoot, "directory");
    if (!rootCheck.ok) {
      errors.push({ path: normalizeRel(relRoot), code: rootCheck.code });
      return;
    }
  }
  let entries;
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  } catch (error) {
    errors.push({ path: normalizeRel(relRoot), code: error.code || "read_failed" });
    return;
  }
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const rel = normalizeRel(relRoot ? `${normalizeRel(relRoot)}/${entry.name}` : entry.name);
    if (legacyScanPathExcluded(rel, extraPrefixes)) continue;
    let stat;
    try {
      stat = fs.lstatSync(path.join(absRoot, entry.name));
    } catch (error) {
      errors.push({ path: rel, code: error.code || "lstat_failed" });
      continue;
    }
    if (stat.isSymbolicLink()) errors.push({ path: rel, code: "redirect_not_followed" });
    else if (stat.isFile()) candidates.add(rel);
  }
}

function normalizeOverrideMap(overrides) {
  const result = new Map();
  for (const [rawRel, rawValue] of overrides instanceof Map ? overrides : Object.entries(overrides || {})) {
    const rel = validateLegacyScanRel(rawRel);
    assert.ok(rel, `invalid legacy scan override path: ${rawRel}`);
    const value = Buffer.isBuffer(rawValue) ? rawValue : fs.readFileSync(rawValue);
    result.set(rel, value);
  }
  return result;
}

export function buildDeterministicLegacyScanScope(projectRoot, options = {}) {
  assertNoWorkBuddyPath(projectRoot, "legacy scan project root");
  const root = path.resolve(projectRoot);
  const evidenceRoot = options.currentEvidenceRoot ? path.resolve(options.currentEvidenceRoot) : null;
  const rawEvidenceRel = evidenceRoot ? normalizeRel(path.relative(root, evidenceRoot)) : null;
  const evidenceRel = rawEvidenceRel && rawEvidenceRel !== "." && !path.isAbsolute(rawEvidenceRel)
    && !rawEvidenceRel.split("/").includes("..") ? rawEvidenceRel : null;
  const extraPrefixes = evidenceRel ? [evidenceRel] : [];
  const overrides = normalizeOverrideMap(options.overrides || new Map());
  const candidates = new Set(LEGACY_SCAN_FIXED_PATHS);
  const errors = [];
  let rootUsable = true;

  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) {
      rootUsable = false;
      errors.push({ path: ".", code: "redirect_not_followed" });
    } else if (!rootStat.isDirectory()) {
      rootUsable = false;
      errors.push({ path: ".", code: "not_directory" });
    }
  } catch (error) {
    rootUsable = false;
    errors.push({ path: ".", code: error.code || "lstat_failed" });
  }

  if (!rootUsable) {
    const paths = [];
    const files = [];
    return {
      scope_complete: false,
      errors,
      path_count: 0,
      paths,
      path_set_digest: canonicalDigest({ paths }),
      files,
      file_sources: [],
      manifest_digest: canonicalDigest({ schema_version: 1, files }),
      occurrences: [],
      unique_ids: [],
      current_evidence_project_relative_exclusion: evidenceRel,
    };
  }

  collectOneLevelMarkdown(root, "", candidates, errors, extraPrefixes);
  collectDirectoryCatalogs(root, "历史记录", (name) => /^00-.*总目录\.md$/u.test(name), candidates, errors, extraPrefixes);
  collectOneLevelMarkdown(root, "证据库/总索引", candidates, errors, extraPrefixes);

  const overlay = new Map([...overrides.entries()].map(([rel, bytes]) => [rel, { kind: "file", bytes }]));
  const context = createInspectionContext(root, { phase: options.phase || "legacy_scan", overlay });
  const indexModel = buildTypedIndexModel(context);
  for (const rawRel of indexModel.managedMarkdownPaths || []) {
    const rel = validateLegacyScanRel(rawRel, extraPrefixes);
    if (rel) candidates.add(rel);
  }

  const paths = [...candidates]
    .map((rel) => validateLegacyScanRel(rel, extraPrefixes))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en"));
  const files = [];
  const occurrences = [];
  const fileSources = [];
  for (const rel of paths) {
    const liveCheck = checkNoRedirect(root, rel);
    if (!liveCheck.ok) {
      errors.push({ path: rel, code: liveCheck.code });
      continue;
    }
    let bytes;
    let source = "live_project";
    try {
      if (overrides.has(rel)) {
        bytes = overrides.get(rel);
        source = "affected_files_before";
      } else {
        bytes = fs.readFileSync(liveCheck.abs);
      }
    } catch (error) {
      errors.push({ path: rel, code: error.code || "read_failed" });
      continue;
    }
    files.push({ path: rel, kind: "file", bytes: bytes.length, sha256: sha256(bytes) });
    fileSources.push({ path: rel, source });
    if (bytes.length > MAX_ENUMERATED_TEXT_BYTES) {
      errors.push({ path: rel, code: "text_file_too_large", limit_bytes: MAX_ENUMERATED_TEXT_BYTES, observed_bytes: bytes.length });
      continue;
    }
    let text;
    try {
      text = UTF8_FATAL_DECODER.decode(bytes);
    } catch {
      errors.push({ path: rel, code: "invalid_utf8" });
      continue;
    }
    if (bytes.includes(0)) {
      errors.push({ path: rel, code: "nul_byte_in_text_file" });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const match of legacyMatches(rel)) {
      occurrences.push({ legacy_id: match.legacy_id, path: rel, line: 0, column: match.index + 1, context_kind: "path" });
    }
    lines.forEach((line, lineIndex) => {
      for (const match of legacyMatches(line)) {
        occurrences.push({
          legacy_id: match.legacy_id,
          path: rel,
          line: lineIndex + 1,
          column: match.index + 1,
          context_kind: "content",
        });
      }
    });
  }
  errors.sort((left, right) => `${left.path}|${left.code}`.localeCompare(`${right.path}|${right.code}`, "en"));
  occurrences.sort((left, right) => occurrenceKey(left).localeCompare(occurrenceKey(right), "en"));
  const pathPayload = { paths };
  const manifestPayload = { schema_version: 1, files };
  return {
    scope_complete: errors.length === 0 && files.length === paths.length,
    errors,
    path_count: paths.length,
    paths,
    path_set_digest: canonicalDigest(pathPayload),
    files,
    file_sources: fileSources,
    manifest_digest: canonicalDigest(manifestPayload),
    occurrences,
    unique_ids: [...new Set(occurrences.map((item) => item.legacy_id))].sort(),
    current_evidence_project_relative_exclusion: evidenceRel,
  };
}

export function buildLegacyScanScopeDocument(projectRoot, beforeOverrides, currentEvidenceRoot = null) {
  const root = path.resolve(projectRoot);
  const evidenceRoot = currentEvidenceRoot ? path.resolve(currentEvidenceRoot) : null;
  const rawEvidenceRel = evidenceRoot ? normalizeRel(path.relative(root, evidenceRoot)) : null;
  const evidenceRel = rawEvidenceRel && rawEvidenceRel !== "." && !path.isAbsolute(rawEvidenceRel)
    && !rawEvidenceRel.split("/").includes("..") ? rawEvidenceRel : null;
  return {
    schema_version: 1,
    project_root: path.resolve(projectRoot),
    rules: {
      max_file_bytes: MAX_ENUMERATED_TEXT_BYTES,
      fixed_paths: [...LEGACY_SCAN_FIXED_PATHS],
      root_one_level_markdown: true,
      history_catalog_glob: "历史记录/**/00-*总目录.md",
      evidence_index_glob: "证据库/总索引/*.md",
      typed_index_safe_project_relative_markdown: true,
      excluded: [".git", ".project-gov", "node_modules", "项目物料/输出产物"],
      current_remediation_evidence: evidenceRel || "outside_project_root",
      redirects: "rejected_not_followed",
    },
    before: buildDeterministicLegacyScanScope(projectRoot, {
      phase: "legacy_scan_before",
      overrides: beforeOverrides,
      currentEvidenceRoot,
    }),
    final: buildDeterministicLegacyScanScope(projectRoot, { phase: "legacy_scan_final", currentEvidenceRoot }),
  };
}

function legacyMatches(source) {
  const regex = new RegExp(LEGACY_ID_SOURCE, "g");
  const matches = [];
  let match;
  while ((match = regex.exec(source))) matches.push({ legacy_id: match[1], index: match.index });
  return matches;
}

export function enumerateLegacyOccurrences(root) {
  assertNoWorkBuddyPath(root, "legacy enumeration root");
  const inventory = walkFiles(root);
  const occurrences = [];
  const errors = [...inventory.errors];
  for (const file of inventory.files) {
    for (const match of legacyMatches(file.rel)) {
      occurrences.push({
        legacy_id: match.legacy_id,
        path: file.rel,
        line: 0,
        column: match.index + 1,
        context_kind: "path",
      });
    }
    if (!LEGACY_TEXT_EXTENSIONS.has(path.extname(file.rel).toLowerCase())) continue;
    if (file.bytes > MAX_ENUMERATED_TEXT_BYTES) {
      errors.push({ path: file.rel, code: "text_file_too_large" });
      continue;
    }
    let text;
    try {
      const buffer = fs.readFileSync(file.abs);
      text = UTF8_FATAL_DECODER.decode(buffer);
      if (buffer.includes(0)) {
        errors.push({ path: file.rel, code: "nul_byte_in_text_file" });
        continue;
      }
    } catch (error) {
      errors.push({
        path: file.rel,
        code: error instanceof TypeError ? "invalid_utf8" : (error.code || "read_failed"),
      });
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      for (const match of legacyMatches(line)) {
        occurrences.push({
          legacy_id: match.legacy_id,
          path: file.rel,
          line: lineIndex + 1,
          column: match.index + 1,
          context_kind: "content",
        });
      }
    });
  }
  occurrences.sort((left, right) => occurrenceKey(left).localeCompare(occurrenceKey(right), "en"));
  return {
    root: path.resolve(root),
    scope_complete: errors.length === 0,
    errors,
    occurrences,
    unique_ids: [...new Set(occurrences.map((item) => item.legacy_id))].sort(),
  };
}

export function occurrenceKey(item) {
  return [
    String(item.legacy_id || item.id || ""),
    normalizeRel(item.path || item.rel || ""),
    Number(item.line ?? item.line_number ?? 0),
    Number(item.column ?? item.column_number ?? 0),
    String(item.context_kind || item.kind || "content"),
  ].join("|");
}

export function normalizeEvidenceOccurrences(document) {
  const values = Array.isArray(document) ? document : document?.occurrences;
  assert.ok(Array.isArray(values), "legacy-id-occurrences-before.json must contain an occurrences array");
  return values.map((item) => ({
    legacy_id: String(item.legacy_id || item.id || ""),
    path: normalizeRel(item.path || item.rel || ""),
    line: Number(item.line ?? item.line_number ?? 0),
    column: Number(item.column ?? item.column_number ?? 0),
    context_kind: String(item.context_kind || item.kind || "content"),
  })).sort((left, right) => occurrenceKey(left).localeCompare(occurrenceKey(right), "en"));
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalDigest(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), "utf8"));
}

function normalizeManifestEntries(document, label) {
  assert.equal(document?.schema_version, 1, `${label}.schema_version must be 1`);
  assert.ok(Array.isArray(document.files), `${label}.files must be an array`);
  const seen = new Set();
  return document.files.map((item, index) => {
    const rel = normalizeRel(item?.path);
    assert.ok(rel && !path.isAbsolute(rel), `${label}.files[${index}].path must be project-relative`);
    assert.equal(rel.split("/").includes(".."), false, `${label}.files[${index}].path escapes root`);
    assertNoWorkBuddyPath(rel, `${label}.files[${index}].path`);
    assert.equal(seen.has(rel.toLowerCase()), false, `${label} contains duplicate path: ${rel}`);
    seen.add(rel.toLowerCase());
    assert.equal(item.kind, "file", `${label}.${rel}.kind must be file`);
    assert.ok(Number.isInteger(item.bytes) && item.bytes >= 0, `${label}.${rel}.bytes invalid`);
    assert.match(item.sha256 || "", /^[a-f0-9]{64}$/, `${label}.${rel}.sha256 invalid`);
    return { path: rel, kind: "file", bytes: item.bytes, sha256: item.sha256 };
  });
}

export function buildPathManifest(root) {
  assertNoWorkBuddyPath(root, "manifest root");
  const inventory = walkFiles(root);
  assert.deepEqual(inventory.errors, [], `manifest enumeration incomplete: ${JSON.stringify(inventory.errors)}`);
  const files = inventory.files
    .map((item) => ({
      path: item.rel,
      kind: "file",
      bytes: item.bytes,
      sha256: sha256File(item.abs),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const payload = { schema_version: 1, files };
  return { ...payload, manifest_digest: canonicalDigest(payload) };
}

export function verifyPathManifest(document, root, label = "manifest", options = {}) {
  assertNoWorkBuddyPath(root, `${label} root`);
  assert.ok(fs.existsSync(root), `${label} root missing: ${root}`);
  const expected = normalizeManifestEntries(document, label);
  const actualInventory = walkFiles(root);
  assert.deepEqual(actualInventory.errors, [], `${label} enumeration incomplete: ${JSON.stringify(actualInventory.errors)}`);
  const actualByPath = new Map(actualInventory.files.map((item) => [item.rel.toLowerCase(), item]));
  const expectedPaths = expected.map((item) => item.path).sort((a, b) => a.localeCompare(b, "en"));
  if (options.completeRoot !== false) {
    const actualPaths = actualInventory.files.map((item) => item.rel).sort((a, b) => a.localeCompare(b, "en"));
    assert.deepEqual(actualPaths, expectedPaths, `${label} path set does not match filesystem`);
  }
  for (const item of expected) {
    const actual = actualByPath.get(item.path.toLowerCase());
    assert.ok(actual, `${label} path missing from filesystem: ${item.path}`);
    assert.equal(actual.rel, item.path, `${label} path spelling/case drift: ${item.path}`);
    assert.equal(actual.bytes, item.bytes, `${label} byte count mismatch: ${item.path}`);
    assert.equal(sha256File(actual.abs), item.sha256, `${label} SHA-256 mismatch: ${item.path}`);
  }
  const payload = { schema_version: 1, files: expected };
  assert.match(document.manifest_digest || "", /^[a-f0-9]{64}$/, `${label}.manifest_digest invalid`);
  assert.equal(document.manifest_digest, canonicalDigest(payload), `${label}.manifest_digest is not canonical content digest`);
  return { files: expected, paths: expectedPaths, manifest_digest: document.manifest_digest };
}

function verifyManifestPathsAtProjectRoot(document, projectRoot, label) {
  const expected = normalizeManifestEntries(document, label);
  const observed = [];
  for (const item of expected) {
    const abs = path.resolve(projectRoot, ...item.path.split("/"));
    const relative = normalizeRel(path.relative(projectRoot, abs));
    assert.equal(relative, item.path, `${label} path does not resolve canonically inside project root: ${item.path}`);
    const stat = fs.lstatSync(abs);
    assert.equal(stat.isSymbolicLink(), false, `${label} path is a redirect: ${item.path}`);
    assert.equal(stat.isFile(), true, `${label} path is not a regular file: ${item.path}`);
    observed.push({ path: item.path, kind: "file", bytes: stat.size, sha256: sha256File(abs) });
  }
  assert.deepEqual(observed, expected, `${label} does not match current real project files`);
  return expected;
}

export function loadMigrationEvidenceGate(env = process.env) {
  const projectRoot = String(env.PDE_V038_REAL_PROJECT_ROOT || "").trim();
  const freezeDir = String(env.PDE_V038_PROJECT_DATA_FREEZE_DIR || "").trim();
  const explicitManifest = String(env.PDE_V038_PROJECT_DATA_MIGRATION_MANIFEST || "").trim();
  const missing = [];
  if (!projectRoot) missing.push("PDE_V038_REAL_PROJECT_ROOT");
  if (!freezeDir) missing.push("PDE_V038_PROJECT_DATA_FREEZE_DIR");
  if (missing.length > 0) {
    return { status: "pending", reason: `PENDING: missing test-only evidence location: ${missing.join(", ")}` };
  }
  assertNoWorkBuddyPath(projectRoot, "real project root");
  assertNoWorkBuddyPath(freezeDir, "project data freeze directory");
  const paths = {
    projectRoot: path.resolve(projectRoot),
    freezeDir: path.resolve(freezeDir),
    affectedBefore: path.join(freezeDir, "affected-files-before"),
    affectedManifestBefore: path.join(freezeDir, "affected-files-manifest-before.json"),
    affectedAfter: path.join(freezeDir, "affected-files-after"),
    affectedManifestAfter: path.join(freezeDir, "affected-files-manifest-after.json"),
    failureRestore: path.join(freezeDir, "failure-injection-copy"),
    legacyOccurrencesBefore: path.join(freezeDir, "legacy-id-occurrences-before.json"),
    legacyScanScope: path.join(freezeDir, "legacy-scan-scope.json"),
    migrationPlan: path.join(freezeDir, "migration-plan.json"),
    migrationManifest: explicitManifest
      ? path.resolve(explicitManifest)
      : path.join(freezeDir, "project-data-migration-manifest.json"),
  };
  for (const [label, value] of Object.entries(paths)) {
    assertNoWorkBuddyPath(value, label);
  }
  const required = [
    ["project root", paths.projectRoot],
    ["affected-files-before", paths.affectedBefore],
    ["affected-files-manifest-before.json", paths.affectedManifestBefore],
    ["affected-files-after", paths.affectedAfter],
    ["affected-files-manifest-after.json", paths.affectedManifestAfter],
    ["failure-injection-copy", paths.failureRestore],
    ["legacy-id-occurrences-before.json", paths.legacyOccurrencesBefore],
    ["legacy-scan-scope.json", paths.legacyScanScope],
    ["migration-plan.json", paths.migrationPlan],
    ["project-data-migration-manifest.json", paths.migrationManifest],
  ];
  const missingEvidence = required.filter(([, value]) => !fs.existsSync(value)).map(([label]) => label);
  if (missingEvidence.length > 0) {
    return { status: "pending", reason: `PENDING: real migration evidence not generated: ${missingEvidence.join(", ")}`, paths };
  }
  return {
    status: "ready",
    paths,
    affectedManifestBefore: readJson(paths.affectedManifestBefore),
    affectedManifestAfter: readJson(paths.affectedManifestAfter),
    legacyOccurrencesBefore: readJson(paths.legacyOccurrencesBefore),
    legacyScanScope: readJson(paths.legacyScanScope),
    migrationPlan: readJson(paths.migrationPlan),
    migrationManifest: readJson(paths.migrationManifest),
  };
}

function migrationBeforeOverrides(gate) {
  const overrides = new Map();
  for (const item of normalizeManifestEntries(gate.affectedManifestBefore, "affected-files-manifest-before")) {
    overrides.set(item.path, path.join(gate.paths.affectedBefore, ...item.path.split("/")));
  }
  return overrides;
}

export function verifyLegacyScopeSnapshotDocument(declared, label = "legacy-scope-snapshot") {
  assert.equal(declared?.scope_complete, true, `${label}.scope_complete must be true`);
  assert.deepEqual(declared.errors || [], [], `${label}.errors must be empty`);
  assert.ok(Array.isArray(declared.paths), `${label}.paths must be an array`);
  const paths = declared.paths.map(normalizeRel);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  assert.equal(new Set(paths.map((item) => item.toLowerCase())).size, paths.length, `${label}.paths contain duplicates`);
  assert.deepEqual(paths, sortedPaths, `${label}.paths must be sorted`);
  assert.equal(declared.path_count, paths.length, `${label}.path_count does not match recorded paths`);
  assert.equal(declared.path_set_digest, canonicalDigest({ paths }), `${label}.path_set_digest is not canonical`);

  assert.ok(Array.isArray(declared.files), `${label}.files must be an array`);
  const files = declared.files.map((item, index) => {
    const rel = normalizeRel(item?.path);
    assert.ok(rel && !path.isAbsolute(rel) && !rel.split("/").includes(".."), `${label}.files[${index}].path invalid`);
    assert.equal(item.kind, "file", `${label}.${rel}.kind must be file`);
    assert.ok(Number.isInteger(item.bytes) && item.bytes >= 0, `${label}.${rel}.bytes invalid`);
    assert.match(item.sha256 || "", /^[a-f0-9]{64}$/u, `${label}.${rel}.sha256 invalid`);
    return { path: rel, kind: "file", bytes: item.bytes, sha256: item.sha256 };
  });
  assert.deepEqual(files.map((item) => item.path), paths, `${label}.files do not exactly cover recorded paths`);
  assert.equal(
    declared.manifest_digest,
    canonicalDigest({ schema_version: 1, files }),
    `${label}.manifest_digest is not canonical`,
  );
  assert.ok(Array.isArray(declared.file_sources), `${label}.file_sources must be an array`);
  assert.deepEqual(
    declared.file_sources.map((item) => normalizeRel(item?.path)),
    paths,
    `${label}.file_sources do not exactly cover recorded paths`,
  );
  assert.ok(declared.file_sources.every((item) => ["live_project", "affected_files_before"].includes(item?.source)),
    `${label}.file_sources contain an unknown source`);

  const occurrences = normalizeEvidenceOccurrences(declared);
  const occurrenceKeys = (declared.occurrences || []).map(occurrenceKey);
  assert.deepEqual(occurrenceKeys, [...occurrenceKeys].sort((a, b) => a.localeCompare(b, "en")), `${label}.occurrences must be sorted`);
  assert.equal(new Set(occurrenceKeys).size, occurrenceKeys.length, `${label}.occurrences contain duplicates`);
  const pathSet = new Set(paths);
  for (const item of occurrences) {
    assert.match(item.legacy_id, /^[DE]-(?:\d{6}|\d{8})(?:-[A-Z0-9]+)*-\d{3}$/u, `${label}.legacy_id invalid`);
    assert.equal(pathSet.has(item.path), true, `${label}.occurrence path is outside recorded scope: ${item.path}`);
  }
  const uniqueIds = [...new Set(occurrences.map((item) => item.legacy_id))].sort();
  assert.deepEqual(declared.unique_ids, uniqueIds, `${label}.unique_ids drift`);
  return { ...declared, paths, files, occurrences, unique_ids: uniqueIds };
}

function assertLegacyScopeCopyBinding(scope, manifest, copyRoot, expectedSource, label) {
  const scopeFiles = new Map(scope.files.map((item) => [item.path, item]));
  const sourceByPath = new Map(scope.file_sources.map((item) => [normalizeRel(item.path), item.source]));
  for (const item of manifest.files) {
    assert.deepEqual(scopeFiles.get(item.path), item, `${label}.${item.path} is not bound to the frozen manifest`);
    assert.equal(sourceByPath.get(item.path), expectedSource, `${label}.${item.path} has the wrong frozen source`);
  }
  const copied = enumerateLegacyOccurrences(copyRoot);
  assert.equal(copied.scope_complete, true, `${label} occurrence copy scan incomplete: ${JSON.stringify(copied.errors)}`);
  const affected = new Set(manifest.paths);
  assert.deepEqual(
    scope.occurrences.filter((item) => affected.has(item.path)).map(occurrenceKey),
    copied.occurrences.map(occurrenceKey),
    `${label} recorded occurrences do not match frozen bytes`,
  );
  assert.deepEqual(scope.occurrences.filter((item) => !affected.has(item.path)), [], `${label} has an unfrozen legacy occurrence`);
}

export function verifyDeterministicLegacyScanScope(gate) {
  assert.equal(gate.status, "ready");
  const evidence = gate.legacyScanScope;
  assert.equal(evidence?.schema_version, 1, "legacy-scan-scope.schema_version must be 1");
  assert.equal(normalizeRel(path.resolve(evidence.project_root)).toLowerCase(), normalizeRel(gate.paths.projectRoot).toLowerCase());
  assert.equal(evidence.rules?.max_file_bytes, MAX_ENUMERATED_TEXT_BYTES);
  assert.deepEqual(evidence.rules?.fixed_paths, LEGACY_SCAN_FIXED_PATHS);
  assert.equal(evidence.rules?.root_one_level_markdown, true);
  assert.equal(evidence.rules?.history_catalog_glob, "历史记录/**/00-*总目录.md");
  assert.equal(evidence.rules?.evidence_index_glob, "证据库/总索引/*.md");
  assert.equal(evidence.rules?.typed_index_safe_project_relative_markdown, true);
  assert.deepEqual(
    evidence.rules?.excluded,
    [".git", ".project-gov", "node_modules", "项目物料/输出产物"],
  );
  const rawEvidenceRel = normalizeRel(path.relative(gate.paths.projectRoot, gate.paths.freezeDir));
  const expectedEvidenceRule = rawEvidenceRel && rawEvidenceRel !== "." && !path.isAbsolute(rawEvidenceRel)
    && !rawEvidenceRel.split("/").includes("..") ? rawEvidenceRel : "outside_project_root";
  assert.equal(evidence.rules?.current_remediation_evidence, expectedEvidenceRule);
  assert.equal(evidence.rules?.redirects, "rejected_not_followed");

  const before = verifyLegacyScopeSnapshotDocument(evidence.before, "legacy-scan-scope.before");
  const final = verifyLegacyScopeSnapshotDocument(evidence.final, "legacy-scan-scope.final");
  const manifests = verifyAffectedMigrationManifests(gate);
  assertLegacyScopeCopyBinding(before, manifests.before, gate.paths.affectedBefore, "affected_files_before", "legacy-scan-scope.before");
  assertLegacyScopeCopyBinding(final, manifests.after, gate.paths.affectedAfter, "live_project", "legacy-scan-scope.final");
  const occurrenceFiles = [...new Set(before.occurrences.map((item) => item.path))].sort();
  return { before, final, occurrence_files: occurrenceFiles };
}

export function verifyAffectedMigrationManifests(gate) {
  assert.equal(gate.status, "ready");
  const before = verifyPathManifest(
    gate.affectedManifestBefore,
    gate.paths.affectedBefore,
    "affected-files-manifest-before",
  );
  const afterCopy = verifyPathManifest(
    gate.affectedManifestAfter,
    gate.paths.affectedAfter,
    "affected-files-manifest-after",
  );
  const failureRestore = verifyPathManifest(
    gate.affectedManifestBefore,
    gate.paths.failureRestore,
    "failure-injection-restored-files",
  );
  assert.deepEqual(afterCopy.paths, before.paths, "before/after affected path sets differ");
  assert.deepEqual(failureRestore.paths, before.paths, "failure restore affected path set differs from before");
  const declaredAffected = [...(gate.migrationPlan.affected_files || [])]
    .map(normalizeRel)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const rel of declaredAffected) assertNoWorkBuddyPath(rel, "migration-plan affected path");
  assert.deepEqual(declaredAffected, before.paths, "migration-plan affected_files does not exactly cover frozen affected files");
  return { before, after: afterCopy, failureRestore };
}

function legacyLocationKey(legacyId, item) {
  return [
    legacyId,
    normalizeRel(item?.path),
    Number(item?.line ?? item?.line_number ?? 0),
    Number(item?.column ?? item?.column_number ?? 0),
  ].join("|");
}

export function verifyLegacyMappingCoverage(gate) {
  assert.equal(gate.status, "ready");
  const frozen = normalizeEvidenceOccurrences(gate.legacyOccurrencesBefore);
  const frozenIds = [...new Set(frozen.map((item) => item.legacy_id))].sort();
  const planMapping = gate.migrationPlan?.legacy_mapping;
  assert.ok(planMapping && !Array.isArray(planMapping) && typeof planMapping === "object", "migration-plan legacy_mapping missing");
  assert.deepEqual(Object.keys(planMapping).sort(), frozenIds, "legacy_mapping keys do not exactly cover frozen legacy IDs");
  const records = gate.migrationManifest?.legacy_ids;
  assert.ok(Array.isArray(records), "migration manifest legacy_ids missing");
  const recordIds = records.map((item) => String(item.legacy_id || ""));
  assert.equal(new Set(recordIds).size, recordIds.length, "migration manifest contains duplicate legacy mappings");
  assert.deepEqual([...recordIds].sort(), frozenIds, "migration manifest mapping keys do not exactly cover frozen legacy IDs");
  const declaredLocations = [];
  for (const item of records) {
    assert.equal(item.canonical_id, planMapping[item.legacy_id], `canonical mapping drift for ${item.legacy_id}`);
    assert.match(item.canonical_id || "", /^(?:M|EV|MAT)-\d{8}(?:-[A-Z0-9]+)*-\d{3}$/);
    for (const field of ["definition_locations", "reference_locations"]) {
      assert.ok(Array.isArray(item[field]), `${item.legacy_id}.${field} must be an array`);
      for (const location of item[field]) {
        assertNoWorkBuddyPath(location?.path, `${item.legacy_id}.${field}.path`);
        declaredLocations.push(legacyLocationKey(item.legacy_id, location));
      }
    }
    assert.ok(Array.isArray(item.renamed_files), `${item.legacy_id}.renamed_files must be an array`);
    for (const renamed of item.renamed_files) {
      const values = typeof renamed === "string" ? [renamed] : [renamed?.before, renamed?.after].filter(Boolean);
      for (const value of values) assertNoWorkBuddyPath(value, `${item.legacy_id}.renamed_files`);
    }
  }
  const frozenLocations = frozen.map((item) => legacyLocationKey(item.legacy_id, item)).sort();
  declaredLocations.sort();
  assert.equal(new Set(declaredLocations).size, declaredLocations.length, "migration mapping repeats a frozen occurrence");
  assert.deepEqual(declaredLocations, frozenLocations, "mapping locations do not exactly cover frozen legacy occurrences");
  return { legacy_ids: frozenIds, occurrence_count: frozenLocations.length };
}

function parseMarkdownCells(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function isMarkdownSeparator(line) {
  const cells = parseMarkdownCells(line);
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function legacyOccurrenceIsMetadataOnly(root, occurrence) {
  if (occurrence.context_kind !== "content" || occurrence.line < 1) return false;
  const lines = fs.readFileSync(path.join(root, occurrence.path), "utf8").split(/\r?\n/);
  const rowIndex = occurrence.line - 1;
  const cells = parseMarkdownCells(lines[rowIndex]);
  if (!cells) return false;
  let header = null;
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const candidate = parseMarkdownCells(lines[index]);
    if (!candidate) break;
    if (isMarkdownSeparator(lines[index + 1])) {
      header = candidate;
      break;
    }
  }
  if (!header || header.length !== cells.length) return false;
  const containing = [];
  cells.forEach((cell, index) => {
    if (legacyMatches(cell).some((item) => item.legacy_id === occurrence.legacy_id)) containing.push(index);
  });
  return containing.length > 0 && containing.every((index) => header[index].toLowerCase() === "legacy-id");
}

export function verifyFinalLegacyMetadataOnly(gate) {
  assert.equal(gate.status, "ready");
  const scopes = verifyDeterministicLegacyScanScope(gate);
  const finalScan = scopes.final;
  const frozenIds = normalizeEvidenceOccurrences(gate.legacyOccurrencesBefore).map((item) => item.legacy_id);
  const expectedIds = [...new Set(frozenIds)].sort();
  assert.deepEqual(finalScan.unique_ids, expectedIds, "final legacy metadata IDs differ from frozen legacy ID set");
  assert.ok(finalScan.occurrences.length >= expectedIds.length, "each frozen legacy ID must remain represented as metadata");
  for (const occurrence of finalScan.occurrences) {
    assert.equal(
      legacyOccurrenceIsMetadataOnly(gate.paths.affectedAfter, occurrence),
      true,
      `active legacy reference remains outside legacy-id metadata cell: ${occurrenceKey(occurrence)}`,
    );
  }
  return { unique_ids: finalScan.unique_ids, occurrence_count: finalScan.occurrences.length };
}

export function verifyCurrentLegacyMetadataOnly(gate) {
  assert.equal(gate.status, "ready");
  const currentScan = buildDeterministicLegacyScanScope(gate.paths.projectRoot, {
    phase: "legacy_scan_current_regression_verify",
    currentEvidenceRoot: gate.paths.freezeDir,
  });
  assert.equal(currentScan.scope_complete, true, `current legacy scope incomplete: ${JSON.stringify(currentScan.errors)}`);
  const frozenIds = [...new Set(normalizeEvidenceOccurrences(gate.legacyOccurrencesBefore)
    .map((item) => item.legacy_id))].sort();
  const currentIds = new Set(currentScan.unique_ids);
  assert.deepEqual(frozenIds.filter((item) => !currentIds.has(item)), [], "current project lost frozen legacy metadata IDs");
  for (const occurrence of currentScan.occurrences) {
    assert.equal(
      legacyOccurrenceIsMetadataOnly(gate.paths.projectRoot, occurrence),
      true,
      `current active legacy reference remains outside legacy-id metadata cell: ${occurrenceKey(occurrence)}`,
    );
  }
  return { path_count: currentScan.path_count, unique_ids: currentScan.unique_ids, occurrence_count: currentScan.occurrences.length };
}

export function verifyRealProjectWithCurrentSource(gate) {
  assert.equal(gate.status, "ready");
  const inspected = inspect(gate.paths.projectRoot);
  assert.equal(inspected.status, 0, `current source inspect failed on real project\n${inspected.raw || inspected.stderr}`);
  assert.equal(inspected.json?.ok, true, `current source inspect did not report ok\n${inspected.raw || inspected.stderr}`);
  const validated = validate(gate.paths.projectRoot);
  assert.equal(validated.status, 0, `current source validate failed on real project\n${validated.raw || validated.stderr}`);
  assert.equal(validated.json?.ok, true, `current source validate did not report ok\n${validated.raw || validated.stderr}`);
  return { inspected, validated };
}

export function verifyLegacyFreezeEnumeration(gate) {
  assert.equal(gate.status, "ready");
  const evidence = gate.legacyOccurrencesBefore;
  assert.equal(evidence.scope_complete, true, "legacy occurrence freeze must declare complete scope");
  assert.deepEqual(evidence.scan_errors || [], [], "legacy occurrence freeze contains scan errors");
  const actual = verifyDeterministicLegacyScanScope(gate).before;
  assert.equal(actual.scope_complete, true, `deterministic before scope incomplete: ${JSON.stringify(actual.errors)}`);
  const expectedOccurrences = normalizeEvidenceOccurrences(evidence);
  assert.deepEqual(actual.occurrences.map(occurrenceKey), expectedOccurrences.map(occurrenceKey));
  const expectedIds = [...new Set(expectedOccurrences.map((item) => item.legacy_id))].sort();
  assert.deepEqual(actual.unique_ids, expectedIds);
  if (Number.isInteger(evidence.unique_id_count)) assert.equal(evidence.unique_id_count, expectedIds.length);
  if (Number.isInteger(evidence.occurrence_count)) assert.equal(evidence.occurrence_count, expectedOccurrences.length);
  return { unique_id_count: expectedIds.length, occurrence_count: expectedOccurrences.length };
}

export async function startHttpProbe(root) {
  const portFile = path.join(root, "http-probe-port.txt");
  const hitFile = path.join(root, "http-probe-hits.txt");
  fs.writeFileSync(hitFile, "0", "utf8");
  const source = [
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    "const portFile = process.env.PDE_HTTP_PROBE_PORT_FILE;",
    "const hitFile = process.env.PDE_HTTP_PROBE_HIT_FILE;",
    "let hits = 0;",
    "const server = http.createServer((_req, res) => { hits += 1; fs.writeFileSync(hitFile, String(hits)); res.end('probe'); });",
    "server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source], {
    windowsHide: true,
    env: {
      ...process.env,
      PDE_HTTP_PROBE_PORT_FILE: portFile,
      PDE_HTTP_PROBE_HIT_FILE: hitFile,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk; });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(portFile) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`HTTP probe exited early: ${childError}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!fs.existsSync(portFile)) {
    child.kill();
    throw new Error(`HTTP probe did not start: ${childError}`);
  }
  const port = Number(fs.readFileSync(portFile, "utf8"));
  return {
    url: `http://127.0.0.1:${port}/must-not-be-requested`,
    hits: () => Number(fs.readFileSync(hitFile, "utf8")),
    stop: async () => {
      if (child.exitCode !== null) return;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    },
  };
}
