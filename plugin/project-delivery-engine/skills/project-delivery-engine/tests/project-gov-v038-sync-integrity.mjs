import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const EXPECTED_MANAGED_TOP_LEVEL = ["SKILL.md", "agents", "assets", "examples", "references", "scripts", "tests"];
const ALLOWED_EXCLUDE_PATTERNS = [".git/**", ".gitignore", "plugin/**"];
const EXPECTED_USER_COMMANDS = [
  "apply", "ids", "inspect", "migrate-check", "propose", "prune", "startup", "validate", "verify-materials",
];
const EXPECTED_ACTION_TYPES = [
  "append_after", "mkdir", "replace_block_exact", "replace_line_contains", "write_file",
];
const FINAL_REPORT_PREREQUISITES = Array.from({ length: 17 }, (_, index) => `LR${83 + index}`);
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT_OVERRIDE = process.env.PDE038_SOURCE_ROOT?.trim();
const CANONICAL_SOURCE_ROOT = SOURCE_ROOT_OVERRIDE
  ? path.resolve(SOURCE_ROOT_OVERRIDE)
  : DEFAULT_SOURCE_ROOT;
const ALLOWED_RECONCILIATION = new Set([
  "preserved_byte_exact",
  "preserved_and_extended",
  "intentionally_superseded",
]);
const FORBIDDEN_TARGET = ["Work", "Buddy"].join("");

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

function fileDigest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function bufferDigest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function canonicalPathIdentity(value) {
  const normalized = normalizeRel(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSafeRel(value) {
  const rel = normalizeRel(value);
  return rel.length > 0
    && !path.isAbsolute(rel)
    && !rel.split("/").some((part) => part === "" || part === "." || part === "..");
}

function sameResolvedPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolveEvidenceNode(rootValue, relValue, expectedKind) {
  if (!rootValue || !isSafeRel(relValue)) return null;
  const root = path.resolve(rootValue);
  const rel = normalizeRel(relValue);
  const parts = rel.split("/");
  const abs = path.resolve(root, ...parts);
  if (!isContainedPath(root, abs) || !fs.existsSync(abs)) return null;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !stat.isDirectory()) return null;
    if (index === parts.length - 1
      && (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory())) return null;
  }
  const realRoot = fs.realpathSync.native(root);
  const realNode = fs.realpathSync.native(abs);
  return isContainedPath(realRoot, realNode) ? abs : null;
}

function resolveRegularEvidenceFile(rootValue, relValue) {
  return resolveEvidenceNode(rootValue, relValue, "file");
}

function resolveRegularEvidenceDirectory(rootValue, relValue) {
  return resolveEvidenceNode(rootValue, relValue, "directory");
}

function readStrictUtf8(file) {
  return UTF8_FATAL_DECODER.decode(fs.readFileSync(file));
}

function runGit(root, args, encoding = null) {
  const child = spawnSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  return child.status === 0 ? child.stdout : null;
}

