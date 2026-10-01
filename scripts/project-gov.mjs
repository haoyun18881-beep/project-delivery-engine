#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const FIVE_PIECE = [
  "AGENTS.md",
  "PROJECT_START_HERE.md",
  "STATUS.md",
  "TODO.md",
  "HANDOFF.md",
];

const INDEX_FILES = [
  "历史记录/00-历史总目录.md",
  "证据库/总索引/证据总目录.md",
  "项目物料/INDEX.md",
];
const GOVERNANCE_ROOT_DIRECTORIES = ["历史记录", "证据库", "项目物料"];

const FIVE_PIECE_LIMIT_BYTES = 45 * 1024;
const FIVE_PIECE_LOW_SPACE_BYTES = 2 * 1024;
const MARKDOWN_SCAN_LIMIT = 5000;
const MAX_MARKDOWN_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MARKDOWN_SCAN_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MARKDOWN_SCAN_ISSUE_SAMPLES = 20;
const MAX_ACTIONS = 200;
const MAX_ACTION_TEXT_BYTES = 512 * 1024;
const MAX_TOTAL_ACTION_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_ANCHOR_TEXT_BYTES = 16 * 1024;
const MAX_MUTABLE_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MATERIAL_HASH_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MATERIAL_REPORT_ITEMS = 100;
const MAX_MATERIAL_MATCH_SAMPLES = 20;
const MAX_PRUNE_REPORT_ITEMS = 100;
const MAX_STRUCTURE_ISSUES = 100;
const MAX_STRUCTURE_DETAIL_CHARS = 512;
const MAX_PHYSICAL_LAYOUT_SAMPLES = 20;
const MAX_KNOWLEDGE_REVIEW_TEXT_BYTES = 512;
const MAX_KNOWLEDGE_REVIEW_PATHS = 20;
const SCRIPT_NAME = "project-gov";
const SKILL_VERSION = "0.3.8-rc7";
const OPERATION_SCHEMA_VERSION = 2;
const COMPILED_SCHEMA_VERSION = 5;
const PROJECT_STRUCTURE_VERSION = 2;
const DECISION_POLICY_VERSION = 2;
const DECISION_SNAPSHOT_SCHEMA_VERSION = 2;
const DIGEST_ALGORITHM = "sha256-canonical-json-utf8-bytewise-v1";
const LEGACY_CHECKPOINT_PATHS = new Set(["STATUS.md", "TODO.md", "HANDOFF.md"]);
const DEFAULT_PRUNE_AGE_DAYS = 30;
const BACKUP_OWNER_FILE = ".project-gov-owner.json";
const APPLY_LOCK_SCHEMA_VERSION = 2;
const TRANSACTION_JOURNAL_SCHEMA_VERSION = 2;
const TRANSACTION_JOURNAL_FILE = "backup-manifest.json";
const MAX_APPLY_LOCK_BYTES = 32 * 1024;
const MAX_TRANSACTION_OWNER_BYTES = 32 * 1024;
const MAX_TRANSACTION_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_PATH_BYTES = 4096;
// Transaction owner IDs are canonical UUID text: 36 ASCII bytes.
const TRANSACTION_TEMP_REL_SUFFIX_BYTES = Buffer.byteLength(".tmp-project-gov-", "utf8") + 36;
const MAX_TRANSACTION_CREATED_DIRECTORIES = MAX_ACTIONS * 32;
const MAX_TRANSACTION_PLAN_ID_BYTES = 1024;
const MAX_TRANSACTION_EARLY_DIRECTORY_ENTRIES = 8;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");
const RESERVED_PATH_SEGMENTS = new Set([".git", ".project-gov", "node_modules"]);
const DECISION_SNAPSHOT_DETAILS = new WeakMap();
const STRUCTURE_RESULT_DETAILS = new WeakMap();
const STRUCTURE_ISSUE_IDENTITY_DETAILS = new WeakMap();
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PROJECT_ID_TOPIC_SEGMENTS_SOURCE = String.raw`(?:-[A-Z0-9]+)*`;
const PROJECT_ID_SEQUENCE_SOURCE = String.raw`\d{3}`;
const PROJECT_ID_BODY_SOURCE = String.raw`(?:MAT|EV|M)-\d{8}${PROJECT_ID_TOPIC_SEGMENTS_SOURCE}-${PROJECT_ID_SEQUENCE_SOURCE}`;
const PROJECT_ID_REGEX_SOURCE = `(?<![A-Za-z0-9_])(${PROJECT_ID_BODY_SOURCE})(?![A-Za-z0-9_-])`;
const KNOWLEDGE_REVIEW_STATUSES = new Set(["created", "updated", "none", "deferred"]);
const FINGERPRINT_KINDS = new Set(["absent", "file", "directory", "symlink", "other"]);
const MATERIAL_LOCATOR_KINDS = new Set([
  "file",
  "directory",
  "historical_identity",
  "external_uri",
  "absolute_reference",
]);
const COMPILED_PLAN_FIELDS = new Set([
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
]);
const ACTION_FIELDS = new Map([
  ["mkdir", new Set(["kind", "path"])],
  ["write_file", new Set(["kind", "path", "content", "overwrite"])],
  ["append_after", new Set(["kind", "path", "after", "match", "content"])],
  ["replace_line_contains", new Set(["kind", "path", "contains", "replacement"])],
  ["replace_block_exact", new Set(["kind", "path", "old_block", "replacement"])],
]);

const PLACEHOLDER_PATTERNS = [
  /<placeholder>/i,
  /<YYYY-MM-DD\b[^>]*>/i,
  /<已核对或待确认>/,
  /TODO_FILL/i,
  /\bTBD\b/i,
  /待填写/,
  /未填写/,
];

const TABLE_HEADER_ALIASES = new Map([
  ["历史编号", "history-id"],
  ["history_id", "history-id"],
  ["history-id（历史编号）", "history-id"],
  ["history-id(历史编号)", "history-id"],
  ["证据编号", "evidence-id"],
  ["evidence_id", "evidence-id"],
  ["evidence-id（证据编号）", "evidence-id"],
  ["evidence-id(证据编号)", "evidence-id"],
  ["物料编号", "material-id"],
  ["material_id", "material-id"],
  ["material-id（物料编号）", "material-id"],
  ["material-id(物料编号)", "material-id"],
  ["执行批次", "run_id"],
  ["run-id", "run_id"],
  ["run_id（执行批次）", "run_id"],
  ["run_id(执行批次)", "run_id"],
  ["run-id（执行批次）", "run_id"],
  ["run-id(执行批次)", "run_id"],
  ["任务编号", "task_id"],
  ["task-id", "task_id"],
  ["task_id（任务编号）", "task_id"],
  ["task_id(任务编号)", "task_id"],
  ["task-id（任务编号）", "task_id"],
  ["task-id(任务编号)", "task_id"],
  ["哈希", "hash"],
  ["hash（哈希）", "hash"],
  ["hash(哈希)", "hash"],
  ["sha256", "hash"],
  ["sha-256", "hash"],
  ["原件路径", "路径"],
  ["路径（原件）", "路径"],
  ["路径(原件)", "路径"],
  ["locator_kind", "locator-kind"],
  ["locator-kind（定位类型）", "locator-kind"],
  ["locator-kind(定位类型)", "locator-kind"],
  ["旧编号", "legacy-id"],
  ["legacy_id", "legacy-id"],
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`canonical_json_undefined:${key}`);
      entries.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonical_json_unsupported_type:${typeof value}`);
}

function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function statKind(stat) {
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function sameFileStatIdentity(expected, actual) {
  if (!expected?.isFile?.() || !actual?.isFile?.()) return false;
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((field) => (
    String(expected[field]) === String(actual[field])
  ));
}

function sameFileObjectIdentity(expected, actual) {
  if (!expected?.isFile?.() || !actual?.isFile?.()) return false;
  return ["dev", "ino"].every((field) => String(expected[field]) === String(actual[field]));
}

function samePathStatIdentity(expected, actual) {
  if (expected === null || actual === null) return expected === actual;
  if (!expected || !actual || statKind(expected) !== statKind(actual)) return false;
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((field) => (
    String(expected[field]) === String(actual[field])
  ));
}

function normalizeOverlayEntry(value) {
  if (value === null || value?.kind === "absent") return { kind: "absent", bytes: null };
  if (Buffer.isBuffer(value)) return { kind: "file", bytes: Buffer.from(value) };
  if (typeof value === "string") return { kind: "file", bytes: Buffer.from(value, "utf8") };
  if (value?.kind === "file") {
    const bytes = Buffer.isBuffer(value.bytes) ? value.bytes : Buffer.from(value.bytes ?? "", "utf8");
    return { kind: "file", bytes: Buffer.from(bytes) };
  }
  if (value?.kind === "directory") return { kind: "directory", bytes: null };
  throw new TypeError("inspection_overlay_entry_invalid");
}

function createInspectionOverlay(entries = []) {
  const overlay = new Map();
  for (const [rel, value] of entries) overlay.set(String(rel).replace(/\\/g, "/"), normalizeOverlayEntry(value));
  return overlay;
}

function createInspectionContext(root, options = {}) {
  const normalizedRoot = path.resolve(root);
  const io = options.io || fs;
  const overlay = options.overlay instanceof Map
    ? options.overlay
    : createInspectionOverlay(Object.entries(options.overlay || {}));
  const baseContext = options.baseContext || null;
  const limits = {
    maxTotalTextBytes: MAX_MARKDOWN_SCAN_TOTAL_BYTES,
    ...(options.limits || {}),
  };
  const context = {
    epoch_id: options.epoch_id || crypto.randomUUID(),
    phase: options.phase || "inspect",
    root: normalizedRoot,
    realRoot: io.realpathSync.native(normalizedRoot),
    io,
    overlay,
    baseContext,
    lstatCache: new Map(),
    pathKindCache: new Map(),
    sizeCache: new Map(),
    fingerprintCache: new Map(),
    boundedTextCache: new Map(),
    eolCache: new Map(),
    readIssues: [],
    completenessState: {
      hard_issues_complete: true,
      coverage_issues_complete: true,
    },
    indexModel: null,
    totalTextBytesRead: 0,
    sealIssueKeys: new Set(),
    limits,
  };

  context.toRel = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");
  context.abs = (rel) => path.join(context.root, context.toRel(rel));
  context.markIncomplete = (code, rel, options = {}) => {
    context.readIssues.push({ code, subject_key: `${context.toRel(rel)}#${options.reason || code}` });
    if (options.hard !== false) context.completenessState.hard_issues_complete = false;
    if (options.coverage === false) context.completenessState.coverage_issues_complete = false;
  };
  context.overlayEntry = (rel) => overlay.get(context.toRel(rel));
  context.lstat = (rel) => {
    const normalizedRel = context.toRel(rel);
    const virtual = context.overlayEntry(normalizedRel);
    if (virtual) {
      const result = {
        virtual: true,
        kind: virtual.kind,
        size: virtual.kind === "file" ? virtual.bytes.length : null,
      };
      context.pathKindCache.set(normalizedRel, result.kind);
      context.sizeCache.set(normalizedRel, result.size);
      return result;
    }
    if (baseContext) {
      const stat = baseContext.lstat(normalizedRel);
      context.lstatCache.set(normalizedRel, stat);
      context.pathKindCache.set(normalizedRel, baseContext.kind(normalizedRel));
      context.sizeCache.set(normalizedRel, baseContext.size(normalizedRel));
      return stat;
    }
    if (context.lstatCache.has(normalizedRel)) return context.lstatCache.get(normalizedRel);
    let stat = null;
    try {
      stat = io.lstatSync(context.abs(normalizedRel));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        context.markIncomplete("managed_file_not_checked", normalizedRel, {
          reason: "lstat_failed",
          coverage: false,
        });
        const wrapped = new Error(`inspection_lstat_failed:${normalizedRel}`);
        wrapped.code = "lstat_failed";
        throw wrapped;
      }
    }
    context.lstatCache.set(normalizedRel, stat);
    context.pathKindCache.set(normalizedRel, statKind(stat));
    context.sizeCache.set(normalizedRel, stat?.size ?? null);
    return stat;
  };
  context.kind = (rel) => {
    const normalizedRel = context.toRel(rel);
    if (!context.pathKindCache.has(normalizedRel)) context.lstat(normalizedRel);
    return context.pathKindCache.get(normalizedRel);
  };
  context.size = (rel) => {
    const normalizedRel = context.toRel(rel);
    if (!context.sizeCache.has(normalizedRel)) context.lstat(normalizedRel);
    return context.sizeCache.get(normalizedRel);
  };
  context.getBoundedBuffer = (rel, maxBytes, remainingTotalBytes = limits.maxTotalTextBytes) => {
    const normalizedRel = context.toRel(rel);
    const virtual = context.overlayEntry(normalizedRel);
    const kind = context.kind(normalizedRel);
    if (kind !== "file") {
      const error = new Error("managed_file_not_regular");
      error.code = "not_regular_file";
      context.markIncomplete("managed_file_not_checked", normalizedRel, { reason: "not_regular_file" });
      throw error;
    }
    const size = context.size(normalizedRel);
    if (size > maxBytes) {
      const error = new Error("managed_file_too_large");
      error.code = "file_too_large";
      context.markIncomplete("managed_file_not_checked", normalizedRel, { reason: "file_too_large" });
      throw error;
    }
    if (context.boundedTextCache.has(normalizedRel)) {
      return Buffer.from(context.boundedTextCache.get(normalizedRel));
    }
    if (size > remainingTotalBytes || context.totalTextBytesRead + size > limits.maxTotalTextBytes) {
      const error = new Error("managed_scan_budget_exhausted");
      error.code = "total_bytes_exceeded";
      context.markIncomplete("managed_scan_budget_exhausted", normalizedRel, {
        reason: "total_bytes_exceeded",
      });
      throw error;
    }
    if (virtual) {
      context.boundedTextCache.set(normalizedRel, Buffer.from(virtual.bytes));
      context.totalTextBytesRead += virtual.bytes.length;
      return Buffer.from(virtual.bytes);
    }
    if (baseContext) {
      const buffer = baseContext.getBoundedBuffer(normalizedRel, maxBytes, remainingTotalBytes);
      context.boundedTextCache.set(normalizedRel, Buffer.from(buffer));
      return Buffer.from(buffer);
    }
    const abs = context.abs(normalizedRel);
    const fd = io.openSync(abs, "r");
    try {
      const before = io.fstatSync(fd);
      const cachedStat = context.lstat(normalizedRel);
      if (!sameFileStatIdentity(cachedStat, before)) {
        const error = new Error("managed_file_changed_before_read");
        error.code = "file_changed_during_read";
        throw error;
      }
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < before.size) {
        const count = io.readSync(fd, buffer, offset, before.size - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = io.fstatSync(fd);
      if (offset !== before.size || !sameFileStatIdentity(before, after)) {
        const error = new Error("managed_file_changed_during_read");
        error.code = "file_changed_during_read";
        throw error;
      }
      context.boundedTextCache.set(normalizedRel, Buffer.from(buffer));
      context.totalTextBytesRead += buffer.length;
      return buffer;
    } catch (error) {
      context.markIncomplete("managed_file_not_checked", normalizedRel, {
        reason: error.code || "read_failed",
      });
      throw error;
    } finally {
      io.closeSync(fd);
    }
  };
  context.getBoundedText = (rel, maxBytes, remainingTotalBytes = limits.maxTotalTextBytes) => {
    const normalizedRel = context.toRel(rel);
    const buffer = context.getBoundedBuffer(normalizedRel, maxBytes, remainingTotalBytes);
    let text;
    try {
      text = UTF8_FATAL_DECODER.decode(buffer);
    } catch {
      context.markIncomplete("managed_file_not_checked", normalizedRel, {
        reason: "invalid_utf8",
        coverage: false,
      });
      const error = new Error(`managed_file_invalid_utf8:${normalizedRel}`);
      error.code = "invalid_utf8";
      throw error;
    }
    if (!context.eolCache.has(normalizedRel)) context.eolCache.set(normalizedRel, preferredNewline(text));
    return { text, bytes: buffer.length };
  };
  context.fingerprint = (rel) => {
    const normalizedRel = context.toRel(rel);
    if (context.fingerprintCache.has(normalizedRel)) {
      return { ...context.fingerprintCache.get(normalizedRel) };
    }
    const virtual = context.overlayEntry(normalizedRel);
    const kind = context.kind(normalizedRel);
    let fingerprint;
    if (kind === "absent") {
      fingerprint = { exists: false, kind: "absent", bytes: null, sha256: null };
    } else if (kind === "file") {
      const bytes = context.size(normalizedRel);
      let hash;
      try {
        hash = virtual
          ? sha256(virtual.bytes)
          : baseContext
            ? baseContext.fingerprint(normalizedRel).sha256
            : context.boundedTextCache.has(normalizedRel)
              ? sha256(context.boundedTextCache.get(normalizedRel))
              : sha256FileChunked(context.abs(normalizedRel), io, context.lstat(normalizedRel));
      } catch (error) {
        context.markIncomplete("managed_file_not_checked", normalizedRel, {
          reason: error.code || "fingerprint_failed",
        });
        throw error;
      }
      fingerprint = { exists: true, kind: "file", bytes, sha256: hash };
    } else {
      fingerprint = { exists: true, kind, bytes: null, sha256: null };
    }
    context.fingerprintCache.set(normalizedRel, fingerprint);
    return { ...fingerprint };
  };
  context.seal = () => {
    const issues = [];
    let issueCount = 0;
    let issuesTruncated = false;
    const identityCounts = new Map();
    const recordDrift = (rel, reason, error = null) => {
      const normalizedRel = context.toRel(rel);
      const key = `${normalizedRel}#${reason}`;
      identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
      const issue = {
        code: "inspection_epoch_drift",
        subject_key: boundedIdentityText(key),
        rel: limitText(normalizedRel, MAX_STRUCTURE_DETAIL_CHARS),
        reason: limitText(reason, MAX_STRUCTURE_DETAIL_CHARS),
        ...(error ? { error: limitText(formatFsError(error), MAX_STRUCTURE_DETAIL_CHARS) } : {}),
      };
      issueCount += 1;
      if (issues.length < MAX_STRUCTURE_ISSUES) issues.push(issue);
      else issuesTruncated = true;
      if (!context.sealIssueKeys.has(key)) {
        context.sealIssueKeys.add(key);
        context.markIncomplete("inspection_epoch_drift", normalizedRel, { reason, coverage: false });
      }
    };

    if (baseContext) {
      const baseSeal = baseContext.seal();
      for (const item of baseSeal.issues) recordDrift(item.rel, item.reason, item.error ? new Error(item.error) : null);
      const inheritedIssueCount = Number(baseSeal.issue_count ?? issueCount);
      return {
        ok: inheritedIssueCount === 0,
        epoch_id: context.epoch_id,
        phase: context.phase,
        checked_path_count: baseSeal.checked_path_count,
        issue_count: inheritedIssueCount,
        issues_truncated: issuesTruncated || baseSeal.issues_truncated === true,
        issue_multiset_digest: baseSeal.issue_multiset_digest || canonicalDigest({
          domain: "project-gov/inspection-epoch-issues/v1",
          entries: [...identityCounts.entries()].sort(([left], [right]) => compareUtf8(left, right)),
        }),
        issues,
      };
    }

    const entries = [...context.lstatCache.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    for (const [rel, expected] of entries) {
      if (context.overlayEntry(rel)) continue;
      let actual = null;
      try {
        actual = io.lstatSync(context.abs(rel));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          recordDrift(rel, "seal_lstat_failed", error);
          continue;
        }
      }
      if (!samePathStatIdentity(expected, actual)) recordDrift(rel, "stat_identity_changed");
    }
    return {
      ok: issueCount === 0,
      epoch_id: context.epoch_id,
      phase: context.phase,
      checked_path_count: entries.length,
      issue_count: issueCount,
      issues_truncated: issuesTruncated,
      issue_multiset_digest: canonicalDigest({
        domain: "project-gov/inspection-epoch-issues/v1",
        entries: [...identityCounts.entries()].sort(([left], [right]) => compareUtf8(left, right)),
      }),
      issues,
    };
  };
  return context;
}

function sealCommandResult(context, result) {
  const seal = context.seal();
  const errors = [
    ...(result.errors || []),
    ...(seal.ok ? [] : ["inspection_epoch_drift"]),
  ];
  return {
    ...result,
    ok: result.ok === true && seal.ok,
    ...(Object.hasOwn(result, "complete") ? { complete: result.complete === true && seal.ok } : {}),
    errors: [...new Set(errors)],
    inspection_epoch: {
      id: context.epoch_id,
      phase: context.phase,
      seal,
    },
  };
}

function sha256FileChunked(abs, io = fs, expectedStat = null) {
  const hash = crypto.createHash("sha256");
  const fd = io.openSync(abs, "r");
  try {
    const before = io.fstatSync(fd);
    if (!before.isFile()) throw Object.assign(new Error("fingerprint_not_regular_file"), { code: "not_regular_file" });
    if (expectedStat && !sameFileStatIdentity(expectedStat, before)) {
      throw Object.assign(new Error("fingerprint_file_changed_before_read"), { code: "file_changed_during_read" });
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = io.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    const after = io.fstatSync(fd);
    if (position !== before.size || !sameFileStatIdentity(before, after)) {
      throw Object.assign(new Error("fingerprint_file_changed_during_read"), { code: "file_changed_during_read" });
    }
    return hash.digest("hex");
  } finally {
    io.closeSync(fd);
  }
}

function boundedIdentityText(value, maxChars = MAX_STRUCTURE_DETAIL_CHARS) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  const suffix = `#sha256:${sha256(Buffer.from(text, "utf8"))}`;
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function formatDiagnosticFailure(prefix, items) {
  const unique = [...new Set(items || [])];
  const sample = unique
    .slice(0, MAX_STRUCTURE_ISSUES)
    .map((item) => boundedIdentityText(item));
  const suffix = unique.length > sample.length ? ` [truncated:${unique.length - sample.length}]` : "";
  return `${prefix}: ${sample.join(", ")}${suffix}`;
}

function stableIssue(code, subjectKey) {
  return {
    code: String(code ?? ""),
    subject_key: String(subjectKey ?? ""),
  };
}

function stableIssueKey(issue) {
  return canonicalJson([String(issue.code), String(issue.subject_key)]);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function sortStableIssues(issues) {
  return [...issues].sort((left, right) => compareUtf8(stableIssueKey(left), stableIssueKey(right)));
}

function displayStableIssue(issue) {
  return {
    code: boundedIdentityText(issue.code, 160),
    subject_key: boundedIdentityText(issue.subject_key),
  };
}

function createStableIssueCollector(limit = MAX_STRUCTURE_ISSUES) {
  return {
    issues: [],
    count: 0,
    truncated: false,
    limit,
    entries: new Map(),
    identities_complete: true,
  };
}

function recordStableIssueCount(collector, issue, count = 1) {
  const normalized = stableIssue(issue.code, issue.subject_key);
  const increment = Number.isInteger(count) && count > 0 ? count : 0;
  if (increment === 0) return;
  const key = stableIssueKey(normalized);
  const current = collector.entries.get(key) || { issue: normalized, count: 0 };
  current.count += increment;
  collector.entries.set(key, current);
  collector.count += increment;
  const remaining = Math.max(0, collector.limit - collector.issues.length);
  for (let index = 0; index < Math.min(remaining, increment); index += 1) {
    collector.issues.push(normalized);
  }
  collector.truncated = collector.count > collector.limit;
}

function recordStableIssue(collector, issue) {
  recordStableIssueCount(collector, issue, 1);
}

function recordStableIssueBatch(collector, issues, totalCount = issues.length) {
  for (const issue of issues) recordStableIssue(collector, issue);
  if (totalCount > issues.length) {
    collector.count += totalCount - issues.length;
    collector.truncated = true;
    collector.identities_complete = false;
  }
}

function mergeStableIssueCollector(target, source) {
  for (const { issue, count } of source?.entries?.values?.() || []) {
    recordStableIssueCount(target, issue, count);
  }
  if (source?.identities_complete === false) target.identities_complete = false;
}

function stableIssueCollectorDetails(collector, domain) {
  const entries = [...collector.entries.values()]
    .map(({ issue, count }) => [issue.code, issue.subject_key, count])
    .sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right)));
  const sample = [];
  for (const [code, subjectKey, count] of entries) {
    for (let index = 0; index < count && sample.length < collector.limit; index += 1) {
      sample.push(displayStableIssue({ code, subject_key: subjectKey }));
    }
    if (sample.length >= collector.limit) break;
  }
  return {
    count: collector.count,
    sample,
    sample_count: sample.length,
    truncated: collector.count > sample.length,
    digest: canonicalDigest({ domain, algorithm: DIGEST_ALGORITHM, entries }),
    entries: collector.entries,
    entries_complete: collector.identities_complete,
  };
}

function stableTupleSummary(domain, tuples) {
  const counts = new Map();
  for (const tuple of tuples) {
    const key = canonicalJson(tuple);
    const current = counts.get(key) || { tuple, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const entries = [...counts.values()]
    .map(({ tuple, count }) => [...tuple, count])
    .sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right)));
  return {
    count: tuples.length,
    distinct_count: entries.length,
    digest: canonicalDigest({ domain, algorithm: DIGEST_ALGORITHM, entries }),
  };
}

function issueMultiset(issues) {
  const counts = new Map();
  const sample = new Map();
  for (const issue of issues || []) {
    const key = stableIssueKey(issue);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!sample.has(key)) sample.set(key, issue);
  }
  return { counts, sample };
}

function multisetDifference(left, right) {
  const leftSet = issueMultiset(left);
  const rightSet = issueMultiset(right);
  const result = [];
  for (const [key, count] of leftSet.counts.entries()) {
    const remaining = Math.max(0, count - (rightSet.counts.get(key) || 0));
    for (let index = 0; index < remaining; index += 1) result.push(leftSet.sample.get(key));
  }
  return sortStableIssues(result);
}

function multisetIsSubset(candidate, baseline) {
  const candidateSet = issueMultiset(candidate);
  const baselineSet = issueMultiset(baseline);
  for (const [key, count] of candidateSet.counts.entries()) {
    if (count > (baselineSet.counts.get(key) || 0)) return false;
  }
  return true;
}

function snapshotIssueDetails(snapshot, kind) {
  const hidden = DECISION_SNAPSHOT_DETAILS.get(snapshot)?.[kind];
  const issues = Array.isArray(snapshot?.[`${kind}_issues`]) ? snapshot[`${kind}_issues`] : [];
  const countField = `${kind}_issue_count`;
  const digestField = `${kind}_issue_multiset_digest`;
  const truncatedField = `${kind}_issues_truncated`;
  const completeField = `${kind}_issues_complete`;
  const count = Number.isInteger(snapshot?.[countField]) ? snapshot[countField] : issues.length;
  if (hidden) {
    return {
      ...hidden,
      complete: snapshot?.[completeField] === true,
      entries_complete: hidden.entries_complete && snapshot?.[completeField] === true,
    };
  }
  const collector = createStableIssueCollector();
  for (const item of issues) recordStableIssue(collector, item);
  const derived = stableIssueCollectorDetails(collector, `project-gov/${kind}-issues/v1`);
  return {
    ...derived,
    count,
    digest: typeof snapshot?.[digestField] === "string" ? snapshot[digestField] : derived.digest,
    complete: snapshot?.[completeField] === true,
    entries_complete: snapshot?.[completeField] === true
      && snapshot?.[truncatedField] !== true
      && count === issues.length,
  };
}

function issueDetailsEqual(left, right) {
  return left.complete
    && right.complete
    && left.count === right.count
    && left.digest === right.digest;
}

function issueDetailsIsSubset(candidate, baseline) {
  if (!candidate.entries_complete || !baseline.entries_complete) return { comparable: false, subset: false };
  for (const [key, item] of candidate.entries.entries()) {
    if (item.count > (baseline.entries.get(key)?.count || 0)) return { comparable: true, subset: false };
  }
  return { comparable: true, subset: true };
}

function issueDetailsDifference(left, right, limit = MAX_STRUCTURE_ISSUES) {
  if (!left.entries_complete || !right.entries_complete) return [];
  const result = [];
  const ordered = [...left.entries.entries()]
    .sort(([leftKey], [rightKey]) => compareUtf8(leftKey, rightKey));
  for (const [key, item] of ordered) {
    const remaining = Math.max(0, item.count - (right.entries.get(key)?.count || 0));
    for (let index = 0; index < remaining && result.length < limit; index += 1) {
      result.push(displayStableIssue(item.issue));
    }
    if (result.length >= limit) break;
  }
  return result;
}

function changedTargetPaths(beforeFingerprints, afterFingerprints) {
  const keys = new Set([
    ...Object.keys(beforeFingerprints || {}),
    ...Object.keys(afterFingerprints || {}),
  ]);
  return [...keys]
    .filter((rel) => canonicalJson(beforeFingerprints?.[rel] ?? null) !== canonicalJson(afterFingerprints?.[rel] ?? null))
    .sort(compareUtf8);
}

function isLegacyCheckpointActionSet(actions, changedPaths) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  const declared = new Set();
  for (const action of actions) {
    if (!isPlainObject(action) || !LEGACY_CHECKPOINT_PATHS.has(action.path)) return false;
    declared.add(action.path);
  }
  if (!declared.has("HANDOFF.md") || !Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  const changed = new Set(changedPaths);
  return changed.has("HANDOFF.md") && [...changed].every((rel) => LEGACY_CHECKPOINT_PATHS.has(rel));
}

function semanticCheckpointDeclarationChanged(before, after) {
  return before?.declarations_present === true
    && after?.declarations_present === true
    && canonicalJson([
      before.last_semantic_checkpoint,
      before.changes_after_checkpoint,
    ]) !== canonicalJson([
      after.last_semantic_checkpoint,
      after.changes_after_checkpoint,
    ]);
}

function relationshipSetsEqual(before, after) {
  return before?.relationships?.complete === true
    && after?.relationships?.complete === true
    && canonicalJson(before.relationships) === canonicalJson(after.relationships);
}

function coreIndexFingerprintsEqual(before, after) {
  return isPlainObject(before?.core_index_fingerprints)
    && isPlainObject(after?.core_index_fingerprints)
    && canonicalJson(before.core_index_fingerprints) === canonicalJson(after.core_index_fingerprints);
}

function isCompletelyCompliant(snapshot) {
  return snapshot?.hard_issues_complete === true
    && snapshot?.coverage_issues_complete === true
    && Number(snapshot?.hard_issue_count ?? snapshot?.hard_issues?.length ?? -1) === 0
    && Number(snapshot?.coverage_issue_count ?? snapshot?.coverage_issues?.length ?? -1) === 0
    && snapshot?.five_piece?.over_limit === false;
}

function evaluateValidationTransition(before, after, options = {}) {
  const rejectionCodes = [];
  const beforeCompliant = isCompletelyCompliant(before);
  const afterCompliant = isCompletelyCompliant(after);
  const beforeHard = snapshotIssueDetails(before, "hard");
  const afterHard = snapshotIssueDetails(after, "hard");
  const beforeCoverage = snapshotIssueDetails(before, "coverage");
  const afterCoverage = snapshotIssueDetails(after, "coverage");
  const completeIssueSets = before?.hard_issues_complete === true
    && before?.coverage_issues_complete === true
    && after?.hard_issues_complete === true
    && after?.coverage_issues_complete === true;
  const hardSubset = issueDetailsIsSubset(afterHard, beforeHard);
  const coverageSubset = issueDetailsIsSubset(afterCoverage, beforeCoverage);
  const beforeBytes = Number(before?.five_piece?.total_bytes ?? 0);
  const afterBytes = Number(after?.five_piece?.total_bytes ?? 0);
  const fivePieceDeltaBytes = afterBytes - beforeBytes;
  const legacyCheckpointAccepted = !beforeCompliant
    && !afterCompliant
    && before?.scan_complete === true
    && after?.scan_complete === true
    && completeIssueSets
    && issueDetailsEqual(beforeHard, afterHard)
    && issueDetailsEqual(beforeCoverage, afterCoverage)
    && relationshipSetsEqual(before, after)
    && coreIndexFingerprintsEqual(before, after)
    && semanticCheckpointDeclarationChanged(
      options.before_semantic_declaration,
      options.after_semantic_declaration,
    )
    && isLegacyCheckpointActionSet(options.actions, options.changed_paths);
  const policyPath = legacyCheckpointAccepted ? "legacy_neutral_checkpoint" : "strict";

  if (legacyCheckpointAccepted) {
    if (before?.five_piece?.over_limit !== true && after?.five_piece?.over_limit === true) {
      rejectionCodes.push("transition_five_piece_newly_over_limit");
    }
    if (before?.five_piece?.over_limit === true && after?.five_piece?.over_limit === true && afterBytes >= beforeBytes) {
      rejectionCodes.push("transition_five_piece_not_reduced");
    }
  } else if (!completeIssueSets && !afterCompliant) {
    rejectionCodes.push("transition_incomplete_issue_set");
  } else if (beforeCompliant) {
    if (!afterCompliant) rejectionCodes.push("transition_compliant_baseline_regressed");
  } else {
    if (completeIssueSets && !afterCompliant && (!hardSubset.comparable || !coverageSubset.comparable)) {
      rejectionCodes.push("transition_issue_set_comparison_unavailable");
    }
    if (completeIssueSets && hardSubset.comparable && !hardSubset.subset) rejectionCodes.push("transition_new_hard_issue");
    if (completeIssueSets && coverageSubset.comparable && !coverageSubset.subset) rejectionCodes.push("transition_new_coverage_issue");
    if (before?.five_piece?.over_limit !== true && after?.five_piece?.over_limit === true) {
      rejectionCodes.push("transition_five_piece_newly_over_limit");
    }
    if (before?.five_piece?.over_limit === true && after?.five_piece?.over_limit === true && afterBytes >= beforeBytes) {
      rejectionCodes.push("transition_five_piece_not_reduced");
    }
    const removedHard = issueDetailsDifference(beforeHard, afterHard);
    const removedCoverage = issueDetailsDifference(beforeCoverage, afterCoverage);
    const bytesImproved = before?.five_piece?.over_limit === true && afterBytes < beforeBytes;
    if (!afterCompliant && removedHard.length === 0 && removedCoverage.length === 0 && !bytesImproved) {
      rejectionCodes.push("transition_no_strict_improvement");
    }
  }

  const transitionOk = rejectionCodes.length === 0;
  return {
    transition_ok: transitionOk,
    policy_path: policyPath,
    legacy_checkpoint_accepted: legacyCheckpointAccepted && transitionOk,
    semantic_checked_by_tool: false,
    commit_state: transitionOk
      ? (afterCompliant ? "compliant" : legacyCheckpointAccepted ? "legacy_checkpoint_noncompliant" : "improved_but_noncompliant")
      : "rejected",
    removed_hard_issues: issueDetailsDifference(beforeHard, afterHard),
    remaining_hard_issues: sortStableIssues(after?.hard_issues || []).slice(0, MAX_STRUCTURE_ISSUES),
    removed_coverage_issues: issueDetailsDifference(beforeCoverage, afterCoverage),
    remaining_coverage_issues: sortStableIssues(after?.coverage_issues || []).slice(0, MAX_STRUCTURE_ISSUES),
    five_piece_delta_bytes: fivePieceDeltaBytes,
    rejection_codes: [...new Set(rejectionCodes)],
  };
}