function captureGitWorkTree(gitRootValue, workTreeValue) {
  const gitRoot = path.resolve(gitRootValue || "");
  const workTree = path.resolve(workTreeValue || "");
  const gitDirectory = path.join(gitRoot, ".git");
  const indexPath = path.join(gitDirectory, "index");
  if (!gitRootValue || !workTreeValue || !fs.existsSync(indexPath)) return null;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-git-index-"));
  const isolatedIndex = path.join(isolated, "index");
  try {
    fs.copyFileSync(indexPath, isolatedIndex);
    const invoke = (args, encoding = null) => spawnSync("git", [
      `--git-dir=${gitDirectory}`,
      `--work-tree=${workTree}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      ...args,
    ], {
      encoding,
      env: { ...process.env, GIT_INDEX_FILE: isolatedIndex, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    const head = invoke(["rev-parse", "HEAD"], "utf8");
    const status = invoke(["status", "--porcelain=v1", "--untracked-files=all"]);
    const workingTreeDiff = invoke(["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
    const indexDiff = invoke(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]);
    if ([head, status, workingTreeDiff, indexDiff].some((child) => child.status !== 0)) return null;
    return {
      head: head.stdout.trim(),
      status: status.stdout,
      working_tree_diff: workingTreeDiff.stdout,
      index_diff: indexDiff.stdout,
    };
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

function recomputeScopeDigest(scope) {
  const bound = { ...scope };
  delete bound.source_root;
  delete bound.scope_digest;
  return digest(bound);
}

function globMatches(relValue, patternValue) {
  const rel = normalizeRel(relValue);
  const pattern = normalizeRel(patternValue);
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u").test(rel)
    || (pattern.endsWith("/**") && rel === pattern.slice(0, -3));
}

function isExplicitlyExcluded(rel, scope) {
  return (scope?.explicit_excludes ?? []).some((entry) => globMatches(rel, entry.path_or_pattern));
}

function inspectNode(abs, rel, inventory, root) {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) {
    inventory.links.push({ path: rel, kind: "symlink" });
    return;
  }
  if (stat.isFile()) {
    inventory.files.push({
      path: rel,
      kind: "file",
      bytes: stat.size,
      sha256: fileDigest(abs),
    });
    return;
  }
  if (!stat.isDirectory()) {
    inventory.non_regular.push({ path: rel, kind: "non_regular" });
    return;
  }
  const real = fs.realpathSync.native(abs);
  const realRoot = fs.realpathSync.native(root);
  const relativeReal = path.relative(realRoot, real);
  if (relativeReal.startsWith(`..${path.sep}`) || relativeReal === ".." || path.isAbsolute(relativeReal)) {
    inventory.links.push({ path: rel, kind: "junction" });
    return;
  }
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const childRel = normalizeRel(path.posix.join(rel, entry.name));
    if (isExplicitlyExcluded(childRel, inventory.scope)) continue;
    inspectNode(path.join(abs, entry.name), childRel, inventory, root);
  }
}

function enumerateManagedRoot(rootValue, scope) {
  const root = path.resolve(rootValue || "");
  const inventory = { root, scope, files: [], links: [], non_regular: [], unclassified: [] };
  if (!rootValue || !fs.existsSync(root)) return { ...inventory, error: "root_missing" };
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ...inventory, error: "root_not_regular_directory" };
  const managed = scope?.managed_top_level;
  if (!Array.isArray(managed) || managed.length === 0 || managed.some((item) => !isSafeRel(item))) {
    return { ...inventory, error: "managed_top_level_invalid" };
  }
  const managedSet = new Set(managed.map(normalizeRel));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = normalizeRel(entry.name);
    if (!managedSet.has(rel) && !isExplicitlyExcluded(rel, scope)) inventory.unclassified.push(rel);
  }
  for (const item of [...managedSet].sort()) {
    if (isExplicitlyExcluded(item, scope)) continue;
    const abs = path.join(root, ...item.split("/"));
    try {
      fs.lstatSync(abs);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    inspectNode(abs, item, inventory, root);
  }
  inventory.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  inventory.links.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  inventory.non_regular.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  inventory.unclassified.sort();
  return inventory;
}

function canonicalManagedRootsValid(rootValue) {
  const root = path.resolve(rootValue || "");
  try {
    return EXPECTED_MANAGED_TOP_LEVEL.every((rel) => {
      const stat = fs.lstatSync(path.join(root, rel));
      if (stat.isSymbolicLink()) return false;
      return rel === "SKILL.md" ? stat.isFile() : stat.isDirectory();
    });
  } catch {
    return false;
  }
}

function recomputeManifest(root, scope) {
  const inventory = enumerateManagedRoot(root, scope);
  const paths = inventory.files.map((entry) => entry.path);
  const manifest = {
    schema_version: 1,
    root: path.resolve(root),
    scope_digest: recomputeScopeDigest(scope),
    files: inventory.files,
    path_set_digest: digest(paths),
  };
  const bound = { ...manifest };
  delete bound.root;
  manifest.manifest_digest = digest(bound);
  return { inventory, manifest };
}

function manifestMatchesDisk(recorded, scope) {
  if (!validManifest(recorded)
    || !scope
    || !recorded.root
    || path.resolve(recorded.root) !== recorded.root) return false;
  const recomputed = recomputeManifest(recorded.root, scope);
  if (recomputed.inventory.error
    || recomputed.inventory.links.length > 0
    || recomputed.inventory.non_regular.length > 0
    || recomputed.inventory.unclassified.length > 0) return false;
  return scope.scope_digest === recomputeScopeDigest(scope)
    && recorded.scope_digest === scope.scope_digest
    && sameStrings(scope.files, recomputed.manifest.files.map((entry) => entry.path))
    && canonicalJson(recorded.files) === canonicalJson(recomputed.manifest.files)
    && recorded.path_set_digest === recomputed.manifest.path_set_digest
    && recorded.manifest_digest === recomputed.manifest.manifest_digest;
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function hasForbiddenTarget(value) {
  if (typeof value === "string") return value.toLowerCase().includes(FORBIDDEN_TARGET.toLowerCase());
  if (Array.isArray(value)) return value.some(hasForbiddenTarget);
  if (value && typeof value === "object") return Object.entries(value)
    .some(([key, item]) => hasForbiddenTarget(key) || hasForbiddenTarget(item));
  return false;
}

function validManifest(manifest) {
  if (!manifest || manifest.schema_version !== 1 || !SHA256_RE.test(manifest.scope_digest ?? "")) return false;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return false;
  const paths = manifest.files.map((entry) => entry.path);
  const sortedPaths = [...paths].sort();
  if (new Set(paths.map(canonicalPathIdentity)).size !== paths.length
    || !paths.every((item, index) => item === sortedPaths[index])) return false;
  if (!manifest.files.every((entry) => typeof entry.path === "string"
    && entry.path.length > 0
    && entry.kind === "file"
    && Number.isSafeInteger(entry.bytes)
    && entry.bytes >= 0
    && SHA256_RE.test(entry.sha256 ?? ""))) return false;
  if (manifest.path_set_digest !== digest(paths)) return false;
  const bound = { ...manifest };
  delete bound.root;
  delete bound.manifest_digest;
  return manifest.manifest_digest === digest(bound);
}

function manifestsEqual(left, right) {
  if (!validManifest(left) || !validManifest(right)) return false;
  return left.scope_digest === right.scope_digest
    && left.path_set_digest === right.path_set_digest
    && left.manifest_digest === right.manifest_digest;
}

function makeManifest(paths = ["SKILL.md", "scripts/project-gov.mjs"]) {
  const sorted = [...paths].sort();
  const manifest = {
    schema_version: 1,
    root: "display-only",
    scope_digest: "a".repeat(64),
    files: sorted.map((item, index) => ({
      path: item,
      kind: "file",
      bytes: index + 1,
      sha256: String(index + 1).padStart(64, "0"),
    })),
    path_set_digest: digest(sorted),
  };
  const bound = { ...manifest };
  delete bound.root;
  manifest.manifest_digest = digest(bound);
  return manifest;
}

function result(ok, reason) {
  return { ok, reason };
}

function checkFreeze(value) {
  return result(Boolean(value?.head_valid
    && value?.status_present
    && value?.binary_diff_present
    && value?.manifest_valid
    && value?.snapshots_valid
    && value?.manifest_paths_unique
    && value?.source_scope_bound
    && value?.head_manifest_bound
    && value?.git_binding_valid), "freeze must bind one canonical prechange manifest path set to the real Git root, HEAD, isolated-index status/diffs, and copied bytes");
}

function checkReconciliation(value) {
  const entries = value?.reconciliation?.entries;
  const initialPaths = value?.initial_paths;
  const finalPaths = entries?.map((entry) => entry.path);
  return result(Boolean(Array.isArray(entries)
    && entries.length > 0
    && new Set(finalPaths).size === finalPaths.length
    && sameStrings(initialPaths, finalPaths)
    && entries.every((entry) => ALLOWED_RECONCILIATION.has(entry.classification))),
  "every initially changed path must have one allowed reconciliation class");
}

function checkSuperseded(value) {
  const entries = value?.reconciliation?.entries;
  return result(Boolean(Array.isArray(entries) && entries
    .filter((entry) => entry.classification === "intentionally_superseded")
    .every((entry) => typeof entry.rationale === "string"
      && entry.rationale.trim().length > 0
      && typeof entry.original_intent_preserved === "string"
      && entry.original_intent_preserved.trim().length > 0
      && Array.isArray(entry.evidence)
      && entry.evidence.some((item) => /^test:/u.test(item))
      && entry.evidence.some((item) => /^diff:/u.test(item)))),
  "superseded entries require rationale, original-intent preservation, test, and diff evidence");
}

function checkNoUnexplainedLoss(value) {
  const entries = value?.reconciliation?.entries;
  return result(Boolean(Array.isArray(entries) && entries.every((entry) => entry.final_exists
    || (entry.classification === "intentionally_superseded" && entry.deletion_authorized === true))),
  "an initially changed path cannot disappear without explicit authorized supersession");
}

function deriveHeadToInitial(freeze) {
  if (!freeze?.manifest || !Array.isArray(freeze.manifest.entries) || !GIT_OID_RE.test(freeze.head ?? "")) return null;
  const rows = [];
  for (const entry of freeze.manifest.entries) {
    const logical = normalizeRel(entry.path);
    if (!logical.startsWith("source/")) continue;
    const rel = logical.slice("source/".length);
    if (!isSafeRel(rel) || rel.includes(":")) return null;
    const snapshot = resolveRegularEvidenceFile(freeze.root, entry.snapshot_path);
    if (!snapshot) return null;
    const headBytes = runGit(freeze.source_root, ["show", `${freeze.head}:${rel}`]);
    const row = {
      path: rel,
      head_sha256: Buffer.isBuffer(headBytes) ? bufferDigest(headBytes) : null,
      initial_sha256: fileDigest(snapshot),
    };
    if (row.head_sha256 !== row.initial_sha256) rows.push(row);
  }
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function deriveInitialToFinal(reconciliation, freeze) {
  if (reconciliation?.schema_version !== 1
    || reconciliation.head !== freeze?.head
    || !Array.isArray(reconciliation.entries)) return null;
    const seen = new Set();
  const rows = [];
  for (const entry of reconciliation.entries) {
    const rel = normalizeRel(entry.path);
    const identity = canonicalPathIdentity(rel);
    if (!isSafeRel(rel) || seen.has(identity)
      || !ALLOWED_RECONCILIATION.has(entry.classification)
      || !SHA256_RE.test(entry.initial_sha256 ?? "")
      || !SHA256_RE.test(entry.final_sha256 ?? "")) return null;
    seen.add(identity);
    if (entry.classification === "preserved_byte_exact" && entry.initial_sha256 !== entry.final_sha256) return null;
    if (entry.classification !== "preserved_byte_exact") {
      rows.push({
        path: rel,
        classification: entry.classification,
        initial_sha256: entry.initial_sha256,
        final_sha256: entry.final_sha256,
      });
    }
  }
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function checkFinalGitEvidence(finalGit, freeze) {
  return Boolean(finalGit?.git_binding_valid
    && finalGit.head === freeze?.head
    && finalGit.status_present
    && finalGit.binary_diff_present
    && finalGit.status_path
    && finalGit.working_tree_diff_path
    && finalGit.index_diff_path);
}

function deriveHeadToFinal(freeze, finalGit) {
  if (!checkFinalGitEvidence(finalGit, freeze)) return null;
  return {
    head: finalGit.head,
    status_sha256: fileDigest(finalGit.status_path),
    working_tree_diff_sha256: fileDigest(finalGit.working_tree_diff_path),
    index_diff_sha256: fileDigest(finalGit.index_diff_path),
  };
}

function checkThreeDiffs(value) {
  const diffs = value?.diffs;
  const keys = ["head_to_initial", "initial_to_final", "head_to_final"];
  const paths = keys.map((key) => canonicalPathIdentity(diffs?.[key]?.path));
  const structurallyValid = Boolean(diffs
    && new Set(paths).size === keys.length
    && keys.every((key) => {
      const entry = diffs[key];
      return entry
        && typeof entry.summary === "string"
        && entry.summary.trim().length > 0
        && isSafeRel(entry.path)
        && SHA256_RE.test(entry.sha256 ?? "");
    }));
  if (!structurallyValid) return result(false, "three distinct, safe, content-addressed diff artifacts are required");
  if (value?.verify_disk !== true) return result(true, "three distinct, safe, content-addressed diff artifacts are required");
  if (!value.evidence_root || !value.freeze || !value.reconciliation
    || !checkFreeze(value.freeze).ok || !checkFinalGitEvidence(value.final_git, value.freeze)) {
    return result(false, "diff artifacts require valid prechange freeze, final Git, and reconciliation anchors");
  }
  const artifacts = {};
  for (const key of keys) {
    const abs = resolveRegularEvidenceFile(value.evidence_root, diffs[key].path);
    if (!abs || fileDigest(abs) !== diffs[key].sha256) {
      return result(false, "diff artifact path or SHA-256 does not match disk");
    }
    try {
      artifacts[key] = JSON.parse(readStrictUtf8(abs));
    } catch {
      return result(false, "diff artifact is not strict UTF-8 JSON");
    }
  }
  const expected = {
    head_to_initial: deriveHeadToInitial(value.freeze),
    initial_to_final: deriveInitialToFinal(value.reconciliation, value.freeze),
    head_to_final: deriveHeadToFinal(value.freeze, value.final_git),
  };
  return result(Boolean(expected.head_to_initial
    && expected.initial_to_final
    && expected.head_to_final
    && keys.every((key) => canonicalJson(artifacts[key]) === canonicalJson(expected[key]))),
  "three diff artifacts must be recomputed from Git, frozen snapshots, reconciliation, and final status/diffs");
}

function checkFivePieceDiscipline(value) {
  const five = value?.five_piece;
  return result(Boolean(five
    && five.microstep_mechanical_rewrites === 0
    && Number.isSafeInteger(five.before_total_bytes)
    && Number.isSafeInteger(five.final_total_bytes)
    && five.before_total_bytes >= 0
    && five.final_total_bytes >= 0), "five-piece bytes must be disclosed without micro-step mechanical rewrites");
}

function checkSyncScope(value, expectedSourceRoot = CANONICAL_SOURCE_ROOT) {
  const scope = value?.scope;
  const sortedFiles = Array.isArray(scope?.files) ? [...scope.files].sort() : [];
  const excludePatterns = Array.isArray(scope?.explicit_excludes)
    ? scope.explicit_excludes.map((entry) => normalizeRel(entry?.path_or_pattern))
    : [];
  const structurallyValid = Boolean(scope?.schema_version === 1
    && typeof scope.source_root === "string"
    && path.isAbsolute(scope.source_root)
    && path.resolve(scope.source_root) === scope.source_root
    && (value?.verify_disk !== true || sameResolvedPath(scope.source_root, expectedSourceRoot))
    && Array.isArray(scope.managed_top_level)
    && sameStrings(scope.managed_top_level, EXPECTED_MANAGED_TOP_LEVEL)
    && new Set(scope.managed_top_level.map(canonicalPathIdentity)).size === scope.managed_top_level.length
    && scope.managed_top_level.every(isSafeRel)
    && Array.isArray(scope.files)
    && scope.files.length > 0
    && new Set(scope.files.map(canonicalPathIdentity)).size === scope.files.length
    && scope.files.every((item, index) => item === sortedFiles[index])
    && sameStrings(scope.files, value?.enumerated_source_files)
    && scope.files.every(isSafeRel)
    && Array.isArray(scope.explicit_excludes)
    && new Set(excludePatterns.map(canonicalPathIdentity)).size === excludePatterns.length
    && sameStrings(excludePatterns, ALLOWED_EXCLUDE_PATTERNS)
    && scope.explicit_excludes.every((entry) => typeof entry.reason === "string" && entry.reason.trim().length > 0)
    && scope.scope_digest === recomputeScopeDigest(scope));
  if (!structurallyValid) return result(false, "sync scope must use the canonical managed roots and exclusion allowlist");
  if (value?.verify_disk !== true) return result(true, "sync scope must use the canonical managed roots and exclusion allowlist");
  const actual = enumerateManagedRoot(scope.source_root, scope);
  return result(Boolean(!actual.error
    && canonicalManagedRootsValid(scope.source_root)
    && actual.links.length === 0
    && actual.non_regular.length === 0
    && actual.unclassified.length === 0
    && sameStrings(scope.files, actual.files.map((entry) => entry.path))),
  "sync scope must equal a fresh managed-root enumeration and reject links, non-regular nodes, unclassified entries, and arbitrary exclusions");
}

function checkSourceManifest(value) {
  const structurallyValid = Boolean(validManifest(value?.manifest)
    && sameStrings(value.manifest.files.map((entry) => entry.path), value?.scope_files));
  if (!structurallyValid) return result(false, "source recursive manifest must be canonical and cover exactly the sync scope");
  if (value?.verify_disk === true && (path.resolve(value.manifest.root || "") !== value.manifest.root
    || path.resolve(value.scope?.source_root || "") !== value.manifest.root)) {
    return result(false, "source manifest root must be the canonical sync-scope source root");
  }
  return result(value?.verify_disk !== true || manifestMatchesDisk(value.manifest, value.scope),
  "source recursive manifest must be freshly recomputed from its root and cover exactly the sync scope");
}

function checkSourceMirror(value) {
  const liveValid = value?.verify_disk !== true
    || (manifestMatchesDisk(value.source, value.scope) && manifestMatchesDisk(value.mirror, value.scope));
  return result(liveValid && manifestsEqual(value?.source, value?.mirror),
    "source and repo mirror manifests must each match disk before full comparison");
}

function checkMirrorActive(value) {
  const liveValid = value?.verify_disk !== true
    || (manifestMatchesDisk(value.mirror, value.scope) && manifestMatchesDisk(value.active, value.scope));
  return result(liveValid && manifestsEqual(value?.mirror, value?.active),
    "repo mirror and active manifests must each match disk before full comparison");
}

function checkStaleManaged(value) {
  const stale = value?.stale;
  const recordedValid = Boolean(stale
    && Number.isSafeInteger(stale.found)
    && stale.found >= 0
    && stale.backup_complete === true
    && stale.managed_only === true
    && stale.scope_outside_untouched === true
    && Array.isArray(stale.entries)
    && stale.entries.length === stale.found);
  if (!recordedValid) return result(false, "stale managed files require backup and scope-safe reconciliation");
  if (value?.verify_disk !== true) return result(true, "stale managed files require backup and scope-safe reconciliation");
  return result([value.source, value.mirror, value.active].every((manifest) => {
    const actual = enumerateManagedRoot(manifest?.root, value.scope);
    return !actual.error
      && actual.unclassified.length === 0
      && sameStrings(value.scope.files, actual.files.map((entry) => entry.path));
  }), "fresh managed-root enumeration must prove that no stale managed file remains");
}

function checkLinks(value) {
  const scan = value?.link_scan;
  const recordedValid = Boolean(scan?.complete === true
    && Array.isArray(scan.entries)
    && scan.entries.every((entry) => entry.kind !== "symlink" && entry.kind !== "junction"
      ? true
      : entry.disposition === "rejected"));
  if (!recordedValid) return result(false, "scope link scan must be complete and never silently follow links");
  if (value?.verify_disk !== true) return result(true, "scope link scan must be complete and never silently follow links");
  return result([value.source, value.mirror, value.active].every((manifest) => {
    const actual = enumerateManagedRoot(manifest?.root, value.scope);
    return !actual.error && actual.links.length === 0 && actual.non_regular.length === 0;
  }), "fresh scans of source, mirror, and active must contain no links or other non-regular nodes");
}

function checkThreePathSets(value) {
  const source = value?.source?.files?.map((entry) => entry.path);
  const mirror = value?.mirror?.files?.map((entry) => entry.path);
  const active = value?.active?.files?.map((entry) => entry.path);
  const roots = [value?.source?.root, value?.mirror?.root, value?.active?.root]
    .map((item) => typeof item === "string" ? path.resolve(item).toLowerCase() : "");
  const liveValid = value?.verify_disk !== true || [value.source, value.mirror, value.active]
    .every((manifest) => manifestMatchesDisk(manifest, value.scope));
  return result(Boolean(liveValid
    && (value?.verify_disk !== true || new Set(roots).size === 3)
    && sameStrings(source, mirror)
    && sameStrings(mirror, active)),
    "all three freshly recomputed path sets must match exactly");
}

function checkActiveVersion(value) {
  const active = value?.active_runtime;
  return result(Boolean(active
    && active.skill_version === "0.3.8-rc7"
    && active.plugin_manifest_version === "0.3.8-rc7"
    && active.compiled_schema_version === 5
    && active.operation_schema_version === 2
    && active.project_structure_version === 2
    && active.decision_policy_version === 2
    && active.formal_version_present === false
    && (active.host_prerelease_supported === true
      || active.error_code === "host_manifest_prerelease_unsupported")),
  "active runtime and plugin host manifest must expose the same RC version without claiming formal 0.3.8");
}

function checkActiveSmoke(value) {
  const smoke = value?.active_smoke;
  return result(Boolean(smoke?.ran_from_active_skill === true
    && smoke.inspect === "PASS"
    && smoke.propose === "PASS"
    && smoke.apply === "PASS"
    && smoke.rollback === "PASS"
    && smoke.exit_code === 0), "active-path smoke must cover inspect, propose, apply, and rollback");
}

function checkExcludedTarget(value) {
  const audit = value?.scope_audit;
  const inspectedLists = audit && [audit.changed_paths, audit.sync_roots, audit.test_commands, audit.migration_paths];
  return result(Boolean(audit
    && inspectedLists.every(Array.isArray)
    && !hasForbiddenTarget([
      inspectedLists,
      value.scope,
      value.source?.root,
      value.mirror?.root,
      value.active?.root,
    ])
    && audit.excluded_target_read_count === 0
    && audit.excluded_target_hash_count === 0), "excluded target must not appear in task paths or be read or hashed");
}

function uniqueSourceBlock(source, regex) {
  const matches = [...source.matchAll(regex)];
  return matches.length === 1 ? matches[0][1] : null;
}

function parseSourceAuthority(source) {
  const handlers = uniqueSourceBlock(source, /const handlers = \{([\s\S]*?)\r?\n\s*\};\r?\n\s*if \(!handlers\[command\]\)/gu);
  const actions = uniqueSourceBlock(source, /const ACTION_FIELDS = new Map\(\[([\s\S]*?)\n\]\);/gu);
  if (handlers === null || actions === null) return null;
  const handlerRow = /^\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_-]*)):\s*command[A-Za-z0-9_]+\s*,?\s*$/gmu;
  const actionRow = /^\s*\["([^"]+)",\s*new Set\(\[[^\]\r\n]*\]\)\],?\s*$/gmu;
  const commands = [...handlers.matchAll(handlerRow)]
    .map((match) => match[1] || match[2]).sort();
  const actionTypes = [...actions.matchAll(actionRow)]
    .map((match) => match[1]).sort();
  if (handlers.replace(handlerRow, "").trim() !== ""
    || actions.replace(actionRow, "").trim() !== ""
    || new Set(commands).size !== commands.length
    || new Set(actionTypes).size !== actionTypes.length) return null;

  const importSpecifiers = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]);
  const literalDynamicImports = [...source.matchAll(/\bimport\s*\(\s*["'][^"']+["']\s*\)/gu)].length;
  const allDynamicImports = [...source.matchAll(/\bimport\s*\(/gu)].length;
  if (literalDynamicImports !== allDynamicImports || /\brequire\s*\(/u.test(source)) return null;
  const dependencies = [...new Set(importSpecifiers.filter((specifier) => (
    !specifier.startsWith("node:") && !specifier.startsWith("./") && !specifier.startsWith("../")
  )))].sort();
  const modes = [...new Set([...source.matchAll(/\bmode\s*:\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]))].sort();
  return { commands, action_types: actionTypes, dependencies, modes };
}

function deriveComplexity(value) {
  const freeze = value?.freeze;
  const scopeValue = value?.scope;
  if (!freeze?.manifest || !checkFreeze(freeze).ok
    || !scopeValue || !sameResolvedPath(scopeValue.source_root, CANONICAL_SOURCE_ROOT)) return null;
  const initialScript = freeze.manifest.entries.find((entry) => normalizeRel(entry.path) === "source/scripts/project-gov.mjs");
  const initialScriptPath = initialScript ? resolveRegularEvidenceFile(freeze.root, initialScript.snapshot_path) : null;
  const currentScriptPath = path.join(CANONICAL_SOURCE_ROOT, "scripts", "project-gov.mjs");
  if (!initialScriptPath || !fs.existsSync(currentScriptPath)) return null;
  let initialAuthority;
  let currentAuthority;
  try {
    initialAuthority = parseSourceAuthority(readStrictUtf8(initialScriptPath));
    currentAuthority = parseSourceAuthority(readStrictUtf8(currentScriptPath));
  } catch {
    return null;
  }
  if (!initialAuthority || !currentAuthority
    || !sameStrings(currentAuthority.commands, EXPECTED_USER_COMMANDS)
    || !sameStrings(currentAuthority.action_types, EXPECTED_ACTION_TYPES)) return null;
  const initialSourcePaths = freeze.manifest.entries
    .filter((entry) => normalizeRel(entry.path).startsWith("source/"))
    .map((entry) => normalizeRel(entry.path).slice("source/".length));
  return {
    user_commands: currentAuthority.commands.length,
    action_types: currentAuthority.action_types.length,
    new_dependencies: currentAuthority.dependencies.filter((item) => !initialAuthority.dependencies.includes(item)),
    new_modes: currentAuthority.modes.filter((item) => !initialAuthority.modes.includes(item)),
    new_core_files: [...scopeValue.files].filter((item) => !initialSourcePaths.includes(item)).sort(),
  };
}

function checkComplexity(value) {
  const complexity = value?.complexity;
  const structurallyValid = Boolean(complexity
    && complexity.user_commands === EXPECTED_USER_COMMANDS.length
    && complexity.action_types === EXPECTED_ACTION_TYPES.length
    && Array.isArray(complexity.new_dependencies)
    && complexity.new_dependencies.length === 0
    && Array.isArray(complexity.new_modes)
    && complexity.new_modes.length === 0
    && Array.isArray(complexity.new_core_files)
    && complexity.new_core_files.length === 0);
  if (!structurallyValid) return result(false, "the RC must retain the exact command/action authorities and add no dependency, mode, or core file");
  if (value?.verify_disk !== true) return result(true, "the RC must retain the exact command/action authorities and add no dependency, mode, or core file");
  const derived = deriveComplexity(value);
  return result(Boolean(derived && canonicalJson(derived) === canonicalJson(complexity)),
    "complexity must be derived from current and frozen source authorities, imports, modes, and managed paths");
}

function checkFinalReport(value) {
  const final = value?.final_report;
  const rows = value?.prerequisite_rows;
  const prerequisiteIds = Array.isArray(rows) ? rows.map((row) => row.id) : [];
  return result(Boolean(Array.isArray(rows)
    && rows.length === FINAL_REPORT_PREREQUISITES.length
    && new Set(prerequisiteIds).size === prerequisiteIds.length
    && sameStrings(prerequisiteIds, FINAL_REPORT_PREREQUISITES)
    && rows.every((row) => row.status === "PASS")
    && final
    && final.local_runtime_rc === "PASS"
    && final.distribution_candidate === "deferred"
    && final.formal_release_0_3_8 === "not_started"
    && final.claimed_release_level === "local_runtime_rc"),
  "final report may pass only after every LR83-LR99 Gate passes and distribution/formal release remain deferred");
}

const baseManifest = makeManifest();
const baseReconciliation = {
  schema_version: 1,
  entries: [{
    path: "SKILL.md",
    classification: "preserved_and_extended",
    final_exists: true,
    rationale: "preserved",
    evidence: ["test:one", "diff:one"],
  }],
};
const baseGate = {
  diffs: {
    head_to_initial: { summary: "one", sha256: "1".repeat(64), path: "diffs/head_to_initial.json" },
    initial_to_final: { summary: "two", sha256: "2".repeat(64), path: "diffs/initial_to_final.json" },
    head_to_final: { summary: "three", sha256: "3".repeat(64), path: "diffs/head_to_final.json" },
  },
  five_piece: { microstep_mechanical_rewrites: 0, before_total_bytes: 10, final_total_bytes: 11 },
  stale: { found: 0, backup_complete: true, managed_only: true, scope_outside_untouched: true, entries: [] },
  link_scan: { complete: true, entries: [] },
  active_runtime: {
    skill_version: "0.3.8-rc7",
    plugin_manifest_version: "0.3.8-rc7",
    compiled_schema_version: 5,
    operation_schema_version: 2,
    project_structure_version: 2,
    decision_policy_version: 2,
    formal_version_present: false,
    host_prerelease_supported: true,
  },
  active_smoke: {
    ran_from_active_skill: true,
    inspect: "PASS",
    propose: "PASS",
    apply: "PASS",
    rollback: "PASS",
    exit_code: 0,
  },
  scope_audit: {
    changed_paths: ["scripts/project-gov.mjs"],
    sync_roots: ["source", "mirror", "active"],
    test_commands: ["node tests/project-gov-v038-sync-integrity.mjs"],
    migration_paths: ["project-data"],
    excluded_target_read_count: 0,
    excluded_target_hash_count: 0,
  },
  complexity: { user_commands: 9, action_types: 5, new_dependencies: [], new_modes: [], new_core_files: [] },
  final_report: {
    local_runtime_rc: "PASS",
    distribution_candidate: "deferred",
    formal_release_0_3_8: "not_started",
    claimed_release_level: "local_runtime_rc",
  },
};
const passingFinalPrerequisites = FINAL_REPORT_PREREQUISITES.map((id) => ({ id, status: "PASS" }));
const baseScope = {
  schema_version: 1,
  source_root: path.resolve("display-source"),
  managed_top_level: [...EXPECTED_MANAGED_TOP_LEVEL],
  files: baseManifest.files.map((entry) => entry.path),
  explicit_excludes: ALLOWED_EXCLUDE_PATTERNS.map((path_or_pattern) => ({
    path_or_pattern,
    reason: "canonical non-runtime path",
  })),
};
baseScope.scope_digest = recomputeScopeDigest(baseScope);
baseManifest.scope_digest = baseScope.scope_digest;
{
  const bound = { ...baseManifest };
  delete bound.root;
  delete bound.manifest_digest;
  baseManifest.manifest_digest = digest(bound);
}

const CASES = [
  {
    id: "LR83",
    check: checkFreeze,
    good: {
      head_valid: true,
      status_present: true,
      binary_diff_present: true,
      manifest_valid: true,
      snapshots_valid: true,
      manifest_paths_unique: true,
      source_scope_bound: true,
      head_manifest_bound: true,
      git_binding_valid: true,
    },
    bad: { head_valid: true },
  },
  { id: "LR84", check: checkReconciliation, good: { reconciliation: baseReconciliation, initial_paths: ["SKILL.md"] }, bad: { reconciliation: baseReconciliation, initial_paths: ["SKILL.md", "lost.md"] } },
  { id: "LR85", check: checkSuperseded, good: { reconciliation: { entries: [{ classification: "intentionally_superseded", rationale: "v2.1 replaces it", original_intent_preserved: "same behavior remains", evidence: ["test:one", "diff:one"] }] } }, bad: { reconciliation: { entries: [{ classification: "intentionally_superseded", rationale: "because" }] } } },
  { id: "LR86", check: checkNoUnexplainedLoss, good: { reconciliation: baseReconciliation }, bad: { reconciliation: { entries: [{ classification: "preserved_and_extended", final_exists: false }] } } },
  { id: "LR87", check: checkThreeDiffs, good: baseGate, bad: { diffs: { ...baseGate.diffs, head_to_final: null } } },
  { id: "LR88", check: checkFivePieceDiscipline, good: baseGate, bad: { five_piece: { microstep_mechanical_rewrites: 3, before_total_bytes: 10, final_total_bytes: 11 } } },
  { id: "LR89", check: checkSyncScope, good: { scope: baseScope, enumerated_source_files: baseScope.files }, bad: { scope: baseScope, enumerated_source_files: [...baseScope.files, "unlisted.md"] } },
  { id: "LR90", check: checkSourceManifest, good: { manifest: baseManifest, scope_files: baseScope.files }, bad: { manifest: { ...baseManifest, manifest_digest: "0".repeat(64) }, scope_files: baseScope.files } },
  { id: "LR91", check: checkSourceMirror, good: { source: baseManifest, mirror: { ...baseManifest, root: "mirror" } }, bad: { source: baseManifest, mirror: makeManifest(["SKILL.md"]) } },
  { id: "LR92", check: checkMirrorActive, good: { mirror: baseManifest, active: { ...baseManifest, root: "active" } }, bad: { mirror: baseManifest, active: makeManifest(["README.md"]) } },
  { id: "LR93", check: checkStaleManaged, good: baseGate, bad: { stale: { found: 1, backup_complete: false, managed_only: true, scope_outside_untouched: true, entries: [{}] } } },
  { id: "LR94", check: checkLinks, good: baseGate, bad: { link_scan: { complete: true, entries: [{ kind: "junction", disposition: "followed" }] } } },
  { id: "LR95", check: checkThreePathSets, good: { source: baseManifest, mirror: baseManifest, active: baseManifest }, bad: { source: baseManifest, mirror: baseManifest, active: makeManifest(["SKILL.md"]) } },
  { id: "LR96", check: checkActiveVersion, good: baseGate, bad: { active_runtime: { ...baseGate.active_runtime, skill_version: "0.3.8" } } },
  { id: "LR97", check: checkActiveSmoke, good: baseGate, bad: { active_smoke: { ...baseGate.active_smoke, ran_from_active_skill: false } } },
  { id: "LR98", check: checkExcludedTarget, good: baseGate, bad: { scope_audit: { ...baseGate.scope_audit, changed_paths: [FORBIDDEN_TARGET], excluded_target_read_count: 1 } } },
  { id: "LR99", check: checkComplexity, good: baseGate, bad: { complexity: { ...baseGate.complexity, user_commands: 10 } } },
  {
    id: "LR100",
    check: checkFinalReport,
    good: { ...baseGate, prerequisite_rows: passingFinalPrerequisites },
    bad: {
      final_report: { ...baseGate.final_report, distribution_candidate: "PASS" },
      prerequisite_rows: passingFinalPrerequisites,
    },
  },
];

assert.equal(CASES.length, 18);
assert.equal(new Set(CASES.map((item) => item.id)).size, CASES.length);
for (const item of CASES) {
  assert.equal(item.check(item.good).ok, true, `${item.id} verifier rejected its valid fixture`);
  assert.equal(item.check(item.bad).ok, false, `${item.id} verifier accepted its counterexample`);
}
assert.equal(checkThreeDiffs({
  diffs: {
    ...baseGate.diffs,
    head_to_final: { ...baseGate.diffs.head_to_final, path: baseGate.diffs.head_to_initial.path },
  },
}).ok, false, "LR87 accepted two diff identities backed by the same path");
assert.equal(checkFinalReport({
  ...baseGate,
  prerequisite_rows: passingFinalPrerequisites.map((row, index) => (
    index === 0 ? { ...row, status: "PENDING" } : row
  )),
}).ok, false, "LR100 passed while a prerequisite Gate was pending");

function selfTestDerivedEvidenceGates() {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-derived-gates-"));
  try {
    assert.equal(checkThreeDiffs({
      ...baseGate,
      evidence_root: evidence,
      freeze: {},
      reconciliation: {},
      verify_disk: true,
    }).ok, false, "LR87 accepted summaries and hashes without real diff artifacts");

    const source = readStrictUtf8(path.join(CANONICAL_SOURCE_ROOT, "scripts", "project-gov.mjs"));
    const authority = parseSourceAuthority(source);
    assert.ok(authority, "current command/action authority could not be parsed exactly once");
    assert.deepEqual(authority.commands, EXPECTED_USER_COMMANDS);
    assert.deepEqual(authority.action_types, EXPECTED_ACTION_TYPES);
    const tenthCommand = parseSourceAuthority(source.replace(
      "const handlers = {",
      "const handlers = {\n      experimental: commandInspect,",
    ));
    assert.ok(tenthCommand && tenthCommand.commands.includes("experimental"), "tenth command was not detected");
    const sixthAction = parseSourceAuthority(source.replace(
      "const ACTION_FIELDS = new Map([",
      "const ACTION_FIELDS = new Map([\n  [\"experimental\", new Set([\"kind\"])],",
    ));
    assert.ok(sixthAction && sixthAction.action_types.includes("experimental"), "sixth action was not detected");
    const externalDependency = parseSourceAuthority(`import external from "left-pad";\n${source}`);
    assert.ok(externalDependency?.dependencies.includes("left-pad"), "bare dependency was not detected");
    const newMode = parseSourceAuthority(`${source}\nconst synthetic = { mode: "new_runtime_mode" };\n`);
    assert.ok(newMode?.modes.includes("new_runtime_mode"), "new literal mode was not detected");
    assert.equal(parseSourceAuthority(source.replace(
      "const handlers = {",
      "const handlers = {\n      ...extraHandlers,",
    )), null, "unparsed command spread was ignored");
    assert.equal(parseSourceAuthority(source.replace(
      "const ACTION_FIELDS = new Map([",
      "const ACTION_FIELDS = new Map([\n  ...extraActionFields,",
    )), null, "unparsed action spread was ignored");
  } finally {
    fs.rmSync(evidence, { recursive: true, force: true });
  }
}

selfTestDerivedEvidenceGates();

function selfTestLiveManifestGate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-sync-gate-"));
  let linkTarget = null;
  try {
    writeFixture(root, "SKILL.md", "fixture-skill\n");
    writeFixture(root, "scripts/project-gov.mjs", "fixture-script\n");
    for (const rel of EXPECTED_MANAGED_TOP_LEVEL.filter((item) => !["SKILL.md", "scripts"].includes(item))) {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
    }
    const liveScope = {
      schema_version: 1,
      source_root: root,
      managed_top_level: [...EXPECTED_MANAGED_TOP_LEVEL],
      explicit_excludes: ALLOWED_EXCLUDE_PATTERNS.map((path_or_pattern) => ({
        path_or_pattern,
        reason: "canonical non-runtime path",
      })),
      files: ["SKILL.md", "scripts/project-gov.mjs"],
    };
    liveScope.scope_digest = recomputeScopeDigest(liveScope);
    const recorded = recomputeManifest(root, liveScope).manifest;
    assert.equal(manifestMatchesDisk(recorded, liveScope), true, "fresh live manifest was rejected");
    assert.equal(checkSyncScope({
      scope: liveScope,
      enumerated_source_files: liveScope.files,
      verify_disk: true,
    }, root).ok, true, "canonical fixed sync scope was rejected");

    fs.writeFileSync(path.join(root, "SKILL.md"), "fixture-Xkill\n", "utf8");
    assert.equal(manifestMatchesDisk(recorded, liveScope), false, "same-scope content drift was trusted");
    fs.writeFileSync(path.join(root, "SKILL.md"), "fixture-skill\n", "utf8");

    writeFixture(root, "scripts/stale-managed.mjs", "stale\n");
    assert.equal(manifestMatchesDisk(recorded, liveScope), false, "stale managed file was ignored");
    const hiddenByExclude = {
      ...liveScope,
      explicit_excludes: [
        ...liveScope.explicit_excludes,
        { path_or_pattern: "scripts/stale-managed.mjs", reason: "self-attested hidden file" },
      ],
    };
    hiddenByExclude.scope_digest = recomputeScopeDigest(hiddenByExclude);
    assert.equal(checkSyncScope({
      scope: hiddenByExclude,
      enumerated_source_files: hiddenByExclude.files,
      verify_disk: true,
    }).ok, false, "arbitrary explicit exclude hid a managed file");
    fs.rmSync(path.join(root, "scripts", "stale-managed.mjs"));

    const missingManagedRoot = {
      ...liveScope,
      managed_top_level: liveScope.managed_top_level.filter((item) => item !== "tests"),
    };
    missingManagedRoot.scope_digest = recomputeScopeDigest(missingManagedRoot);
    assert.equal(checkSyncScope({
      scope: missingManagedRoot,
      enumerated_source_files: missingManagedRoot.files,
    }).ok, false, "managed top-level roots were self-attested");

    writeFixture(root, "unclassified.txt", "unclassified\n");
    assert.equal(manifestMatchesDisk(recorded, liveScope), false, "unclassified top-level entry was ignored");
    fs.rmSync(path.join(root, "unclassified.txt"));

    try {
      linkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-sync-link-target-"));
      fs.symlinkSync(linkTarget, path.join(root, "scripts", "redirect"), "junction");
      assert.equal(manifestMatchesDisk(recorded, liveScope), false, "junction in managed scope was followed or ignored");
      fs.rmSync(path.join(root, "scripts", "redirect"));
    } catch (error) {
      if (!new Set(["EPERM", "EACCES", "ENOSYS"]).has(error.code)) throw error;
    }

    const wrongScope = { ...liveScope, scope_digest: "0".repeat(64) };
    assert.equal(manifestMatchesDisk(recorded, wrongScope), false, "recorded scope digest was trusted without recomputation");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (linkTarget) fs.rmSync(linkTarget, { recursive: true, force: true });
  }
}

selfTestLiveManifestGate();

function readJsonIfPresent(root, name) {
  if (!root) return null;
  const file = path.join(root, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function writeFixture(root, rel, content) {
  const abs = path.join(root, ...normalizeRel(rel).split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function createSmokeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-active-smoke-"));
  writeFixture(root, "AGENTS.md", "# AGENTS.md\n");
  writeFixture(root, "PROJECT_START_HERE.md", "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 当前项目根目录。\n\n## 启动入口\n\n1. 读取五件套。\n");
  writeFixture(root, "STATUS.md", "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n| 回归 | 正常 | 本地夹具 |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n| 基线 | 通过 | 主线 |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n");
  writeFixture(root, "TODO.md", "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n| P1 | 回归 | 通过 |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n| 无 | 无 |\n");
  writeFixture(root, "HANDOFF.md", "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-08-28 08:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n| 状态 | `STATUS.md` | 当前状态 |\n\n## 未决上下文\n\n- 无\n");
  writeFixture(root, "历史记录/00-历史总目录.md", "# 历史总目录\n\n| history-id | 日期 | 标题 | 路径 | 状态 |\n| --- | --- | --- | --- | --- |\n");
  writeFixture(root, "证据库/总索引/证据总目录.md", "# 证据总目录\n\n| evidence-id | run_id | task_id | 来源 | 摘要 | 路径 | 采纳状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
  writeFixture(root, "项目物料/INDEX.md", "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n");
  return root;
}

function runJsonScript(script, args, options = {}) {
  const child = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90_000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const raw = String(child.stdout || "").trim() || String(child.stderr || "").trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // The caller retains raw output and treats missing JSON as a failed live invocation.
  }
  return { ...child, raw, json };
}

function runActiveRuntimeProbe(activeManifest) {
  const activeRoot = path.resolve(activeManifest.root);
  const script = path.join(activeRoot, "scripts", "project-gov.mjs");
  if (!fs.existsSync(script)) return null;
  const pluginManifestPath = path.join(
    CANONICAL_SOURCE_ROOT,
    "plugin",
    "project-delivery-engine",
    ".codex-plugin",
    "plugin.json",
  );
  let pluginManifestVersion = null;
  try {
    pluginManifestVersion = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8")).version ?? null;
  } catch {
    // The real LR96 input fails closed when the canonical host manifest is absent or invalid.
  }
  const root = createSmokeProject();
  try {
    const inspected = runJsonScript(script, ["inspect", "--root", root, "--json"]);
    const operation = writeFixture(root, "active-smoke.operation.json", `${JSON.stringify({
      schema_version: 2,
      plan_id: "active-smoke",
      knowledge_review: { status: "none", basis: "临时夹具不产生项目知识。" },
      actions: [{
        kind: "write_file",
        path: "历史记录/active-smoke.md",
        content: "# active smoke\n",
        overwrite: false,
      }],
    }, null, 2)}\n`);
    const compiledPath = path.join(root, ".project-gov", "plans", "active-smoke.json");
    const proposed = runJsonScript(script, [
      "propose", "--root", root, "--plan", operation, "--out", compiledPath, "--json",
    ]);
    const compiled = fs.existsSync(compiledPath) ? JSON.parse(fs.readFileSync(compiledPath, "utf8")) : null;
    const applied = compiled ? runJsonScript(script, ["apply", "--plan", compiledPath, "--json"]) : null;

    const todo = path.join(root, "TODO.md");
    const todoBefore = fs.readFileSync(todo, "utf8");
    const rollbackOperation = writeFixture(root, "active-rollback.operation.json", `${JSON.stringify({
      schema_version: 2,
      plan_id: "active-rollback",
      knowledge_review: { status: "none", basis: "临时夹具不产生项目知识。" },
      actions: [
        {
          kind: "write_file",
          path: "历史记录/active-rollback.md",
          content: "# rollback smoke\n",
          overwrite: false,
        },
        {
          kind: "replace_line_contains",
          path: "TODO.md",
          contains: "| P1 | 回归 | 通过 |",
          replacement: "| P1 | 回归 | 回滚夹具 |",
        },
      ],
    }, null, 2)}\n`);
    const rollbackPlan = path.join(root, ".project-gov", "plans", "active-rollback.json");
    const rollbackProposed = runJsonScript(script, [
      "propose", "--root", root, "--plan", rollbackOperation, "--out", rollbackPlan, "--json",
    ]);
    const hook = writeFixture(root, "active-smoke-fault-hook.mjs", [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const target = path.resolve(process.env.PDE_ACTIVE_SMOKE_FAIL_TARGET || "");',
      'const originalRenameSync = fs.renameSync.bind(fs);',
      'let injected = false;',
      'fs.renameSync = (from, to) => {',
      '  if (!injected && path.resolve(String(to)) === target) {',
      '    injected = true;',
      '    const error = new Error("active_smoke_injected_second_write_failure");',
      '    error.code = "EIO";',
      '    throw error;',
      '  }',
      '  return originalRenameSync(from, to);',
      '};',
      '',
    ].join("\n"));
    const rollback = rollbackProposed.status === 0
      ? runJsonScript(script, ["apply", "--plan", rollbackPlan, "--json"], {
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(hook).href}`.trim(),
          PDE_ACTIVE_SMOKE_FAIL_TARGET: todo,
        },
      })
      : null;
    const rollbackPassed = rollback?.status !== 0
      && rollback.json?.rollback_attempted === true
      && rollback.json?.rolled_back === true
      && rollback.json?.rollback_complete === true
      && rollback.json?.rollback_incomplete === false
      && fs.readFileSync(todo, "utf8") === todoBefore
      && !fs.existsSync(path.join(root, "历史记录", "active-rollback.md"));
    return {
      active_runtime: {
        skill_version: inspected.json?.skill_version,
        plugin_manifest_version: pluginManifestVersion,
        compiled_schema_version: compiled?.compiled_schema_version,
        operation_schema_version: compiled?.operation_schema_version,
        project_structure_version: inspected.json?.project_structure_version,
        decision_policy_version: inspected.json?.decision_policy_version,
        formal_version_present: inspected.json?.skill_version === "0.3.8",
        host_prerelease_supported: inspected.status === 0 && inspected.json?.skill_version === "0.3.8-rc7",
      },
      active_smoke: {
        ran_from_active_skill: true,
        inspect: inspected.status === 0 && inspected.json?.ok === true ? "PASS" : "FAIL",
        propose: proposed.status === 0 && proposed.json?.ok === true ? "PASS" : "FAIL",
        apply: applied?.status === 0 && applied.json?.ok === true ? "PASS" : "FAIL",
        rollback: rollbackPassed ? "PASS" : "FAIL",
        exit_code: inspected.status === 0
          && proposed.status === 0
          && applied?.status === 0
          && rollbackPassed ? 0 : 1,
      },
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function loadFreezeEvidence(root, scopeValue, expectedSourceRoot = CANONICAL_SOURCE_ROOT) {
  if (!root || !fs.existsSync(root) || !scopeValue?.source_root) return null;
  const required = [
    "head.txt",
    "status-porcelain.txt",
    "diff-working-tree.patch",
    "diff-index.patch",
    "initial-change-manifest.json",
  ];
  const files = Object.fromEntries(required.map((name) => [name, resolveRegularEvidenceFile(root, name)]));
  if (Object.values(files).some((file) => !file)) return null;
  const head = readStrictUtf8(files["head.txt"]).trim();
  const status = fs.readFileSync(files["status-porcelain.txt"]);
  const workingTreeDiff = fs.readFileSync(files["diff-working-tree.patch"]);
  const indexDiff = fs.readFileSync(files["diff-index.patch"]);
  let manifest;
  try {
    manifest = JSON.parse(readStrictUtf8(files["initial-change-manifest.json"]));
  } catch {
    return null;
  }
  const sourceRoot = path.resolve(expectedSourceRoot);
  const sourceSnapshotRoot = resolveRegularEvidenceDirectory(root, manifest?.source_snapshot_root);
  const pluginHostEntries = Array.isArray(manifest?.entries)
    ? manifest.entries.filter((entry) => normalizeRel(entry?.path).startsWith("plugin-host/"))
    : [];
  const pluginHostSnapshotRoot = pluginHostEntries.length > 0
    ? resolveRegularEvidenceDirectory(root, manifest?.plugin_host_snapshot_root)
    : null;
  const snapshotFiles = [];
  let snapshotsValid = Array.isArray(manifest?.entries) && manifest.entries.length > 0 && Boolean(sourceSnapshotRoot);
  for (const entry of manifest?.entries ?? []) {
    const logical = normalizeRel(entry?.path);
    const logicalPrefix = logical.startsWith("source/") ? "source/"
      : logical.startsWith("plugin-host/") ? "plugin-host/" : null;
    const relative = logicalPrefix ? logical.slice(logicalPrefix.length) : "";
    const snapshotPrefix = logicalPrefix === "source/"
      ? normalizeRel(manifest.source_snapshot_root)
      : normalizeRel(manifest.plugin_host_snapshot_root);
    const expectedSnapshot = logicalPrefix && isSafeRel(relative) && isSafeRel(snapshotPrefix)
      ? normalizeRel(path.posix.join(snapshotPrefix, relative))
      : null;
    const snapshot = resolveRegularEvidenceFile(root, entry?.snapshot_path);
    snapshotFiles.push(snapshot);
    if (!snapshot
      || normalizeRel(entry?.snapshot_path) !== expectedSnapshot
      || fs.statSync(snapshot).size !== entry?.bytes
      || fileDigest(snapshot) !== entry?.sha256) snapshotsValid = false;
  }
  const entryPaths = Array.isArray(manifest?.entries) ? manifest.entries.map((entry) => normalizeRel(entry?.path)) : [];
  const snapshotPaths = Array.isArray(manifest?.entries) ? manifest.entries.map((entry) => normalizeRel(entry?.snapshot_path)) : [];
  const realSnapshotPaths = snapshotFiles.filter(Boolean)
    .map((file) => canonicalPathIdentity(fs.realpathSync.native(file)));
  const manifestPathsUnique = entryPaths.length > 0
    && new Set(entryPaths.map(canonicalPathIdentity)).size === entryPaths.length
    && new Set(snapshotPaths.map(canonicalPathIdentity)).size === snapshotPaths.length
    && realSnapshotPaths.length === snapshotPaths.length
    && new Set(realSnapshotPaths).size === realSnapshotPaths.length;
  const sourcePaths = Array.isArray(manifest?.entries)
    ? manifest.entries.filter((entry) => normalizeRel(entry?.path).startsWith("source/"))
      .map((entry) => normalizeRel(entry?.path).slice("source/".length))
    : [];
  const sortedEntryPaths = [...entryPaths].sort();
  const manifestValid = Boolean(manifest?.schema_version === 1
    && sameResolvedPath(manifest.git_root, sourceRoot)
    && isSafeRel(manifest.source_snapshot_root)
    && sourceSnapshotRoot
    && (pluginHostEntries.length === 0
      || (isSafeRel(manifest.plugin_host_snapshot_root) && pluginHostSnapshotRoot))
    && Array.isArray(manifest.entries)
    && manifest.entries.length > 0
    && entryPaths.every((item, index) => item === sortedEntryPaths[index])
    && manifest.entries.every((entry) => entry && isSafeRel(entry.path)
      && isSafeRel(entry.snapshot_path)
      && Number.isSafeInteger(entry.bytes)
      && entry.bytes >= 0
      && SHA256_RE.test(entry.sha256 ?? "")
      && (normalizeRel(entry.path).startsWith("source/") || normalizeRel(entry.path).startsWith("plugin-host/"))));

  const snapshotScope = sourceSnapshotRoot ? { ...scopeValue, source_root: sourceSnapshotRoot } : null;
  const sourceScopeBound = Boolean(sourceSnapshotRoot
    && sameResolvedPath(scopeValue.source_root, sourceRoot)
    && sameStrings(sourcePaths, scopeValue.files)
    && checkSyncScope({
      scope: snapshotScope,
      enumerated_source_files: sourcePaths,
      verify_disk: true,
    }, sourceSnapshotRoot).ok);
  const gitTopLevelRaw = runGit(sourceRoot, ["rev-parse", "--show-toplevel"], "utf8");
  const initialGit = sourceSnapshotRoot ? captureGitWorkTree(sourceRoot, sourceSnapshotRoot) : null;
  const gitBindingValid = typeof gitTopLevelRaw === "string"
    && initialGit
    && sameResolvedPath(gitTopLevelRaw.trim(), sourceRoot)
    && initialGit.head === head
    && initialGit.status.equals(status)
    && initialGit.working_tree_diff.equals(workingTreeDiff)
    && initialGit.index_diff.equals(indexDiff);
  return {
    root: path.resolve(root),
    source_root: sourceRoot,
    source_snapshot_root: sourceSnapshotRoot,
    head,
    manifest,
    status_path: files["status-porcelain.txt"],
    working_tree_diff_path: files["diff-working-tree.patch"],
    index_diff_path: files["diff-index.patch"],
    head_valid: GIT_OID_RE.test(head),
    status_present: status.length > 0,
    binary_diff_present: workingTreeDiff.length > 0,
    manifest_valid: manifestValid,
    snapshots_valid: snapshotsValid,
    manifest_paths_unique: manifestPathsUnique,
    source_scope_bound: sourceScopeBound,
    head_manifest_bound: manifest?.head === head && sameResolvedPath(manifest?.git_root, sourceRoot),
    git_binding_valid: gitBindingValid,
  };
}

function loadFinalGitEvidence(root, freeze) {
  if (!root || !freeze?.source_root || !freeze?.head) return null;
  const required = [
    "final-head.txt",
    "final-status-porcelain.txt",
    "final-diff-working-tree.patch",
    "final-diff-index.patch",
  ];
  const files = Object.fromEntries(required.map((name) => [name, resolveRegularEvidenceFile(root, name)]));
  if (Object.values(files).some((file) => !file)) return null;
  let head;
  try {
    head = readStrictUtf8(files["final-head.txt"]).trim();
  } catch {
    return null;
  }
  const status = fs.readFileSync(files["final-status-porcelain.txt"]);
  const workingTreeDiff = fs.readFileSync(files["final-diff-working-tree.patch"]);
  const indexDiff = fs.readFileSync(files["final-diff-index.patch"]);
  const finalGit = captureGitWorkTree(freeze.source_root, freeze.source_root);
  const gitBindingValid = Boolean(finalGit
    && GIT_OID_RE.test(head)
    && head === freeze.head
    && finalGit.head === head
    && finalGit.status.equals(status)
    && finalGit.working_tree_diff.equals(workingTreeDiff)
    && finalGit.index_diff.equals(indexDiff));
  return {
    head,
    head_path: files["final-head.txt"],
    status_path: files["final-status-porcelain.txt"],
    working_tree_diff_path: files["final-diff-working-tree.patch"],
    index_diff_path: files["final-diff-index.patch"],
    status_present: status.length > 0,
    binary_diff_present: workingTreeDiff.length > 0,
    git_binding_valid: gitBindingValid,
  };
}

function selfTestFreezeBinding() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pde-v038-fake-freeze-"));
  try {
    const gitRootPath = path.join(root, "git-root");
    const emptyHooksPath = path.join(root, "empty-hooks");
    fs.mkdirSync(gitRootPath, { recursive: true });
    fs.mkdirSync(emptyHooksPath, { recursive: true });
    const gitRoot = fs.realpathSync.native(gitRootPath);
    writeFixture(gitRoot, "SKILL.md", "baseline\n");
    const invokeGit = (args) => spawnSync("git", ["-C", gitRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const gitSteps = [
      ["init", "--quiet"],
      ["config", "user.name", "PDE Sync Self-Test"],
      ["config", "user.email", "pde-sync-self-test@example.invalid"],
      ["config", "core.autocrlf", "false"],
      ["config", "core.hooksPath", emptyHooksPath],
      ["add", "--", "SKILL.md"],
      ["commit", "--quiet", "--no-gpg-sign", "-m", "self-test baseline"],
    ];
    for (const args of gitSteps) {
      const step = invokeGit(args);
      assert.equal(step.status, 0, `temporary Git repository setup failed: git ${args.join(" ")}: ${step.stderr || ""}`);
    }
    const snapshotRoot = path.join(root, "source-repo");
    const snapshot = writeFixture(snapshotRoot, "SKILL.md", "fake\n");
    for (const rel of EXPECTED_MANAGED_TOP_LEVEL.filter((item) => !["SKILL.md"].includes(item))) {
      fs.mkdirSync(path.join(snapshotRoot, rel), { recursive: true });
    }
    const scopeValue = {
      schema_version: 1,
      source_root: gitRoot,
      managed_top_level: [...EXPECTED_MANAGED_TOP_LEVEL],
      files: ["SKILL.md"],
      explicit_excludes: ALLOWED_EXCLUDE_PATTERNS.map((path_or_pattern) => ({
        path_or_pattern,
        reason: "canonical non-runtime path",
      })),
    };
    scopeValue.scope_digest = recomputeScopeDigest(scopeValue);
    const initialGit = captureGitWorkTree(gitRoot, snapshotRoot);
    assert.ok(initialGit, "isolated-index Git snapshot fixture could not be captured");
    const manifest = {
      schema_version: 1,
      git_root: gitRoot,
      source_snapshot_root: "source-repo",
      head: initialGit.head,
      entries: [{
        path: "source/SKILL.md",
        snapshot_path: "source-repo/SKILL.md",
        bytes: fs.statSync(snapshot).size,
        sha256: fileDigest(snapshot),
      }],
    };
    writeFixture(root, "head.txt", `${initialGit.head}\n`);
    writeFixture(root, "status-porcelain.txt", initialGit.status);
    writeFixture(root, "diff-working-tree.patch", initialGit.working_tree_diff);
    writeFixture(root, "diff-index.patch", initialGit.index_diff);
    writeFixture(root, "initial-change-manifest.json", `${JSON.stringify(manifest)}\n`);
    const valid = loadFreezeEvidence(root, scopeValue, gitRoot);
    assert.ok(valid, "valid alternate-work-tree freeze fixture did not load");
    assert.equal(checkFreeze(valid).ok, true,
      `real Git + prechange work-tree freeze was rejected: ${JSON.stringify(valid)}`);

    const forged = { ...manifest, head: "1".repeat(40) };
    writeFixture(root, "head.txt", `${forged.head}\n`);
    writeFixture(root, "initial-change-manifest.json", `${JSON.stringify(forged)}\n`);
    const fake = loadFreezeEvidence(root, scopeValue, gitRoot);
    assert.ok(fake, "fake freeze fixture did not load");
    assert.equal(checkFreeze(fake).ok, false, "non-matching Git evidence passed LR83");

    writeFixture(root, "head.txt", `${initialGit.head}\n`);
    const duplicate = structuredClone(manifest);
    duplicate.entries.push({ ...duplicate.entries[0] });
    writeFixture(root, "initial-change-manifest.json", `${JSON.stringify(duplicate)}\n`);
    const duplicateLoaded = loadFreezeEvidence(root, scopeValue, gitRoot);
    assert.ok(duplicateLoaded, "duplicate freeze fixture did not load");
    assert.equal(checkFreeze(duplicateLoaded).ok, false, "duplicate logical/snapshot paths passed LR83");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let freezeBindingSelfTest;
try {
  selfTestFreezeBinding();
  freezeBindingSelfTest = { status: "PASS", detail: "temporary Git fixture passed" };
} catch (error) {
  freezeBindingSelfTest = {
    status: "FAIL",
    detail: error instanceof Error ? error.message : String(error),
  };
}

const freezeRoot = process.env.PDE038_FREEZE_DIR ? path.resolve(process.env.PDE038_FREEZE_DIR) : null;
const evidenceRoot = process.env.PDE038_FINAL_EVIDENCE_DIR ? path.resolve(process.env.PDE038_FINAL_EVIDENCE_DIR) : null;
const missingRuntimeInputs = [];
if (!fs.existsSync(path.join(CANONICAL_SOURCE_ROOT, ".git", "index"))) {
  missingRuntimeInputs.push("PDE038_SOURCE_ROOT (Git work-tree root)");
}
if (!freezeRoot) missingRuntimeInputs.push("PDE038_FREEZE_DIR");
if (!evidenceRoot) missingRuntimeInputs.push("PDE038_FINAL_EVIDENCE_DIR");
const initialManifest = freezeRoot ? readJsonIfPresent(freezeRoot, "initial-change-manifest.json") : null;
const reconciliation = readJsonIfPresent(evidenceRoot, "initial-change-reconciliation.json");
const scope = readJsonIfPresent(evidenceRoot, "sync-scope.json");
const source = readJsonIfPresent(evidenceRoot, "source-recursive-manifest.json");
const mirror = readJsonIfPresent(evidenceRoot, "repo-mirror-recursive-manifest.json");
const active = readJsonIfPresent(evidenceRoot, "active-skill-recursive-manifest.json");
const gate = readJsonIfPresent(evidenceRoot, "local-runtime-rc-gate.json");
const freezeEvidence = freezeRoot && scope ? loadFreezeEvidence(freezeRoot, scope) : null;
const finalGitEvidence = evidenceRoot && freezeEvidence ? loadFinalGitEvidence(evidenceRoot, freezeEvidence) : null;
let liveRuntimeProbe = null;
if (active && scope) {
  try {
    liveRuntimeProbe = runActiveRuntimeProbe(active);
  } catch (error) {
    liveRuntimeProbe = { error: error.message };
  }
}

function realInput(id) {
  const initialPaths = initialManifest?.entries?.map((entry) => entry.path);
  const number = Number(id.slice(2));
  if (number === 83) return freezeEvidence;
  if (number === 84) return reconciliation && initialPaths ? { reconciliation, initial_paths: initialPaths } : null;
  if (number === 85 || number === 86) return reconciliation ? { reconciliation } : null;
  if (number === 87) return gate && freezeEvidence && finalGitEvidence && reconciliation && evidenceRoot
    ? {
      ...gate,
      freeze: freezeEvidence,
      final_git: finalGitEvidence,
      reconciliation,
      evidence_root: evidenceRoot,
      verify_disk: true,
    }
    : null;
  if (number === 89) return scope && gate?.enumerated_source_files
    ? { scope, enumerated_source_files: gate.enumerated_source_files, verify_disk: true }
    : null;
  if (number === 90) return source && scope
    ? { manifest: source, scope, scope_files: scope.files, verify_disk: true }
    : null;
  if (number === 91) return source && mirror && scope
    ? { source, mirror, scope, verify_disk: true }
    : null;
  if (number === 92) return mirror && active && scope
    ? { mirror, active, scope, verify_disk: true }
    : null;
  if (number === 93 || number === 94) return gate && source && mirror && active && scope
    ? { ...gate, source, mirror, active, scope, verify_disk: true }
    : null;
  if (number === 95) return source && mirror && active && scope
    ? { source, mirror, active, scope, verify_disk: true }
    : null;
  if (number === 96) return liveRuntimeProbe?.active_runtime
    ? { active_runtime: liveRuntimeProbe.active_runtime }
    : null;
  if (number === 97) return liveRuntimeProbe?.active_smoke
    ? { active_smoke: liveRuntimeProbe.active_smoke }
    : null;
  if (number === 98) return gate && source && mirror && active && scope
    ? { ...gate, source, mirror, active, scope }
    : null;
  if (number === 99) return gate && freezeEvidence && scope
    ? { ...gate, freeze: freezeEvidence, scope, verify_disk: true }
    : null;
  return gate;
}

const rows = [];
for (const item of CASES) {
  if (freezeBindingSelfTest.status !== "PASS") {
    rows.push({
      id: item.id,
      status: "FAIL",
      verifier_self_test: freezeBindingSelfTest.status,
      detail: `freeze-binding verifier self-test failed: ${freezeBindingSelfTest.detail}`,
    });
    continue;
  }
  const input = realInput(item.id);
  if (!input) {
    rows.push({
      id: item.id,
      status: "PENDING",
      verifier_self_test: freezeBindingSelfTest.status,
      detail: missingRuntimeInputs.length > 0
        ? `required runtime input is not present: ${missingRuntimeInputs.join(", ")}; no PASS was inferred`
        : "required real Gate evidence file is not present or invalid; no PASS was inferred",
    });
    continue;
  }
  const checked = item.check(item.id === "LR100"
    ? { ...input, prerequisite_rows: rows.filter((row) => FINAL_REPORT_PREREQUISITES.includes(row.id)) }
    : input);
  rows.push({
    id: item.id,
    status: checked.ok ? "PASS" : "FAIL",
    verifier_self_test: freezeBindingSelfTest.status,
    detail: checked.reason,
  });
}

const statuses = new Set(rows.map((row) => row.status));
const overall = statuses.has("FAIL") ? "FAIL" : statuses.has("PENDING") ? "PENDING" : "PASS";
process.stdout.write(`${JSON.stringify({
  suite: "project-gov-v038-sync-integrity",
  overall,
  canonical_source_root: CANONICAL_SOURCE_ROOT,
  real_gate_evidence_root: evidenceRoot,
  rows,
}, null, 2)}\n`);

if (overall === "FAIL") process.exitCode = 1;
if (overall === "PENDING") process.exitCode = 2;