function main() {
  try {
    const argv = process.argv.slice(2);
    const command = argv.shift();
    const opts = parseArgs(argv);

    if (!command || command === "help" || command === "--help" || command === "-h") {
      printHelp();
      return;
    }

    const handlers = {
      inspect: commandInspect,
      validate: commandValidate,
      ids: commandIds,
      startup: commandStartup,
      "migrate-check": commandMigrateCheck,
      "verify-materials": commandVerifyMaterials,
      prune: commandPrune,
      propose: commandPropose,
      apply: commandApply,
    };
    if (!handlers[command]) fail(`Unknown command: ${command}`, 2);
    validateCommandOptions(command, opts);
    return handlers[command](opts);
  } catch (error) {
    const payload = {
      ok: false,
      error: boundedIdentityText(error.message || String(error), 4096),
      tool: SCRIPT_NAME,
      skill_version: SKILL_VERSION,
    };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = process.exitCode || 1;
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (["json", "text", "apply"].includes(key)) {
      opts[toCamel(key)] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      fail(`Missing value for --${key}`, 2);
    }
    opts[toCamel(key)] = next;
    i += 1;
  }
  return opts;
}

function validateCommandOptions(command, opts) {
  const allowed = {
    inspect: new Set(["root", "json"]),
    validate: new Set(["root", "json"]),
    ids: new Set(["root", "date", "json"]),
    startup: new Set(["root", "json", "text"]),
    "migrate-check": new Set(["root", "json"]),
    "verify-materials": new Set(["root", "json"]),
    prune: new Set(["root", "olderThanDays", "json"]),
    propose: new Set(["root", "plan", "out", "json"]),
    apply: new Set(["plan", "json"]),
  }[command];
  if (opts._.length > 0) fail(`Unexpected positional arguments: ${opts._.join(", ")}`, 2);
  const unknown = Object.keys(opts).filter((key) => key !== "_" && !allowed.has(key));
  if (unknown.length > 0) fail(`Unsupported option(s) for ${command}: ${unknown.join(", ")}`, 2);
  if (command === "startup" && opts.json && opts.text) {
    fail("startup accepts either --json or --text, not both", 2);
  }
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function printHelp() {
  console.log(`Usage:
  Read-only:
  ${SCRIPT_NAME} inspect --root <path> [--json]
  ${SCRIPT_NAME} validate --root <path> [--json]
  ${SCRIPT_NAME} ids --root <path> [--date YYYYMMDD|YYYY-MM-DD] [--json]
  ${SCRIPT_NAME} startup --root <path> [--json|--text]
  ${SCRIPT_NAME} migrate-check --root <path> [--json]
  ${SCRIPT_NAME} verify-materials --root <path> [--json]

  Read-only cache inventory:
  ${SCRIPT_NAME} prune --root <path> [--older-than-days <days>] [--json]

  Controlled writes:
  ${SCRIPT_NAME} propose --root <path> --plan <operation.json> [--out <root>/.project-gov/plans/<plan-id>.json] [--json]
  ${SCRIPT_NAME} apply --plan <prepared.json> [--json]

Rules:
  - inspect/validate/ids/startup/migrate-check/verify-materials are read-only.
  - prune only inventories old .project-gov cache; it never deletes files.
  - propose is dry-run only; it prepares and validates a file-operation plan.
  - apply holds an atomic project-local lock, revalidates actions, checks before_hashes, and rolls back failed writes.`);
}

function commandInspect(opts) {
  const root = resolveRoot(opts.root);
  const report = inspectProject(root);
  output(report, opts);
  if (!report.ok) process.exitCode = 1;
}

function commandValidate(opts) {
  const root = resolveRoot(opts.root);
  const report = inspectProject(root);
  const errors = report.errors;

  const validation = {
    ok: report.ok,
    mechanical_ok: report.mechanical_ok,
    coverage_complete: report.coverage_complete,
    indeterminate: report.indeterminate,
    coverage_issues: report.coverage_issues,
    validation_kind: "mechanical",
    semantic_checked_by_tool: false,
    project_knowledge_checked_by_tool: false,
    tool: SCRIPT_NAME,
    command: "validate",
    skill_version: SKILL_VERSION,
    project_structure_version: PROJECT_STRUCTURE_VERSION,
    root,
    errors,
    warnings: report.warnings,
    semantic_declaration: report.semantic_declaration,
    report,
  };

  output(validation, opts);
  if (!validation.ok) process.exitCode = 1;
}

function commandIds(opts) {
  const root = resolveRoot(opts.root);
  assertManagedCorePathsNotRedirected(root);
  const context = createInspectionContext(root, { phase: "ids" });
  const indexModel = buildTypedIndexModel(context);
  const markdownScan = listManagedMarkdownFiles(root, context, indexModel);
  const date = normalizeDate(opts.date || currentLocalDate());
  const idData = collectIds(root, markdownScan, [], context, indexModel);
  const inspectionEpochSeal = context.seal();
  const scanIssueCategories = [
    ...markdownScanErrors(markdownScan),
    ...markdownScanCoverageIssues(markdownScan),
    ...(inspectionEpochSeal.ok ? [] : ["inspection_epoch_drift"]),
  ];
  const hardIssueDetails = stableIssueCollectorDetails(
    indexModel.hardIssueCollector,
    "project-gov/ids-hard-issues/v1",
  );
  const coverageIssueDetails = stableIssueCollectorDetails(
    indexModel.coverageIssueCollector,
    "project-gov/ids-coverage-issues/v1",
  );
  const markdownCoverageIssueDetails = stableIssueCollectorDetails(
    markdownScan.coverageIssueCollector,
    "project-gov/ids-markdown-coverage-issues/v1",
  );
  const scanIssueSamples = [
    ...scanIssueCategories,
    ...indexModel.hardIssues.map((item) => item.code),
    ...indexModel.coverageIssues.map((item) => item.code),
  ];
  const errorCount = hardIssueDetails.count
    + coverageIssueDetails.count
    + markdownCoverageIssueDetails.count
    + (inspectionEpochSeal.issue_count || 0);
  const errors = [...new Set(scanIssueSamples)]
    .slice(0, MAX_STRUCTURE_ISSUES)
    .map((item) => boundedIdentityText(item, 160));
  const errorMultisetDigest = canonicalDigest({
    domain: "project-gov/ids-errors/v1",
    scan_issue_categories: [...scanIssueCategories].sort(compareUtf8),
    hard_issue_count: hardIssueDetails.count,
    hard_issue_multiset_digest: hardIssueDetails.digest,
    coverage_issue_count: coverageIssueDetails.count,
    coverage_issue_multiset_digest: coverageIssueDetails.digest,
    markdown_coverage_issue_count: markdownCoverageIssueDetails.count,
    markdown_coverage_issue_multiset_digest: markdownCoverageIssueDetails.digest,
    inspection_epoch_issue_count: inspectionEpochSeal.issue_count || 0,
    inspection_epoch_issue_multiset_digest: inspectionEpochSeal.issue_multiset_digest,
  });
  const ids = errorCount === 0 ? nextIds(idData.all, date) : null;
  const result = {
    ok: errorCount === 0,
    tool: SCRIPT_NAME,
    command: "ids",
    root,
    date,
    ids,
    markdown_scan: markdownScan.summary,
    inspection_epoch: {
      id: context.epoch_id,
      phase: context.phase,
      seal: inspectionEpochSeal,
    },
    errors,
    error_count: errorCount,
    errors_truncated: errorCount > errors.length,
    error_multiset_digest: errorMultisetDigest,
  };
  output(result, opts);
  if (!result.ok) process.exitCode = 1;
}

function commandStartup(opts) {
  const root = resolveRoot(opts.root);
  const report = inspectProject(root);
  const startup = `[$project-delivery-engine](<${SKILL_PATH}>) 接续本项目。

项目根目录：
${root}

先读 AGENTS.md、PROJECT_START_HERE.md、HANDOFF.md、STATUS.md、TODO.md 的当前结论、索引和结尾；只有任务需要时再按索引深读历史记录、证据库、项目物料和专项文档。明确或从当前状态推断具体任务后，必须用现有入口做一次轻量相关性判断；仅命中时读取最相关的权威知识入口，没有相关信号就静默继续，不递归展开或批量加载知识资产。接到具体任务后，按本 Skill 的状态治理边界完成建档、接续或交接；只有持久状态发生实质变化时才写正式治理记录，中间进度沿用轻量进度账。具体执行与隔离方式由宿主运行时决定。`;

  const changesPending = report.semantic_declaration.changes_after_checkpoint === "待确认";
  const readinessErrors = [
    ...report.errors,
    ...(changesPending ? ["handoff_changes_not_reconciled"] : []),
  ];
  const ready = readinessErrors.length === 0 && report.coverage_complete;

  const result = {
    ok: ready,
    mechanical_ok: report.mechanical_ok,
    coverage_complete: report.coverage_complete,
    indeterminate: report.indeterminate,
    coverage_issues: report.coverage_issues,
    validation_kind: "startup_readiness",
    semantic_checked_by_tool: false,
    tool: SCRIPT_NAME,
    command: "startup",
    root,
    startup: ready ? startup : null,
    errors: readinessErrors,
    semantic_declaration: report.semantic_declaration,
    warnings: [
      ...(report.warnings || []),
      ...report.files.five_piece.missing.map((file) => `missing:${file}`),
      ...report.files.indexes.missing.map((file) => `missing:${file}`),
      ...(report.five_piece.over_limit ? ["five_piece_over_45kb"] : []),
      ...(report.markdown_scan.truncated ? ["markdown_scan_truncated"] : []),
    ],
  };

  if (opts.json) {
    output(result, opts);
  } else if (result.ok) {
    console.log(startup);
  } else {
    console.error("startup_not_generated: readiness_gate_failed");
    console.error(`errors: ${result.errors.join(", ") || "none"}`);
    console.error(`coverage_complete: ${result.coverage_complete}`);
    console.error(`coverage_issues: ${result.coverage_issues.join(", ") || "none"}`);
  }

  if (!result.ok) process.exitCode = 1;
}

function commandMigrateCheck(opts) {
  const root = resolveRoot(opts.root);
  const report = inspectProject(root);
  const physicalLayout = inspectLegacyRootLayout(root);
  const missingFiles = [
    ...report.files.five_piece.missing,
    ...report.files.indexes.missing,
  ].map((rel) => ({
    code: `structure_file_missing:${rel}`,
    rel,
    section: null,
    detail: "required_file_missing",
  }));
  const scanItems = [
    ...markdownScanErrors(report.markdown_scan),
    ...markdownScanCoverageIssues(report.markdown_scan),
  ].map((code) => ({
    code,
    rel: null,
    section: null,
    detail: "migration_scan_incomplete",
  }));
  const semanticItems = report.semantic_declaration.errors.map((code) => ({
    code,
    rel: "HANDOFF.md",
    section: "## 语义检查点",
    detail: "semantic_declaration_invalid",
  }));
  const inspectionItems = report.errors
    .filter((code) => code === "inspection_epoch_drift")
    .map((code) => ({
      code,
      rel: null,
      section: null,
      detail: "inspection_epoch_incomplete",
    }));
  const typedIndexItems = (report.typed_indexes?.hard_issues || [])
    .filter((item) => !String(item.code || "").startsWith("structure_"))
    .map((item) => ({
      code: item.code,
      rel: null,
      section: null,
      detail: item.subject_key,
      subject_key: item.subject_key,
    }));
  const migrationItemCandidates = [
    ...missingFiles,
    ...report.structure.issues,
    ...typedIndexItems,
    ...semanticItems,
    ...scanItems,
    ...inspectionItems,
  ];
  const migrationItemsTruncated = migrationItemCandidates.length > MAX_STRUCTURE_ISSUES
    || report.structure.issues_truncated === true
    || report.typed_indexes?.hard_issues_truncated === true;
  const migrationItems = migrationItemCandidates.slice(0, MAX_STRUCTURE_ISSUES);
  const indeterminate = scanItems.length > 0
    || report.typed_indexes?.complete !== true
    || report.indeterminate;
  const migrationGatePassed = Number(report.decision_snapshot?.hard_issue_count || 0) === 0
    && Number(report.decision_snapshot?.coverage_issue_count || 0) === 0
    && !indeterminate;
  const result = {
    ok: migrationGatePassed,
    tool: SCRIPT_NAME,
    command: "migrate-check",
    root,
    skill_version: SKILL_VERSION,
    target_project_structure_version: PROJECT_STRUCTURE_VERSION,
    up_to_date: migrationGatePassed,
    indeterminate,
    automatic_rewrite: false,
    semantic_checked_by_tool: false,
    project_knowledge_checked_by_tool: false,
    knowledge_review: {
      status: "not_checked",
      blocking: false,
      affects_structural_up_to_date: false,
      automatic_backfill: false,
    },
    migration_items: migrationItems,
    migration_items_sample_count: migrationItems.length,
    migration_items_truncated: migrationItemsTruncated,
    notices: report.warnings,
    markdown_scan: report.markdown_scan,
    checked: report.structure.checked,
    not_checked: report.structure.not_checked,
    coverage_scope: report.structure.coverage_scope,
    physical_layout: physicalLayout,
  };
  output(result, opts);
  if (!result.ok) process.exitCode = 1;
}

function commandPrune(opts) {
  const root = resolveRoot(opts.root);
  const olderThanDays = parseNonNegativeNumber(opts.olderThanDays ?? DEFAULT_PRUNE_AGE_DAYS, "--older-than-days");
  const result = inventoryGovernanceCache(root, olderThanDays);
  output(result, opts);
  if (!result.ok) process.exitCode = 1;
}

function commandVerifyMaterials(opts) {
  const root = resolveRoot(opts.root);
  const result = verifyMaterialHashes(root);
  output(result, opts);
  if (!result.ok) process.exitCode = 1;
}

function verifyMaterialHashes(root) {
  const rel = "项目物料/INDEX.md";
  assertManagedPathNotRedirected(root, rel);
  const context = createInspectionContext(root, { phase: "verify_materials" });
  const base = {
    tool: SCRIPT_NAME,
    command: "verify-materials",
    root,
    index: rel,
    algorithm: "sha256",
    verification_scope: "indexed_rows_only",
    max_file_bytes: MAX_MATERIAL_HASH_FILE_BYTES,
  };
  if (context.kind(rel) !== "file") {
    return sealCommandResult(context, {
      ...base,
      ok: false,
      complete: false,
      checked_count: 0,
      matched_count: 0,
      mismatches: [],
      missing: [],
      unverifiable: [],
      errors: [`material_index_missing:${rel}`],
    });
  }
  const indexModel = buildTypedIndexModel(context);
  const materialIndex = indexModel.materials;
  if (!materialIndex?.table_complete) {
    return sealCommandResult(context, {
      ...base,
      ok: false,
      complete: false,
      checked_count: 0,
      matched_count: 0,
      mismatches: [],
      missing: [],
      unverifiable: [],
      errors: ["material_index_structure_invalid"],
    });
  }

  let matchedCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;
  let unverifiableCount = 0;
  let indexedCount = 0;
  const seenMaterialIds = new Set();
  const matchedSample = [];
  const mismatches = [];
  const missing = [];
  const unverifiable = [];
  for (const row of materialIndex.rows) {
    indexedCount += 1;
    const rawMaterialId = row.definition_id || "";
    const materialId = limitText(rawMaterialId || `line:${row.line}`, MAX_STRUCTURE_DETAIL_CHARS);
    const locator = row.locator || {
      ok: false,
      kind: "unknown",
      classification: "unknown",
      reason: "material_locator_unclassified",
      report_path: null,
      path_redacted: true,
    };
    const common = {
      material_id: materialId,
      locator_kind: locator.kind,
      classification: locator.classification,
      path: locator.report_path === null || locator.report_path === undefined
        ? null
        : boundedIdentityText(locator.report_path),
      path_kind: materialVerificationPathKind(locator),
      path_redacted: locator.path_redacted === true,
      line: row.line,
    };

    if (!isCanonicalProjectId(rawMaterialId, "MAT")) {
      unverifiableCount += 1;
      pushLimited(unverifiable, {
        ...common,
        reason: "material_id_invalid",
        reasons: ["material_id_invalid"],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }
    if (seenMaterialIds.has(rawMaterialId)) {
      unverifiableCount += 1;
      pushLimited(unverifiable, {
        ...common,
        reason: "material_id_duplicate",
        reasons: ["material_id_duplicate"],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }
    seenMaterialIds.add(rawMaterialId);

    if (
      !locator.ok
      || locator.kind !== "file"
      || locator.classification === "project_relative_missing_file"
    ) {
      const rawHash = normalizeMarkdownCodeCellLiteral(row.cells.hash || "").trim();
      const nonFileHash = rawHash === "-" ? null : normalizeSha256Cell(rawHash);
      const locatorReason = locator.reason || "intentional_unverifiable";
      const reasons = [
        ...(nonFileHash && !nonFileHash.ok ? [nonFileHash.reason] : []),
        locatorReason,
      ].filter(Boolean);
      const reason = reasons[0];
      const missingFile = locator.kind === "file" && reason === "file_missing";
      if (missingFile) missingCount += 1;
      else unverifiableCount += 1;
      pushLimited(missingFile ? missing : unverifiable, {
        ...common,
        reason,
        reasons: [...new Set(reasons)],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }

    const expected = normalizeSha256Cell(row.cells.hash || "");
    if (!expected.ok) {
      unverifiableCount += 1;
      pushLimited(unverifiable, {
        ...common,
        reason: expected.reason,
        reasons: [expected.reason],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }
    const bytes = context.size(locator.rel);
    if (bytes > MAX_MATERIAL_HASH_FILE_BYTES) {
      unverifiableCount += 1;
      pushLimited(unverifiable, {
        ...common,
        reason: "file_over_hash_limit",
        reasons: ["file_over_hash_limit"],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }
    let actual;
    try {
      actual = context.fingerprint(locator.rel).sha256;
    } catch (error) {
      const reason = limitText(`read_failed:${formatFsError(error)}`, MAX_STRUCTURE_DETAIL_CHARS);
      unverifiableCount += 1;
      pushLimited(unverifiable, {
        ...common,
        reason,
        reasons: [reason],
      }, MAX_MATERIAL_REPORT_ITEMS);
      continue;
    }
    const record = {
      material_id: materialId,
      locator_kind: "file",
      classification: locator.classification,
      path: limitText(locator.rel, MAX_STRUCTURE_DETAIL_CHARS),
      path_kind: "project_relative_file",
      path_redacted: false,
      line: row.line,
      expected_sha256: expected.value,
      actual_sha256: actual,
    };
    if (actual === expected.value) {
      matchedCount += 1;
      pushLimited(matchedSample, {
        material_id: record.material_id,
        path: record.path,
        line: record.line,
      }, MAX_MATERIAL_MATCH_SAMPLES);
    } else {
      mismatchCount += 1;
      pushLimited(mismatches, record, MAX_MATERIAL_REPORT_ITEMS);
    }
  }

  const checkedCount = matchedCount + mismatchCount;
  const complete = indexModel.completenessState.hard_issues_complete
    && indexModel.completenessState.coverage_issues_complete
    && mismatchCount === 0
    && missingCount === 0
    && unverifiableCount === 0;
  return sealCommandResult(context, {
    ...base,
    ok: complete,
    complete,
    indexed_count: indexedCount,
    checked_count: checkedCount,
    matched_count: matchedCount,
    mismatch_count: mismatchCount,
    missing_count: missingCount,
    unverifiable_count: unverifiableCount,
    matched_sample: matchedSample,
    mismatches,
    missing,
    unverifiable,
    report_truncated: {
      matched: matchedCount > matchedSample.length,
      mismatches: mismatchCount > mismatches.length,
      missing: missingCount > missing.length,
      unverifiable: unverifiableCount > unverifiable.length,
    },
    warnings: indexedCount === 0 ? ["material_index_empty_no_files_verified"] : [],
    errors: [
      ...(mismatchCount > 0 ? ["material_hash_mismatch"] : []),
      ...(missingCount > 0 ? ["material_file_missing"] : []),
      ...(unverifiableCount > 0 ? ["material_hash_unverifiable"] : []),
    ],
  });
}

function materialVerificationPathKind(locator) {
  if (locator.classification === "external_uri") return "external";
  if (locator.classification === "absolute_reference") return "absolute";
  return locator.classification || locator.kind || "unknown";
}

function pushLimited(target, value, limit) {
  if (target.length < limit) target.push(value);
}


function normalizeSha256Cell(value) {
  const normalized = normalizeMarkdownCodeCellLiteral(value)
    .replace(/^sha-?256\s*:\s*/i, "")
    .trim()
    .toLowerCase();
  if (!normalized) return { ok: false, reason: "hash_missing" };
  if (!/^[a-f0-9]{64}$/.test(normalized)) return { ok: false, reason: "hash_not_sha256" };
  return { ok: true, value: normalized };
}


function commandPropose(opts) {
  const root = resolveRoot(opts.root);
  const planPath = requireOption(opts.plan, "--plan is required");
  const planArtifact = readJsonArtifact(planPath);
  const plan = planArtifact.value;
  const context = createInspectionContext(root, { phase: "propose" });
  const report = inspectProject(root, { context, phase: "propose" });
  const result = compilePlan(root, plan, report, context);

  const compiledText = result.ok ? JSON.stringify(result.compiled_plan, null, 2) + "\n" : null;
  if (compiledText !== null && utf8Bytes(compiledText) > MAX_WORKFLOW_JSON_BYTES) {
    fail("compiled_workflow_artifact_too_large", 2);
  }

  let outPath = null;
  let operationCleanup = null;
  if (opts.out && result.ok) {
    outPath = resolveCompiledPlanOutput(root, opts.out);
    writeAtomic(outPath, compiledText);
    operationCleanup = cleanupProjectCacheArtifact(
      root,
      planPath,
      ["operations", "ops"],
      planArtifact.binding,
    );
  }

  output(summarizeCompiledPlan(result, outPath, operationCleanup), opts);
  if (!result.ok) process.exitCode = 1;
}

function commandApply(opts) {
  const compiledPath = requireOption(opts.plan, "--plan <compiled.json> is required");
  const compiledArtifact = readJsonArtifact(compiledPath);
  const compiled = compiledArtifact.value;
  let result = applyCompiledPlan(compiled);
  if (result.ok === true || result.rolled_back === true) {
    const planCleanup = cleanupProjectCacheArtifact(
      resolveRoot(compiled?.root),
      compiledPath,
      ["plans"],
      compiledArtifact.binding,
    );
    result = {
      ...result,
      plan_cleanup: planCleanup,
      warnings: planCleanup.ok
        ? (result.warnings || [])
        : [...new Set([...(result.warnings || []), `compiled_plan_cleanup_failed:${planCleanup.error}`])],
    };
  }
  output(result, opts);
  if (!result.ok) process.exitCode = 1;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkGovernanceSections(root, context) {
  let text = "";
  try {
    text = context.kind("HANDOFF.md") === "file"
      ? context.getBoundedText("HANDOFF.md", MAX_MARKDOWN_SCAN_FILE_BYTES).text
      : "";
  } catch {
    text = "";
  }
  const lines = visibleMarkdownLines(text);
  const checks = [
    { key: "falsified_routes", heading: "## 已证伪路线", warning: "missing_handoff_falsified_routes" },
  ];
  const present = {};
  const warnings = [];
  for (const item of checks) {
    const found = lines.some((line) => line.trim() === item.heading);
    present[item.key] = found;
    if (!found) warnings.push(item.warning);
  }
  return { present, warnings };
}

const CORE_SECTION_CONTRACTS = [
  { rel: "PROJECT_START_HERE.md", section: "## 项目路径" },
  { rel: "PROJECT_START_HERE.md", section: "## 启动入口" },
  { rel: "HANDOFF.md", section: "## 接手顺序" },
  { rel: "HANDOFF.md", section: "## 未决上下文" },
];

const CORE_TABLE_CONTRACTS = [
  { rel: "STATUS.md", section: "## 当前状态", columns: ["项目", "状态", "依据"] },
  {
    rel: "STATUS.md",
    section: "## 验证",
    columns: ["验证项", "结果", "层级"],
    enums: { 层级: ["主线", "旁证"] },
  },
  { rel: "TODO.md", section: "## 下一步", columns: ["优先级", "事项", "完成条件"] },
  { rel: "TODO.md", section: "## 待确认", columns: ["事项", "影响"] },
  {
    rel: "HANDOFF.md",
    section: "## 已证伪路线",
    columns: ["路线/假设", "证伪证据（一行）", "关闭日期", "复开条件"],
    optional: true,
  },
  { rel: "HANDOFF.md", section: "## 关键索引", columns: ["类型", "路径", "用途"] },
  {
    rel: "历史记录/00-历史总目录.md",
    section: null,
    columns: ["history-id", "日期", "标题", "路径", "状态"],
    uniqueFirstColumn: true,
  },
  {
    rel: "证据库/总索引/证据总目录.md",
    section: null,
    columns: ["evidence-id", "run_id", "task_id", "来源", "摘要", "路径", "采纳状态"],
    uniqueFirstColumn: true,
  },
  {
    rel: "项目物料/INDEX.md",
    section: null,
    columns: ["material-id", "路径", "hash", "来源", "用途", "状态"],
    uniqueFirstColumn: true,
  },
];

function inspectCoreStructure(root, context = createInspectionContext(root), indexModel = buildTypedIndexModel(context)) {
  const collector = createStructureIssueCollector();
  const checked = [];
  for (const contract of CORE_SECTION_CONTRACTS) {
    if (context.kind(contract.rel) !== "file") continue;
    const before = collector.count;
    let text;
    try {
      text = context.getBoundedText(contract.rel, MAX_MARKDOWN_SCAN_FILE_BYTES).text;
    } catch {
      continue;
    }
    const result = inspectSectionContract(text, contract, collector);
    checked.push({
      kind: "section",
      rel: contract.rel,
      section: contract.section,
      present: result.present,
      ok: collector.count === before,
    });
  }
  for (const contract of CORE_TABLE_CONTRACTS) {
    if (context.kind(contract.rel) !== "file") continue;
    const before = collector.count;
    let result;
    if (INDEX_FILES.includes(contract.rel)) {
      const key = contract.rel.startsWith("历史记录/")
        ? "history"
        : contract.rel.startsWith("证据库/") ? "evidence" : "materials";
      const typedIndex = indexModel[key];
      result = typedIndex?.contract_result || { columns: [], table_count: 0 };
      for (const issue of typedIndex?.contract_issues || []) recordStructureIssue(collector, issue);
      const omittedIssueCount = Math.max(
        0,
        (typedIndex?.contract_issue_count || 0) - (typedIndex?.contract_issues?.length || 0),
      );
      if (omittedIssueCount > 0) {
        collector.count += omittedIssueCount;
        collector.truncated = true;
      }
    } else {
      let text;
      try {
        text = context.getBoundedText(contract.rel, MAX_MARKDOWN_SCAN_FILE_BYTES).text;
      } catch {
        continue;
      }
      result = inspectTableContract(text, contract, collector);
    }
    checked.push({
      kind: "table",
      rel: contract.rel,
      section: contract.section,
      ok: collector.count === before,
      columns: result.columns,
      table_count: result.table_count,
    });
  }
  const result = {
    ok: collector.count === 0,
    checked,
    issues: collector.issues,
    issue_count: collector.count,
    issues_truncated: collector.truncated,
    not_checked: [
      "business_semantics",
      "project_knowledge_completeness",
      "material_hash_truth_unless_verify_materials_command_is_run",
      "legacy_migration_completeness",
    ],
    coverage_scope: {
      core_files: [...FIVE_PIECE, ...INDEX_FILES],
      markdown_scope: "five_piece_indexes_and_indexed_markdown_only",
      required_sections: CORE_SECTION_CONTRACTS.map((item) => `${item.rel}:${item.section}`),
      core_tables: CORE_TABLE_CONTRACTS.map((item) => `${item.rel}:${item.section || "root"}`),
      markdown_scan_limit: MARKDOWN_SCAN_LIMIT,
    },
  };
  STRUCTURE_RESULT_DETAILS.set(result, {
    decisionHardIssues: collector.decisionIssues,
  });
  return result;
}

function inspectSectionContract(text, contract, collector) {
  const visible = visibleMarkdownLines(text);
  const headings = visible
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((item) => item.line === contract.section);
  if (headings.length === 0) {
    recordStructureIssue(collector, structureIssue("section_missing", contract, null, "required_section_missing"));
  } else if (headings.length > 1) {
    recordStructureIssue(collector, structureIssue("section_duplicate", contract, headings[1].index + 1, "section_must_be_unique"));
  }
  return { present: headings.length > 0 };
}

function inspectTableContract(text, contract, collector) {
  const visible = visibleMarkdownLines(text);
  let start = 0;
  let end = visible.length;

  if (contract.section) {
    const headings = visible
      .map((line, index) => ({ line: line.trim(), index }))
      .filter((item) => item.line === contract.section);
    if (headings.length === 0) {
      if (!contract.optional) {
        recordStructureIssue(collector, structureIssue("section_missing", contract, null, "required_section_missing"));
      }
      return { columns: [], table_count: 0, headers: [], rows: [] };
    }
    if (headings.length > 1) {
      recordStructureIssue(collector, structureIssue("section_duplicate", contract, headings[1].index + 1, "section_must_be_unique"));
      return { columns: [], table_count: 0, headers: [], rows: [] };
    }
    start = headings[0].index + 1;
    const nextHeadingOffset = visible.slice(start).findIndex((line) => /^##\s+/.test(line.trim()));
    end = nextHeadingOffset === -1 ? visible.length : start + nextHeadingOffset;
  }

  const candidates = findContractTableHeaders(visible, start, end, contract);
  if (candidates.length === 0) {
    recordStructureIssue(collector, structureIssue("table_missing", contract, null, "required_table_missing"));
    return { columns: [], table_count: 0, headers: [], rows: [] };
  }
  if (candidates.length > 1) {
    recordStructureIssue(collector, structureIssue(
      "table_ambiguous",
      contract,
      candidates[1].index + 1,
      `contract_table_count:${candidates.length}`,
    ));
  }

  const seenFirstColumn = new Map();
  let firstColumns = [];
  let firstRows = [];
  for (const candidate of candidates) {
    const result = inspectContractTableAt(visible, candidate.index, end, contract, collector, seenFirstColumn);
    if (firstColumns.length === 0) {
      firstColumns = result.columns;
      firstRows = result.rows;
    }
  }
  return {
    columns: firstColumns,
    headers: firstColumns,
    rows: firstRows,
    table_count: candidates.length,
  };
}

function inspectContractTableAt(lines, headerIndex, end, contract, collector, seenFirstColumn) {
  const headerCells = splitMarkdownTableRow(lines[headerIndex]).map(normalizeTableHeader);
  const separatorIndex = headerIndex + 1;
  const separatorCells = separatorIndex < end && isMarkdownTableRow(lines[separatorIndex])
    ? splitMarkdownTableRow(lines[separatorIndex]).map((cell) => cell.trim())
    : [];
  const separatorValid = separatorCells.length === headerCells.length
    && separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell));
  if (!separatorValid) {
    recordStructureIssue(collector, structureIssue(
      "separator_invalid",
      contract,
      separatorIndex + 1,
      "table_separator_must_follow_header",
      canonicalJson(separatorCells),
    ));
    return { columns: headerCells, rows: [] };
  }

  const missingColumns = contract.columns.filter((column) => !headerCells.includes(column));
  if (missingColumns.length > 0) {
    recordStructureIssue(collector, structureIssue("columns_missing", contract, headerIndex + 1, `missing:${missingColumns.join(",")}`));
  }
  const duplicateColumns = contract.columns.filter(
    (column) => headerCells.filter((cell) => cell === column).length > 1,
  );
  if (duplicateColumns.length > 0) {
    recordStructureIssue(collector, structureIssue("columns_duplicate", contract, headerIndex + 1, `duplicate:${duplicateColumns.join(",")}`));
  }

  let cursor = separatorIndex + 1;
  const rows = [];
  while (cursor < end && isMarkdownTableRow(lines[cursor])) {
    const rawCells = splitMarkdownTableRow(lines[cursor]);
    const cells = rawCells.map(normalizeTableCell);
    rows.push({ line: cursor + 1, cells, raw_cells: rawCells });
    if (cells.length !== headerCells.length) {
      recordStructureIssue(collector, structureIssue(
        "row_width_mismatch",
        contract,
        cursor + 1,
        `${cells.length}/${headerCells.length}`,
        `${cells.length}/${headerCells.length}#${canonicalJson(rawCells)}`,
      ));
    } else {
      if (contract.uniqueFirstColumn) {
        const uniqueColumn = contract.columns[0];
        const uniqueColumnIndex = headerCells.indexOf(uniqueColumn);
        const value = uniqueColumnIndex === -1 ? "" : cells[uniqueColumnIndex];
        if (value) {
          if (seenFirstColumn.has(value)) {
            recordStructureIssue(collector, structureIssue(
              "duplicate_id",
              contract,
              cursor + 1,
              `${value}:first_seen_line:${seenFirstColumn.get(value)}`,
            ));
          } else {
            seenFirstColumn.set(value, cursor + 1);
          }
        }
      }
      for (const [column, allowed] of Object.entries(contract.enums || {})) {
        const columnIndex = headerCells.indexOf(column);
        if (columnIndex !== -1 && !allowed.includes(cells[columnIndex])) {
          recordStructureIssue(collector, structureIssue(
            "value_invalid",
            contract,
            cursor + 1,
            `${column}:${cells[columnIndex] || "empty"}`,
          ));
        }
      }
    }
    cursor += 1;
  }
  const laterTableOffset = lines.slice(cursor, end).findIndex(isMarkdownTableRow);
  if (laterTableOffset !== -1) {
    const laterIndex = cursor + laterTableOffset;
    const laterStartsNewTable = laterIndex + 1 < end && isMarkdownSeparatorRow(lines[laterIndex + 1]);
    if (!laterStartsNewTable) {
      recordStructureIssue(collector, structureIssue(
        "table_discontinuous",
        contract,
        laterIndex + 1,
        "table_rows_must_be_contiguous",
        canonicalJson(splitMarkdownTableRow(lines[laterIndex])),
      ));
    }
  }
  return { columns: headerCells, rows };
}

function findContractTableHeaders(lines, start, end, contract) {
  const candidates = [];
  for (let index = start; index < end; index += 1) {
    if (!isMarkdownTableRow(lines[index])) continue;
    const cells = splitMarkdownTableRow(lines[index]).map(normalizeTableHeader);
    const nextIsSeparator = index + 1 < end && isMarkdownSeparatorRow(lines[index + 1]);
    if (!nextIsSeparator) continue;
    const score = contract.columns.filter((column) => cells.includes(column)).length;
    candidates.push({ index, cells, nextIsSeparator, score });
  }
  if (candidates.length === 0) return [];
  const primary = contract.columns[0];
  const primaryMatches = candidates.filter((item) => item.cells.includes(primary));
  if (primaryMatches.length > 0) return primaryMatches;
  const best = [...candidates].sort((left, right) => right.score - left.score || left.index - right.index)[0];
  return best && best.score > 0 ? [best] : [];
}

function structureIssue(kind, contract, line, detail, identityDetail = detail) {
  const sectionKey = contract.section ? contract.section.replace(/^##\s+/, "") : "root";
  const issue = {
    code: `structure_${kind}:${contract.rel}:${sectionKey}`,
    rel: contract.rel,
    section: contract.section,
    line,
    detail: limitText(detail, MAX_STRUCTURE_DETAIL_CHARS),
  };
  STRUCTURE_ISSUE_IDENTITY_DETAILS.set(issue, String(identityDetail ?? detail ?? issue.code));
  return issue;
}

function createStructureIssueCollector() {
  return {
    issues: [],
    count: 0,
    truncated: false,
    stableIssues: createStableIssueCollector(),
    decisionIssues: createStableIssueCollector(),
  };
}

function recordStructureIssue(collector, issue) {
  collector.count += 1;
  const identityDetail = STRUCTURE_ISSUE_IDENTITY_DETAILS.get(issue) || issue.detail || issue.code;
  STRUCTURE_ISSUE_IDENTITY_DETAILS.delete(issue);
  const normalized = stableIssue(
    issue.code,
    `${issue.rel || "project"}#${issue.section || "root"}#${identityDetail}`,
  );
  recordStableIssue(collector.stableIssues, normalized);
  if (!INDEX_FILES.includes(issue.rel)) recordStableIssue(collector.decisionIssues, normalized);
  if (collector.issues.length < MAX_STRUCTURE_ISSUES) {
    collector.issues.push(issue);
  } else {
    collector.truncated = true;
  }
}

function visibleMarkdownLines(text) {
  const state = { htmlComment: false, fence: null };
  return text.split(/\r?\n/).map((source) => {
    const line = stripHtmlComments(source, state);
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (state.fence) {
      if (fenceMatch && fenceMatch[1][0] === state.fence) state.fence = null;
      return "";
    }
    if (fenceMatch) {
      state.fence = fenceMatch[1][0];
      return "";
    }
    return line;
  });
}

function stripHtmlComments(source, state) {
  let line = source;
  let result = "";
  while (line.length > 0) {
    if (state.htmlComment) {
      const close = line.indexOf("-->");
      if (close === -1) return result;
      state.htmlComment = false;
      line = line.slice(close + 3);
      continue;
    }
    const open = line.indexOf("<!--");
    if (open === -1) return result + line;
    result += line.slice(0, open);
    state.htmlComment = true;
    line = line.slice(open + 4);
  }
  return result;
}

function isMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownSeparatorRow(line) {
  if (!isMarkdownTableRow(line)) return false;
  const cells = splitMarkdownTableRow(line).map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === "|") {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeTableCell(value) {
  return String(value || "").trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
}

function normalizeMarkdownCodeCellLiteral(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^(`+)([\s\S]*?)\1$/);
  if (!match) return trimmed;
  let literal = match[2];
  if (
    literal.startsWith(" ")
    && literal.endsWith(" ")
    && /[^ ]/.test(literal)
  ) {
    literal = literal.slice(1, -1);
  }
  return literal;
}

function normalizeTableHeader(value) {
  const normalized = normalizeTableCell(value);
  const lookup = normalized.replace(/[A-Z]/g, (character) => character.toLowerCase());
  return TABLE_HEADER_ALIASES.get(lookup) || lookup;
}

function canonicalIdPrefix(rel) {
  if (rel === "历史记录/00-历史总目录.md") return "M-";
  if (rel === "证据库/总索引/证据总目录.md") return "EV-";
  if (rel === "项目物料/INDEX.md") return "MAT-";
  return null;
}

function isCanonicalProjectId(value, prefix = null) {
  const regex = new RegExp(`^${PROJECT_ID_BODY_SOURCE}$`);
  return regex.test(value) && (!prefix || value.startsWith(prefix));
}

function splitCanonicalIndexPaths(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return { tokens: [], degraded: false, reason: null };
  const canonicalParts = raw.split(/<br\s*\/?>/i);
  const hasCanonicalSeparator = canonicalParts.length > 1;
  const looksLikeLegacyMulti = !hasCanonicalSeparator
    && /(?:\s+\/\s+|\s*[,;，；]\s*)/.test(raw)
    && (raw.match(/\.md\b/gi) || []).length > 1;
  if (looksLikeLegacyMulti) {
    return { tokens: [], degraded: true, reason: "legacy_multi_path_separator" };
  }
  return {
    tokens: canonicalParts.map((item) => normalizeMarkdownCodeCellLiteral(item).trim()).filter(Boolean),
    degraded: false,
    reason: null,
  };
}

function looksLikeMultipleLocators(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (raw.split(/<br\s*\/?>/i).filter((item) => item.trim()).length > 1) return true;
  if ((raw.match(/https?:\/\//gi) || []).length > 1) return true;
  if ((raw.match(/[A-Za-z]:[\\/]/g) || []).length > 1) return true;
  return /(?:\s+\/\s+|\s*[,;，；]\s*)/.test(raw)
    && ((raw.match(/(?:\.md|\.zip|\.json|\.js|\.mjs|\/)/gi) || []).length > 1);
}

function safeMaterialReportPath(raw, kind) {
  if (["absolute_reference", "external_uri", "historical_identity"].includes(kind)) return null;
  return limitText(String(raw || ""), MAX_STRUCTURE_DETAIL_CHARS);
}

function historicalIdentityIsAmbiguous(context, raw) {
  const tokens = String(raw || "")
    .split(/<br\s*\/?>/i)
    .map((item) => normalizeMarkdownCodeCellLiteral(item).trim())
    .filter(Boolean);
  if (tokens.length <= 1) return false;
  let currentLocalTargets = 0;
  for (const token of tokens) {
    const pathCheck = validateRelativePath(context.root, token);
    if (!pathCheck.ok) continue;
    const kind = context.kind(pathCheck.rel);
    if (kind === "file" || kind === "directory") currentLocalTargets += 1;
  }
  return currentLocalTargets > 1;
}

function classifyMaterialLocator(context, rawValue, explicitKind = "") {
  const rawSource = String(rawValue || "").trim();
  const raw = /<br\s*\/?>/i.test(rawSource)
    ? rawSource
    : normalizeMarkdownCodeCellLiteral(rawSource).trim();
  const declared = String(explicitKind || "").trim().toLowerCase();
  if (declared && !MATERIAL_LOCATOR_KINDS.has(declared)) {
    return {
      ok: false,
      kind: "invalid",
      classification: "invalid",
      reason: "material_locator_kind_invalid",
      report_path: null,
      path_redacted: true,
    };
  }
  if (!raw) {
    return {
      ok: false,
      kind: declared || "unknown",
      classification: "invalid",
      reason: "material_locator_missing",
      report_path: null,
      path_redacted: true,
    };
  }
  const inferred = declared || (
    /^https?:\/\//i.test(raw)
      ? "external_uri"
      : (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))
        ? "absolute_reference"
        : ""
  );
  if (looksLikeMultipleLocators(raw) && inferred !== "historical_identity") {
    return {
      ok: false,
      kind: inferred || "ambiguous_multiple",
      classification: "ambiguous_multiple",
      reason: "material_locator_ambiguous_multiple",
      report_path: null,
      path_redacted: true,
    };
  }
  if (inferred === "historical_identity") {
    if (historicalIdentityIsAmbiguous(context, raw)) {
      return {
        ok: false,
        kind: inferred,
        classification: "ambiguous_multiple",
        reason: "material_locator_ambiguous_multiple",
        report_path: null,
        path_redacted: true,
      };
    }
    return {
      ok: true,
      kind: inferred,
      classification: "historical_identity",
      reason: "intentional_unverifiable",
      report_path: null,
      path_redacted: true,
    };
  }
  if (inferred === "external_uri" || inferred === "absolute_reference") {
    return {
      ok: true,
      kind: inferred,
      classification: inferred,
      reason: inferred === "external_uri" ? "external_or_non_file_path" : "absolute_path_not_verified",
      report_path: null,
      path_redacted: true,
    };
  }

  const pathCheck = validateRelativePath(context.root, raw);
  if (!pathCheck.ok) {
    const redirected = String(pathCheck.error || "").includes("symlink_or_junction");
    return {
      ok: false,
      kind: inferred || "unknown",
      classification: redirected ? "project_relative_redirect" : "unsafe_relative",
      reason: redirected ? "material_locator_redirect_not_allowed" : "unsafe_relative_path",
      report_path: null,
      path_redacted: true,
    };
  }
  const rel = pathCheck.rel;
  const actualKind = context.kind(rel);
  if (actualKind === "symlink") {
    return {
      ok: false,
      kind: inferred || "unknown",
      classification: "project_relative_redirect",
      reason: "material_locator_redirect_not_allowed",
      report_path: rel,
      path_redacted: false,
    };
  }
  if (!inferred && actualKind === "absent") {
    return {
      ok: false,
      kind: "unknown",
      classification: "project_relative_missing_unknown",
      reason: "material_locator_missing_kind_ambiguous",
      report_path: rel,
      path_redacted: false,
    };
  }
  const intendedKind = inferred || actualKind;
  if (intendedKind === "file") {
    if (actualKind === "absent") {
      return {
        ok: true,
        kind: "file",
        classification: "project_relative_missing_file",
        reason: "file_missing",
        rel,
        report_path: rel,
        path_redacted: false,
      };
    }
    if (actualKind !== "file") {
      return {
        ok: false,
        kind: "file",
        classification: "project_relative_wrong_kind",
        reason: "not_regular_file",
        rel,
        report_path: rel,
        path_redacted: false,
      };
    }
    return {
      ok: true,
      kind: "file",
      classification: "project_relative_file",
      reason: null,
      rel,
      report_path: rel,
      path_redacted: false,
    };
  }
  if (intendedKind === "directory") {
    if (actualKind === "absent") {
      return {
        ok: true,
        kind: "directory",
        classification: "project_relative_missing_directory",
        reason: "directory_missing",
        rel,
        report_path: rel,
        path_redacted: false,
      };
    }
    if (actualKind !== "directory") {
      return {
        ok: false,
        kind: "directory",
        classification: "project_relative_wrong_kind",
        reason: "not_directory",
        rel,
        report_path: rel,
        path_redacted: false,
      };
    }
    return {
      ok: true,
      kind: "directory",
      classification: "project_relative_directory",
      reason: "directory_not_hashable",
      rel,
      report_path: rel,
      path_redacted: false,
    };
  }
  return {
    ok: false,
    kind: intendedKind || "unknown",
    classification: "unknown",
    reason: "material_locator_unclassified",
    report_path: safeMaterialReportPath(raw, intendedKind),
    path_redacted: true,
  };
}

function buildTypedIndexModel(context) {
  if (context.indexModel) return context.indexModel;
  const hardIssueCollector = createStableIssueCollector();
  const coverageIssueCollector = createStableIssueCollector();
  const addHardIssue = (issue) => recordStableIssue(hardIssueCollector, issue);
  const addCoverageIssue = (issue) => recordStableIssue(coverageIssueCollector, issue);
  const canonicalDefinitions = new Map();
  const canonicalDefinitionOccurrences = new Map();
  const managedMarkdownPaths = new Set();
  const indexes = {};
  let complete = true;

  for (const rel of INDEX_FILES) {
    const contract = CORE_TABLE_CONTRACTS.find((item) => item.rel === rel);
    const collector = createStructureIssueCollector();
    const key = rel.startsWith("历史记录/") ? "history" : rel.startsWith("证据库/") ? "evidence" : "materials";
    const index = {
      rel,
      rows: [],
      headers: [],
      contract_result: null,
      contract_issues: [],
      contract_issue_count: 0,
      contract_issues_truncated: false,
      table_complete: true,
      complete: true,
    };
    indexes[key] = index;
    if (context.kind(rel) !== "file") {
      complete = false;
      index.table_complete = false;
      index.complete = false;
      addHardIssue(stableIssue("index_not_regular_file", rel));
      addCoverageIssue(stableIssue("index_parse_incomplete", rel));
      continue;
    }
    let text;
    try {
      text = context.getBoundedText(rel, MAX_MARKDOWN_SCAN_FILE_BYTES).text;
    } catch (error) {
      complete = false;
      index.table_complete = false;
      index.complete = false;
      addHardIssue(stableIssue("index_not_checked", `${rel}#${error.code || "read_failed"}`));
      addCoverageIssue(stableIssue("index_parse_incomplete", rel));
      continue;
    }
    const parsed = inspectTableContract(text, contract, collector);
    index.contract_result = parsed;
    index.contract_issues = collector.issues;
    index.contract_issue_count = collector.count;
    index.contract_issues_truncated = collector.truncated;
    index.headers = parsed.headers || [];
    if (collector.count > 0 || parsed.table_count !== 1) {
      complete = false;
      index.table_complete = false;
      index.complete = false;
      mergeStableIssueCollector(hardIssueCollector, collector.stableIssues);
      addCoverageIssue(stableIssue("index_parse_incomplete", rel));
    }
    const headerIndex = new Map(index.headers.map((header, position) => [header, position]));
    const idColumn = contract.columns[0];
    const prefix = canonicalIdPrefix(rel);
    const pathColumnIndex = headerIndex.get("路径");
    const locatorKindIndex = headerIndex.get("locator-kind");

    for (const row of parsed.rows || []) {
      const cells = {};
      for (const [header, position] of headerIndex.entries()) {
        cells[header] = row.raw_cells[position] ?? "";
      }
      const definitionId = normalizeTableCell(row.cells[headerIndex.get(idColumn)] || "");
      const normalized = {
        line: row.line,
        cells,
        definition_id: definitionId || null,
        path_tokens: [],
        path_degraded: false,
        locator: null,
      };
      index.rows.push(normalized);
      if (!definitionId) {
        addHardIssue(stableIssue("index_id_required", `${rel}#line:${row.line}`));
      } else if (!isCanonicalProjectId(definitionId, prefix)) {
        addHardIssue(stableIssue("index_id_invalid", `${rel}#${definitionId}`));
      } else {
        const occurrence = { rel, line: row.line, kind: key, source: "formal_id_column" };
        mapPush(canonicalDefinitionOccurrences, definitionId, occurrence);
        if (canonicalDefinitions.has(definitionId)) {
          addHardIssue(stableIssue("index_id_duplicate", definitionId));
        } else {
          canonicalDefinitions.set(definitionId, occurrence);
        }
      }

      const rawPath = pathColumnIndex === undefined ? "" : row.raw_cells[pathColumnIndex] || "";
      if (key === "history" || key === "evidence") {
        const split = splitCanonicalIndexPaths(rawPath);
        if (split.degraded) {
          complete = false;
          index.complete = false;
          normalized.path_degraded = true;
          addHardIssue(stableIssue("index_entry_path_invalid", `${definitionId || rel}#${split.reason}`));
          addCoverageIssue(stableIssue("index_entry_path_degraded", definitionId || `${rel}#line:${row.line}`));
        }
        for (const token of split.tokens) {
          const pathCheck = validateRelativePath(context.root, token);
          if (!pathCheck.ok || !pathCheck.rel.toLowerCase().endsWith(".md")) {
            complete = false;
            index.complete = false;
            normalized.path_degraded = true;
            const tokenKey = sha256(Buffer.from(token, "utf8")).slice(0, 16);
            addHardIssue(stableIssue("index_entry_path_invalid", `${definitionId || rel}#${tokenKey}`));
            addCoverageIssue(stableIssue("index_entry_path_degraded", definitionId || `${rel}#line:${row.line}`));
            continue;
          }
          normalized.path_tokens.push(pathCheck.rel);
          managedMarkdownPaths.add(pathCheck.rel);
        }
      } else {
        const explicitKind = locatorKindIndex === undefined ? "" : normalizeTableCell(row.cells[locatorKindIndex] || "");
        normalized.locator = classifyMaterialLocator(context, rawPath, explicitKind);
        if (!normalized.locator.ok) {
          addHardIssue(stableIssue(normalized.locator.reason, definitionId || `${rel}#line:${row.line}`));
        }
        const scanLocator = normalized.locator.ok
          ? normalized.locator
          : classifyMaterialLocator(context, rawPath, "");
        const scanRel = scanLocator.rel || normalized.locator.rel || null;
        if (scanRel?.toLowerCase().endsWith(".md")) {
          managedMarkdownPaths.add(scanRel);
        } else if (!scanLocator.ok && /\.md(?:\b|[`"')\]\s,;，；<])/i.test(String(rawPath || ""))) {
          complete = false;
          index.complete = false;
        }
      }
    }
  }

  const hardIssueDetails = stableIssueCollectorDetails(hardIssueCollector, "project-gov/hard-issues/v1");
  const coverageIssueDetails = stableIssueCollectorDetails(coverageIssueCollector, "project-gov/coverage-issues/v1");
  const model = {
    history: indexes.history,
    evidence: indexes.evidence,
    materials: indexes.materials,
    canonicalDefinitions,
    canonicalDefinitionOccurrences,
    definitionFiles: new Map(),
    definitionOccurrences: new Map(),
    referenceOccurrences: [],
    managedMarkdownPaths: [...managedMarkdownPaths].sort((left, right) => left.localeCompare(right, "zh-CN")),
    hardIssues: hardIssueDetails.sample,
    hardIssueCount: hardIssueDetails.count,
    hardIssuesTruncated: hardIssueDetails.truncated,
    hardIssueCollector,
    coverageIssues: coverageIssueDetails.sample,
    coverageIssueCount: coverageIssueDetails.count,
    coverageIssuesTruncated: coverageIssueDetails.truncated,
    coverageIssueCollector,
    completenessState: {
      hard_issues_complete: complete
        && hardIssueCollector.identities_complete
        && context.completenessState.hard_issues_complete,
      coverage_issues_complete: complete
        && coverageIssueCollector.identities_complete
        && context.completenessState.coverage_issues_complete,
    },
    referenceStatuses: new Map(),
    managedScanEnriched: false,
  };
  for (const [id, occurrences] of canonicalDefinitionOccurrences.entries()) {
    for (const occurrence of occurrences) {
      mapPush(model.definitionFiles, id, occurrence.rel);
      mapPush(model.definitionOccurrences, id, occurrence);
    }
  }
  context.indexModel = model;
  return model;
}

function enrichTypedIndexModelWithManagedScan(context, indexModel, markdownScan) {
  if (indexModel.managedScanEnriched) return indexModel;
  let actualScannedBytes = 0;

  for (const abs of markdownScan.files) {
    const rel = toRel(context.root, abs);
    let read;
    try {
      read = context.getBoundedText(
        rel,
        MAX_MARKDOWN_SCAN_FILE_BYTES,
        MAX_MARKDOWN_SCAN_TOTAL_BYTES - actualScannedBytes,
      );
    } catch (error) {
      markdownScan.truncated = true;
      if (error.code === "total_bytes_exceeded") {
        markdownScan.total_bytes_exceeded = true;
        recordStableIssue(
          markdownScan.coverageIssueCollector,
          stableIssue("managed_scan_budget_exhausted", "managed-files#total-bytes"),
        );
        break;
      }
      if (error.code === "file_too_large") {
        markdownScan.oversized_file_count += 1;
        if (markdownScan.oversized_files.length < MAX_MARKDOWN_SCAN_ISSUE_SAMPLES) {
          markdownScan.oversized_files.push({
            rel: boundedIdentityText(rel),
            bytes: context.size(rel) ?? null,
          });
        }
        continue;
      }
      recordMarkdownScanReadError(markdownScan, { rel, code: error.code || "read_error" });
      continue;
    }
    actualScannedBytes += read.bytes;
    markdownScan.actual_files_scanned += 1;
    for (const id of extractProjectIds(read.text, { markdown: true })) {
      indexModel.referenceOccurrences.push({ id, rel });
    }
    const fileId = extractProjectIds(path.basename(rel))[0];
    if (fileId && !indexModel.canonicalDefinitions.has(fileId)) {
      const occurrence = {
        rel,
        line: null,
        kind: "canonical_filename",
        source: "canonical_filename",
      };
      mapPush(indexModel.definitionFiles, fileId, rel);
      mapPush(indexModel.definitionOccurrences, fileId, occurrence);
    }
  }
  markdownScan.scanned_bytes = actualScannedBytes;
  refreshMarkdownScanSummary(markdownScan);

  const degradedDefinitions = new Set([
    ...(indexModel.history?.rows || []).filter((row) => row.path_degraded).map((row) => row.definition_id),
    ...(indexModel.evidence?.rows || []).filter((row) => row.path_degraded).map((row) => row.definition_id),
  ].filter(Boolean));
  for (const id of new Set(indexModel.referenceOccurrences.map((item) => item.id))) {
    const occurrences = indexModel.definitionOccurrences.get(id) || [];
    const primary = occurrences[0] || null;
    if (occurrences.length === 0) {
      indexModel.referenceStatuses.set(id, {
        id,
        status: "unresolved",
        reason: "no_definition_or_index_entry",
        definition_source: null,
      });
    } else if (degradedDefinitions.has(id)) {
      indexModel.referenceStatuses.set(id, {
        id,
        status: "resolved_with_invalid_entry_path",
        reason: "index_entry_path_degraded",
        definition_source: primary?.source || null,
      });
    } else {
      indexModel.referenceStatuses.set(id, {
        id,
        status: "resolved",
        reason: null,
        definition_source: primary?.source || null,
      });
    }
  }
  indexModel.managedScanEnriched = true;
  return indexModel;
}

function buildRelationshipSummary(indexModel, complete) {
  const definitionTuples = [];
  for (const [id, occurrences] of indexModel?.definitionOccurrences?.entries?.() || []) {
    for (const occurrence of occurrences) {
      definitionTuples.push([
        id,
        occurrence.rel || null,
        occurrence.kind || null,
        occurrence.source || null,
      ]);
    }
  }
  const referenceTuples = (indexModel?.referenceOccurrences || [])
    .map((item) => [item.id, item.rel]);
  const resolutionTuples = [...(indexModel?.referenceStatuses?.values?.() || [])]
    .map((item) => [
      item.id,
      item.status,
      item.reason || null,
      item.definition_source || null,
    ]);
  const definitions = stableTupleSummary("project-gov/definition-occurrences/v1", definitionTuples);
  const references = stableTupleSummary("project-gov/reference-occurrences/v1", referenceTuples);
  const resolutions = stableTupleSummary("project-gov/reference-resolution-statuses/v1", resolutionTuples);
  return {
    complete,
    definition_occurrence_count: definitions.count,
    definition_distinct_count: definitions.distinct_count,
    definition_digest: definitions.digest,
    reference_occurrence_count: references.count,
    reference_distinct_count: references.distinct_count,
    reference_digest: references.digest,
    resolution_status_count: resolutions.count,
    resolution_status_distinct_count: resolutions.distinct_count,
    resolution_status_digest: resolutions.digest,
  };
}

function inspectLegacyRootLayout(root) {
  const rootNumberedMarkdown = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{2,3}-.*\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return {
    root_numbered_markdown_count: rootNumberedMarkdown.length,
    root_numbered_markdown_sample: rootNumberedMarkdown.slice(0, MAX_PHYSICAL_LAYOUT_SAMPLES),
    interpretation: "shallow_inventory_only_semantic_judgment_required",
  };
}

function inspectProject(root, options = {}) {
  const context = options.context || createInspectionContext(root, {
    phase: options.phase || "inspect",
    overlay: options.overlay,
    io: options.io,
    limits: options.limits,
  });
  const coreFiles = [...FIVE_PIECE, ...INDEX_FILES];
  if (!options.overlay) assertManagedCorePathsNotRedirected(root);
  const indexModel = buildTypedIndexModel(context);
  const fileRecords = coreFiles.map((rel) => inspectFile(root, rel, context));
  const fiveRecords = fileRecords.slice(0, FIVE_PIECE.length);
  const indexRecords = fileRecords.slice(FIVE_PIECE.length);

  const fiveTotal = fiveRecords.reduce((sum, item) => sum + (item.exists ? item.bytes : 0), 0);
  const markdownScan = listManagedMarkdownFiles(root, context, indexModel);
  const idData = collectIds(root, markdownScan, fileRecords, context, indexModel);
  const scanErrors = markdownScanErrors(markdownScan);
  const coverageIssues = [
    ...markdownScanCoverageIssues(markdownScan),
    ...indexModel.coverageIssues.map((item) => item.code),
  ];
  const references = checkReferences(root, idData, indexModel);
  const placeholderScan = scanPlaceholders(
    root,
    markdownScan.files.map((abs) => ({ rel: toRel(root, abs), exists: true })),
    context,
  );
  const semanticDeclaration = inspectHandoffSemanticDeclaration(root, null, context);
  const governanceSections = checkGovernanceSections(root, context);
  const structure = inspectCoreStructure(root, context, indexModel);

  const missingFive = fiveRecords.filter((item) => !item.exists).map((item) => item.rel);
  const missingIndexes = indexRecords.filter((item) => !item.exists).map((item) => item.rel);
  const errors = [];
  if (missingFive.length > 0) errors.push("missing_five_piece_file");
  if (missingIndexes.length > 0) errors.push("missing_index_file");
  if (fiveTotal > FIVE_PIECE_LIMIT_BYTES) errors.push("five_piece_over_45kb");
  if (references.unresolved_count > 0) errors.push("unresolved_references");
  if (idData.summary.definition_collision_count > 0) errors.push("definition_id_collision");
  if (placeholderScan.count > 0) errors.push("template_placeholder_found");
  errors.push(...semanticDeclaration.errors);
  errors.push(...structure.issues.map((item) => item.code));
  errors.push(...indexModel.hardIssues.map((item) => item.code));
  errors.push(...scanErrors);
  const remainingBytes = FIVE_PIECE_LIMIT_BYTES - fiveTotal;
  const warnings = [
    ...governanceSections.warnings,
    ...coverageIssues.map((code) => `coverage_incomplete:${code}`),
  ];
  if (remainingBytes >= 0 && remainingBytes < FIVE_PIECE_LOW_SPACE_BYTES) {
    warnings.push("five_piece_remaining_below_2kib");
  }
  const inspectionEpochSeal = context.seal();
  if (!inspectionEpochSeal.ok) errors.push("inspection_epoch_drift");

  const report = {
    ok: false,
    mechanical_ok: false,
    coverage_complete: false,
    indeterminate: true,
    coverage_issues: [...new Set(coverageIssues)],
    validation_kind: "mechanical",
    semantic_checked_by_tool: false,
    project_knowledge_checked_by_tool: false,
    tool: SCRIPT_NAME,
    command: "inspect",
    skill_version: SKILL_VERSION,
    project_structure_version: PROJECT_STRUCTURE_VERSION,
    decision_policy_version: DECISION_POLICY_VERSION,
    root,
    generated_at: new Date().toISOString(),
    threshold: {
      five_piece_limit_bytes: FIVE_PIECE_LIMIT_BYTES,
      label: "45 KiB (46,080 bytes)",
      low_space_warning_bytes: FIVE_PIECE_LOW_SPACE_BYTES,
    },
    files: {
      five_piece: {
        all_present: missingFive.length === 0,
        missing: missingFive,
        records: fiveRecords,
      },
      indexes: {
        all_present: missingIndexes.length === 0,
        missing: missingIndexes,
        records: indexRecords,
      },
    },
    five_piece: {
      total_bytes: fiveTotal,
      over_limit: fiveTotal > FIVE_PIECE_LIMIT_BYTES,
      remaining_bytes: remainingBytes,
    },
    markdown_scan: markdownScan.summary,
    ids: idData.summary,
    references,
    placeholders: placeholderScan.items,
    placeholder_count: placeholderScan.count,
    placeholders_truncated: placeholderScan.truncated,
    semantic_declaration: semanticDeclaration,
    governance_sections: governanceSections.present,
    structure,
    inspection_epoch: {
      id: context.epoch_id,
      phase: context.phase,
      seal: inspectionEpochSeal,
    },
    typed_indexes: {
      history_rows: indexModel.history?.rows.length || 0,
      evidence_rows: indexModel.evidence?.rows.length || 0,
      material_rows: indexModel.materials?.rows.length || 0,
      canonical_definition_count: indexModel.canonicalDefinitions.size,
      managed_markdown_path_count: indexModel.managedMarkdownPaths.length,
      hard_issues: indexModel.hardIssues,
      hard_issue_count: indexModel.hardIssueCount,
      hard_issues_truncated: indexModel.hardIssuesTruncated,
      coverage_issues: indexModel.coverageIssues,
      coverage_issue_count: indexModel.coverageIssueCount,
      coverage_issues_truncated: indexModel.coverageIssuesTruncated,
      complete: indexModel.completenessState.hard_issues_complete
        && indexModel.completenessState.coverage_issues_complete,
    },
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
  report.decision_snapshot = buildDecisionSnapshot(report, context, indexModel, markdownScan, placeholderScan, idData);
  report.mechanical_ok = report.decision_snapshot.hard_issue_count === 0
    && report.decision_snapshot.hard_issues_complete;
  report.coverage_complete = report.decision_snapshot.coverage_issue_count === 0
    && report.decision_snapshot.coverage_issues_complete;
  report.indeterminate = !report.decision_snapshot.hard_issues_complete
    || !report.decision_snapshot.coverage_issues_complete;
  report.ok = isCompletelyCompliant(report.decision_snapshot);
  return report;
}

function buildDecisionSnapshot(
  report,
  context = null,
  indexModel = null,
  markdownScan = null,
  placeholderScan = null,
  idData = null,
) {
  const hardIssueCollector = createStableIssueCollector();
  const coverageIssueCollector = createStableIssueCollector();
  const addHardIssue = (issue) => recordStableIssue(hardIssueCollector, issue);
  const addCoverageIssue = (issue) => recordStableIssue(coverageIssueCollector, issue);
  for (const rel of report.files?.five_piece?.missing || []) addHardIssue(stableIssue("missing_five_piece_file", rel));
  for (const rel of report.files?.indexes?.missing || []) addHardIssue(stableIssue("missing_index_file", rel));
  for (const item of [
    ...(report.files?.five_piece?.records || []),
    ...(report.files?.indexes?.records || []),
  ]) {
    if (item.code === "core_path_not_regular_file") {
      addHardIssue(stableIssue(item.code, `${item.rel}#${item.kind}`));
    }
  }
  for (const item of indexModel?.referenceStatuses?.values?.() || []) {
    if (item.status === "unresolved") addHardIssue(stableIssue("unresolved_reference", item.id));
  }
  if (idData?.definitionCollisionCollector) {
    mergeStableIssueCollector(hardIssueCollector, idData.definitionCollisionCollector);
  } else {
    for (const item of report.ids?.definition_collisions || []) addHardIssue(stableIssue("definition_id_collision", item.id));
  }
  if (placeholderScan?.issueCollector) {
    mergeStableIssueCollector(hardIssueCollector, placeholderScan.issueCollector);
  } else {
    for (const item of report.placeholders || []) addHardIssue(stableIssue("template_placeholder_found", `${item.rel}#placeholder`));
  }
  for (const code of report.semantic_declaration?.errors || []) addHardIssue(stableIssue(code, "HANDOFF.md#semantic-checkpoint"));
  const structureDetails = STRUCTURE_RESULT_DETAILS.get(report.structure);
  if (structureDetails?.decisionHardIssues) {
    mergeStableIssueCollector(hardIssueCollector, structureDetails.decisionHardIssues);
  } else {
    for (const item of report.structure?.issues || []) {
      if (!INDEX_FILES.includes(item.rel)) {
        addHardIssue(stableIssue(item.code, `${item.rel || "project"}#${item.section || "root"}#${item.detail || item.code}`));
      }
    }
  }
  if (indexModel?.hardIssueCollector) mergeStableIssueCollector(hardIssueCollector, indexModel.hardIssueCollector);
  else for (const item of indexModel?.hardIssues || []) addHardIssue(item);
  for (const item of context?.readIssues || []) addHardIssue(item);

  const scan = markdownScan || report.markdown_scan || {};
  if (scan.coverageIssueCollector) mergeStableIssueCollector(coverageIssueCollector, scan.coverageIssueCollector);
  else {
    for (const item of scan.oversized_files || []) addCoverageIssue(stableIssue("managed_file_not_checked", `${item.rel}#file_too_large`));
    for (const rel of scan.missing_indexed_files || []) addCoverageIssue(stableIssue("managed_file_not_checked", `${rel}#missing`));
    for (const item of scan.read_errors || []) addCoverageIssue(stableIssue("managed_file_not_checked", `${item.rel}#${item.code || "read_failed"}`));
    if (scan.file_count_limit_exceeded) addCoverageIssue(stableIssue("managed_scan_budget_exhausted", "managed-files#file-count"));
    if (scan.total_bytes_exceeded) addCoverageIssue(stableIssue("managed_scan_budget_exhausted", "managed-files#total-bytes"));
  }
  if (indexModel?.coverageIssueCollector) mergeStableIssueCollector(coverageIssueCollector, indexModel.coverageIssueCollector);
  else for (const item of indexModel?.coverageIssues || []) addCoverageIssue(item);

  const scanComplete = context?.completenessState?.hard_issues_complete !== false
    && context?.completenessState?.coverage_issues_complete !== false
    && scan.truncated !== true
    && (scan.read_error_count || 0) === 0
    && scan.file_count_limit_exceeded !== true
    && scan.total_bytes_exceeded !== true
    && report.inspection_epoch?.seal?.ok !== false;
  const hardIssuesComplete = scanComplete
    && indexModel?.completenessState?.hard_issues_complete !== false
    && hardIssueCollector.identities_complete;
  const coverageIssuesComplete = scanComplete
    && indexModel?.completenessState?.coverage_issues_complete !== false
    && coverageIssueCollector.identities_complete;
  const hardIssueDetails = stableIssueCollectorDetails(hardIssueCollector, "project-gov/hard-issues/v1");
  const coverageIssueDetails = stableIssueCollectorDetails(coverageIssueCollector, "project-gov/coverage-issues/v1");
  const relationshipsComplete = scanComplete
    && indexModel?.completenessState?.hard_issues_complete !== false
    && indexModel?.completenessState?.coverage_issues_complete !== false;
  const coreIndexFingerprints = {};
  for (const record of report.files?.indexes?.records || []) {
    coreIndexFingerprints[record.rel] = record.exists
      ? {
          exists: true,
          kind: record.kind || "file",
          bytes: record.kind === "file" ? record.bytes : null,
          sha256: record.kind === "file" ? record.sha256 : null,
        }
      : { exists: false, kind: "absent", bytes: null, sha256: null };
  }
  const snapshot = {
    schema_version: DECISION_SNAPSHOT_SCHEMA_VERSION,
    decision_policy_version: DECISION_POLICY_VERSION,
    digest_algorithm: DIGEST_ALGORITHM,
    scan_complete: scanComplete,
    semantic_checked_by_tool: false,
    hard_issues_complete: hardIssuesComplete,
    coverage_issues_complete: coverageIssuesComplete,
    hard_issue_count: hardIssueDetails.count,
    hard_issue_sample_count: hardIssueDetails.sample_count,
    hard_issues_truncated: hardIssueDetails.truncated,
    hard_issue_multiset_digest: hardIssueDetails.digest,
    hard_issues: hardIssueDetails.sample,
    coverage_issue_count: coverageIssueDetails.count,
    coverage_issue_sample_count: coverageIssueDetails.sample_count,
    coverage_issues_truncated: coverageIssueDetails.truncated,
    coverage_issue_multiset_digest: coverageIssueDetails.digest,
    coverage_issues: coverageIssueDetails.sample,
    relationships: buildRelationshipSummary(indexModel, relationshipsComplete),
    core_index_fingerprints: coreIndexFingerprints,
    five_piece: {
      limit_bytes: FIVE_PIECE_LIMIT_BYTES,
      total_bytes: report.five_piece.total_bytes,
      over_limit: report.five_piece.over_limit,
    },
  };
  DECISION_SNAPSHOT_DETAILS.set(snapshot, {
    hard: hardIssueDetails,
    coverage: coverageIssueDetails,
  });
  return snapshot;
}

function inspectFile(root, rel, context = createInspectionContext(root)) {
  const fingerprint = context.fingerprint(rel);
  if (!fingerprint.exists) {
    return { rel, exists: false, bytes: 0, sha256: null };
  }
  if (fingerprint.kind !== "file") {
    return {
      code: "core_path_not_regular_file",
      rel,
      exists: true,
      kind: fingerprint.kind,
      bytes: 0,
      sha256: null,
      recovery_hint: "replace_with_regular_file_then_rerun_inspect",
    };
  }
  return {
    rel,
    exists: true,
    kind: fingerprint.kind,
    bytes: fingerprint.bytes ?? 0,
    sha256: fingerprint.sha256,
  };
}

function inspectHandoffSemanticDeclaration(root, textOverride = null, context = null) {
  const rel = "HANDOFF.md";
  let text = textOverride;
  if (text === null) {
    if (context) {
      try {
        text = context.kind(rel) === "file"
          ? context.getBoundedText(rel, MAX_MARKDOWN_SCAN_FILE_BYTES).text
          : "";
      } catch {
        text = "";
      }
    } else text = "";
  }
  const lines = text.split(/\r?\n/).map((line, index) => ({
    index,
    text: index === 0 ? line.replace(/^\uFEFF/, "").trimEnd() : line.trimEnd(),
  }));
  const nonBlank = lines.filter((item) => item.text.trim().length > 0);
  const sectionHeadings = lines.filter((item) => item.text === "## 语义检查点");
  const checkpointOccurrences = lines.filter((item) =>
    /^ {0,3}-\s+最后语义检查点：/.test(item.text),
  );
  const changeOccurrences = lines.filter((item) =>
    /^ {0,3}-\s+检查点后变化：/.test(item.text),
  );
  const errors = [];

  if (sectionHeadings.length === 0) errors.push("handoff_semantic_section_missing");
  if (sectionHeadings.length > 1) errors.push("handoff_semantic_section_duplicate");

  let lastSemanticCheckpoint = null;
  let changesAfterCheckpoint = null;

  const canonicalHeading =
    nonBlank[0]?.text === "# HANDOFF.md" && nonBlank[1]?.text === "## 语义检查点";
  if (sectionHeadings.length === 1 && !canonicalHeading) {
    errors.push("handoff_semantic_section_not_at_top");
  }

  const canonicalCheckpointMatch = nonBlank[2]?.text.match(/^-\s+最后语义检查点：\s*(.*?)\s*$/);
  const canonicalChangeMatch = nonBlank[3]?.text.match(/^-\s+检查点后变化：\s*(.*?)\s*$/);

  if (checkpointOccurrences.length === 0) {
    errors.push("handoff_last_semantic_checkpoint_missing");
  } else if (checkpointOccurrences.length > 1) {
    errors.push("handoff_last_semantic_checkpoint_duplicate");
  } else if (checkpointOccurrences[0].index !== nonBlank[2]?.index) {
    errors.push("handoff_semantic_declaration_outside_section");
  } else if (!canonicalCheckpointMatch) {
    errors.push("handoff_semantic_declaration_not_canonical");
  } else {
    const value = canonicalCheckpointMatch[1]?.trim() || "";
    if (isValidSemanticCheckpoint(value)) {
      lastSemanticCheckpoint = value;
    } else {
      errors.push("handoff_last_semantic_checkpoint_invalid");
    }
  }

  if (changeOccurrences.length === 0) {
    errors.push("handoff_change_status_missing_or_invalid");
  } else if (changeOccurrences.length > 1) {
    errors.push("handoff_change_status_duplicate");
  } else if (changeOccurrences[0].index !== nonBlank[3]?.index) {
    errors.push("handoff_semantic_declaration_outside_section");
  } else if (!canonicalChangeMatch) {
    errors.push("handoff_semantic_declaration_not_canonical");
  } else {
    const value = canonicalChangeMatch[1]?.trim() || "";
    if (["已核对", "待确认"].includes(value)) {
      changesAfterCheckpoint = value;
    } else {
      errors.push("handoff_change_status_missing_or_invalid");
    }
  }

  return {
    rel,
    declarations_present: errors.length === 0,
    section_count: sectionHeadings.length,
    last_semantic_checkpoint: lastSemanticCheckpoint,
    changes_after_checkpoint: changesAfterCheckpoint,
    errors,
  };
}

function isValidSemanticCheckpoint(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (Z|UTC|[+-]\d{2}:\d{2}|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/,
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (year < 1000 || !isValidCalendarDate(year, month, day) || hour > 23 || minute > 59) return false;

  if (/^[+-]/.test(timezone)) {
    const [, offsetHourText, offsetMinuteText] = timezone.match(/^[+-](\d{2}):(\d{2})$/) || [];
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0);
  }
  if (["Z", "UTC"].includes(timezone)) return true;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function listManagedMarkdownFiles(
  root,
  context = createInspectionContext(root),
  indexModel = buildTypedIndexModel(context),
) {
  const scan = {
    scope: "managed_governance_records",
    files: [],
    discovered_count: 0,
    actual_files_scanned: 0,
    scanned_bytes: 0,
    truncated: false,
    file_count_limit_exceeded: false,
    total_bytes_exceeded: false,
    oversized_file_count: 0,
    oversized_files: [],
    missing_indexed_file_count: 0,
    missing_indexed_files: [],
    read_error_count: 0,
    read_errors: [],
    read_errors_truncated: false,
    coverageIssueCollector: createStableIssueCollector(),
    summary: null,
  };
  const corePaths = [...FIVE_PIECE, ...INDEX_FILES];
  const corePathSet = new Set(corePaths);
  const indexedPaths = collectIndexedMarkdownPaths(root, context, indexModel);
  const managedPaths = [...new Set([...corePaths, ...indexedPaths])];

  for (const rel of managedPaths) {
    const abs = path.join(root, rel);
    let kind;
    let size;
    try {
      kind = context.kind(rel);
      size = context.size(rel);
    } catch (error) {
      scan.truncated = true;
      recordMarkdownScanReadError(scan, { rel, code: error.code || "read_error" });
      continue;
    }
    if (kind === "absent") {
      if (!corePathSet.has(rel)) {
        scan.truncated = true;
        scan.missing_indexed_file_count += 1;
        recordStableIssue(scan.coverageIssueCollector, stableIssue("managed_file_not_checked", `${rel}#missing`));
        if (scan.missing_indexed_files.length < MAX_MARKDOWN_SCAN_ISSUE_SAMPLES) {
          scan.missing_indexed_files.push(boundedIdentityText(rel));
        }
      }
      continue;
    }
    scan.discovered_count += 1;
    if (scan.discovered_count > MARKDOWN_SCAN_LIMIT) {
      scan.truncated = true;
      scan.file_count_limit_exceeded = true;
      recordStableIssue(scan.coverageIssueCollector, stableIssue("managed_scan_budget_exhausted", "managed-files#file-count"));
      break;
    }
    if (kind !== "file") {
      scan.truncated = true;
      recordMarkdownScanReadError(scan, { rel, code: "not_regular_file" });
      continue;
    }
    if (size > MAX_MARKDOWN_SCAN_FILE_BYTES) {
      scan.truncated = true;
      scan.oversized_file_count += 1;
      recordStableIssue(scan.coverageIssueCollector, stableIssue("managed_file_not_checked", `${rel}#file_too_large`));
      if (scan.oversized_files.length < MAX_MARKDOWN_SCAN_ISSUE_SAMPLES) {
        scan.oversized_files.push({ rel: boundedIdentityText(rel), bytes: size });
      }
      continue;
    }
    if (scan.scanned_bytes + size > MAX_MARKDOWN_SCAN_TOTAL_BYTES) {
      scan.truncated = true;
      scan.total_bytes_exceeded = true;
      recordStableIssue(scan.coverageIssueCollector, stableIssue("managed_scan_budget_exhausted", "managed-files#total-bytes"));
      break;
    }
    scan.files.push(abs);
    scan.scanned_bytes += size;
  }
  refreshMarkdownScanSummary(scan);
  return scan;
}

function collectIndexedMarkdownPaths(
  root,
  context = createInspectionContext(root),
  indexModel = buildTypedIndexModel(context),
) {
  return [...indexModel.managedMarkdownPaths];
}

function recordMarkdownScanReadError(scan, item) {
  scan.read_error_count += 1;
  recordStableIssue(
    scan.coverageIssueCollector,
    stableIssue("managed_file_not_checked", `${item.rel}#${item.code || "read_failed"}`),
  );
  if (scan.read_errors.length < MAX_MARKDOWN_SCAN_ISSUE_SAMPLES) {
    scan.read_errors.push({
      ...item,
      rel: boundedIdentityText(item.rel),
      code: boundedIdentityText(item.code || "read_error", 160),
    });
  } else {
    scan.read_errors_truncated = true;
  }
}

function refreshMarkdownScanSummary(scan) {
  scan.summary = {
    scope: scan.scope,
    files_scanned: scan.actual_files_scanned,
    files_selected: scan.files.length,
    files_discovered: scan.discovered_count,
    max_files: MARKDOWN_SCAN_LIMIT,
    scanned_bytes: scan.scanned_bytes,
    max_file_bytes: MAX_MARKDOWN_SCAN_FILE_BYTES,
    max_total_bytes: MAX_MARKDOWN_SCAN_TOTAL_BYTES,
    truncated: scan.truncated,
    file_count_limit_exceeded: scan.file_count_limit_exceeded,
    total_bytes_exceeded: scan.total_bytes_exceeded,
    oversized_file_count: scan.oversized_file_count,
    oversized_files: scan.oversized_files,
    missing_indexed_file_count: scan.missing_indexed_file_count,
    missing_indexed_files: scan.missing_indexed_files,
    read_error_count: scan.read_error_count,
    read_errors: scan.read_errors,
    read_errors_truncated: scan.read_errors_truncated,
  };
}

function markdownScanErrors(scan) {
  const errors = [];
  if ((scan.read_error_count ?? scan.read_errors?.length ?? 0) > 0) errors.push("markdown_scan_read_error");
  return errors;
}

function markdownScanCoverageIssues(scan) {
  const issues = [];
  if (scan.truncated) issues.push("markdown_scan_truncated");
  if (scan.file_count_limit_exceeded) issues.push("markdown_scan_file_count_exceeded");
  if (scan.total_bytes_exceeded) issues.push("markdown_scan_total_bytes_exceeded");
  if ((scan.oversized_file_count || 0) > 0) issues.push("markdown_scan_file_too_large");
  if ((scan.missing_indexed_file_count || 0) > 0) issues.push("indexed_markdown_missing");
  return issues;
}

function collectIds(
  root,
  markdownScan,
  coreRecords,
  context = createInspectionContext(root),
  indexModel = buildTypedIndexModel(context),
) {
  enrichTypedIndexModelWithManagedScan(context, indexModel, markdownScan);
  const all = [...indexModel.referenceOccurrences];
  const definitionFiles = indexModel.definitionFiles;

  const byPrefix = { M: [], EV: [], MAT: [] };
  for (const item of all) {
    const prefix = item.id.startsWith("EV-") ? "EV" : item.id.startsWith("MAT-") ? "MAT" : "M";
    byPrefix[prefix].push(item.id);
  }

  const definitionCollisions = [];
  const definitionCollisionCollector = createStableIssueCollector();
  let definitionCollisionCount = 0;
  for (const [id, occurrences] of indexModel.definitionOccurrences.entries()) {
    if (occurrences.length > 1) {
      definitionCollisionCount += 1;
      recordStableIssue(definitionCollisionCollector, stableIssue("definition_id_collision", id));
      if (definitionCollisions.length < MAX_STRUCTURE_ISSUES) {
        const allFiles = [...new Set(occurrences.map((item) => item.rel))];
        const allLocations = occurrences.map((item) => ({ rel: item.rel, line: item.line }));
        definitionCollisions.push({
          id: boundedIdentityText(id),
          count: occurrences.length,
          occurrence_count: occurrences.length,
          files: allFiles.slice(0, MAX_STRUCTURE_ISSUES).map((rel) => boundedIdentityText(rel)),
          file_count: allFiles.length,
          files_truncated: allFiles.length > MAX_STRUCTURE_ISSUES,
          locations: allLocations.slice(0, MAX_STRUCTURE_ISSUES).map((item) => ({
            ...item,
            rel: boundedIdentityText(item.rel),
          })),
          locations_truncated: allLocations.length > MAX_STRUCTURE_ISSUES,
        });
      }
    }
  }
  const maxima = {
    M: maxId(byPrefix.M),
    EV: maxId(byPrefix.EV),
    MAT: maxId(byPrefix.MAT),
  };

  return {
    all,
    definitionFiles,
    definitionCollisionCollector,
    summary: {
      occurrence_count: all.length,
      sample: all.slice(0, 10).map((item) => ({
        ...item,
        id: boundedIdentityText(item.id),
        rel: limitText(item.rel, MAX_STRUCTURE_DETAIL_CHARS),
      })),
      counts: {
        M: new Set(byPrefix.M).size,
        EV: new Set(byPrefix.EV).size,
        MAT: new Set(byPrefix.MAT).size,
      },
      max: {
        M: maxima.M === null ? null : boundedIdentityText(maxima.M),
        EV: maxima.EV === null ? null : boundedIdentityText(maxima.EV),
        MAT: maxima.MAT === null ? null : boundedIdentityText(maxima.MAT),
      },
      definition_collisions: definitionCollisions,
      definition_collision_count: definitionCollisionCount,
      definition_collisions_truncated: definitionCollisionCount > definitionCollisions.length,
    },
    coreRecords,
  };
}

function extractProjectIds(text, options = {}) {
  const source = options.markdown ? visibleMarkdownLines(String(text || "")).join("\n") : String(text || "");
  const regex = new RegExp(PROJECT_ID_REGEX_SOURCE, "g");
  const ids = [];
  let match;
  while ((match = regex.exec(source))) {
    ids.push(match[1]);
  }
  return ids;
}

function checkReferences(root, idData, indexModel = null) {
  const statuses = [...(indexModel?.referenceStatuses?.values() || [])];
  const unresolvedAll = statuses
    .filter((item) => item.status === "unresolved")
    .map((item) => ({ id: boundedIdentityText(item.id), reason: limitText(item.reason, MAX_STRUCTURE_DETAIL_CHARS) }))
    .sort((left, right) => compareUtf8(left.id, right.id));
  const resolvedWithInvalidEntryPathAll = statuses
    .filter((item) => item.status === "resolved_with_invalid_entry_path")
    .map((item) => ({ id: boundedIdentityText(item.id), status: item.status }))
    .sort((left, right) => compareUtf8(left.id, right.id));

  return {
    unresolved: unresolvedAll.slice(0, MAX_STRUCTURE_ISSUES),
    unresolved_count: unresolvedAll.length,
    unresolved_truncated: unresolvedAll.length > MAX_STRUCTURE_ISSUES,
    resolved_with_invalid_entry_path: resolvedWithInvalidEntryPathAll.slice(0, MAX_STRUCTURE_ISSUES),
    resolved_with_invalid_entry_path_count: resolvedWithInvalidEntryPathAll.length,
    resolved_with_invalid_entry_path_truncated: resolvedWithInvalidEntryPathAll.length > MAX_STRUCTURE_ISSUES,
    checked_id_count: statuses.length,
  };
}

function scanPlaceholders(root, fileRecords, context = null) {
  const items = [];
  const issueCollector = createStableIssueCollector();
  let count = 0;
  for (const record of fileRecords.filter((item) => item.exists)) {
    let text;
    try {
      text = context
        ? context.getBoundedText(record.rel, MAX_MARKDOWN_SCAN_FILE_BYTES).text
        : readText(path.join(root, record.rel));
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (PLACEHOLDER_PATTERNS.some((regex) => regex.test(line))) {
        count += 1;
        recordStableIssue(issueCollector, stableIssue("template_placeholder_found", `${record.rel}#placeholder`));
        if (items.length < MAX_STRUCTURE_ISSUES) items.push({ rel: record.rel, line: index + 1 });
      }
    });
  }
  return {
    items,
    count,
    truncated: count > items.length,
    issueCollector,
  };
}

function fingerprintOverlayEntry(entry) {
  const normalized = normalizeOverlayEntry(entry);
  if (normalized.kind === "absent") return { exists: false, kind: "absent", bytes: null, sha256: null };
  if (normalized.kind === "directory") return { exists: true, kind: "directory", bytes: null, sha256: null };
  return {
    exists: true,
    kind: "file",
    bytes: normalized.bytes.length,
    sha256: sha256(normalized.bytes),
  };
}

function strictUnknownFields(value, allowed, prefix) {
  if (!isPlainObject(value)) return [`${prefix}_object_required`];
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${prefix}_unknown_field:${key}`);
}

function canonicalizeOperationPlan(root, plan) {
  const violations = [];
  const allowed = new Set(["schema_version", "plan_id", "knowledge_review", "actions"]);
  violations.push(...strictUnknownFields(plan, allowed, "operation_plan"));
  if (plan?.schema_version !== OPERATION_SCHEMA_VERSION) {
    violations.push(`schema_version_must_be_${OPERATION_SCHEMA_VERSION}`);
  }
  const planId = typeof plan?.plan_id === "string" ? plan.plan_id.trim() : "";
  if (!isNonEmptyString(planId)) violations.push("plan_id_required");
  else if (utf8Bytes(planId) > MAX_TRANSACTION_PLAN_ID_BYTES) {
    violations.push(`plan_id_exceeds_${MAX_TRANSACTION_PLAN_ID_BYTES}_bytes`);
  }
  if (!Array.isArray(plan?.actions)) violations.push("actions_array_required");
  if (Array.isArray(plan?.actions) && plan.actions.length === 0) violations.push("actions_non_empty_required");
  if (Array.isArray(plan?.actions) && plan.actions.length > MAX_ACTIONS) {
    violations.push(`actions_exceed_limit_${MAX_ACTIONS}`);
  }
  validateTotalActionTextBudget(plan?.actions, "actions", violations);
  return {
    plan_id: planId,
    actions: Array.isArray(plan?.actions) ? plan.actions : [],
    knowledge_review: plan?.knowledge_review,
    violations,
  };
}

function validateTotalActionTextBudget(actions, prefix, violations) {
  if (!Array.isArray(actions)) return;
  let totalBytes = 0;
  const textFields = new Set(["content", "after", "contains", "replacement", "old_block"]);
  for (const action of actions) {
    if (!isPlainObject(action)) continue;
    for (const [field, value] of Object.entries(action)) {
      if (textFields.has(field) && typeof value === "string") totalBytes += utf8Bytes(value);
    }
  }
  if (totalBytes > MAX_TOTAL_ACTION_TEXT_BYTES) {
    violations.push(`${prefix}_total_text_exceeds_${MAX_TOTAL_ACTION_TEXT_BYTES}_bytes`);
  }
}

function transactionActionPathByteViolation(actionPath, kind) {
  const actionPathBytes = utf8Bytes(actionPath);
  if (actionPathBytes > MAX_TRANSACTION_PATH_BYTES) {
    return `path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`;
  }
  if (
    kind !== "mkdir"
    && actionPathBytes + TRANSACTION_TEMP_REL_SUFFIX_BYTES > MAX_TRANSACTION_PATH_BYTES
  ) {
    return `transaction_temp_path_exceeds_${MAX_TRANSACTION_PATH_BYTES}_bytes`;
  }
  return null;
}

function simulateCanonicalActions(context, actions) {
  const violations = [];
  const warnings = [];
  const canonicalActions = [];
  const overlay = createInspectionOverlay();
  const touched = new Set();
  const contributing = new Map();

  const currentEntry = (rel, requireText = false) => {
    if (overlay.has(rel)) return overlay.get(rel);
    const kind = context.kind(rel);
    if (kind === "absent") return { kind: "absent", bytes: null };
    if (kind === "directory") return { kind: "directory", bytes: null };
    if (kind !== "file") return { kind, bytes: null };
    if (!requireText) return { kind: "file", bytes: null, size: context.size(rel) };
    const read = context.getBoundedBuffer(rel, MAX_MUTABLE_TEXT_FILE_BYTES);
    return { kind: "file", bytes: Buffer.from(read), size: read.length };
  };

  const recordTouch = (rel, index) => {
    touched.add(rel);
    if (!contributing.has(rel)) contributing.set(rel, []);
    contributing.get(rel).push(index);
  };

  for (const [index, action] of actions.entries()) {
    const prefix = `actions[${index}]`;
    if (!isPlainObject(action)) {
      violations.push(`${prefix}.object_required`);
      continue;
    }
    const kind = action.kind;
    if (!isNonEmptyString(kind) || !ACTION_FIELDS.has(kind)) {
      violations.push(!isNonEmptyString(kind) ? `${prefix}.kind_required` : `${prefix}.unknown_kind:${kind}`);
      continue;
    }
    for (const key of Object.keys(action)) {
      if (!ACTION_FIELDS.get(kind).has(key)) violations.push(`${prefix}.unknown_field:${key}`);
    }
    if (!isNonEmptyString(action.path)) {
      violations.push(`${prefix}.path_required`);
      continue;
    }
    const pathByteViolation = transactionActionPathByteViolation(action.path, kind);
    if (pathByteViolation) {
      violations.push(`${prefix}.${pathByteViolation}`);
      continue;
    }
    const pathCheck = validateRelativePath(context.root, action.path);
    if (!pathCheck.ok) {
      violations.push(`${prefix}.path_invalid:${pathCheck.error}`);
      continue;
    }
    const rel = pathCheck.rel;
    if (!isAllowedProjectPath(rel)) {
      const code = kind === "mkdir" && GOVERNANCE_ROOT_DIRECTORIES.includes(rel)
        ? "mkdir_top_level_governance_directory_not_allowed_use_index_file_or_subdirectory"
        : "path_not_allowed";
      violations.push(`${prefix}.${code}`);
      continue;
    }
    recordTouch(rel, index);
    const startViolationCount = violations.length;

    if (kind === "mkdir") {
      const existing = currentEntry(rel, false);
      if (!["absent", "directory"].includes(existing.kind)) violations.push(`${prefix}.mkdir_target_is_not_directory`);
      if (existing.kind === "directory") warnings.push(`${prefix}.directory_already_exists`);
      if (violations.length === startViolationCount) {
        canonicalActions.push({ kind, path: rel });
        overlay.set(rel, { kind: "directory", bytes: null });
      }
      continue;
    }

    if (kind === "write_file") {
      if (typeof action.content !== "string") violations.push(`${prefix}.content_required`);
      if (typeof action.overwrite !== "boolean") violations.push(`${prefix}.overwrite_must_be_boolean`);
      if (utf8Bytes(action.content || "") > MAX_ACTION_TEXT_BYTES) violations.push(`${prefix}.content_exceeds_${MAX_ACTION_TEXT_BYTES}_bytes`);
      if (hasPlaceholderContent(action.content || "")) violations.push(`${prefix}.content_contains_placeholder`);
      const existing = currentEntry(rel, false);
      if (!["absent", "file"].includes(existing.kind)) violations.push(`${prefix}.write_target_is_not_file`);
      if (existing.kind !== "absent" && action.overwrite !== true) violations.push(`${prefix}.target_exists_without_overwrite`);
      const finalText = ensureTrailingNewline(action.content || "");
      const finalBytes = Buffer.from(finalText, "utf8");
      const oldBytes = existing.kind === "file" ? (existing.size ?? existing.bytes?.length ?? context.size(rel)) : 0;
      if (oldBytes > MAX_MUTABLE_TEXT_FILE_BYTES && !(action.overwrite === true && finalBytes.length < oldBytes)) {
        violations.push(`${prefix}.write_target_exceeds_${MAX_MUTABLE_TEXT_FILE_BYTES}_bytes_without_strict_shrink`);
      }
      if (violations.length === startViolationCount) {
        canonicalActions.push({ kind, path: rel, content: finalText, overwrite: action.overwrite });
        overlay.set(rel, { kind: "file", bytes: finalBytes });
      }
      continue;
    }

    let existing;
    try {
      existing = currentEntry(rel, true);
    } catch (error) {
      violations.push(`${prefix}.target_not_readable:${error.code || "read_failed"}`);
      continue;
    }
    if (existing.kind !== "file") {
      violations.push(`${prefix}.target_is_not_file`);
      continue;
    }
    const existingText = existing.bytes.toString("utf8");
    const newline = preferredNewline(existingText);

    if (kind === "append_after") {
      if (typeof action.after !== "string") violations.push(`${prefix}.after_required`);
      if (typeof action.content !== "string") violations.push(`${prefix}.content_required`);
      if (!["exact", "contains"].includes(action.match)) violations.push(`${prefix}.match_invalid`);
      if (utf8Bytes(action.after || "") > MAX_ANCHOR_TEXT_BYTES) violations.push(`${prefix}.after_exceeds_${MAX_ANCHOR_TEXT_BYTES}_bytes`);
      if (utf8Bytes(action.content || "") > MAX_ACTION_TEXT_BYTES) violations.push(`${prefix}.content_exceeds_${MAX_ACTION_TEXT_BYTES}_bytes`);
      if (hasPlaceholderContent(action.content || "")) violations.push(`${prefix}.content_contains_placeholder`);
      const lines = existingText.split(/\r?\n/);
      const matches = lines
        .map((line, lineIndex) => ({ line, lineIndex }))
        .filter((item) => action.match === "contains" ? item.line.includes(action.after || "") : item.line === (action.after || ""));
      if (matches.length !== 1) violations.push(`${prefix}.after_match_count_${matches.length}`);
      if (existingText.includes(action.content || "")) warnings.push(`${prefix}.content_already_present`);
      if (violations.length === startViolationCount) {
        const contentLines = ensureTrailingNewline(action.content).replace(/\r?\n$/, "").split(/\r?\n/);
        lines.splice(matches[0].lineIndex + 1, 0, ...contentLines);
        const next = ensureTrailingNewlineWithStyle(lines.join(newline), newline);
        canonicalActions.push({ kind, path: rel, after: action.after, match: action.match, content: ensureTrailingNewline(action.content) });
        overlay.set(rel, { kind: "file", bytes: Buffer.from(next, "utf8") });
      }
      continue;
    }

    if (kind === "replace_line_contains") {
      if (typeof action.contains !== "string") violations.push(`${prefix}.contains_required`);
      if (typeof action.replacement !== "string") violations.push(`${prefix}.replacement_required`);
      if (typeof action.replacement === "string" && /[\r\n]/.test(action.replacement)) violations.push(`${prefix}.replacement_must_be_single_line`);
      if (utf8Bytes(action.contains || "") > MAX_ANCHOR_TEXT_BYTES) violations.push(`${prefix}.contains_exceeds_${MAX_ANCHOR_TEXT_BYTES}_bytes`);
      if (utf8Bytes(action.replacement || "") > MAX_ACTION_TEXT_BYTES) violations.push(`${prefix}.replacement_exceeds_${MAX_ACTION_TEXT_BYTES}_bytes`);
      if (hasPlaceholderContent(action.replacement || "")) violations.push(`${prefix}.replacement_contains_placeholder`);
      const lines = existingText.split(/\r?\n/);
      const matches = lines
        .map((line, lineIndex) => ({ line, lineIndex }))
        .filter((item) => item.line.includes(action.contains || ""));
      if (matches.length !== 1) violations.push(`${prefix}.contains_match_count_${matches.length}`);
      if (violations.length === startViolationCount) {
        lines[matches[0].lineIndex] = action.replacement;
        const next = ensureTrailingNewlineWithStyle(lines.join(newline), newline);
        canonicalActions.push({ kind, path: rel, contains: action.contains, replacement: action.replacement });
        overlay.set(rel, { kind: "file", bytes: Buffer.from(next, "utf8") });
      }
      continue;
    }

    if (kind === "replace_block_exact") {
      if (typeof action.old_block !== "string" || action.old_block.length === 0) violations.push(`${prefix}.old_block_required`);
      if (typeof action.replacement !== "string") violations.push(`${prefix}.replacement_required`);
      if (utf8Bytes(action.old_block || "") > MAX_ACTION_TEXT_BYTES) violations.push(`${prefix}.old_block_exceeds_${MAX_ACTION_TEXT_BYTES}_bytes`);
      if (utf8Bytes(action.replacement || "") > MAX_ACTION_TEXT_BYTES) violations.push(`${prefix}.replacement_exceeds_${MAX_ACTION_TEXT_BYTES}_bytes`);
      if (hasPlaceholderContent(action.replacement || "")) violations.push(`${prefix}.replacement_contains_placeholder`);
      const replacement = replaceBlockExactResult(existingText, action.old_block || "", action.replacement || "");
      if (replacement.match_count !== 1) violations.push(`${prefix}.old_block_match_count_${replacement.match_count}`);
      if (violations.length === startViolationCount) {
        canonicalActions.push({ kind, path: rel, old_block: action.old_block, replacement: action.replacement });
        overlay.set(rel, { kind: "file", bytes: Buffer.from(replacement.next, "utf8") });
      }
    }
  }

  const canonicalPaths = [...new Set(canonicalActions.map((item) => item.path))];
  for (const child of canonicalPaths) {
    const childComparable = process.platform === "win32" ? child.toLowerCase() : child;
    const segments = child.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join("/");
      const parentComparable = process.platform === "win32" ? parent.toLowerCase() : parent;
      const plannedParent = canonicalPaths.find((candidate) => (
        (process.platform === "win32" ? candidate.toLowerCase() : candidate) === parentComparable
      ));
      const parentEntry = plannedParent
        ? overlay.get(plannedParent)
        : currentEntry(parent, false);
      if (parentEntry?.kind !== "absent" && parentEntry?.kind !== "directory") {
        violations.push(`canonical_action_parent_path_not_directory:${parent}:${child}`);
      }
    }
    for (const parent of canonicalPaths) {
      if (parent === child) continue;
      const parentComparable = process.platform === "win32" ? parent.toLowerCase() : parent;
      if (!childComparable.startsWith(`${parentComparable}/`)) continue;
      if (overlay.get(parent)?.kind !== "directory") {
        violations.push(`canonical_action_parent_path_not_directory:${parent}:${child}`);
      }
    }
  }

  for (const action of canonicalActions.filter((item) => item.kind === "mkdir")) {
    if (context.kind(action.path) === "directory") continue;
    const prefix = `${action.path}/`;
    const populated = canonicalActions.some((item) => item.kind !== "mkdir" && item.path.startsWith(prefix));
    if (!populated) violations.push(`orphan_mkdir_would_leave_empty_directory:${action.path}`);
  }

  const beforeFingerprints = {};
  const predictedTargetFingerprints = {};
  const preparedWrites = new Map();
  if (violations.length === 0) {
    for (const rel of [...touched].sort((left, right) => left.localeCompare(right, "en"))) {
      const finalEntry = overlay.get(rel);
      if (!finalEntry) {
        violations.push(`prepared_write_missing:${rel}`);
        continue;
      }
      const before = context.fingerprint(rel);
      const expected = fingerprintOverlayEntry(finalEntry);
      beforeFingerprints[rel] = before;
      predictedTargetFingerprints[rel] = expected;
      preparedWrites.set(rel, {
        rel,
        contributing_action_indices: [...(contributing.get(rel) || [])],
        final_kind: finalEntry.kind,
        exact_final_bytes: finalEntry.kind === "file" ? Buffer.from(finalEntry.bytes) : null,
        expected_after_fingerprint: expected,
        write_strategy: finalEntry.kind === "directory" ? "directory_intent" : "exact_bytes",
      });
    }
  }
  const targetKeys = [...touched].sort((left, right) => left.localeCompare(right, "en"));
  const keySetsMatch = [
    Object.keys(beforeFingerprints),
    Object.keys(predictedTargetFingerprints),
    [...preparedWrites.keys()],
  ].every((keys) => canonicalJson([...keys].sort()) === canonicalJson(targetKeys));
  if (violations.length === 0 && !keySetsMatch) violations.push("prepared_target_set_invariant_failed");

  return {
    violations: [...new Set(violations)],
    warnings: [...new Set(warnings)],
    actions: canonicalActions,
    overlay,
    preparedWrites,
    touched: targetKeys,
    beforeFingerprints,
    predictedTargetFingerprints,
  };
}

function compilePlan(root, plan, report, context = null) {
  const inspectionContext = context || createInspectionContext(root, { phase: "propose" });
  const operation = canonicalizeOperationPlan(root, plan);
  const simulation = simulateCanonicalActions(inspectionContext, operation.actions);
  const violations = [...operation.violations, ...simulation.violations];
  const warnings = [...simulation.warnings];

  const inMemory = new Map();
  for (const rel of ["TODO.md", "HANDOFF.md"]) {
    if (simulation.overlay.has(rel) && simulation.overlay.get(rel).kind === "file") {
      inMemory.set(rel, simulation.overlay.get(rel).bytes.toString("utf8"));
    } else if (inspectionContext.kind(rel) === "file") {
      try {
        inMemory.set(rel, inspectionContext.getBoundedText(rel, MAX_MUTABLE_TEXT_FILE_BYTES).text);
      } catch {
        // The inspection snapshot already carries the incomplete-read issue.
        inMemory.set(rel, "");
      }
    } else inMemory.set(rel, "");
  }
  const knowledgeReviewCheck = compileKnowledgeReview(
    root,
    operation.knowledge_review,
    simulation.actions,
    inMemory,
    inspectionContext,
    simulation.overlay,
  );
  violations.push(...knowledgeReviewCheck.violations);
  warnings.push(...knowledgeReviewCheck.warnings);

  const predictedContext = createInspectionContext(root, {
    phase: inspectionContext.phase,
    epoch_id: inspectionContext.epoch_id,
    overlay: simulation.overlay,
    baseContext: inspectionContext,
  });
  const predictedReport = inspectProject(root, {
    context: predictedContext,
    overlay: simulation.overlay,
    phase: inspectionContext.phase,
  });
  const baselineValidation = report.decision_snapshot;
  const predictedValidation = predictedReport.decision_snapshot;
  const predictedTransition = evaluateValidationTransition(
    baselineValidation,
    predictedValidation,
    {
      actions: simulation.actions,
      changed_paths: changedTargetPaths(simulation.beforeFingerprints, simulation.predictedTargetFingerprints),
      before_semantic_declaration: report.semantic_declaration,
      after_semantic_declaration: predictedReport.semantic_declaration,
    },
  );
  if (!predictedTransition.transition_ok) violations.push(...predictedTransition.rejection_codes);

  const uniqueViolations = [...new Set(violations)];
  let compiledPlan = null;
  if (uniqueViolations.length === 0) {
    compiledPlan = {
      tool: SCRIPT_NAME,
      command: "propose",
      compiled_schema_version: COMPILED_SCHEMA_VERSION,
      operation_schema_version: OPERATION_SCHEMA_VERSION,
      skill_version: SKILL_VERSION,
      project_structure_version: PROJECT_STRUCTURE_VERSION,
      decision_policy_version: DECISION_POLICY_VERSION,
      compiled_at: new Date().toISOString(),
      root: path.resolve(root),
      plan_id: operation.plan_id,
      before_fingerprints: simulation.beforeFingerprints,
      baseline_validation: baselineValidation,
      baseline_validation_digest: canonicalDigest(baselineValidation),
      knowledge_review: knowledgeReviewCheck.normalized,
      actions: simulation.actions,
      predicted_target_fingerprints: simulation.predictedTargetFingerprints,
      predicted_validation: predictedValidation,
      predicted_validation_digest: canonicalDigest(predictedValidation),
      predicted_transition: predictedTransition,
      compiled_content_digest: "",
    };
    const digestPayload = { ...compiledPlan };
    delete digestPayload.compiled_at;
    delete digestPayload.compiled_content_digest;
    compiledPlan.compiled_content_digest = canonicalDigest(digestPayload);
  }

  return {
    ok: uniqueViolations.length === 0,
    tool: SCRIPT_NAME,
    command: "propose",
    skill_version: SKILL_VERSION,
    root,
    plan_id: operation.plan_id,
    compiled_plan: compiledPlan,
    prepared_writes: simulation.preparedWrites,
    predicted_report: predictedReport,
    predicted_transition: predictedTransition,
    violations: uniqueViolations,
    warnings: [...new Set(warnings)],
  };
}

function summarizeCompiledPlan(result, outPath, operationCleanup = null) {
  const compiled = result.compiled_plan;
  const actions = Array.isArray(compiled?.actions) ? compiled.actions : [];
  const actionCounts = {};
  for (const action of actions) {
    actionCounts[action.kind] = (actionCounts[action.kind] || 0) + 1;
  }
  const allViolations = [...new Set(result.violations || [])];
  const allWarnings = operationCleanup?.ok === false
    ? [...new Set([...(result.warnings || []), `operation_cleanup_failed:${operationCleanup.error}`])]
    : [...new Set(result.warnings || [])];
  return {
    ok: result.ok,
    tool: SCRIPT_NAME,
    command: "propose",
    skill_version: SKILL_VERSION,
    plan_id: result.plan_id,
    root: result.root,
    compiled_plan_path: outPath,
    operation_cleanup: operationCleanup,
    knowledge_review: compiled?.knowledge_review
      ? { status: compiled.knowledge_review.status }
      : null,
    action_count: actions.length,
    action_counts: actionCounts,
    actions: actions.map((action) => ({ kind: action.kind, path: action.path })),
    predicted_transition: result.predicted_transition,
    violation_count: allViolations.length,
    violations_truncated: allViolations.length > MAX_STRUCTURE_ISSUES,
    violations: allViolations.slice(0, MAX_STRUCTURE_ISSUES).map((item) => boundedIdentityText(item)),
    warning_count: allWarnings.length,
    warnings_truncated: allWarnings.length > MAX_STRUCTURE_ISSUES,
    warnings: allWarnings.slice(0, MAX_STRUCTURE_ISSUES).map((item) => boundedIdentityText(item)),
  };
}

function compileKnowledgeReview(root, review, actions, inMemory, context, overlay = null) {
  const violations = [];
  const warnings = [];
  if (!isPlainObject(review)) {
    return { normalized: null, violations: ["knowledge_review_object_required"], warnings };
  }

  const allowedFields = new Set(["status", "basis", "paths", "recheck"]);
  for (const key of Object.keys(review)) {
    if (!allowedFields.has(key)) violations.push(`knowledge_review_unknown_field:${key}`);
  }

  const status = typeof review.status === "string" ? review.status.trim() : "";
  if (!KNOWLEDGE_REVIEW_STATUSES.has(status)) {
    violations.push("knowledge_review_status_invalid");
  }

  const basis = normalizeKnowledgeReviewText(review.basis, "basis", violations);
  const normalized = { status, basis };
  const actionFilePaths = new Set(
    actions.filter((action) => action.kind !== "mkdir").map((action) => action.path),
  );

  if (status === "created" || status === "updated") {
    if (!Array.isArray(review.paths) || review.paths.length === 0) {
      violations.push("knowledge_review_paths_required");
    } else if (review.paths.length > MAX_KNOWLEDGE_REVIEW_PATHS) {
      violations.push(`knowledge_review_paths_exceed_${MAX_KNOWLEDGE_REVIEW_PATHS}`);
    } else {
      const normalizedRoles = [];
      for (const [index, value] of review.paths.entries()) {
        if (!isNonEmptyString(value)) {
          violations.push(`knowledge_review_paths[${index}]_invalid`);
          continue;
        }
        const pathCheck = validateRelativePath(root, value.trim());
        if (!pathCheck.ok) {
          violations.push(`knowledge_review_paths[${index}]_invalid:${pathCheck.error}`);
          continue;
        }
        const virtual = overlay?.get(pathCheck.rel);
        const actualKind = virtual?.kind || context.kind(pathCheck.rel);
        const planned = actionFilePaths.has(pathCheck.rel);
        if (actualKind !== "absent" && actualKind !== "file" && !planned) {
          violations.push(`knowledge_review_paths[${index}]_must_be_file`);
          continue;
        }
        if (actualKind === "absent" && !planned) {
          violations.push(`knowledge_review_paths[${index}]_not_existing_or_planned`);
          continue;
        }
        normalizedRoles.push({
          path: pathCheck.rel,
          role: planned ? "planned_write" : "declaration_only",
        });
      }
      if (new Set(normalizedRoles.map((item) => item.path)).size !== normalizedRoles.length) {
        violations.push("knowledge_review_paths_duplicate");
      }
      normalized.roles = normalizedRoles;
    }
    if (review.recheck !== undefined) violations.push("knowledge_review_recheck_not_allowed_for_status");
  } else if (status === "deferred") {
    const recheck = normalizeKnowledgeReviewText(review.recheck, "recheck", violations);
    normalized.recheck = recheck;
    const tracksDeferral = actions.some((action) => ["TODO.md", "HANDOFF.md"].includes(action.path));
    if (!tracksDeferral) violations.push("knowledge_review_deferred_requires_todo_or_handoff_action");
    const deferralTargets = ["TODO.md", "HANDOFF.md"].map((rel) => {
      const finalText = inMemory?.get(rel);
      const plannedText = actions
        .filter((action) => action.path === rel && action.kind !== "mkdir")
        .map((action) => action.content ?? action.replacement ?? "")
        .join("\n");
      return { finalText, plannedText };
    });
    const writtenTargets = deferralTargets.filter(({ plannedText }) => (
      plannedText.includes(basis) && plannedText.includes(recheck)
    ));
    const persistedBySamePlannedFile = writtenTargets.some(({ finalText }) => (
      typeof finalText === "string" && finalText.includes(basis) && finalText.includes(recheck)
    ));
    if (writtenTargets.length === 0) {
      violations.push("knowledge_review_deferred_details_not_written_by_plan");
    }
    if (!persistedBySamePlannedFile) {
      violations.push("knowledge_review_deferred_details_not_persisted");
    }
    warnings.push("knowledge_review_deferred");
    if (review.paths !== undefined) violations.push("knowledge_review_paths_not_allowed_for_status");
  } else {
    if (review.paths !== undefined) violations.push("knowledge_review_paths_not_allowed_for_status");
    if (review.recheck !== undefined) violations.push("knowledge_review_recheck_not_allowed_for_status");
  }

  return { normalized, violations, warnings };
}

function normalizeKnowledgeReviewText(value, field, violations) {
  if (!isNonEmptyString(value)) {
    violations.push(`knowledge_review_${field}_required`);
    return "";
  }
  const normalized = value.trim();
  if (/\r|\n/.test(normalized)) violations.push(`knowledge_review_${field}_must_be_single_line`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_KNOWLEDGE_REVIEW_TEXT_BYTES) {
    violations.push(`knowledge_review_${field}_exceeds_${MAX_KNOWLEDGE_REVIEW_TEXT_BYTES}_bytes`);
  }
  return normalized;
}


function validateFingerprintSchema(value, prefix, violations) {
  const allowed = new Set(["exists", "kind", "bytes", "sha256"]);
  violations.push(...strictUnknownFields(value, allowed, prefix));
  if (!isPlainObject(value)) return;
  if (typeof value.exists !== "boolean") violations.push(`${prefix}_exists_boolean_required`);
  if (!FINGERPRINT_KINDS.has(value.kind)) violations.push(`${prefix}_kind_invalid`);
  if (value.exists === false) {
    if (value.kind !== "absent" || value.bytes !== null || value.sha256 !== null) violations.push(`${prefix}_absent_shape_invalid`);
  } else if (value.kind === "absent") {
    violations.push(`${prefix}_present_kind_absent_invalid`);
  } else if (value.kind === "file") {
    if (!Number.isInteger(value.bytes) || value.bytes < 0) violations.push(`${prefix}_file_bytes_invalid`);
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) violations.push(`${prefix}_file_sha256_invalid`);
  } else if (value.bytes !== null || value.sha256 !== null) {
    violations.push(`${prefix}_non_file_shape_invalid`);
  }
}

function validateStableIssueSchema(value, prefix, violations) {
  const allowed = new Set(["code", "subject_key"]);
  violations.push(...strictUnknownFields(value, allowed, prefix));
  if (!isPlainObject(value)) return;
  if (!isNonEmptyString(value.code)) violations.push(`${prefix}_code_required`);
  else if (value.code.length > 160) violations.push(`${prefix}_code_too_long`);
  if (!isNonEmptyString(value.subject_key)) violations.push(`${prefix}_subject_key_required`);
  else if (value.subject_key.length > MAX_STRUCTURE_DETAIL_CHARS) violations.push(`${prefix}_subject_key_too_long`);
}

function validateDecisionSnapshotSchema(value, prefix, violations) {
  const allowed = new Set([
    "schema_version",
    "decision_policy_version",
    "digest_algorithm",
    "scan_complete",
    "semantic_checked_by_tool",
    "hard_issues_complete",
    "coverage_issues_complete",
    "hard_issue_count",
    "hard_issue_sample_count",
    "hard_issues_truncated",
    "hard_issue_multiset_digest",
    "hard_issues",
    "coverage_issue_count",
    "coverage_issue_sample_count",
    "coverage_issues_truncated",
    "coverage_issue_multiset_digest",
    "coverage_issues",
    "relationships",
    "core_index_fingerprints",
    "five_piece",
  ]);
  violations.push(...strictUnknownFields(value, allowed, prefix));
  if (!isPlainObject(value)) return;
  if (value.schema_version !== DECISION_SNAPSHOT_SCHEMA_VERSION) violations.push(`${prefix}_schema_version_invalid`);
  if (value.decision_policy_version !== DECISION_POLICY_VERSION) violations.push(`${prefix}_decision_policy_version_invalid`);
  if (value.digest_algorithm !== DIGEST_ALGORITHM) violations.push(`${prefix}_digest_algorithm_invalid`);
  if (typeof value.scan_complete !== "boolean") violations.push(`${prefix}_scan_complete_boolean_required`);
  if (value.semantic_checked_by_tool !== false) violations.push(`${prefix}_semantic_checked_by_tool_must_be_false`);
  if (typeof value.hard_issues_complete !== "boolean") violations.push(`${prefix}_hard_issues_complete_boolean_required`);
  if (typeof value.coverage_issues_complete !== "boolean") violations.push(`${prefix}_coverage_issues_complete_boolean_required`);
  for (const kind of ["hard", "coverage"]) {
    const field = `${kind}_issues`;
    const countField = `${kind}_issue_count`;
    const sampleCountField = `${kind}_issue_sample_count`;
    const truncatedField = `${kind}_issues_truncated`;
    const digestField = `${kind}_issue_multiset_digest`;
    if (!Array.isArray(value[field])) violations.push(`${prefix}_${field}_array_required`);
    else value[field].forEach((item, index) => validateStableIssueSchema(item, `${prefix}_${field}[${index}]`, violations));
    if (!Number.isInteger(value[countField]) || value[countField] < 0) violations.push(`${prefix}_${countField}_invalid`);
    if (!Number.isInteger(value[sampleCountField]) || value[sampleCountField] < 0 || value[sampleCountField] > MAX_STRUCTURE_ISSUES) {
      violations.push(`${prefix}_${sampleCountField}_invalid`);
    }
    if (Array.isArray(value[field]) && value[sampleCountField] !== value[field].length) violations.push(`${prefix}_${field}_sample_count_mismatch`);
    if (typeof value[truncatedField] !== "boolean") violations.push(`${prefix}_${truncatedField}_boolean_required`);
    if (
      Number.isInteger(value[countField])
      && Number.isInteger(value[sampleCountField])
      && value[truncatedField] !== (value[countField] > value[sampleCountField])
    ) violations.push(`${prefix}_${truncatedField}_count_mismatch`);
    if (typeof value[digestField] !== "string" || !/^[a-f0-9]{64}$/.test(value[digestField])) violations.push(`${prefix}_${digestField}_invalid`);
  }
  const relationshipAllowed = new Set([
    "complete",
    "definition_occurrence_count",
    "definition_distinct_count",
    "definition_digest",
    "reference_occurrence_count",
    "reference_distinct_count",
    "reference_digest",
    "resolution_status_count",
    "resolution_status_distinct_count",
    "resolution_status_digest",
  ]);
  violations.push(...strictUnknownFields(value.relationships, relationshipAllowed, `${prefix}_relationships`));
  if (isPlainObject(value.relationships)) {
    if (typeof value.relationships.complete !== "boolean") violations.push(`${prefix}_relationships_complete_boolean_required`);
    for (const name of ["definition", "reference", "resolution_status"]) {
      const count = value.relationships[`${name}_occurrence_count`] ?? value.relationships[`${name}_count`];
      const distinct = value.relationships[`${name}_distinct_count`];
      const digest = value.relationships[`${name}_digest`];
      if (!Number.isInteger(count) || count < 0) violations.push(`${prefix}_relationships_${name}_count_invalid`);
      if (!Number.isInteger(distinct) || distinct < 0 || (Number.isInteger(count) && distinct > count)) {
        violations.push(`${prefix}_relationships_${name}_distinct_count_invalid`);
      }
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) violations.push(`${prefix}_relationships_${name}_digest_invalid`);
    }
  }
  if (!isPlainObject(value.core_index_fingerprints)) {
    violations.push(`${prefix}_core_index_fingerprints_object_required`);
  } else {
    const actualPaths = Object.keys(value.core_index_fingerprints).sort();
    const expectedPaths = [...INDEX_FILES].sort();
    if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) violations.push(`${prefix}_core_index_fingerprints_path_set_invalid`);
    for (const [rel, fingerprint] of Object.entries(value.core_index_fingerprints)) {
      validateFingerprintSchema(fingerprint, `${prefix}_core_index_fingerprints:${rel}`, violations);
    }
  }
  const fiveAllowed = new Set(["limit_bytes", "total_bytes", "over_limit"]);
  violations.push(...strictUnknownFields(value.five_piece, fiveAllowed, `${prefix}_five_piece`));
  if (isPlainObject(value.five_piece)) {
    if (value.five_piece.limit_bytes !== FIVE_PIECE_LIMIT_BYTES) violations.push(`${prefix}_five_piece_limit_invalid`);
    if (!Number.isInteger(value.five_piece.total_bytes) || value.five_piece.total_bytes < 0) violations.push(`${prefix}_five_piece_total_invalid`);
    if (typeof value.five_piece.over_limit !== "boolean") violations.push(`${prefix}_five_piece_over_limit_boolean_required`);
  }
}

function validateTransitionSchema(value, prefix, violations) {
  const allowed = new Set([
    "transition_ok",
    "policy_path",
    "legacy_checkpoint_accepted",
    "semantic_checked_by_tool",
    "commit_state",
    "removed_hard_issues",
    "remaining_hard_issues",
    "removed_coverage_issues",
    "remaining_coverage_issues",
    "five_piece_delta_bytes",
    "rejection_codes",
  ]);
  violations.push(...strictUnknownFields(value, allowed, prefix));
  if (!isPlainObject(value)) return;
  if (typeof value.transition_ok !== "boolean") violations.push(`${prefix}_transition_ok_boolean_required`);
  if (!["strict", "legacy_neutral_checkpoint"].includes(value.policy_path)) violations.push(`${prefix}_policy_path_invalid`);
  if (typeof value.legacy_checkpoint_accepted !== "boolean") violations.push(`${prefix}_legacy_checkpoint_accepted_boolean_required`);
  if (value.semantic_checked_by_tool !== false) violations.push(`${prefix}_semantic_checked_by_tool_must_be_false`);
  if (!["compliant", "improved_but_noncompliant", "legacy_checkpoint_noncompliant", "rejected"].includes(value.commit_state)) violations.push(`${prefix}_commit_state_invalid`);
  for (const field of ["removed_hard_issues", "remaining_hard_issues", "removed_coverage_issues", "remaining_coverage_issues"]) {
    if (!Array.isArray(value[field])) violations.push(`${prefix}_${field}_array_required`);
    else value[field].forEach((item, index) => validateStableIssueSchema(item, `${prefix}_${field}[${index}]`, violations));
  }
  if (!Number.isInteger(value.five_piece_delta_bytes)) violations.push(`${prefix}_five_piece_delta_invalid`);
  if (!Array.isArray(value.rejection_codes) || value.rejection_codes.some((item) => !isNonEmptyString(item))) violations.push(`${prefix}_rejection_codes_invalid`);
}

function validateCanonicalActionEnvelope(action, index, violations) {
  const prefix = `compiled_actions[${index}]`;
  if (!isPlainObject(action)) {
    violations.push(`${prefix}_object_required`);
    return;
  }
  if (!ACTION_FIELDS.has(action.kind)) {
    violations.push(`${prefix}_kind_invalid`);
    return;
  }
  for (const key of Object.keys(action)) {
    if (!ACTION_FIELDS.get(action.kind).has(key)) violations.push(`${prefix}_unknown_field:${key}`);
  }
  if (typeof action.path === "string") {
    const pathByteViolation = transactionActionPathByteViolation(action.path, action.kind);
    if (pathByteViolation) violations.push(`${prefix}_${pathByteViolation}`);
  }
  const actionSegments = typeof action.path === "string" ? action.path.split("/") : [];
  if (
    !isNonEmptyString(action.path)
    || action.path.includes("\\")
    || path.isAbsolute(action.path)
    || actionSegments.includes("..")
    || actionSegments.some((segment) => segment === "")
  ) violations.push(`${prefix}_path_not_canonical`);
  if (action.kind === "write_file") {
    if (typeof action.content !== "string") violations.push(`${prefix}_content_required`);
    if (typeof action.overwrite !== "boolean") violations.push(`${prefix}_overwrite_boolean_required`);
  } else if (action.kind === "append_after") {
    if (typeof action.after !== "string" || typeof action.content !== "string") violations.push(`${prefix}_text_fields_required`);
    if (!["exact", "contains"].includes(action.match)) violations.push(`${prefix}_match_invalid`);
  } else if (action.kind === "replace_line_contains") {
    if (typeof action.contains !== "string" || typeof action.replacement !== "string" || /[\r\n]/.test(action.replacement || "")) violations.push(`${prefix}_replace_line_fields_invalid`);
  } else if (action.kind === "replace_block_exact") {
    if (!isNonEmptyString(action.old_block) || typeof action.replacement !== "string") violations.push(`${prefix}_replace_block_fields_invalid`);
  }
}

function validateCompiledKnowledgeReview(value, violations) {
  if (!isPlainObject(value)) {
    violations.push("compiled_knowledge_review_object_required");
    return;
  }
  const status = value.status;
  const allowed = status === "created" || status === "updated"
    ? new Set(["status", "basis", "roles"])
    : status === "deferred"
      ? new Set(["status", "basis", "recheck"])
      : new Set(["status", "basis"]);
  violations.push(...strictUnknownFields(value, allowed, "compiled_knowledge_review"));
  if (!KNOWLEDGE_REVIEW_STATUSES.has(status)) violations.push("compiled_knowledge_review_status_invalid");
  if (!isNonEmptyString(value.basis)) violations.push("compiled_knowledge_review_basis_required");
  if (status === "created" || status === "updated") {
    if (!Array.isArray(value.roles) || value.roles.length === 0) violations.push("compiled_knowledge_review_roles_required");
    else {
      for (const [index, role] of value.roles.entries()) {
        violations.push(...strictUnknownFields(role, new Set(["path", "role"]), `compiled_knowledge_review_roles[${index}]`));
        if (!isNonEmptyString(role?.path)) violations.push(`compiled_knowledge_review_roles[${index}]_path_required`);
        if (!["planned_write", "declaration_only"].includes(role?.role)) violations.push(`compiled_knowledge_review_roles[${index}]_role_invalid`);
      }
    }
  }
  if (status === "deferred" && !isNonEmptyString(value.recheck)) violations.push("compiled_knowledge_review_recheck_required");
}

function validateCompiledPlanEnvelope(compiled) {
  const violations = [];
  violations.push(...strictUnknownFields(compiled, COMPILED_PLAN_FIELDS, "compiled_plan"));
  if (!isPlainObject(compiled)) return { violations, touched: [] };
  for (const field of COMPILED_PLAN_FIELDS) {
    if (!Object.hasOwn(compiled, field)) violations.push(`compiled_plan_field_missing:${field}`);
  }
  if (compiled.tool !== SCRIPT_NAME || compiled.command !== "propose") violations.push("compiled_plan_origin_invalid");
  if (compiled.compiled_schema_version !== COMPILED_SCHEMA_VERSION) violations.push(`compiled_schema_version_must_be_${COMPILED_SCHEMA_VERSION}`);
  if (compiled.operation_schema_version !== OPERATION_SCHEMA_VERSION) violations.push(`compiled_operation_schema_version_must_be_${OPERATION_SCHEMA_VERSION}`);
  if (compiled.skill_version !== SKILL_VERSION) violations.push("compiled_skill_version_mismatch");
  if (compiled.project_structure_version !== PROJECT_STRUCTURE_VERSION) violations.push("compiled_project_structure_version_mismatch");
  if (compiled.decision_policy_version !== DECISION_POLICY_VERSION) violations.push("compiled_decision_policy_version_mismatch");
  if (!isNonEmptyString(compiled.compiled_at) || !Number.isFinite(Date.parse(compiled.compiled_at))) violations.push("compiled_at_invalid");
  if (!isNonEmptyString(compiled.root) || path.resolve(compiled.root || ".") !== compiled.root) violations.push("compiled_root_not_canonical");
  if (!isNonEmptyString(compiled.plan_id)) violations.push("compiled_plan_id_required");
  else if (utf8Bytes(compiled.plan_id) > MAX_TRANSACTION_PLAN_ID_BYTES) {
    violations.push(`compiled_plan_id_exceeds_${MAX_TRANSACTION_PLAN_ID_BYTES}_bytes`);
  }
  if (!Array.isArray(compiled.actions) || compiled.actions.length === 0 || compiled.actions.length > MAX_ACTIONS) {
    violations.push("compiled_actions_array_invalid");
  }
  else {
    compiled.actions.forEach((action, index) => validateCanonicalActionEnvelope(action, index, violations));
    validateTotalActionTextBudget(compiled.actions, "compiled_actions", violations);
  }
  validateCompiledKnowledgeReview(compiled.knowledge_review, violations);
  validateDecisionSnapshotSchema(compiled.baseline_validation, "baseline_validation", violations);
  validateDecisionSnapshotSchema(compiled.predicted_validation, "predicted_validation", violations);
  validateTransitionSchema(compiled.predicted_transition, "predicted_transition", violations);
  if (
    isPlainObject(compiled.baseline_validation)
    && compiled.baseline_validation_digest !== canonicalDigest(compiled.baseline_validation)
  ) violations.push("baseline_validation_digest_mismatch");
  if (
    isPlainObject(compiled.predicted_validation)
    && compiled.predicted_validation_digest !== canonicalDigest(compiled.predicted_validation)
  ) violations.push("predicted_validation_digest_mismatch");
  const touched = Array.isArray(compiled.actions)
    ? [...new Set(compiled.actions.map((action) => action?.path).filter(isNonEmptyString))].sort((left, right) => left.localeCompare(right, "en"))
    : [];
  for (const [name, fingerprints] of [
    ["before_fingerprints", compiled.before_fingerprints],
    ["predicted_target_fingerprints", compiled.predicted_target_fingerprints],
  ]) {
    if (!isPlainObject(fingerprints)) {
      violations.push(`${name}_object_required`);
      continue;
    }
    if (canonicalJson(Object.keys(fingerprints).sort()) !== canonicalJson(touched)) violations.push(`${name}_target_set_mismatch`);
    for (const [rel, fingerprint] of Object.entries(fingerprints)) validateFingerprintSchema(fingerprint, `${name}:${rel}`, violations);
  }
  const digestPayload = { ...compiled };
  delete digestPayload.compiled_at;
  delete digestPayload.compiled_content_digest;
  try {
    if (
      typeof compiled.compiled_content_digest !== "string"
      || compiled.compiled_content_digest !== canonicalDigest(digestPayload)
    ) violations.push("compiled_content_digest_mismatch");
  } catch (error) {
    violations.push(`compiled_content_digest_unverifiable:${error.message}`);
  }
  return { violations: [...new Set(violations)], touched };
}

function applyCompiledPlan(compiled) {
  const envelope = validateCompiledPlanEnvelope(compiled);
  if (envelope.violations.length > 0) fail(formatDiagnosticFailure("Compiled plan failed static validation", envelope.violations), 2);
  const root = resolveRoot(compiled.root);
  const lock = acquireApplyLock(root, compiled?.plan_id);
  let result;
  let operationError = null;
  try {
    result = applyCompiledPlanLocked(root, compiled, lock);
  } catch (error) {
    operationError = error;
  }

  if (operationError) {
    const lockCleanup = releaseOwnedLock(lock);
    if (!lockCleanup.ok) {
      operationError.message = `${operationError.message}; apply lock cleanup failed: ${lockCleanup.error}`;
    }
    throw operationError;
  }

  const transaction = result?._transaction || null;
  if (result && Object.hasOwn(result, "_transaction")) delete result._transaction;
  const retainForRecovery = result?.rollback_incomplete === true && transaction !== null;
  const lockCleanup = retainForRecovery
    ? {
      ok: true,
      released: false,
      method: "retained_for_interrupted_recovery",
      warnings: [],
    }
    : releaseOwnedLock(lock);

  let backupCleanup = result?.backup_cleanup || {
    ok: true,
    removed: false,
    retained: false,
    method: "not_created",
  };
  if (transaction) {
    if (lockCleanup.ok && lockCleanup.released) {
      backupCleanup = cleanupTransactionBackup(root, transaction.backup_root, {
        expectedTransactionId: transaction.transaction_id,
        expectedPlanId: transaction.plan_id,
        removeBackupBase: transaction.backup_base_created === true,
      });
    } else {
      backupCleanup = {
        ok: false,
        removed: false,
        retained: true,
        rel: toRel(root, transaction.backup_root),
        error: retainForRecovery
          ? "rollback_incomplete_backup_and_lock_retained"
          : "apply_lock_not_released_backup_retained",
      };
    }
  }

  result = {
    ...result,
    backups_retained: backupCleanup.ok ? [] : (transaction?.backups || result.backups_retained || []),
    backup_cleanup: backupCleanup,
    interrupted_recovery: lock.interrupted_recovery || null,
  };
  if (!backupCleanup.ok) {
    result.warnings = [...new Set([
      ...(result.warnings || []),
      `transaction_backup_retained:${backupCleanup.error}`,
    ])];
  }

  if (!lockCleanup.ok || lockCleanup.warnings.length > 0) {
    const warning = lockCleanup.ok
      ? `apply_lock_cleanup_fallback:${lockCleanup.warnings.join(" | ")}`
      : `apply_lock_cleanup_failed:${lockCleanup.error}`;
    return {
      ...result,
      lock_cleanup: lockCleanup,
      warnings: [...new Set([...(result.warnings || []), warning])],
    };
  }
  return { ...result, lock_cleanup: lockCleanup };
}


function applyCompiledPlanLocked(root, compiled, lock) {
  const alreadyApplied = detectCompiledPlanAlreadyApplied(root, compiled);
  if (alreadyApplied) return alreadyApplied;
  const preflight = preflightCompiledPlan(root, compiled);
  if (preflight.violations.length > 0) {
    fail(formatDiagnosticFailure("Compiled plan failed apply preflight", preflight.violations), 2);
  }
  const transactionId = lock.owner_id;
  const backupRoot = path.join(root, ".project-gov", "backups", `txn-${transactionId}`);
  const changed = [];
  const unchanged = [];
  const backups = [];
  const createdDirectories = [];
  const plannedCreatedDirectories = planTransactionCreatedDirectories(root, preflight);
  const targetTempRels = Object.fromEntries(
    [...preflight.preparedWrites.values()]
      .filter((item) => item.final_kind === "file")
      .map((item) => [item.rel, `${item.rel}.tmp-project-gov-${transactionId}`]),
  );
  let backupBaseCreatedByTransaction = false;
  let writesStarted = false;
  let backupManifestDigest = null;
  let journal = null;

  try {
    transitionApplyLockPhase(lock, "acquired", "backup_started");
    const backupBase = path.dirname(backupRoot);
    assertTransactionBackupBaseSafe(root);
    if (!fs.existsSync(backupBase)) {
      ensureDirectoryDurable(backupBase, root);
      backupBaseCreatedByTransaction = true;
    }
    assertTransactionBackupBaseSafe(root);
    ensureDirectoryDurable(backupRoot, backupBase);
    writeAtomicDurable(path.join(backupRoot, BACKUP_OWNER_FILE), `${JSON.stringify({
      schema_version: TRANSACTION_JOURNAL_SCHEMA_VERSION,
      tool: SCRIPT_NAME,
      kind: "transaction_backup",
      root,
      plan_id: String(compiled.plan_id || "unknown"),
      transaction_id: transactionId,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`, {
      tempPath: path.join(backupRoot, `${BACKUP_OWNER_FILE}.tmp-${transactionId}`),
    });
    journal = {
      schema_version: TRANSACTION_JOURNAL_SCHEMA_VERSION,
      tool: SCRIPT_NAME,
      kind: "transaction_journal",
      root,
      plan_id: compiled.plan_id,
      transaction_id: transactionId,
      state: "preparing",
      baseline_validation_digest: preflight.baselineDigest,
      predicted_validation_digest: preflight.predictedDigest,
      before_fingerprints: preflight.beforeFingerprints,
      predicted_target_fingerprints: preflight.predictedTargetFingerprints,
      targets: preflight.touched,
      planned_created_directories: plannedCreatedDirectories,
      directory_records: plannedCreatedDirectories.map((rel) => ({
        rel,
        state: "intent",
        identity: null,
      })),
      target_temp_rels: targetTempRels,
      backup_base_created: backupBaseCreatedByTransaction,
      backed_up_files: [],
    };
    journal = persistTransactionJournal(backupRoot, journal);
    backupManifestDigest = journal.manifest_digest;
    for (const rel of preflight.touched) {
      const abs = path.join(root, rel);
      const before = preflight.beforeFingerprints[rel];
      if (before.kind === "file") {
        const backupPath = path.join(backupRoot, rel);
        ensureDirectoryDurable(path.dirname(backupPath), backupRoot);
        fs.copyFileSync(abs, backupPath);
        fsyncFileAndParent(backupPath);
        const backupFingerprint = fingerprintBackupFile(backupPath);
        const backupDifferingFields = fingerprintDifferingFields(before, backupFingerprint);
        if (backupDifferingFields.length > 0) {
          const backupError = new Error(`backup_copy_verification_failed:${rel}`);
          backupError.transaction_details = {
            rel: boundedIdentityText(rel),
            differing_fields: backupDifferingFields,
            expected: before,
            actual: backupFingerprint,
          };
          throw backupError;
        }
        backups.push(toRel(root, backupPath));
        journal.backed_up_files.push({
          target_rel: rel,
          backup_rel: toRel(backupRoot, backupPath),
          fingerprint: backupFingerprint,
        });
      }
    }
    const lockedBeforeWriteContext = createInspectionContext(root, { phase: "locked_before_write" });
    const lockedBeforeWrite = verifyTargetFingerprints(
      root,
      preflight.beforeFingerprints,
      "locked_before_write",
      lockedBeforeWriteContext,
    );
    const lockedBeforeWriteSeal = lockedBeforeWriteContext.seal();
    if (!lockedBeforeWrite.ok || !lockedBeforeWriteSeal.ok) {
      const driftError = new Error(`locked_before_write_target_drift:${lockedBeforeWrite.mismatches.map((item) => item.rel).join(",")}`);
      driftError.transaction_details = {
        ...lockedBeforeWrite,
        inspection_epoch_seal: lockedBeforeWriteSeal,
      };
      throw driftError;
    }
    for (const tempRel of Object.values(targetTempRels)) {
      if (lstatIfPresent(path.join(root, tempRel))) {
        throw new Error(`transaction_temp_path_preexisting:${tempRel}`);
      }
    }
    journal = persistTransactionJournal(backupRoot, { ...journal, state: "prepared" });
    backupManifestDigest = journal.manifest_digest;
    writesStarted = true;
    for (const record of journal.directory_records) {
      const abs = path.join(root, record.rel);
      if (lstatIfPresent(abs)) throw new Error(`transaction_created_directory_no_longer_absent:${record.rel}`);
      const parent = path.dirname(abs);
      const parentStat = fs.lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error(`transaction_created_directory_parent_not_plain_directory:${record.rel}`);
      }
      fs.mkdirSync(abs);
      fsyncDirectoryBestEffort(parent);
      fsyncDirectoryBestEffort(abs);
      const createdStat = fs.lstatSync(abs, { bigint: true });
      const createdRecord = {
        rel: record.rel,
        state: "created",
        identity: fsObjectIdentity(createdStat),
      };
      createdDirectories.push(createdRecord);
      journal = persistTransactionJournal(backupRoot, {
        ...journal,
        directory_records: journal.directory_records.map((item) => (
          item.rel === record.rel ? createdRecord : item
        )),
      });
      backupManifestDigest = journal.manifest_digest;
    }
    for (const prepared of preflight.preparedWrites.values()) {
      const rel = prepared.rel;
      const abs = path.join(root, rel);
      const before = preflight.beforeFingerprints[rel];
      if (prepared.final_kind === "directory") {
        if (before.kind === "directory") unchanged.push(rel);
        else {
          const createdRecord = journal.directory_records.find((item) => item.rel === rel && item.state === "created");
          if (!createdRecord) throw new Error(`transaction_created_directory_record_missing:${rel}`);
          changed.push(rel);
        }
      } else if (prepared.final_kind === "file") {
        const prewriteContext = createInspectionContext(root, { phase: `prewrite_target:${rel}` });
        const prewrite = verifyTargetFingerprints(
          root,
          { [rel]: before },
          `prewrite_target:${rel}`,
          prewriteContext,
        );
        const prewriteSeal = prewriteContext.seal();
        if (!prewrite.ok || !prewriteSeal.ok) {
          const error = new Error(`prewrite_target_drift:${rel}`);
          error.transaction_details = {
            ...prewrite,
            inspection_epoch_seal: prewriteSeal,
          };
          throw error;
        }
        writeAtomic(abs, prepared.exact_final_bytes, {
          tempPath: path.join(root, targetTempRels[rel]),
          durable: true,
          ensureParent: false,
          transactionBound: true,
        });
        if (canonicalJson(before) === canonicalJson(prepared.expected_after_fingerprint)) unchanged.push(rel);
        else changed.push(rel);
      } else {
        throw new Error(`prepared_write_kind_invalid:${rel}:${prepared.final_kind}`);
      }
    }

    const postwriteContext = createInspectionContext(root, { phase: "postwrite" });
    const postwrite = verifyTargetFingerprints(
      root,
      preflight.predictedTargetFingerprints,
      "postwrite",
      postwriteContext,
    );
    if (!postwrite.ok) {
      const error = new Error(`postwrite_target_mismatch:${postwrite.mismatches.map((item) => item.rel).join(",")}`);
      error.transaction_details = postwrite;
      throw error;
    }
    const validation = inspectProject(root, { context: postwriteContext, phase: "postwrite" });
    const actualValidationDigest = canonicalDigest(validation.decision_snapshot);
    const actualTransition = evaluateValidationTransition(
      preflight.baselineValidation,
      validation.decision_snapshot,
      {
        actions: compiled.actions,
        changed_paths: changedTargetPaths(preflight.beforeFingerprints, preflight.predictedTargetFingerprints),
        before_semantic_declaration: preflight.baselineReport.semantic_declaration,
        after_semantic_declaration: validation.semantic_declaration,
      },
    );
    if (!actualTransition.transition_ok) {
      const error = new Error(`post_apply_transition_rejected:${actualTransition.rejection_codes.join(",")}`);
      error.transaction_details = { actual_transition: actualTransition };
      throw error;
    }
    const finalTargets = verifyTargetFingerprints(root, preflight.predictedTargetFingerprints, "precommit_final");
    if (!finalTargets.ok) {
      const error = new Error(`precommit_target_drift:${finalTargets.mismatches.map((item) => item.rel).join(",")}`);
      error.transaction_details = finalTargets;
      throw error;
    }
    const postwriteSeal = postwriteContext.seal();
    if (!postwriteSeal.ok) {
      const error = new Error(`inspection_epoch_drift:${postwriteSeal.issues.map((item) => item.rel).join(",")}`);
      error.transaction_details = { inspection_epoch_seal: postwriteSeal };
      throw error;
    }
    if (
      actualValidationDigest !== preflight.predictedDigest
      || canonicalJson(validation.decision_snapshot) !== canonicalJson(preflight.predictedValidation)
    ) {
      const error = new Error("post_apply_predicted_validation_mismatch");
      error.transaction_details = {
        predicted_validation_digest: preflight.predictedDigest,
        actual_validation_digest: actualValidationDigest,
      };
      throw error;
    }

    try {
      journal = persistTransactionJournal(backupRoot, {
        ...journal,
        state: "commit_verified",
        actual_validation_digest: actualValidationDigest,
      });
    } catch (commitJournalError) {
      commitJournalError.transaction_commit_ambiguous = true;
      commitJournalError.transaction_details = {
        state: "commit_journal_persistence_ambiguous",
        rename_completed: commitJournalError.atomic_rename_completed === true,
      };
      throw commitJournalError;
    }
    backupManifestDigest = journal.manifest_digest;
    return {
      ok: true,
      tool: SCRIPT_NAME,
      command: "apply",
      root,
      plan_id: compiled.plan_id,
      changed: [...new Set(changed)],
      unchanged: [...new Set(unchanged)],
      backups_retained: backups,
      warnings: [
        ...(validation.coverage_complete
          ? []
          : validation.coverage_issues.map((code) => `post_apply_coverage_incomplete:${code}`)),
      ],
      rolled_back: false,
      rollback_attempted: false,
      rollback_complete: false,
      rollback_incomplete: false,
      transaction_verification: {
        baseline_digest_locked: preflight.baselineDigest,
        before_targets: preflight.beforeFingerprints,
        predicted_targets: preflight.predictedTargetFingerprints,
        actual_targets_postwrite: postwrite.actual,
        postwrite_match: true,
        actual_validation_digest: actualValidationDigest,
        transition_ok: true,
        prepared_target_keys: [...preflight.preparedWrites.keys()],
        inspection_epoch_seals: {
          apply_preflight: preflight.inspectionEpochSeal,
          locked_before_write: lockedBeforeWriteSeal,
          postwrite: postwriteSeal,
        },
      },
      validation: validationSummary(validation),
      _transaction: {
        backup_root: backupRoot,
        transaction_id: transactionId,
        plan_id: compiled.plan_id,
        backups,
        backup_base_created: backupBaseCreatedByTransaction,
        terminal_state: "commit_verified",
      },
    };
  } catch (error) {
    const commitAmbiguous = error.transaction_commit_ambiguous === true;
    let rollback = writesStarted && !commitAmbiguous
      ? restoreAndVerifyTransaction(
        root,
        preflight,
        backupRoot,
        createdDirectories,
        targetTempRels,
      )
      : {
        attempted: false,
        complete: false,
        incomplete: commitAmbiguous,
        operational_error_count: 0,
        operational_errors_truncated: false,
        operational_errors: [],
        mismatch_count: 0,
        mismatches_truncated: false,
        mismatches: [],
        targets_after: {},
        baseline_digest_after: null,
        validation_summary: null,
      };
    if (!commitAmbiguous && (rollback.complete || !writesStarted) && journal) {
      try {
        journal = persistTransactionJournal(backupRoot, { ...journal, state: "rollback_verified" });
        backupManifestDigest = journal.manifest_digest;
      } catch (journalError) {
        if (writesStarted) {
          const operationalErrors = [
            ...(rollback.operational_errors || []),
            { rel: null, error: `rollback_terminal_journal_failed:${formatFsError(journalError)}` },
          ];
          rollback = {
            ...rollback,
            complete: false,
            incomplete: true,
            operational_error_count: operationalErrors.length,
            operational_errors_truncated: operationalErrors.length > MAX_STRUCTURE_ISSUES,
            operational_errors: operationalErrors.slice(0, MAX_STRUCTURE_ISSUES),
          };
        }
      }
    }
    return {
      ok: false,
      tool: SCRIPT_NAME,
      command: "apply",
      root,
      plan_id: compiled.plan_id,
      error: boundedIdentityText(error.message || String(error), 4096),
      transaction_error_details: error.transaction_details || null,
      changed_before_rollback: [...new Set(changed)],
      backups_retained: backups,
      warnings: [
        ...(rollback.validation_summary ? [] : ["postrollback_validation_unavailable"]),
      ],
      rollback_attempted: rollback.attempted,
      rolled_back: rollback.complete,
      rollback_complete: rollback.complete,
      rollback_incomplete: rollback.incomplete,
      rollback_error_count: rollback.operational_error_count,
      rollback_errors_truncated: rollback.operational_errors_truncated,
      rollback_errors: rollback.operational_errors,
      rollback_mismatch_count: rollback.mismatch_count,
      rollback_mismatches_truncated: rollback.mismatches_truncated,
      rollback_mismatches: rollback.mismatches,
      rollback_ownership_check: rollback.ownership_check || null,
      transaction_verification: {
        baseline_digest_locked: preflight.baselineDigest,
        before_targets: preflight.beforeFingerprints,
        predicted_targets: preflight.predictedTargetFingerprints,
        actual_targets_postwrite: error.transaction_details?.actual || null,
        postwrite_match: false,
        actual_validation_digest: null,
        transition_ok: false,
        prepared_target_keys: [...preflight.preparedWrites.keys()],
        rollback: {
          attempted: rollback.attempted,
          rolled_back: rollback.complete,
          targets_after: rollback.targets_after,
          baseline_digest_after: rollback.baseline_digest_after,
          complete: rollback.complete,
          incomplete: rollback.incomplete,
          mismatch_count: rollback.mismatch_count,
          mismatches_truncated: rollback.mismatches_truncated,
          mismatches: rollback.mismatches,
          ownership_check: rollback.ownership_check || null,
          backup_preserved: rollback.incomplete,
          backup_manifest_digest: backupManifestDigest,
        },
      },
      validation: rollback.validation_summary,
      _transaction: {
        backup_root: backupRoot,
        transaction_id: transactionId,
        plan_id: compiled.plan_id,
        backups,
        backup_base_created: backupBaseCreatedByTransaction,
        terminal_state: rollback.complete || !writesStarted ? "rollback_verified" : "prepared",
      },
    };
  }
}

function detectCompiledPlanAlreadyApplied(root, compiled) {
  const context = createInspectionContext(root, { phase: "already_applied_probe" });
  const targets = verifyTargetFingerprints(
    root,
    compiled.predicted_target_fingerprints,
    "already_applied_probe",
    context,
  );
  if (!targets.ok) return null;
  let validation;
  try {
    validation = inspectProject(root, { context, phase: "already_applied_probe" });
  } catch {
    return null;
  }
  const validationDigest = canonicalDigest(validation.decision_snapshot);
  if (
    validationDigest !== compiled.predicted_validation_digest
    || canonicalJson(validation.decision_snapshot) !== canonicalJson(compiled.predicted_validation)
  ) return null;
  const seal = context.seal();
  if (!seal.ok) return null;
  return {
    ok: true,
    tool: SCRIPT_NAME,
    command: "apply",
    root,
    plan_id: compiled.plan_id,
    already_applied: true,
    changed: [],
    unchanged: Object.keys(compiled.predicted_target_fingerprints).sort(),
    backups_retained: [],
    warnings: [],
    rolled_back: false,
    rollback_attempted: false,
    rollback_complete: false,
    rollback_incomplete: false,
    transaction_verification: {
      baseline_digest_locked: compiled.baseline_validation_digest,
      before_targets: compiled.before_fingerprints,
      predicted_targets: compiled.predicted_target_fingerprints,
      actual_targets_postwrite: targets.actual,
      postwrite_match: true,
      actual_validation_digest: validationDigest,
      transition_ok: true,
      prepared_target_keys: Object.keys(compiled.predicted_target_fingerprints).sort(),
      inspection_epoch_seals: { already_applied_probe: seal },
    },
    validation: validationSummary(validation),
  };
}

function planTransactionCreatedDirectories(root, preflight) {
  const directories = new Set();
  for (const prepared of preflight.preparedWrites.values()) {
    const candidates = [];
    if (prepared.final_kind === "directory") candidates.push(prepared.rel);
    let current = prepared.final_kind === "directory"
      ? path.posix.dirname(prepared.rel)
      : path.posix.dirname(prepared.rel);
    while (current && current !== ".") {
      candidates.push(current);
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const rel of candidates) {
      const checked = validateRelativePath(root, rel);
      if (!checked.ok) fail(`transaction_created_directory_path_invalid:${rel}:${checked.error}`, 3);
      const stat = lstatIfPresent(path.join(root, rel));
      if (!stat) directories.add(rel);
      else if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`transaction_created_directory_parent_not_plain_directory:${rel}`, 3);
      }
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right, "en");
  });
}

function persistTransactionJournal(backupRoot, value) {
  const payload = { ...value };
  delete payload.manifest_digest;
  const journal = { ...payload, manifest_digest: canonicalDigest(payload) };
  writeAtomicDurable(
    path.join(backupRoot, TRANSACTION_JOURNAL_FILE),
    `${JSON.stringify(journal, null, 2)}\n`,
    { tempPath: path.join(backupRoot, `${TRANSACTION_JOURNAL_FILE}.tmp-${value.transaction_id}`) },
  );
  return journal;
}

function fingerprintDifferingFields(expected, actual) {
  const fields = [];
  for (const field of ["exists", "kind", "bytes", "sha256"]) {
    if (expected?.[field] !== actual?.[field]) fields.push(field);
  }
  return fields;
}

function fingerprintBackupFile(abs) {
  const stat = fs.lstatSync(abs);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, kind: statKind(stat), bytes: null, sha256: null };
  }
  return {
    exists: true,
    kind: "file",
    bytes: stat.size,
    sha256: sha256FileChunked(abs, fs, stat),
  };
}

function removeTransactionTempFile(abs, expectedFingerprints, options = {}) {
  const quarantine = `${abs}.quarantine`;
  const existingQuarantine = lstatIfPresent(quarantine);
  let stat = lstatIfPresent(abs);
  if (stat && existingQuarantine) throw new Error("rollback_transaction_temp_and_quarantine_both_exist");
  if (!stat && existingQuarantine) {
    if (!existingQuarantine.isFile() || existingQuarantine.isSymbolicLink()) {
      throw new Error("rollback_transaction_temp_quarantine_is_not_plain_file");
    }
    fs.renameSync(quarantine, abs);
    const restored = fs.lstatSync(abs);
    if (!sameFsObjectIdentity(existingQuarantine, restored)) {
      throw new Error("rollback_transaction_temp_quarantine_identity_changed");
    }
    fsyncDirectoryBestEffort(path.dirname(abs));
    stat = restored;
  }
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("rollback_transaction_temp_is_not_plain_file");
  }
  const actual = fingerprintBackupFile(abs);
  const allowed = options.journal_bound === true || (expectedFingerprints || []).some((expected) => (
    isPlainObject(expected) && canonicalJson(actual) === canonicalJson(expected)
  ));
  if (!allowed) throw new Error("rollback_transaction_temp_fingerprint_unowned");
  try {
    fs.renameSync(abs, quarantine);
    fsyncDirectoryBestEffort(path.dirname(abs));
    const moved = fs.lstatSync(quarantine);
    if (!sameFsObjectIdentity(stat, moved)) throw new Error("rollback_transaction_temp_identity_changed");
    const movedFingerprint = fingerprintBackupFile(quarantine);
    if (canonicalJson(actual) !== canonicalJson(movedFingerprint)) {
      throw new Error("rollback_transaction_temp_content_changed_during_cleanup");
    }
    fs.unlinkSync(quarantine);
    fsyncDirectoryBestEffort(path.dirname(abs));
  } catch (error) {
    // Keep the deterministic quarantine in place; the next recovery can resume cleanup.
    throw error;
  }
}

function copyFileAtomicDurable(source, target, tempPath) {
  let created = false;
  let createdStat = null;
  try {
    fs.copyFileSync(source, tempPath, fs.constants.COPYFILE_EXCL);
    created = true;
    createdStat = fs.lstatSync(tempPath, { bigint: true });
    if (!createdStat.isFile() || createdStat.isSymbolicLink()) {
      throw new Error("rollback_restore_temp_not_plain_file");
    }
    fsyncFileAndParent(tempPath);
    fs.renameSync(tempPath, target);
    created = false;
    const finalStat = fs.lstatSync(target, { bigint: true });
    if (!sameFsObjectIdentity(createdStat, finalStat)) throw new Error("rollback_restore_target_identity_changed_after_rename");
    fsyncDirectoryBestEffort(path.dirname(target));
  } catch (error) {
    if (created && createdStat) {
      try {
        removeTransactionTempFile(tempPath, [], { journal_bound: true });
      } catch {
        // The caller reports the original restore failure and retains the transaction fence.
      }
    }
    throw error;
  }
}

function fsyncFileAndParent(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, "r+");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fsyncDirectoryBestEffort(path.dirname(abs));
}

function verifyTargetFingerprints(
  root,
  expectedMap,
  phase,
  context = createInspectionContext(root, { phase }),
) {
  const actual = {};
  const mismatches = [];
  for (const rel of Object.keys(expectedMap).sort((left, right) => left.localeCompare(right, "en"))) {
    try {
      actual[rel] = context.fingerprint(rel);
      const differingFields = fingerprintDifferingFields(expectedMap[rel], actual[rel]);
      if (differingFields.length > 0) mismatches.push({ rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS), differing_fields: differingFields });
    } catch (error) {
      mismatches.push({
        rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS),
        differing_fields: ["read"],
        error: limitText(formatFsError(error), MAX_STRUCTURE_DETAIL_CHARS),
      });
    }
  }
  const mismatchCount = mismatches.length;
  return {
    ok: mismatchCount === 0,
    phase,
    actual,
    mismatch_count: mismatchCount,
    mismatches_truncated: mismatchCount > MAX_STRUCTURE_ISSUES,
    mismatches: mismatches.slice(0, MAX_STRUCTURE_ISSUES),
  };
}

function restoreTouchedTargets(root, preflight, backupRoot, createdDirectories, targetTempRels = {}) {
  const operationalErrors = [];
  for (const rel of [...preflight.touched].reverse()) {
    const abs = path.join(root, rel);
    const before = preflight.beforeFingerprints[rel];
    try {
      const tempRel = targetTempRels[rel];
      if (tempRel) {
        removeTransactionTempFile(path.join(root, tempRel), [
          preflight.beforeFingerprints[rel],
          preflight.predictedTargetFingerprints[rel],
        ], { journal_bound: true });
      }
      const current = lstatIfPresent(abs);
      const currentKind = statKind(current);
      if (before.kind === "file") {
        if (currentKind === "directory") fs.rmdirSync(abs);
        else if (!["absent", "file"].includes(currentKind)) fs.unlinkSync(abs);
        ensureDirectoryDurable(path.dirname(abs), root);
        if (!tempRel) throw new Error("rollback_transaction_temp_path_missing");
        copyFileAtomicDurable(path.join(backupRoot, rel), abs, path.join(root, tempRel));
      } else if (before.kind === "directory") {
        if (currentKind === "file" || currentKind === "symlink" || currentKind === "other") fs.unlinkSync(abs);
        if (!fs.existsSync(abs)) fs.mkdirSync(abs);
      } else if (before.kind === "absent" && currentKind !== "absent") {
        if (currentKind === "directory") fs.rmdirSync(abs);
        else fs.unlinkSync(abs);
      }
    } catch (restoreError) {
      operationalErrors.push({ rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS), error: limitText(formatFsError(restoreError), MAX_STRUCTURE_DETAIL_CHARS) });
    }
  }
  for (const [targetRel, rel] of Object.entries(targetTempRels)) {
    const abs = path.join(root, rel);
    const current = lstatIfPresent(abs);
    if (!current) continue;
    try {
      removeTransactionTempFile(abs, [
        preflight.beforeFingerprints[targetRel],
        preflight.predictedTargetFingerprints[targetRel],
      ], { journal_bound: true });
    } catch (tempError) {
      operationalErrors.push({
        rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS),
        error: limitText(formatFsError(tempError), MAX_STRUCTURE_DETAIL_CHARS),
      });
    }
  }
  const directories = [...new Map((createdDirectories || []).map((item) => [item.rel, item])).values()]
    .sort((left, right) => right.rel.split("/").length - left.rel.split("/").length);
  for (const record of directories) {
    const rel = record.rel;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const current = fs.lstatSync(abs, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("rollback_created_directory_is_not_plain_directory");
      if (!statMatchesFsObjectIdentity(current, record.identity)) {
        throw new Error("rollback_created_directory_identity_changed");
      }
      fs.rmdirSync(abs);
      fsyncDirectoryBestEffort(path.dirname(abs));
    } catch (directoryError) {
      operationalErrors.push({ rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS), error: limitText(formatFsError(directoryError), MAX_STRUCTURE_DETAIL_CHARS) });
    }
  }
  return operationalErrors;
}

function restoreAndVerifyTransaction(root, preflight, backupRoot, createdDirectories, targetTempRels = {}) {
  try {
    const ownership = verifyImmediateRollbackTargetOwnership(root, preflight);
    if (!ownership.ok) {
      return {
        attempted: true,
        complete: false,
        incomplete: true,
        operational_error_count: 0,
        operational_errors_truncated: false,
        operational_errors: [],
        mismatch_count: ownership.mismatch_count,
        mismatches_truncated: ownership.mismatches_truncated,
        mismatches: ownership.mismatches,
        targets_after: ownership.actual_targets,
        baseline_digest_after: null,
        validation_summary: null,
        ownership_check: ownership,
      };
    }
    return restoreAndVerifyTransactionUnchecked(
      root,
      preflight,
      backupRoot,
      createdDirectories,
      targetTempRels,
    );
  } catch (error) {
    return {
      attempted: true,
      complete: false,
      incomplete: true,
      operational_error_count: 1,
      operational_errors_truncated: false,
      operational_errors: [{ rel: null, error: `rollback_unhandled_error:${formatFsError(error)}` }],
      mismatch_count: 0,
      mismatches_truncated: false,
      mismatches: [],
      targets_after: {},
      baseline_digest_after: null,
      validation_summary: null,
    };
  }
}

function verifyImmediateRollbackTargetOwnership(root, preflight) {
  const context = createInspectionContext(root, { phase: "immediate_rollback_ownership" });
  const actualTargets = {};
  const mismatches = [];
  for (const rel of [...preflight.touched].sort((left, right) => left.localeCompare(right, "en"))) {
    let actual;
    try {
      actual = context.fingerprint(rel);
      actualTargets[rel] = actual;
    } catch (error) {
      mismatches.push({
        rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS),
        differing_fields: ["read"],
        error: `rollback_ownership_read_failed:${limitText(formatFsError(error), MAX_STRUCTURE_DETAIL_CHARS)}`,
      });
      continue;
    }
    const before = preflight.beforeFingerprints[rel];
    const predicted = preflight.predictedTargetFingerprints[rel];
    const matchesBefore = canonicalJson(actual) === canonicalJson(before);
    const matchesPredicted = canonicalJson(actual) === canonicalJson(predicted);
    if (!matchesBefore && !matchesPredicted) {
      mismatches.push({
        rel: limitText(rel, MAX_STRUCTURE_DETAIL_CHARS),
        differing_fields: [...new Set([
          ...fingerprintDifferingFields(before, actual),
          ...fingerprintDifferingFields(predicted, actual),
        ])],
        error: "rollback_target_third_party_state",
      });
    }
  }
  const seal = context.seal();
  if (!seal.ok) {
    mismatches.push({
      rel: null,
      differing_fields: ["inspection_epoch"],
      error: "rollback_ownership_inspection_epoch_drift",
    });
  }
  const mismatchCount = mismatches.length;
  return {
    ok: mismatchCount === 0,
    phase: "immediate_rollback_ownership",
    actual_targets: actualTargets,
    mismatch_count: mismatchCount,
    mismatches_truncated: mismatchCount > MAX_STRUCTURE_ISSUES,
    mismatches: mismatches.slice(0, MAX_STRUCTURE_ISSUES),
    inspection_epoch_seal: seal,
  };
}

function restoreAndVerifyTransactionUnchecked(root, preflight, backupRoot, createdDirectories, targetTempRels = {}) {
  const allOperationalErrors = restoreTouchedTargets(
    root,
    preflight,
    backupRoot,
    createdDirectories,
    targetTempRels,
  );
  const rollbackContext = createInspectionContext(root, { phase: "postrollback" });
  const targetVerification = verifyTargetFingerprints(
    root,
    preflight.beforeFingerprints,
    "postrollback",
    rollbackContext,
  );
  let baselineDigestAfter = null;
  let rollbackReport = null;
  const additionalMismatches = [];
  try {
    rollbackReport = inspectProject(root, { context: rollbackContext, phase: "postrollback" });
    baselineDigestAfter = canonicalDigest(rollbackReport.decision_snapshot);
    if (baselineDigestAfter !== preflight.baselineDigest) {
      additionalMismatches.push({ rel: null, differing_fields: ["baseline_digest"], error: "baseline_digest_mismatch" });
    }
    const rollbackSeal = rollbackContext.seal();
    if (!rollbackSeal.ok) {
      additionalMismatches.push({
        rel: null,
        differing_fields: ["inspection_epoch"],
        error: "inspection_epoch_drift",
        inspection_epoch_seal: rollbackSeal,
      });
    }
  } catch (verificationError) {
    additionalMismatches.push({
      rel: null,
      differing_fields: ["baseline_read"],
      error: limitText(formatFsError(verificationError), MAX_STRUCTURE_DETAIL_CHARS),
    });
  }
  const mismatchCount = Number(targetVerification.mismatch_count || 0) + additionalMismatches.length;
  const mismatches = [...targetVerification.mismatches, ...additionalMismatches].slice(0, MAX_STRUCTURE_ISSUES);
  const complete = allOperationalErrors.length === 0 && mismatchCount === 0;
  return {
    attempted: true,
    complete,
    incomplete: !complete,
    operational_error_count: allOperationalErrors.length,
    operational_errors_truncated: allOperationalErrors.length > MAX_STRUCTURE_ISSUES,
    operational_errors: allOperationalErrors.slice(0, MAX_STRUCTURE_ISSUES),
    mismatch_count: mismatchCount,
    mismatches_truncated: mismatchCount > mismatches.length,
    mismatches,
    targets_after: targetVerification.actual,
    baseline_digest_after: baselineDigestAfter,
    validation_summary: rollbackReport ? validationSummary(rollbackReport) : null,
  };
}

function recoverStaleApplyTransaction(root, lock) {
  if (
    lock.schema_version !== APPLY_LOCK_SCHEMA_VERSION
    || lock.tool !== SCRIPT_NAME
    || lock.kind !== "apply_lock"
  ) {
    return { ok: false, error: "legacy_stale_transaction_unrecoverable" };
  }
  if (!UUID_REGEX.test(lock.owner_id || "")) return { ok: false, error: "stale_transaction_owner_id_invalid" };
  const backupBase = path.resolve(root, ".project-gov", "backups");
  const backupRoot = path.resolve(backupBase, `txn-${lock.owner_id}`);
  if (
    path.dirname(backupRoot) !== backupBase
    || path.basename(backupRoot) !== `txn-${lock.owner_id}`
    || !isPathInside(backupBase, backupRoot)
  ) {
    return { ok: false, error: "stale_transaction_backup_path_not_exact_child" };
  }
  const backupRel = toRel(root, backupRoot);
  let lockPhase;
  try {
    lockPhase = readApplyLockPhase(lock, path.join(root, ".project-gov", "apply.lock"));
  } catch (error) {
    return { ok: false, error: `stale_transaction_phase_unreadable:${formatFsError(error)}` };
  }
  const backupStat = lstatIfPresent(backupRoot);
  if (!backupStat) {
    if (lockPhase.phase !== "acquired") {
      return { ok: false, error: "stale_transaction_backup_missing_after_backup_start" };
    }
    return {
      ok: true,
      recovered: true,
      terminal_state: "no_transaction_backup",
      backup_root: null,
      transaction_id: lock.owner_id,
      plan_id: lock.plan_id,
    };
  }
  if (lockPhase.phase === "acquired") {
    return { ok: false, error: "stale_transaction_backup_occupied_before_backup_start" };
  }
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    return { ok: false, error: `stale_transaction_backup_not_plain_directory:${backupRel}` };
  }
  const pathCheck = validateExistingPathNotRedirected(root, backupRoot);
  if (!pathCheck.ok) return { ok: false, error: `stale_transaction_backup_redirected:${pathCheck.error}` };
  const ownerPath = path.join(backupRoot, BACKUP_OWNER_FILE);
  const ownerTempPath = path.join(backupRoot, `${BACKUP_OWNER_FILE}.tmp-${lock.owner_id}`);
  const ownerCleanupResume = resumeOwnedMetadataTempCleanup(ownerTempPath);
  if (!ownerCleanupResume.ok) return ownerCleanupResume;
  if (!lstatIfPresent(ownerPath)) {
    const entries = readDirectoryEntriesBounded(
      backupRoot,
      MAX_TRANSACTION_EARLY_DIRECTORY_ENTRIES,
      "stale_transaction_owner_directory",
    );
    if (entries.length === 0) {
      writeAtomicDurable(ownerPath, `${JSON.stringify({
        schema_version: TRANSACTION_JOURNAL_SCHEMA_VERSION,
        tool: SCRIPT_NAME,
        kind: "transaction_backup",
        root,
        plan_id: lock.plan_id,
        transaction_id: lock.owner_id,
        created_at: lock.created_at,
      }, null, 2)}\n`, { tempPath: ownerTempPath });
    } else if (canonicalJson(entries) === canonicalJson([path.basename(ownerTempPath)])) {
      const tempOwner = validateTransactionBackupOwner(
        root,
        backupRoot,
        lock.owner_id,
        lock.plan_id,
        ownerTempPath,
      );
      if (tempOwner.ok) {
        const promoted = promoteOwnedMetadataTemp(ownerTempPath, ownerPath);
        if (!promoted.ok) return promoted;
      } else {
        const removed = removeOwnedMetadataTemp(ownerTempPath);
        if (!removed.ok) return removed;
        writeAtomicDurable(ownerPath, `${JSON.stringify({
          schema_version: TRANSACTION_JOURNAL_SCHEMA_VERSION,
          tool: SCRIPT_NAME,
          kind: "transaction_backup",
          root,
          plan_id: lock.plan_id,
          transaction_id: lock.owner_id,
          created_at: lock.created_at,
        }, null, 2)}\n`, { tempPath: ownerTempPath });
      }
    } else {
      return { ok: false, error: "stale_transaction_owner_missing_with_unverified_artifacts" };
    }
  } else if (lstatIfPresent(ownerTempPath)) {
    const removed = removeOwnedMetadataTemp(ownerTempPath);
    if (!removed.ok) return removed;
  }
  const ownerCheck = validateTransactionBackupOwner(root, backupRoot, lock.owner_id, lock.plan_id);
  if (!ownerCheck.ok) return { ok: false, error: ownerCheck.error };

  const journalPath = path.join(backupRoot, TRANSACTION_JOURNAL_FILE);
  const journalTempPath = path.join(backupRoot, `${TRANSACTION_JOURNAL_FILE}.tmp-${lock.owner_id}`);
  const journalCleanupResume = resumeOwnedMetadataTempCleanup(journalTempPath);
  if (!journalCleanupResume.ok) return journalCleanupResume;
  if (!lstatIfPresent(journalPath)) {
    if (lstatIfPresent(journalTempPath)) {
      const tempChecked = validateTransactionJournal(root, backupRoot, lock, journalTempPath);
      if (tempChecked.ok) {
        const promoted = promoteOwnedMetadataTemp(journalTempPath, journalPath);
        if (!promoted.ok) return promoted;
      } else {
        const entries = readDirectoryEntriesBounded(
          backupRoot,
          MAX_TRANSACTION_EARLY_DIRECTORY_ENTRIES,
          "stale_transaction_journal_temp_directory",
        );
        const expected = [BACKUP_OWNER_FILE, path.basename(journalTempPath)].sort();
        if (canonicalJson(entries) !== canonicalJson(expected)) return tempChecked;
        const removed = removeOwnedMetadataTemp(journalTempPath);
        if (!removed.ok) return removed;
      }
    }
  } else if (lstatIfPresent(journalTempPath)) {
    const removed = removeOwnedMetadataTemp(journalTempPath);
    if (!removed.ok) return removed;
  }
  if (!lstatIfPresent(journalPath)) {
    const entries = readDirectoryEntriesBounded(
      backupRoot,
      MAX_TRANSACTION_EARLY_DIRECTORY_ENTRIES,
      "stale_transaction_journal_directory",
    );
    if (canonicalJson(entries) !== canonicalJson([BACKUP_OWNER_FILE])) {
      return { ok: false, error: "stale_transaction_journal_missing_with_unverified_artifacts" };
    }
    return {
      ok: true,
      recovered: true,
      terminal_state: "preparing_no_journal",
      backup_root: backupRoot,
      backup_base_created: false,
      transaction_id: lock.owner_id,
      plan_id: lock.plan_id,
    };
  }

  const checked = validateTransactionJournal(root, backupRoot, lock);
  if (!checked.ok) return checked;
  let journal = checked.journal;
  const preflight = {
    touched: journal.targets,
    beforeFingerprints: journal.before_fingerprints,
    predictedTargetFingerprints: journal.predicted_target_fingerprints,
    baselineDigest: journal.baseline_validation_digest,
  };

  if (journal.state === "preparing") {
    const directoryRecovery = analyzeInterruptedCreatedDirectories(root, journal);
    if (!directoryRecovery.ok) return directoryRecovery;
    const before = verifyRecoverySnapshot(
      root,
      journal.before_fingerprints,
      journal.baseline_validation_digest,
      "interrupted_preparing",
    );
    if (!before.ok) return { ok: false, error: before.error };
    journal = persistTransactionJournal(backupRoot, { ...journal, state: "rollback_verified" });
  } else if (journal.state === "prepared") {
    const directoryRecovery = analyzeInterruptedCreatedDirectories(root, journal);
    if (!directoryRecovery.ok) return directoryRecovery;
    const ownership = verifyInterruptedTransactionOwnedStates(root, journal);
    if (!ownership.ok) return ownership;
    const hypothetical = verifyHypotheticalRollbackBaseline(root, backupRoot, journal);
    if (!hypothetical.ok) return hypothetical;
    const rollback = restoreAndVerifyTransaction(
      root,
      preflight,
      backupRoot,
      directoryRecovery.recoverable,
      journal.target_temp_rels,
    );
    if (!rollback.complete) {
      return {
        ok: false,
        error: `interrupted_transaction_rollback_incomplete:${canonicalDigest({
          operational_errors: rollback.operational_errors,
          mismatches: rollback.mismatches,
        })}`,
      };
    }
    journal = persistTransactionJournal(backupRoot, { ...journal, state: "rollback_verified" });
  } else if (journal.state === "commit_verified") {
    const committed = verifyRecoverySnapshot(
      root,
      journal.predicted_target_fingerprints,
      journal.predicted_validation_digest,
      "interrupted_commit_verified",
    );
    if (!committed.ok) return { ok: false, error: committed.error };
  } else if (journal.state === "rollback_verified") {
    const rolledBack = verifyRecoverySnapshot(
      root,
      journal.before_fingerprints,
      journal.baseline_validation_digest,
      "interrupted_rollback_verified",
    );
    if (!rolledBack.ok) return { ok: false, error: rolledBack.error };
  }

  return {
    ok: true,
    recovered: true,
    terminal_state: journal.state,
    backup_root: backupRoot,
    transaction_id: lock.owner_id,
    plan_id: lock.plan_id,
    backup_base_created: journal.backup_base_created === true,
    journal_digest: journal.manifest_digest,
  };
}

function promoteOwnedMetadataTemp(tempPath, finalPath) {
  try {
    if (lstatIfPresent(finalPath)) return { ok: false, error: "transaction_metadata_final_path_occupied" };
    const before = fs.lstatSync(tempPath);
    if (!before.isFile() || before.isSymbolicLink()) return { ok: false, error: "transaction_metadata_temp_not_plain_file" };
    fs.renameSync(tempPath, finalPath);
    const after = fs.lstatSync(finalPath);
    if (!sameFsObjectIdentity(before, after)) return { ok: false, error: "transaction_metadata_identity_changed_during_promote" };
    fsyncDirectoryBestEffort(path.dirname(finalPath));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `transaction_metadata_promote_failed:${formatFsError(error)}` };
  }
}

function removeOwnedMetadataTemp(tempPath) {
  const resumed = resumeOwnedMetadataTempCleanup(tempPath);
  if (!resumed.ok) return resumed;
  const quarantine = `${tempPath}.cleanup`;
  try {
    const before = fs.lstatSync(tempPath);
    if (!before.isFile() || before.isSymbolicLink()) return { ok: false, error: "transaction_metadata_temp_not_plain_file" };
    fs.renameSync(tempPath, quarantine);
    fsyncDirectoryBestEffort(path.dirname(tempPath));
    const moved = fs.lstatSync(quarantine);
    if (!sameFsObjectIdentity(before, moved)) return { ok: false, error: "transaction_metadata_temp_identity_changed" };
    fs.unlinkSync(quarantine);
    fsyncDirectoryBestEffort(path.dirname(tempPath));
    return { ok: true };
  } catch (error) {
    // Keep the deterministic quarantine. A later recovery resumes it by exact path and identity.
    return { ok: false, error: `transaction_metadata_temp_cleanup_failed:${formatFsError(error)}` };
  }
}

function resumeOwnedMetadataTempCleanup(tempPath) {
  const quarantine = `${tempPath}.cleanup`;
  try {
    const canonical = lstatIfPresent(tempPath);
    const quarantined = lstatIfPresent(quarantine);
    if (canonical && quarantined) {
      return { ok: false, error: "transaction_metadata_temp_and_cleanup_both_exist" };
    }
    if (!quarantined) return { ok: true, resumed: false };
    if (!quarantined.isFile() || quarantined.isSymbolicLink()) {
      return { ok: false, error: "transaction_metadata_cleanup_not_plain_file" };
    }
    fs.renameSync(quarantine, tempPath);
    const restored = fs.lstatSync(tempPath);
    if (!sameFsObjectIdentity(quarantined, restored)) {
      return { ok: false, error: "transaction_metadata_cleanup_identity_changed" };
    }
    fsyncDirectoryBestEffort(path.dirname(tempPath));
    return { ok: true, resumed: true };
  } catch (error) {
    return { ok: false, error: `transaction_metadata_cleanup_resume_failed:${formatFsError(error)}` };
  }
}

function readDirectoryEntriesBounded(directory, maxEntries, label) {
  const entries = [];
  let handle;
  try {
    handle = fs.opendirSync(directory);
    while (entries.length <= maxEntries) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry.name);
    }
  } finally {
    if (handle) handle.closeSync();
  }
  if (entries.length > maxEntries) throw new Error(`${label}_too_many_entries`);
  return entries.sort();
}

function validateTransactionJournal(root, backupRoot, lock, journalPath = path.join(backupRoot, TRANSACTION_JOURNAL_FILE)) {
  try {
    return validateTransactionJournalUnchecked(root, backupRoot, lock, journalPath);
  } catch (error) {
    return { ok: false, error: `stale_transaction_journal_invalid:${formatFsError(error)}` };
  }
}

function validateTransactionJournalUnchecked(root, backupRoot, lock, journalPath) {
  let journal;
  try {
    journal = readPlainJsonFile(journalPath, "transaction_journal", MAX_TRANSACTION_JOURNAL_BYTES);
  } catch (error) {
    return { ok: false, error: formatFsError(error) };
  }
  const allowed = new Set([
    "schema_version",
    "tool",
    "kind",
    "root",
    "plan_id",
    "transaction_id",
    "state",
    "baseline_validation_digest",
    "predicted_validation_digest",
    "before_fingerprints",
    "predicted_target_fingerprints",
    "targets",
    "planned_created_directories",
    "directory_records",
    "target_temp_rels",
    "backup_base_created",
    "backed_up_files",
    "actual_validation_digest",
    "manifest_digest",
  ]);
  const violations = strictUnknownFields(journal, allowed, "transaction_journal");
  if (!isPlainObject(journal)) violations.push("transaction_journal_object_required");
  const payload = isPlainObject(journal) ? { ...journal } : {};
  delete payload.manifest_digest;
  if (
    typeof journal?.manifest_digest !== "string"
    || journal.manifest_digest !== canonicalDigest(payload)
  ) violations.push("transaction_journal_digest_mismatch");
  if (journal?.schema_version !== TRANSACTION_JOURNAL_SCHEMA_VERSION) violations.push("transaction_journal_schema_invalid");
  if (journal?.tool !== SCRIPT_NAME || journal?.kind !== "transaction_journal") violations.push("transaction_journal_identity_invalid");
  if (!sameResolvedPath(journal?.root || "", root)) violations.push("transaction_journal_root_mismatch");
  if (journal?.plan_id !== lock.plan_id || journal?.transaction_id !== lock.owner_id) violations.push("transaction_journal_owner_mismatch");
  if (!isNonEmptyString(journal?.plan_id) || utf8Bytes(journal.plan_id) > MAX_TRANSACTION_PLAN_ID_BYTES) {
    violations.push("transaction_journal_plan_id_invalid");
  }
  if (!UUID_REGEX.test(journal?.transaction_id || "")) violations.push("transaction_journal_transaction_id_invalid");
  if (!["preparing", "prepared", "commit_verified", "rollback_verified"].includes(journal?.state)) {
    violations.push("transaction_journal_state_invalid");
  }
  if (typeof journal?.backup_base_created !== "boolean") {
    violations.push("transaction_journal_backup_base_created_boolean_required");
  }
  if (journal?.state === "commit_verified") {
    if (
      typeof journal.actual_validation_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(journal.actual_validation_digest)
      || journal.actual_validation_digest !== journal.predicted_validation_digest
    ) violations.push("transaction_journal_commit_validation_digest_invalid");
  } else if (journal?.actual_validation_digest !== undefined) {
    violations.push("transaction_journal_actual_validation_digest_not_allowed_for_state");
  }
  for (const field of ["baseline_validation_digest", "predicted_validation_digest"]) {
    if (typeof journal?.[field] !== "string" || !/^[a-f0-9]{64}$/.test(journal[field])) {
      violations.push(`transaction_journal_${field}_invalid`);
    }
  }
  if (!Array.isArray(journal?.targets) || journal.targets.length === 0 || journal.targets.length > MAX_ACTIONS) {
    violations.push("transaction_journal_targets_non_empty_array_required");
  }
  const targets = Array.isArray(journal?.targets) ? journal.targets : [];
  if (
    targets.some((item) => !isNonEmptyString(item) || utf8Bytes(item) > MAX_TRANSACTION_PATH_BYTES)
    || new Set(targets).size !== targets.length
  ) {
    violations.push("transaction_journal_targets_invalid");
  }
  if (canonicalJson(targets) !== canonicalJson([...targets].sort((a, b) => a.localeCompare(b, "en")))) {
    violations.push("transaction_journal_targets_not_canonical");
  }
  for (const rel of targets) {
    const checked = validateRelativePath(root, rel);
    if (!checked.ok) violations.push(`transaction_journal_target_invalid:${rel}:${checked.error}`);
  }
  for (const [name, fingerprints] of [
    ["before_fingerprints", journal?.before_fingerprints],
    ["predicted_target_fingerprints", journal?.predicted_target_fingerprints],
  ]) {
    if (!isPlainObject(fingerprints)) {
      violations.push(`transaction_journal_${name}_object_required`);
      continue;
    }
    if (canonicalJson(Object.keys(fingerprints).sort()) !== canonicalJson(targets)) {
      violations.push(`transaction_journal_${name}_target_set_mismatch`);
    }
    for (const [rel, fingerprint] of Object.entries(fingerprints)) {
      validateFingerprintSchema(fingerprint, `transaction_journal_${name}:${rel}`, violations);
    }
  }

  const planned = Array.isArray(journal?.planned_created_directories)
    ? journal.planned_created_directories
    : [];
  if (!Array.isArray(journal?.planned_created_directories)) {
    violations.push("transaction_journal_planned_created_directories_array_required");
  }
  if (
    planned.length > MAX_TRANSACTION_CREATED_DIRECTORIES
    || planned.some((item) => !isNonEmptyString(item) || utf8Bytes(item) > MAX_TRANSACTION_PATH_BYTES)
    || new Set(planned).size !== planned.length
  ) {
    violations.push("transaction_journal_planned_created_directories_invalid");
  }
  for (const rel of planned) {
    const checked = validateRelativePath(root, rel);
    if (!checked.ok) violations.push(`transaction_journal_created_directory_invalid:${rel}:${checked.error}`);
    const ownsPath = targets.some((target) => target === rel || target.startsWith(`${rel}/`));
    if (!ownsPath) violations.push(`transaction_journal_created_directory_not_target_ancestor:${rel}`);
  }

  const directoryRecords = Array.isArray(journal?.directory_records) ? journal.directory_records : [];
  if (!Array.isArray(journal?.directory_records)) {
    violations.push("transaction_journal_directory_records_array_required");
  }
  if (directoryRecords.length > MAX_TRANSACTION_CREATED_DIRECTORIES) {
    violations.push("transaction_journal_directory_records_too_many");
  }
  const directoryRecordRels = [];
  for (const [index, record] of directoryRecords.entries()) {
    const prefix = `transaction_journal_directory_records[${index}]`;
    if (!isPlainObject(record)) {
      violations.push(`${prefix}_object_required`);
      continue;
    }
    violations.push(...strictUnknownFields(record, new Set(["rel", "state", "identity"]), prefix));
    if (!isNonEmptyString(record.rel) || utf8Bytes(record.rel) > MAX_TRANSACTION_PATH_BYTES) {
      violations.push(`${prefix}_rel_invalid`);
    } else directoryRecordRels.push(record.rel);
    if (!new Set(["intent", "created"]).has(record.state)) violations.push(`${prefix}_state_invalid`);
    if (record.state === "intent") {
      if (record.identity !== null) violations.push(`${prefix}_intent_identity_must_be_null`);
    } else if (!isFsObjectIdentity(record.identity)) {
      violations.push(`${prefix}_created_identity_invalid`);
    }
  }
  if (canonicalJson(directoryRecordRels) !== canonicalJson(planned)) {
    violations.push("transaction_journal_directory_records_not_bound_to_plan");
  }

  const targetTempRels = journal?.target_temp_rels;
  if (!isPlainObject(targetTempRels)) {
    violations.push("transaction_journal_target_temp_rels_object_required");
  } else {
    const expectedTempTargets = targets.filter((rel) => journal.predicted_target_fingerprints?.[rel]?.kind === "file").sort();
    if (Object.keys(targetTempRels).length > MAX_ACTIONS) violations.push("transaction_journal_target_temp_rels_too_many");
    if (canonicalJson(Object.keys(targetTempRels).sort()) !== canonicalJson(expectedTempTargets)) {
      violations.push("transaction_journal_target_temp_rels_target_set_mismatch");
    }
    for (const [rel, tempRel] of Object.entries(targetTempRels)) {
      const expected = `${rel}.tmp-project-gov-${lock.owner_id}`;
      if (tempRel !== expected) violations.push(`transaction_journal_target_temp_rel_invalid:${rel}`);
      if (!isNonEmptyString(tempRel) || utf8Bytes(tempRel) > MAX_TRANSACTION_PATH_BYTES) {
        violations.push(`transaction_journal_target_temp_rel_too_long:${rel}`);
      }
      const checked = validateRelativePath(root, tempRel);
      if (!checked.ok) violations.push(`transaction_journal_target_temp_path_invalid:${rel}:${checked.error}`);
    }
  }

  const backedUpFiles = Array.isArray(journal?.backed_up_files) ? journal.backed_up_files : [];
  if (!Array.isArray(journal?.backed_up_files)) violations.push("transaction_journal_backed_up_files_array_required");
  if (backedUpFiles.length > targets.length) violations.push("transaction_journal_backed_up_files_too_many");
  const requiredBackupTargets = targets.filter((rel) => journal.before_fingerprints?.[rel]?.kind === "file").sort();
  const seenBackupTargets = [];
  for (const entry of backedUpFiles) {
    if (!isPlainObject(entry)) {
      violations.push("transaction_journal_backup_entry_object_required");
      continue;
    }
    const entryAllowed = new Set(["target_rel", "backup_rel", "fingerprint"]);
    violations.push(...strictUnknownFields(entry, entryAllowed, "transaction_journal_backup_entry"));
    if (!targets.includes(entry.target_rel) || entry.backup_rel !== entry.target_rel) {
      violations.push(`transaction_journal_backup_entry_path_invalid:${entry.target_rel || "unknown"}`);
      continue;
    }
    seenBackupTargets.push(entry.target_rel);
    validateFingerprintSchema(entry.fingerprint, `transaction_journal_backup:${entry.target_rel}`, violations);
    if (canonicalJson(entry.fingerprint) !== canonicalJson(journal.before_fingerprints[entry.target_rel])) {
      violations.push(`transaction_journal_backup_fingerprint_binding_mismatch:${entry.target_rel}`);
    }
    if (journal?.state === "prepared") {
      const backupPath = path.join(backupRoot, entry.backup_rel);
      const checked = validateExistingPathNotRedirected(backupRoot, backupPath);
      if (!checked.ok) {
        violations.push(`transaction_journal_backup_path_redirected:${entry.target_rel}`);
        continue;
      }
      try {
        const actual = fingerprintBackupFile(backupPath);
        if (canonicalJson(actual) !== canonicalJson(entry.fingerprint)) {
          violations.push(`transaction_journal_backup_content_mismatch:${entry.target_rel}`);
        }
      } catch (error) {
        violations.push(`transaction_journal_backup_unreadable:${entry.target_rel}:${formatFsError(error)}`);
      }
    }
  }
  if (new Set(seenBackupTargets).size !== seenBackupTargets.length) {
    violations.push("transaction_journal_backup_targets_duplicate");
  }
  const canonicalSeen = [...new Set(seenBackupTargets)].sort();
  if (["preparing", "rollback_verified"].includes(journal?.state)) {
    if (canonicalSeen.some((rel) => !requiredBackupTargets.includes(rel))) {
      violations.push("transaction_journal_preparing_backup_set_invalid");
    }
  } else if (canonicalJson(canonicalSeen) !== canonicalJson(requiredBackupTargets)) {
    violations.push("transaction_journal_backup_set_incomplete");
  }

  return violations.length > 0
    ? { ok: false, error: `stale_transaction_journal_invalid:${[...new Set(violations)].slice(0, 20).join("|")}` }
    : { ok: true, journal };
}

function verifyRecoverySnapshot(root, expectedTargets, expectedDigest, phase) {
  const context = createInspectionContext(root, { phase });
  const targets = verifyTargetFingerprints(root, expectedTargets, phase, context);
  if (!targets.ok) return { ok: false, error: `stale_transaction_target_drift:${targets.mismatches.map((item) => item.rel).join(",")}` };
  try {
    const validation = inspectProject(root, { context, phase });
    const actualDigest = canonicalDigest(validation.decision_snapshot);
    if (actualDigest !== expectedDigest) return { ok: false, error: `stale_transaction_validation_digest_drift:${phase}` };
    const seal = context.seal();
    if (!seal.ok) return { ok: false, error: `stale_transaction_inspection_epoch_drift:${phase}` };
    return { ok: true, targets: targets.actual, validation_digest: actualDigest };
  } catch (error) {
    return { ok: false, error: `stale_transaction_validation_failed:${phase}:${formatFsError(error)}` };
  }
}

function verifyInterruptedTransactionOwnedStates(root, journal) {
  const context = createInspectionContext(root, { phase: "interrupted_owned_state_check" });
  const mismatches = [];
  const actualTargets = {};
  const ownedTempTargets = [];
  for (const rel of journal.targets) {
    let actual;
    try {
      actual = context.fingerprint(rel);
      actualTargets[rel] = actual;
    } catch (error) {
      mismatches.push(`${rel}:read_failed:${formatFsError(error)}`);
      continue;
    }
    const before = journal.before_fingerprints[rel];
    const predicted = journal.predicted_target_fingerprints[rel];
    if (canonicalJson(actual) !== canonicalJson(before) && canonicalJson(actual) !== canonicalJson(predicted)) {
      mismatches.push(`${rel}:third_party_state`);
    }
  }
  for (const [targetRel, tempRel] of Object.entries(journal.target_temp_rels)) {
    const tempPath = path.join(root, tempRel);
    const quarantinePath = `${tempPath}.quarantine`;
    const canonicalStat = lstatIfPresent(tempPath);
    const quarantineStat = lstatIfPresent(quarantinePath);
    if (canonicalStat && quarantineStat) {
      mismatches.push(`${tempRel}:canonical_and_quarantine_both_exist`);
      continue;
    }
    const stat = canonicalStat || quarantineStat;
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      mismatches.push(`${tempRel}:not_plain_file`);
      continue;
    }
    ownedTempTargets.push(targetRel);
  }
  const seal = context.seal();
  if (!seal.ok) mismatches.push("inspection_epoch_drift");
  return mismatches.length > 0
    ? { ok: false, error: `stale_transaction_target_drift:${mismatches.slice(0, 20).join("|")}` }
    : { ok: true, actual_targets: actualTargets, owned_temp_targets: ownedTempTargets };
}

function analyzeInterruptedCreatedDirectories(root, journal) {
  const recoverable = [];
  const ambiguous = [];
  for (const record of journal.directory_records || []) {
    const abs = path.join(root, record.rel);
    const stat = lstatIfPresent(abs, { bigint: true });
    if (!stat) continue;
    if (record.state !== "created") {
      ambiguous.push(`${record.rel}:intent_directory_exists`);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      ambiguous.push(`${record.rel}:created_directory_kind_changed`);
      continue;
    }
    if (!statMatchesFsObjectIdentity(stat, record.identity)) {
      ambiguous.push(`${record.rel}:created_directory_identity_changed`);
      continue;
    }
    recoverable.push(record);
  }
  return ambiguous.length > 0
    ? { ok: false, error: `interrupted_transaction_directory_creation_ambiguous:${ambiguous.slice(0, 20).join("|")}` }
    : { ok: true, recoverable };
}

function verifyHypotheticalRollbackBaseline(root, backupRoot, journal) {
  const overlay = {};
  const fileMap = new Map();
  for (const rel of journal.targets) {
    const before = journal.before_fingerprints[rel];
    if (before.kind === "file") {
      fileMap.set(path.resolve(root, rel), path.resolve(backupRoot, rel));
    }
    else if (before.kind === "directory") overlay[rel] = { kind: "directory" };
    else if (before.kind === "absent") overlay[rel] = { kind: "absent" };
    else return { ok: false, error: `interrupted_transaction_before_kind_unrecoverable:${rel}:${before.kind}` };
  }
  try {
    const context = createInspectionContext(root, {
      phase: "interrupted_hypothetical_rollback",
      overlay,
      io: createReadOnlyPathMappedIo(fileMap),
    });
    const validation = inspectProject(root, { context, phase: "interrupted_hypothetical_rollback" });
    const digest = canonicalDigest(validation.decision_snapshot);
    if (digest !== journal.baseline_validation_digest) {
      return { ok: false, error: "interrupted_transaction_non_target_drift" };
    }
    const seal = context.seal();
    if (!seal.ok) return { ok: false, error: "interrupted_transaction_hypothetical_epoch_drift" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `interrupted_transaction_hypothetical_validation_failed:${formatFsError(error)}` };
  }
}

function createReadOnlyPathMappedIo(fileMap) {
  const mapped = (value) => fileMap.get(path.resolve(value)) || value;
  const io = Object.create(fs);
  io.lstatSync = (value, ...args) => fs.lstatSync(mapped(value), ...args);
  io.openSync = (value, flags, ...args) => fs.openSync(mapped(value), flags, ...args);
  const realpathSync = (value, ...args) => fs.realpathSync(value, ...args);
  realpathSync.native = (value, ...args) => fs.realpathSync.native(value, ...args);
  io.realpathSync = realpathSync;
  return io;
}

function acquireApplyLock(root, planId) {
  if (!isNonEmptyString(planId) || utf8Bytes(planId) > MAX_TRANSACTION_PLAN_ID_BYTES) {
    fail(`apply_plan_id_invalid_or_exceeds_${MAX_TRANSACTION_PLAN_ID_BYTES}_bytes`, 2);
  }
  const governanceRoot = path.join(root, ".project-gov");
  const createdParent = !fs.existsSync(governanceRoot);
  ensureDirectoryDurable(governanceRoot, root);
  const realRoot = fs.realpathSync.native(root);
  const realGovernanceRoot = fs.realpathSync.native(governanceRoot);
  if (!isPathInside(realRoot, realGovernanceRoot)) {
    fail(`Apply lock directory escapes the project through a symlink or junction: ${governanceRoot}`, 4);
  }
  const expectedRealGovernanceRoot = path.resolve(realRoot, path.relative(root, governanceRoot));
  if (!sameResolvedPath(realGovernanceRoot, expectedRealGovernanceRoot)) {
    fail(`Apply lock directory is redirected through a symlink or junction: ${governanceRoot}`, 4);
  }
  const lockPath = path.join(governanceRoot, "apply.lock");
  const ownerId = crypto.randomUUID();
  const owner = {
    schema_version: APPLY_LOCK_SCHEMA_VERSION,
    tool: SCRIPT_NAME,
    kind: "apply_lock",
    owner_id: ownerId,
    pid: process.pid,
    plan_id: String(planId || "unknown"),
    created_at: new Date().toISOString(),
    phase_state: `apply.lock.state-${ownerId}`,
  };
  let interruptedRecovery = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      createOwnedJsonLock(lockPath, owner);
      return {
        path: lockPath,
        owner_id: owner.owner_id,
        plan_id: owner.plan_id,
        phase_state: owner.phase_state,
        cleanup_empty_parent: createdParent,
        governanceRoot,
        interrupted_recovery: interruptedRecovery,
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existing = readOwnedLock(lockPath, true);
    if (!existing) continue;
    if (!isReclaimableApplyLock(existing)) {
      fail(`Apply lock is active: ${lockPath} (pid ${existing.pid}, created ${existing.created_at})`, 4);
    }

    const reclaimPath = path.join(governanceRoot, "apply.lock.reclaim");
    const reclaimOwner = {
      schema_version: APPLY_LOCK_SCHEMA_VERSION,
      tool: SCRIPT_NAME,
      kind: "apply_lock_reclaim",
      owner_id: crypto.randomUUID(),
      pid: process.pid,
      plan_id: owner.plan_id,
      created_at: new Date().toISOString(),
      purpose: "stale-apply-lock-reclaim",
    };
    acquireApplyReclaimGuard(reclaimPath, reclaimOwner);

    try {
      const current = readOwnedLock(lockPath, true);
      if (!current) continue;
      if (!isReclaimableApplyLock(current)) {
        fail(`Apply lock became active during stale check: ${lockPath}`, 4);
      }
      const recovery = recoverStaleApplyTransaction(root, current);
      if (!recovery.ok) {
        fail(`interrupted_transaction_recovery_failed:${recovery.error}`, 4);
      }
      const staleLockCleanup = releaseOwnedLock({ path: lockPath, owner_id: current.owner_id });
      if (!staleLockCleanup.ok || !staleLockCleanup.released) {
        fail(`interrupted_transaction_lock_release_failed:${staleLockCleanup.error || staleLockCleanup.method}`, 4);
      }
      let backupCleanup = null;
      if (recovery.backup_root) {
        backupCleanup = cleanupTransactionBackup(root, recovery.backup_root, {
          expectedTransactionId: recovery.transaction_id,
          expectedPlanId: recovery.plan_id,
          removeBackupBase: recovery.backup_base_created === true,
        });
      }
      interruptedRecovery = {
        recovered: true,
        terminal_state: recovery.terminal_state,
        transaction_id: recovery.transaction_id,
        plan_id: recovery.plan_id,
        backup_cleanup: backupCleanup,
      };
    } finally {
      const reclaimCleanup = releaseOwnedLock({ path: reclaimPath, owner_id: reclaimOwner.owner_id });
      if (!reclaimCleanup.ok) {
        fail(`Failed to release apply lock reclamation guard: ${reclaimCleanup.error}`, 4);
      }
    }
  }

  fail(`Could not acquire apply lock after stale-lock retries: ${lockPath}`, 4);
}

function acquireApplyReclaimGuard(reclaimPath, owner) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createOwnedJsonLock(reclaimPath, owner);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const existing = readOwnedLock(reclaimPath, true);
    if (!existing) continue;
    if (
      existing.schema_version !== APPLY_LOCK_SCHEMA_VERSION
      || existing.tool !== SCRIPT_NAME
      || existing.kind !== "apply_lock_reclaim"
      || !isReclaimableApplyLock(existing)
    ) {
      fail(`Apply lock reclamation is already in progress: ${reclaimPath}`, 4);
    }
    const cleanup = releaseOwnedLock({ path: reclaimPath, owner_id: existing.owner_id });
    if (!cleanup.ok || !cleanup.released) {
      fail(`Failed to reclaim abandoned apply lock guard: ${cleanup.error || cleanup.method}`, 4);
    }
  }
  fail(`Could not acquire apply lock reclamation guard: ${reclaimPath}`, 4);
}

function createOwnedJsonLock(lockPath, owner) {
  if (!UUID_REGEX.test(owner?.owner_id || "")) throw new Error("apply_lock_owner_id_invalid");
  const candidatePath = `${lockPath}.candidate-${owner.owner_id}`;
  let phaseBinding = null;
  let fd;
  let candidateStat = null;
  let published = false;
  try {
    if (owner.kind === "apply_lock") {
      phaseBinding = createOwnedApplyLockPhase(lockPath, owner, "acquired");
    }
    fd = fs.openSync(candidatePath, "wx", 0o600);
    candidateStat = fs.fstatSync(fd, { bigint: true });
    writeAllSync(fd, Buffer.from(`${JSON.stringify(owner, null, 2)}\n`, "utf8"));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const candidate = readPlainJsonFile(candidatePath, "apply_lock_candidate", MAX_APPLY_LOCK_BYTES);
    if (candidate.owner_id !== owner.owner_id || candidate.kind !== owner.kind) {
      throw new Error("apply_lock_candidate_verification_failed");
    }
    fs.linkSync(candidatePath, lockPath);
    published = true;
    const publishedStat = fs.lstatSync(lockPath, { bigint: true });
    if (!sameFsObjectIdentity(candidateStat, publishedStat)) {
      throw new Error("apply_lock_publish_identity_mismatch");
    }
    const publishedOwner = readPlainJsonFile(lockPath, "apply_lock", MAX_APPLY_LOCK_BYTES);
    if (publishedOwner.owner_id !== owner.owner_id || publishedOwner.kind !== owner.kind) {
      throw new Error("apply_lock_publish_content_mismatch");
    }
    fsyncFileAndParent(lockPath);
    cleanupCreatedFileByIdentity(candidatePath, candidateStat);
    fsyncDirectoryBestEffort(path.dirname(lockPath));
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original lock publication error.
      }
      fd = undefined;
    }
    if (candidateStat) cleanupCreatedFileByIdentity(candidatePath, candidateStat);
    if (!published && phaseBinding) cleanupCreatedFileByIdentity(phaseBinding.path, phaseBinding.stat);
    if (published) error.apply_lock_publish_ambiguous = true;
    throw error;
  }
}

function createOwnedApplyLockPhase(lockPath, owner, phase) {
  if (owner.phase_state !== `apply.lock.state-${owner.owner_id}`) {
    throw new Error("apply_lock_phase_state_path_invalid");
  }
  const finalPath = path.join(path.dirname(lockPath), owner.phase_state);
  const candidatePath = `${finalPath}.candidate`;
  const payload = {
    schema_version: APPLY_LOCK_SCHEMA_VERSION,
    tool: SCRIPT_NAME,
    kind: "apply_lock_phase",
    owner_id: owner.owner_id,
    phase,
    updated_at: new Date().toISOString(),
  };
  let fd;
  let candidateStat = null;
  let published = false;
  try {
    fd = fs.openSync(candidatePath, "wx", 0o600);
    candidateStat = fs.fstatSync(fd, { bigint: true });
    writeAllSync(fd, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(candidatePath, finalPath);
    published = true;
    const finalStat = fs.lstatSync(finalPath, { bigint: true });
    if (!sameFsObjectIdentity(candidateStat, finalStat)) throw new Error("apply_lock_phase_publish_identity_mismatch");
    const checked = readPlainJsonFile(finalPath, "apply_lock_phase", MAX_APPLY_LOCK_BYTES);
    if (checked.owner_id !== owner.owner_id || checked.phase !== phase) {
      throw new Error("apply_lock_phase_publish_content_mismatch");
    }
    fsyncFileAndParent(finalPath);
    cleanupCreatedFileByIdentity(candidatePath, candidateStat);
    return { path: finalPath, stat: finalStat };
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original phase publication error.
      }
    }
    if (candidateStat) cleanupCreatedFileByIdentity(candidatePath, candidateStat);
    if (published) error.apply_lock_phase_publish_ambiguous = true;
    throw error;
  }
}

function cleanupCreatedFileByIdentity(filePath, expectedStat) {
  const current = lstatIfPresent(filePath, { bigint: true });
  if (!current || !sameFsObjectIdentity(expectedStat, current)) return false;
  const quarantine = `${filePath}.failed-create-${crypto.randomUUID()}`;
  try {
    fs.renameSync(filePath, quarantine);
    fsyncDirectoryBestEffort(path.dirname(filePath));
    const moved = fs.lstatSync(quarantine, { bigint: true });
    if (!sameFsObjectIdentity(expectedStat, moved)) {
      if (!fs.existsSync(filePath)) fs.renameSync(quarantine, filePath);
      return false;
    }
    fs.unlinkSync(quarantine);
    fsyncDirectoryBestEffort(path.dirname(filePath));
    return true;
  } catch {
    if (fs.existsSync(quarantine) && !fs.existsSync(filePath)) {
      try {
        fs.renameSync(quarantine, filePath);
      } catch {
        // Keep the original failure; never delete an object whose identity is no longer proven.
      }
    }
    return false;
  }
}

function readOwnedLock(lockPath, allowMissing = false) {
  let lock;
  try {
    lock = readPlainJsonFile(lockPath, "apply_lock", MAX_APPLY_LOCK_BYTES);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    fail(`Existing lock cannot be validated and will not be removed: ${lockPath}`, 4);
  }
  const createdAt = Date.parse(lock?.created_at);
  if (
    !isPlainObject(lock)
    || lock.schema_version !== APPLY_LOCK_SCHEMA_VERSION
    || lock.tool !== SCRIPT_NAME
    || !new Set(["apply_lock", "apply_lock_reclaim"]).has(lock.kind)
    || !UUID_REGEX.test(lock.owner_id || "")
    || !Number.isInteger(lock.pid)
    || lock.pid <= 0
    || !isNonEmptyString(lock.plan_id)
    || utf8Bytes(lock.plan_id) > MAX_TRANSACTION_PLAN_ID_BYTES
    || !Number.isFinite(createdAt)
    || (lock.kind === "apply_lock" && lock.phase_state !== `apply.lock.state-${lock.owner_id}`)
  ) {
    fail(`Existing lock metadata is invalid and will not be removed: ${lockPath}`, 4);
  }
  return lock;
}

function transitionApplyLockPhase(lock, expectedPhase, nextPhase) {
  const current = readOwnedLock(lock.path, false);
  const phase = readApplyLockPhase(current, lock.path);
  if (current.owner_id !== lock.owner_id || current.kind !== "apply_lock" || phase.phase !== expectedPhase) {
    throw new Error("apply_lock_phase_transition_owner_or_state_mismatch");
  }
  const updated = { ...phase, phase: nextPhase, updated_at: new Date().toISOString() };
  const phasePath = path.join(path.dirname(lock.path), current.phase_state);
  writeAtomicDurable(phasePath, `${JSON.stringify(updated, null, 2)}\n`, {
    tempPath: `${phasePath}.update-${nextPhase}`,
  });
  const verified = readApplyLockPhase(current, lock.path);
  if (verified.owner_id !== lock.owner_id || verified.phase !== nextPhase) {
    throw new Error("apply_lock_phase_transition_verification_failed");
  }
}

function readApplyLockPhase(lock, lockPath) {
  if (lock.kind !== "apply_lock" || lock.phase_state !== `apply.lock.state-${lock.owner_id}`) {
    throw new Error("apply_lock_phase_state_binding_invalid");
  }
  const phasePath = path.join(path.dirname(lockPath), lock.phase_state);
  const value = readPlainJsonFile(phasePath, "apply_lock_phase", MAX_APPLY_LOCK_BYTES);
  const allowed = new Set(["schema_version", "tool", "kind", "owner_id", "phase", "updated_at"]);
  if (
    !isPlainObject(value)
    || strictUnknownFields(value, allowed, "apply_lock_phase").length > 0
    || value.schema_version !== APPLY_LOCK_SCHEMA_VERSION
    || value.tool !== SCRIPT_NAME
    || value.kind !== "apply_lock_phase"
    || value.owner_id !== lock.owner_id
    || !new Set(["acquired", "backup_started"]).has(value.phase)
    || !Number.isFinite(Date.parse(value.updated_at))
  ) {
    throw new Error("apply_lock_phase_state_invalid");
  }
  return value;
}

function isReclaimableApplyLock(lock) {
  return !isPidAlive(lock.pid);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function releaseOwnedLock(lock) {
  const result = {
    ok: true,
    released: false,
    method: "not_acquired",
    warnings: [],
  };
  if (!lock) return result;

  try {
    if (!fs.existsSync(lock.path)) {
      return { ...result, released: true, method: "already_missing" };
    }
    const beforeStat = fs.lstatSync(lock.path);
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      return { ...result, ok: false, method: "owner_mismatch", error: "lock_not_plain_file" };
    }
    const current = readOwnedLock(lock.path, true);
    if (!current) return { ...result, released: true, method: "already_missing" };
    if (current.owner_id !== lock.owner_id) {
      return {
        ...result,
        ok: false,
        method: "owner_mismatch",
        error: boundedIdentityText(`Lock owner changed before cleanup: ${lock.path}`),
      };
    }

    const releasedPath = `${lock.path}.release-${crypto.randomUUID()}`;
    try {
      fs.renameSync(lock.path, releasedPath);
    } catch (renameError) {
      if (renameError.code === "ENOENT" || !fs.existsSync(lock.path)) {
        return { ...result, released: true, method: "already_missing" };
      }
      return {
        ...result,
        ok: false,
        method: "release_failed",
        error: formatFsError(renameError),
      };
    }
    try {
      fsyncDirectoryBestEffort(path.dirname(lock.path));
    } catch (syncError) {
      const restored = restoreQuarantinedLock(lock.path, releasedPath);
      return {
        ...result,
        ok: false,
        method: restored.ok ? "release_fsync_failed" : "lock_quarantine_restore_conflict",
        error: restored.ok ? formatFsError(syncError) : restored.error,
      };
    }
    const movedStat = fs.lstatSync(releasedPath);
    const moved = readOwnedLock(releasedPath, false);
    if (!sameFsObjectIdentity(beforeStat, movedStat) || moved.owner_id !== lock.owner_id) {
      const restored = restoreQuarantinedLock(lock.path, releasedPath);
      return {
        ...result,
        ok: false,
        method: restored.ok ? "owner_mismatch" : "lock_quarantine_restore_conflict",
        error: restored.ok ? "lock_owner_changed_during_release" : restored.error,
      };
    }
    try {
      fs.unlinkSync(releasedPath);
      try {
        fsyncDirectoryBestEffort(path.dirname(lock.path));
      } catch (syncError) {
        result.warnings.push(`lock_quarantine_unlink_fsync_failed:${formatFsError(syncError)}`);
      }
      result.released = true;
      result.method = "quarantine_then_unlink";
    } catch (unlinkError) {
      result.released = true;
      result.method = "rename_fallback";
      result.warnings.push(`lock_quarantine_unlink_failed:${formatFsError(unlinkError)}`);
    }
    result.warnings.push(...cleanupOwnedLockAuxiliaryFiles(lock.path, moved));

    if (lock.cleanup_empty_parent) {
      try {
        fs.rmdirSync(lock.governanceRoot);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
          result.warnings.push(`empty_lock_parent_cleanup_failed:${formatFsError(error)}`);
        }
      }
    }
    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      method: "release_failed",
      error: formatFsError(error),
    };
  }
}

function restoreQuarantinedLock(canonicalPath, quarantinePath) {
  try {
    if (fs.existsSync(canonicalPath)) {
      return { ok: false, error: "lock_quarantine_restore_conflict:canonical_path_occupied" };
    }
    fs.renameSync(quarantinePath, canonicalPath);
    fsyncDirectoryBestEffort(path.dirname(canonicalPath));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `lock_quarantine_restore_failed:${formatFsError(error)}` };
  }
}

function cleanupOwnedLockAuxiliaryFiles(lockPath, owner) {
  const warnings = [];
  const candidates = [`${lockPath}.candidate-${owner.owner_id}`];
  if (owner.kind === "apply_lock") {
    const phasePath = path.join(path.dirname(lockPath), owner.phase_state);
    try {
      const phase = readApplyLockPhase(owner, lockPath);
      const stat = fs.lstatSync(phasePath, { bigint: true });
      if (phase.owner_id !== owner.owner_id || !cleanupCreatedFileByIdentity(phasePath, stat)) {
        warnings.push("apply_lock_phase_cleanup_unproven");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") warnings.push(`apply_lock_phase_cleanup_failed:${formatFsError(error)}`);
    }
    candidates.push(
      `${phasePath}.candidate`,
      `${phasePath}.update-acquired`,
      `${phasePath}.update-backup_started`,
    );
  }
  for (const candidate of candidates) {
    if (!lstatIfPresent(candidate) && !lstatIfPresent(`${candidate}.cleanup`)) continue;
    const removed = removeOwnedMetadataTemp(candidate);
    if (!removed.ok) warnings.push(`apply_lock_auxiliary_cleanup_failed:${path.basename(candidate)}:${removed.error}`);
  }
  return warnings;
}

function formatFsError(error) {
  const code = error?.code ? `${error.code}:` : "";
  return boundedIdentityText(`${code}${error?.message || String(error)}`);
}

function rederiveCompiledKnowledgeReview(root, compiledReview, actions, inMemory, context, overlay) {
  const operationReview = {
    status: compiledReview.status,
    basis: compiledReview.basis,
  };
  if (compiledReview.status === "created" || compiledReview.status === "updated") {
    operationReview.paths = compiledReview.roles.map((item) => item.path);
  }
  if (compiledReview.status === "deferred") operationReview.recheck = compiledReview.recheck;
  return compileKnowledgeReview(root, operationReview, actions, inMemory, context, overlay);
}

function preflightCompiledPlan(root, compiled) {
  const violations = [];
  assertManagedCorePathsNotRedirected(root);
  assertTransactionBackupBaseSafe(root);
  const context = createInspectionContext(root, { phase: "apply_preflight" });
  const baselineReport = inspectProject(root, { context, phase: "apply_preflight" });
  const baselineValidation = baselineReport.decision_snapshot;
  const baselineDigest = canonicalDigest(baselineValidation);
  if (baselineDigest !== compiled.baseline_validation_digest) violations.push("baseline_validation_digest_drift");
  if (canonicalJson(baselineValidation) !== canonicalJson(compiled.baseline_validation)) violations.push("baseline_validation_drift");

  const simulation = simulateCanonicalActions(context, compiled.actions);
  violations.push(...simulation.violations);
  if (canonicalJson(simulation.actions) !== canonicalJson(compiled.actions)) violations.push("compiled_actions_not_canonical");
  if (canonicalJson(simulation.beforeFingerprints) !== canonicalJson(compiled.before_fingerprints)) violations.push("before_fingerprint_drift");
  if (canonicalJson(simulation.predictedTargetFingerprints) !== canonicalJson(compiled.predicted_target_fingerprints)) violations.push("predicted_target_fingerprint_drift");

  const inMemory = new Map();
  for (const rel of ["TODO.md", "HANDOFF.md"]) {
    if (simulation.overlay.get(rel)?.kind === "file") inMemory.set(rel, simulation.overlay.get(rel).bytes.toString("utf8"));
    else if (context.kind(rel) === "file") {
      try {
        inMemory.set(rel, context.getBoundedText(rel, MAX_MUTABLE_TEXT_FILE_BYTES).text);
      } catch {
        // The baseline snapshot already carries the incomplete-read state.
      }
    }
  }
  const knowledgeCheck = rederiveCompiledKnowledgeReview(
    root,
    compiled.knowledge_review,
    simulation.actions,
    inMemory,
    context,
    simulation.overlay,
  );
  violations.push(...knowledgeCheck.violations);
  if (canonicalJson(knowledgeCheck.normalized) !== canonicalJson(compiled.knowledge_review)) violations.push("compiled_knowledge_review_not_canonical");

  const predictedContext = createInspectionContext(root, {
    phase: "apply_preflight",
    epoch_id: context.epoch_id,
    overlay: simulation.overlay,
    baseContext: context,
  });
  const predictedReport = inspectProject(root, {
    context: predictedContext,
    overlay: simulation.overlay,
    phase: "apply_preflight",
  });
  const predictedValidation = predictedReport.decision_snapshot;
  const predictedDigest = canonicalDigest(predictedValidation);
  const transition = evaluateValidationTransition(
    baselineValidation,
    predictedValidation,
    {
      actions: simulation.actions,
      changed_paths: changedTargetPaths(simulation.beforeFingerprints, simulation.predictedTargetFingerprints),
      before_semantic_declaration: baselineReport.semantic_declaration,
      after_semantic_declaration: predictedReport.semantic_declaration,
    },
  );
  if (predictedDigest !== compiled.predicted_validation_digest) violations.push("predicted_validation_digest_drift");
  if (canonicalJson(predictedValidation) !== canonicalJson(compiled.predicted_validation)) violations.push("predicted_validation_drift");
  if (canonicalJson(transition) !== canonicalJson(compiled.predicted_transition)) violations.push("predicted_transition_drift");
  if (!transition.transition_ok) violations.push(...transition.rejection_codes);

  const targetKeys = simulation.touched;
  const invariantSets = [
    Object.keys(compiled.before_fingerprints),
    Object.keys(compiled.predicted_target_fingerprints),
    [...simulation.preparedWrites.keys()],
  ];
  if (!invariantSets.every((items) => canonicalJson([...items].sort()) === canonicalJson(targetKeys))) {
    violations.push("prepared_target_set_invariant_failed");
  }
  const inspectionEpochSeal = context.seal();
  if (!inspectionEpochSeal.ok) violations.push("inspection_epoch_drift");
  return {
    context,
    baselineReport,
    baselineValidation,
    baselineDigest,
    predictedReport,
    predictedValidation,
    predictedDigest,
    transition,
    actions: simulation.actions,
    touched: targetKeys,
    preparedWrites: simulation.preparedWrites,
    beforeFingerprints: simulation.beforeFingerprints,
    predictedTargetFingerprints: simulation.predictedTargetFingerprints,
    inspectionEpochSeal,
    violations: [...new Set(violations)],
  };
}

function validationSummary(validation) {
  return {
    ok: validation.ok,
    mechanical_ok: validation.mechanical_ok,
    coverage_complete: validation.coverage_complete,
    indeterminate: validation.indeterminate,
    coverage_issues: validation.coverage_issues,
    validation_kind: "mechanical",
    semantic_checked_by_tool: false,
    project_knowledge_checked_by_tool: false,
    errors: validation.errors,
    warnings: validation.warnings,
    five_piece_total_bytes: validation.five_piece.total_bytes,
    over_45kb: validation.five_piece.over_limit,
    remaining_bytes: validation.five_piece.remaining_bytes,
    unresolved_references: validation.references.unresolved_count,
    semantic_declaration: validation.semantic_declaration,
    structure_ok: validation.structure.ok,
  };
}

function cleanupTransactionBackup(root, backupRoot, options = {}) {
  const backupBase = path.resolve(root, ".project-gov", "backups");
  const target = path.resolve(backupRoot);
  const rel = toRel(root, target);
  const expectedTransactionId = options.expectedTransactionId;
  const expectedPlanId = options.expectedPlanId;
  const removeBackupBase = options.removeBackupBase === true;
  const expectedTarget = path.join(backupBase, `txn-${expectedTransactionId}`);
  if (path.dirname(target) !== backupBase || !isPathInside(backupBase, target)) {
    return { ok: false, removed: false, retained: true, rel, error: "transaction_backup_path_invalid" };
  }
  if (!isNonEmptyString(expectedTransactionId) || !isNonEmptyString(expectedPlanId)) {
    return { ok: false, removed: false, retained: true, rel, error: "transaction_backup_expected_identity_required" };
  }
  if (!sameResolvedPath(target, expectedTarget)) {
    return { ok: false, removed: false, retained: true, rel, error: "transaction_backup_identity_path_mismatch" };
  }
  const baseCheck = validateExistingPathNotRedirected(root, backupBase);
  if (!baseCheck.ok) {
    return { ok: false, removed: false, retained: true, rel, error: `transaction_backup_base_redirected:${baseCheck.error}` };
  }
  if (!fs.existsSync(target)) {
    try {
      removeTransactionBackupBaseIfEmpty(backupBase, removeBackupBase);
      return { ok: true, removed: false, retained: false, rel, method: "already_missing" };
    } catch (error) {
      return { ok: false, removed: false, retained: true, rel, error: formatFsError(error) };
    }
  }
  let quarantine = null;
  try {
    const before = fs.lstatSync(target);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return { ok: false, removed: false, retained: true, rel, error: "transaction_backup_not_owned_directory" };
    }
    const markerCheck = validateTransactionBackupOwner(root, target, expectedTransactionId, expectedPlanId);
    if (!markerCheck.ok) return { ok: false, removed: false, retained: true, rel, error: markerCheck.error };

    quarantine = `${target}.cleanup-${crypto.randomUUID()}`;
    fs.renameSync(target, quarantine);
    const moved = fs.lstatSync(quarantine);
    if (!sameFsObjectIdentity(before, moved)) {
      throw new Error("transaction_backup_identity_changed_during_cleanup");
    }
    const movedMarkerCheck = validateTransactionBackupOwner(
      root,
      quarantine,
      expectedTransactionId,
      expectedPlanId,
    );
    if (!movedMarkerCheck.ok) throw new Error(movedMarkerCheck.error);
    fs.rmSync(quarantine, { recursive: true, force: false });
    quarantine = null;
    removeTransactionBackupBaseIfEmpty(backupBase, removeBackupBase);
    return { ok: true, removed: true, retained: false, rel, method: "remove_owned_transaction_backup" };
  } catch (error) {
    if (quarantine && fs.existsSync(quarantine) && !fs.existsSync(target)) {
      try {
        fs.renameSync(quarantine, target);
        quarantine = null;
      } catch (restoreError) {
        return {
          ok: false,
          removed: false,
          retained: true,
          rel,
          error: `${formatFsError(error)}; transaction_backup_quarantine_restore_failed:${formatFsError(restoreError)}`,
        };
      }
    }
    return { ok: false, removed: false, retained: true, rel, error: formatFsError(error) };
  }
}

function validateTransactionBackupOwner(
  root,
  backupRoot,
  expectedTransactionId,
  expectedPlanId,
  markerPath = path.join(backupRoot, BACKUP_OWNER_FILE),
) {
  try {
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return { ok: false, error: "transaction_backup_marker_not_plain_file" };
    }
    const marker = readPlainJsonFile(markerPath, "transaction_backup_marker", MAX_TRANSACTION_OWNER_BYTES);
    const allowed = new Set([
      "schema_version",
      "tool",
      "kind",
      "root",
      "plan_id",
      "transaction_id",
      "created_at",
    ]);
    if (
      strictUnknownFields(marker, allowed, "transaction_backup_marker").length > 0
      || marker.schema_version !== TRANSACTION_JOURNAL_SCHEMA_VERSION
      || marker.tool !== SCRIPT_NAME
      || marker.kind !== "transaction_backup"
      || !isNonEmptyString(marker.root)
      || !sameResolvedPath(marker.root, root)
      || marker.plan_id !== expectedPlanId
      || marker.transaction_id !== expectedTransactionId
      || !Number.isFinite(Date.parse(marker.created_at))
    ) {
      return { ok: false, error: "transaction_backup_marker_invalid" };
    }
    return { ok: true, marker };
  } catch (error) {
    return { ok: false, error: `transaction_backup_marker_invalid:${formatFsError(error)}` };
  }
}

function removeTransactionBackupBaseIfEmpty(backupBase, allowed) {
  if (!allowed) return;
  try {
    fs.rmdirSync(backupBase);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function sameFsObjectIdentity(expected, actual) {
  if (!expected || !actual || statKind(expected) !== statKind(actual)) return false;
  return ["dev", "ino"].every((field) => String(expected[field]) === String(actual[field]));
}

function fsObjectIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function isFsObjectIdentity(value) {
  return isPlainObject(value)
    && strictUnknownFields(value, new Set(["dev", "ino"]), "fs_object_identity").length === 0
    && /^\d+$/.test(value.dev || "")
    && /^\d+$/.test(value.ino || "");
}

function statMatchesFsObjectIdentity(stat, identity) {
  return statKind(stat) !== "absent"
    && isFsObjectIdentity(identity)
    && String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino;
}

function cleanupProjectCacheArtifact(root, filePath, allowedParents, binding = null) {
  const result = {
    ok: true,
    removed: false,
    rel: null,
    method: "not_project_cache_file",
  };
  if (!filePath || filePath === "-") return result;

  const abs = path.resolve(filePath);
  const governanceRoot = path.resolve(root, ".project-gov");
  const parent = allowedParents
    .map((name) => path.resolve(governanceRoot, name))
    .find((candidate) => sameResolvedPath(path.dirname(abs), candidate));
  if (!parent) return result;

  result.rel = toRel(root, abs);
  const pathCheck = validateExistingPathNotRedirected(root, abs);
  if (!pathCheck.ok) {
    return {
      ...result,
      ok: false,
      method: "refused_redirected_cache_file",
      error: pathCheck.error,
    };
  }

  const stat = lstatIfPresent(abs);
  if (!stat) return { ...result, method: "already_missing" };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      ...result,
      ok: false,
      method: "refused_non_plain_cache_file",
      error: "cache_artifact_not_plain_file",
    };
  }

  if (!binding) {
    return {
      ...result,
      ok: false,
      method: "refused_unbound_workflow_artifact",
      error: "workflow_artifact_cleanup_binding_missing",
    };
  }
  if (!isNonEmptyString(binding.abs) || !sameResolvedPath(binding.abs, abs)) {
    return {
      ...result,
      ok: false,
      method: "refused_mismatched_workflow_artifact_binding",
      error: "workflow_artifact_cleanup_binding_path_mismatch",
    };
  }

  const currentFingerprint = fingerprintBackupFile(abs);
  if (
    !sameFileStatIdentity(binding.stat, stat)
    || canonicalJson(currentFingerprint) !== canonicalJson(binding.fingerprint)
  ) {
    return {
      ...result,
      ok: false,
      method: "refused_replaced_workflow_artifact",
      error: "workflow_artifact_replaced_since_read",
      differing_fields: fingerprintDifferingFields(binding.fingerprint, currentFingerprint),
    };
  }

  const quarantine = path.join(parent, `.project-gov-cleanup-${crypto.randomUUID()}.quarantine`);
  try {
    fs.renameSync(abs, quarantine);
    const movedStat = fs.lstatSync(quarantine);
    const movedFingerprint = fingerprintBackupFile(quarantine);
    const movedMatches = sameFileObjectIdentity(binding.stat, movedStat)
      && canonicalJson(movedFingerprint) === canonicalJson(binding.fingerprint);
    if (!movedMatches) {
      const restored = restoreQuarantinedWorkflowArtifact(abs, quarantine);
      return {
        ...result,
        ok: false,
        method: restored.ok
          ? "refused_replaced_workflow_artifact"
          : "workflow_artifact_quarantine_restore_conflict",
        error: restored.ok
          ? "workflow_artifact_replaced_since_read"
          : "workflow_artifact_quarantine_restore_conflict",
        quarantine_rel: restored.ok ? null : toRel(root, quarantine),
        differing_fields: fingerprintDifferingFields(binding.fingerprint, movedFingerprint),
      };
    }
    try {
      fs.unlinkSync(quarantine);
    } catch (unlinkError) {
      const restored = restoreQuarantinedWorkflowArtifact(abs, quarantine);
      return {
        ...result,
        ok: false,
        method: restored.ok
          ? "cache_artifact_cleanup_failed_restored"
          : "workflow_artifact_quarantine_restore_conflict",
        error: restored.ok
          ? formatFsError(unlinkError)
          : `workflow_artifact_quarantine_restore_conflict:${formatFsError(unlinkError)}`,
        quarantine_rel: restored.ok ? null : toRel(root, quarantine),
      };
    }
    removeEmptyCacheDirectory(parent);
    removeEmptyCacheDirectory(governanceRoot);
    return { ...result, removed: true, method: "quarantine_then_unlink_bound_workflow_artifact" };
  } catch (error) {
    return {
      ...result,
      ok: false,
      method: "cache_artifact_cleanup_failed",
      error: formatFsError(error),
    };
  }
}

function restoreQuarantinedWorkflowArtifact(original, quarantine) {
  try {
    if (lstatIfPresent(original)) {
      return { ok: false, error: "workflow_artifact_quarantine_restore_conflict" };
    }
    fs.renameSync(quarantine, original);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatFsError(error) };
  }
}

function removeEmptyCacheDirectory(dir) {
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function inventoryGovernanceCache(root, olderThanDays) {
  const governanceRoot = path.join(root, ".project-gov");
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const items = [];
  const errors = [];
  if (fs.existsSync(governanceRoot)) {
    const pathCheck = validateExistingPathNotRedirected(root, governanceRoot);
    if (!pathCheck.ok) errors.push(`cache_root_invalid:${pathCheck.error}`);
  }

  for (const [name, kind] of [
    ["plans", "compiled_plan"],
    ["backups", "transaction_backup"],
    ["operations", "legacy_operation"],
    ["ops", "legacy_operation"],
  ]) {
    const parent = path.join(governanceRoot, name);
    if (errors.length > 0 || !fs.existsSync(parent)) continue;
    try {
      const parentStat = fs.lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        errors.push(`cache_parent_invalid:${toRel(root, parent)}`);
        continue;
      }
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        const abs = path.join(parent, entry.name);
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink() || stat.mtimeMs > cutoffMs) continue;
        items.push({
          kind,
          rel: toRel(root, abs),
          type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          modified_at: stat.mtime.toISOString(),
          bytes: stat.isFile() ? stat.size : null,
        });
      }
    } catch (error) {
      errors.push(`cache_scan_failed:${toRel(root, parent)}:${formatFsError(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    tool: SCRIPT_NAME,
    command: "prune",
    mode: "read_only_inventory",
    automatic_delete: false,
    root,
    older_than_days: olderThanDays,
    cutoff: new Date(cutoffMs).toISOString(),
    item_count: items.length,
    items: items.slice(0, MAX_PRUNE_REPORT_ITEMS),
    errors: errors.map((item) => limitText(item, MAX_STRUCTURE_DETAIL_CHARS)),
    report_truncated: items.length > MAX_PRUNE_REPORT_ITEMS,
  };
}


function replaceBlockExactResult(existing, oldBlock, replacement) {
  const source = normalizeNewlines(existing);
  const target = normalizeNewlines(oldBlock);
  const nextBlock = normalizeNewlines(replacement);
  if (target.length === 0) return { match_count: 0, next: existing };
  const matchCount = countExactOccurrences(source, target);
  if (matchCount !== 1) return { match_count: matchCount, next: existing };
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const next = source.replace(target, nextBlock).replace(/\n/g, newline);
  return { match_count: 1, next };
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function countExactOccurrences(source, target) {
  let count = 0;
  let cursor = 0;
  while (target.length > 0) {
    const found = source.indexOf(target, cursor);
    if (found === -1) break;
    count += 1;
    cursor = found + target.length;
  }
  return count;
}


function hasPlaceholderContent(text) {
  return PLACEHOLDER_PATTERNS.some((regex) => regex.test(text));
}

function isAllowedProjectPath(rel) {
  if (FIVE_PIECE.includes(rel)) return true;
  if (INDEX_FILES.includes(rel)) return true;
  if (rel.startsWith("历史记录/")) return true;
  if (rel.startsWith("证据库/")) return true;
  if (rel.startsWith("项目物料/")) return true;
  return false;
}

function validateRelativePath(root, rel) {
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
    return { ok: false, error: "absolute_path_not_allowed" };
  }
  if (rel.includes("\0")) return { ok: false, error: "nul_byte_not_allowed" };
  const rawSegments = rel.replace(/\\/g, "/").split("/");
  if (rawSegments.includes("..")) {
    return { ok: false, error: "parent_traversal_not_allowed" };
  }
  const segments = rawSegments.filter((segment) => segment && segment !== ".");
  if (segments.length === 0) return { ok: false, error: "empty_path_not_allowed" };
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    return { ok: false, error: "reserved_path_segment_not_allowed" };
  }
  if (segments.some((segment) => (
    segment !== segment.trim()
    || segment.includes(":")
    || /\.$/.test(segment)
  ))) {
    return { ok: false, error: "nonportable_path_segment_not_allowed" };
  }
  const normalized = segments.join("/");
  const abs = path.resolve(root, normalized);
  if (!isPathInside(root, abs)) return { ok: false, error: "path_outside_root" };

  const realRoot = fs.realpathSync.native(root);
  const existingAncestor = findExistingAncestor(abs);
  const ancestorStat = fs.lstatSync(existingAncestor);
  if (!sameResolvedPath(existingAncestor, root) && ancestorStat.isSymbolicLink()) {
    return { ok: false, error: "symlink_or_junction_redirect_not_allowed" };
  }
  if (existingAncestor !== abs && !ancestorStat.isDirectory()) {
    return { ok: false, error: "existing_ancestor_is_not_directory" };
  }
  const realAncestor = fs.realpathSync.native(existingAncestor);
  if (!isPathInside(realRoot, realAncestor)) {
    return { ok: false, error: "symlink_or_junction_escape" };
  }
  const ancestorRel = path.relative(root, existingAncestor);
  const expectedRealAncestor = path.resolve(realRoot, ancestorRel);
  if (!sameResolvedPath(realAncestor, expectedRealAncestor)) {
    return { ok: false, error: "symlink_or_junction_redirect_not_allowed" };
  }
  return { ok: true, rel: normalized, abs };
}

function validateExistingPathNotRedirected(root, target) {
  const realRoot = fs.realpathSync.native(root);
  const existingAncestor = findExistingAncestor(target);
  const ancestorStat = fs.lstatSync(existingAncestor);
  if (!sameResolvedPath(existingAncestor, root) && ancestorStat.isSymbolicLink()) {
    return { ok: false, error: "symlink_or_junction_redirect_not_allowed" };
  }
  const realAncestor = fs.realpathSync.native(existingAncestor);
  if (!isPathInside(realRoot, realAncestor)) {
    return { ok: false, error: "symlink_or_junction_escape" };
  }
  const ancestorRel = path.relative(root, existingAncestor);
  const expectedRealAncestor = path.resolve(realRoot, ancestorRel);
  if (!sameResolvedPath(realAncestor, expectedRealAncestor)) {
    return { ok: false, error: "symlink_or_junction_redirect_not_allowed" };
  }
  return { ok: true };
}

function assertManagedPathNotRedirected(root, rel) {
  const check = validateExistingPathNotRedirected(root, path.join(root, rel));
  if (!check.ok) fail(`managed_project_path_redirected:${rel}:${check.error}`, 4);
}

function assertManagedCorePathsNotRedirected(root) {
  for (const rel of [...FIVE_PIECE, ...INDEX_FILES]) {
    assertManagedPathNotRedirected(root, rel);
  }
}

function assertTransactionBackupBaseSafe(root) {
  const rel = ".project-gov/backups";
  assertManagedPathNotRedirected(root, rel);
  const abs = path.join(root, rel);
  const stat = lstatIfPresent(abs);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`transaction_backup_base_not_plain_directory:${rel}`, 4);
  }
}

function findExistingAncestor(abs) {
  let current = abs;
  while (!lstatIfPresent(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isPathInside(root, candidate) {
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const normalizedRoot = normalize(path.resolve(root));
  const normalizedCandidate = normalize(path.resolve(candidate));
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}

function sameResolvedPath(left, right) {
  const normalize = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

function nextIds(allOccurrences, date) {
  const ids = allOccurrences.map((item) => item.id);
  return {
    history_id: nextId(ids, "M", date),
    evidence_id: nextId(ids, "EV", date),
    material_id: nextId(ids, "MAT", date),
    run_id: `run_${date}_${timeCompact()}_${crypto.randomBytes(3).toString("hex")}`,
  };
}

function nextId(ids, prefix, date) {
  const pattern = new RegExp(
    `^${prefix}-${date}${PROJECT_ID_TOPIC_SEGMENTS_SOURCE}-(${PROJECT_ID_SEQUENCE_SOURCE})$`,
  );
  let max = 0;
  for (const id of ids) {
    const match = id.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  if (max >= 999) fail(`ID sequence exhausted for ${prefix}-${date}`, 2);
  return `${prefix}-${date}-${String(max + 1).padStart(3, "0")}`;
}

function maxId(ids) {
  const sorted = [...new Set(ids)].sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function normalizeDate(value) {
  const input = String(value);
  if (!/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(input)) fail(`Invalid date: ${value}`, 2);
  const raw = input.replace(/-/g, "");
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (!isValidCalendarDate(year, month, day)) {
    fail(`Invalid calendar date: ${value}`, 2);
  }
  return raw;
}

function isValidCalendarDate(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function currentLocalDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function timeCompact() {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

function parseNonNegativeNumber(value, optionName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`${optionName} must be a non-negative number`, 2);
  return number;
}

function resolveRoot(rootArg) {
  const root = path.resolve(rootArg || process.cwd());
  if (!fs.existsSync(root)) fail(`Root does not exist: ${root}`, 2);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) fail(`Root is not a directory: ${root}`, 2);
  return root;
}

function resolveCompiledPlanOutput(root, outArg) {
  const outPath = path.resolve(outArg);
  const planRoot = path.join(root, ".project-gov", "plans");
  if (!isPathInside(planRoot, outPath)) {
    fail(`Compiled plan output must stay under ${planRoot}`, 2);
  }
  if (!sameResolvedPath(path.dirname(outPath), planRoot)) {
    fail("compiled_plan_output_not_direct_child_of_plans", 2);
  }
  if (path.extname(outPath).toLowerCase() !== ".json") {
    fail("Compiled plan output must use a .json extension", 2);
  }
  if (lstatIfPresent(outPath)) fail(`Refusing to overwrite compiled plan output: ${outPath}`, 2);

  const pathCheck = validateExistingPathNotRedirected(root, outPath);
  if (!pathCheck.ok) fail(`Compiled plan output path is redirected: ${pathCheck.error}`, 2);
  return outPath;
}

function requireOption(value, message) {
  if (!value) fail(message, 2);
  return value;
}

function readJsonArtifact(filePath) {
  if (filePath === "-") {
    const bytes = readFileDescriptorBytesBounded(0, MAX_WORKFLOW_JSON_BYTES, "workflow_artifact");
    return { value: parseWorkflowJsonBytes(bytes, "workflow_artifact"), binding: null };
  }
  const abs = path.resolve(filePath);
  const before = fs.lstatSync(abs);
  if (!before.isFile() || before.isSymbolicLink()) fail(`Workflow JSON must be a plain file: ${abs}`, 2);
  if (!Number.isSafeInteger(before.size) || before.size > MAX_WORKFLOW_JSON_BYTES) {
    fail(`workflow_artifact_too_large:${abs}`, 2);
  }
  let fd;
  let bytes;
  let opened;
  let after;
  try {
    fd = fs.openSync(abs, "r");
    opened = fs.fstatSync(fd);
    if (!sameFileStatIdentity(before, opened)) fail(`workflow_artifact_changed_before_read:${abs}`, 2);
    bytes = readFileDescriptorBytesBounded(fd, MAX_WORKFLOW_JSON_BYTES, "workflow_artifact");
    const afterRead = fs.fstatSync(fd);
    after = fs.lstatSync(abs);
    if (!sameFileStatIdentity(opened, afterRead) || !sameFileStatIdentity(opened, after)) {
      fail(`workflow_artifact_changed_during_read:${abs}`, 2);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return {
    value: parseWorkflowJsonBytes(bytes, `workflow_artifact:${abs}`),
    binding: {
      abs,
      stat: after,
      fingerprint: {
        exists: true,
        kind: "file",
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    },
  };
}

function readFileDescriptorBytesBounded(fd, maxBytes, label) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  let total = 0;
  while (total <= maxBytes) {
    const remaining = Math.min(buffer.length, maxBytes + 1 - total);
    if (remaining <= 0) break;
    const read = fs.readSync(fd, buffer, 0, remaining, null);
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
  }
  if (total > maxBytes) fail(`${label}_too_large`, 2);
  return Buffer.concat(chunks, total);
}

function parseWorkflowJsonBytes(bytes, label) {
  let text;
  try {
    text = UTF8_FATAL_DECODER.decode(bytes);
  } catch {
    fail(`${label}_invalid_utf8`, 2);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}_invalid_json`, 2);
  }
}

function readPlainJsonFile(abs, label = "json_file", maxBytes = MAX_TRANSACTION_JOURNAL_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label}_max_bytes_invalid`);
  const before = fs.lstatSync(abs);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label}_not_plain_file`);
  if (!Number.isSafeInteger(before.size) || before.size > maxBytes) throw new Error(`${label}_too_large`);
  let fd;
  let bytes;
  try {
    fd = fs.openSync(abs, "r");
    const opened = fs.fstatSync(fd);
    if (!sameFileStatIdentity(before, opened)) throw new Error(`${label}_changed_before_read`);
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 || 1));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = Math.min(buffer.length, maxBytes + 1 - total);
      if (remaining <= 0) break;
      const read = fs.readSync(fd, buffer, 0, remaining, null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      total += read;
    }
    if (total > maxBytes) throw new Error(`${label}_too_large`);
    const afterRead = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(abs);
    if (!sameFileStatIdentity(opened, afterRead) || !sameFileStatIdentity(opened, afterPath)) {
      throw new Error(`${label}_changed_during_read`);
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let text;
  try {
    text = UTF8_FATAL_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label}_invalid_utf8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
}

function readText(abs) {
  return fs.readFileSync(abs, "utf8");
}



function lstatIfPresent(abs, options = undefined) {
  try {
    return fs.lstatSync(abs, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function preferredNewline(text) {
  return String(text || "").includes("\r\n") ? "\r\n" : "\n";
}

function ensureTrailingNewlineWithStyle(text, newline) {
  if (text.endsWith("\r\n") || text.endsWith("\n")) return text;
  return `${text}${newline}`;
}

function limitText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated:${text.length - maxChars}]`;
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function writeAtomic(abs, value, options = {}) {
  if (options.ensureParent !== false) ensureDirectoryDurable(path.dirname(abs));
  const tmp = options.tempPath
    ? path.resolve(options.tempPath)
    : `${abs}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  if (!sameResolvedPath(path.dirname(tmp), path.dirname(abs)) || sameResolvedPath(tmp, abs)) {
    throw new Error(`atomic_temp_path_invalid:${tmp}`);
  }
  let fd;
  let created = false;
  let createdStat = null;
  let renamed = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    created = true;
    createdStat = fs.fstatSync(fd, { bigint: true });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    writeAllSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, abs);
    renamed = true;
    const finalStat = fs.lstatSync(abs, { bigint: true });
    if (statKind(createdStat) !== statKind(finalStat)) throw new Error("atomic_target_kind_changed_after_rename");
    if (!sameFsObjectIdentity(createdStat, finalStat)) throw new Error("atomic_target_identity_changed_after_rename");
    if (options.durable === true) fsyncDirectoryBestEffort(path.dirname(abs));
  } catch (error) {
    error.atomic_rename_completed = renamed;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
      fd = undefined;
    }
    if (created && lstatIfPresent(tmp)) {
      try {
        if (options.transactionBound === true) {
          removeTransactionTempFile(tmp, [], { journal_bound: true });
        } else if (createdStat) {
          cleanupCreatedFileByIdentity(tmp, createdStat);
        }
      } catch {
        // Preserve the original write error; recovery owns any exact transaction temp.
      }
    }
    throw error;
  }
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error("short_write_without_progress");
    offset += written;
  }
}

function ensureDirectoryDurable(target, boundary = path.parse(path.resolve(target)).root) {
  const resolvedTarget = path.resolve(target);
  const resolvedBoundary = path.resolve(boundary);
  if (resolvedTarget !== resolvedBoundary && !isPathInside(resolvedBoundary, resolvedTarget)) {
    throw new Error(`durable_directory_escaped_boundary:${resolvedTarget}`);
  }
  const missing = [];
  let current = resolvedTarget;
  while (!lstatIfPresent(current)) {
    if (sameResolvedPath(current, resolvedBoundary)) break;
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing = lstatIfPresent(current);
  if (!existing || !existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`durable_directory_parent_not_plain_directory:${current}`);
  }
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory);
    const created = fs.lstatSync(directory);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error(`durable_directory_creation_not_plain:${directory}`);
    }
    fsyncDirectoryBestEffort(path.dirname(directory));
    fsyncDirectoryBestEffort(directory);
  }
  return missing.map((directory) => directory);
}

function writeAtomicDurable(abs, value, options = {}) {
  writeAtomic(abs, value, { ...options, durable: true });
}

function fsyncDirectoryBestEffort(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!new Set(["EACCES", "EINVAL", "EISDIR", "ENOSYS", "EPERM"]).has(error?.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function mapPush(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function toRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, "/");
}

function sanitizeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function output(data, opts) {
  const versioned = isPlainObject(data) && !Object.hasOwn(data, "skill_version")
    ? { ...data, skill_version: SKILL_VERSION }
    : data;
  if (opts.json) {
    console.log(JSON.stringify(versioned, null, 2));
    return;
  }
  if (versioned.command === "inspect" || versioned.command === "validate") {
    const report = versioned.report || versioned;
    console.log(`root: ${report.root}`);
    console.log("validation_kind: mechanical");
    console.log(`five_piece_total_bytes: ${report.five_piece.total_bytes}/${FIVE_PIECE_LIMIT_BYTES}`);
    console.log(`five_piece_remaining_bytes: ${report.five_piece.remaining_bytes}`);
    console.log(`five_piece_over_45kb: ${report.five_piece.over_limit}`);
    console.log(`missing_five_piece: ${report.files.five_piece.missing.join(", ") || "none"}`);
    console.log(`missing_indexes: ${report.files.indexes.missing.join(", ") || "none"}`);
    console.log(`unresolved_references: ${report.references.unresolved_count}`);
    console.log(`handoff_changes_after_checkpoint: ${report.semantic_declaration.changes_after_checkpoint || "missing"}`);
    console.log(`semantic_checked_by_tool: ${report.semantic_checked_by_tool}`);
    console.log(`project_knowledge_checked_by_tool: ${report.project_knowledge_checked_by_tool}`);
    console.log(`mechanical_ok: ${report.mechanical_ok}`);
    console.log(`coverage_complete: ${report.coverage_complete}`);
    console.log(`indeterminate: ${report.indeterminate}`);
    console.log(`coverage_issues: ${(report.coverage_issues || []).join(", ") || "none"}`);
    console.log(`warnings: ${(report.warnings || []).join(", ") || "none"}`);
    console.log(`errors: ${report.errors.join(", ") || "none"}`);
    return;
  }
  console.log(JSON.stringify(versioned, null, 2));
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  process.exitCode = code;
  throw error;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

export {
  buildTypedIndexModel,
  createInspectionContext,
  enrichTypedIndexModelWithManagedScan,
  evaluateValidationTransition,
  inspectProject,
  validateCompiledPlanEnvelope,
};
