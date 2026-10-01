import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(skillRoot, "scripts", "project-gov.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "project-gov-structure-"));
let sequence = 0;

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function createProject(name) {
  sequence += 1;
  const root = path.join(sandbox, `${String(sequence).padStart(2, "0")}-${name}`);
  write(root, "AGENTS.md", "# AGENTS.md\n");
  write(root, "PROJECT_START_HERE.md", "# PROJECT_START_HERE.md\n\n## 项目路径\n\n- 当前夹具。\n\n## 启动入口\n\n1. 读取五件套。\n");
  write(root, "STATUS.md", "# STATUS.md\n\n## 当前状态\n\n| 项目 | 状态 | 依据 |\n| --- | --- | --- |\n\n## 验证\n\n| 验证项 | 结果 | 层级 |\n| --- | --- | --- |\n| 基线 | 通过 | 主线 |\n\n## 风险\n\n- 无\n\n## 关键引用\n\n- 无\n");
  write(root, "TODO.md", "# TODO.md\n\n## 下一步\n\n| 优先级 | 事项 | 完成条件 |\n| --- | --- | --- |\n\n## 待确认\n\n| 事项 | 影响 |\n| --- | --- |\n");
  write(root, "HANDOFF.md", "# HANDOFF.md\n\n## 语义检查点\n\n- 最后语义检查点：2026-07-28 02:00 +08:00\n- 检查点后变化：已核对\n\n## 接手顺序\n\n1. 读取五件套。\n\n## 已证伪路线\n\n| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |\n| --- | --- | --- | --- |\n\n## 关键索引\n\n| 类型 | 路径 | 用途 |\n| --- | --- | --- |\n| 状态 | `STATUS.md` | 当前状态 |\n\n## 未决上下文\n\n- 无\n");
  write(root, "历史记录/00-历史总目录.md", "# 历史总目录\n\n## 阅读说明\n\n| 如果要做 | 先读 |\n| --- | --- |\n\n## 最近历史索引\n\n| history-id | 日期 | 标题 | 路径 | 状态 | 自定义列 |\n| --- | --- | --- | --- | --- | --- |\n");
  write(root, "证据库/总索引/证据总目录.md", "# 证据总目录\n\n| evidence-id | run_id | task_id | 来源 | 摘要 | 路径 | 采纳状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n");
  write(root, "项目物料/INDEX.md", "# 项目物料索引\n\n| material-id | 路径 | hash | 来源 | 用途 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n");
  return root;
}

function run(command, root, extra = []) {
  const result = spawnSync(process.execPath, [script, command, "--root", root, ...extra, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : JSON.parse(result.stderr),
  };
}

function mutate(root, rel, transform) {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, transform(fs.readFileSync(abs, "utf8")), "utf8");
}

function expectStructureError(result, prefix) {
  assert.notEqual(result.status, 0, `expected ${prefix}`);
  assert.ok(result.json.errors.some((error) => error.startsWith(prefix)), result.stdout);
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function paragraphContaining(text, marker, label) {
  const paragraph = text.replace(/\r\n/gu, "\n")
    .split(/\n{2,}/u)
    .find((item) => item.includes(marker));
  assert.ok(paragraph, `${label}: paragraph containing ${marker} is missing`);
  return paragraph;
}

function assertTerms(text, terms, label) {
  for (const term of terms) {
    assert.ok(text.includes(term), `${label}: missing contract term ${term}`);
  }
}

try {
  const templatesDoc = fs.readFileSync(path.join(skillRoot, "references", "project-file-templates.md"), "utf8");
  const projectStartTemplate = templatesDoc.match(/## PROJECT_START_HERE\.md\s*\r?\n\s*```text\s*\r?\n([\s\S]*?)\r?\n```/u)?.[1];
  assert.ok(projectStartTemplate, "PROJECT_START_HERE template is missing");
  assert.match(projectStartTemplate, /^## 项目路径$/mu);
  assert.doesNotMatch(projectStartTemplate, /^## 项目根$/mu);

  const templateProject = createProject("template-project-start");
  write(templateProject, "PROJECT_START_HERE.md", `${projectStartTemplate}\n`);
  const templateProjectResult = run("validate", templateProject);
  assert.equal(templateProjectResult.status, 0, templateProjectResult.stderr);
  assert.equal(templateProjectResult.json.ok, true);

  const officialExample = path.join(sandbox, "00-official-minimal-example");
  fs.cpSync(path.join(skillRoot, "examples", "minimal-project"), officialExample, { recursive: true });
  mutate(officialExample, "HANDOFF.md", (text) => text
    .replace("<复制后填写真实时间>", "2026-07-30 23:00 +08:00")
    .replace("检查点后变化：待确认", "检查点后变化：已核对"));
  const officialExampleResult = run("validate", officialExample);
  assert.equal(officialExampleResult.status, 0, officialExampleResult.stderr);
  assert.equal(officialExampleResult.json.ok, true);

  const valid = createProject("valid");
  const validResult = run("validate", valid);
  assert.equal(validResult.status, 0, validResult.stderr);
  assert.equal(validResult.json.ok, true);
  assert.equal(validResult.json.report.structure.ok, true);
  assert.equal(validResult.json.project_knowledge_checked_by_tool, false);
  assert.ok(validResult.json.report.structure.not_checked.includes("project_knowledge_completeness"));
  assert.ok(!validResult.json.warnings.includes("five_piece_remaining_below_2kib"));

  mutate(valid, "STATUS.md", (text) => `${text}\n\`\`\`text\n## 验证\n| 假 | 表 |\n| --- | --- |\n\`\`\`\n<!-- ## 验证 -->\n`);
  assert.equal(run("validate", valid).status, 0, "code/comment content must not create duplicate structure");

  const invalidLayer = createProject("invalid-layer");
  mutate(invalidLayer, "STATUS.md", (text) => text.replace("| 基线 | 通过 | 主线 |", "| 基线 | 通过 | 辅助 |"));
  expectStructureError(run("validate", invalidLayer), "structure_value_invalid:STATUS.md:验证");

  const missingTodo = createProject("missing-todo-section");
  mutate(missingTodo, "TODO.md", (text) => text.replace(/## 待确认[\s\S]*$/, ""));
  expectStructureError(run("validate", missingTodo), "structure_section_missing:TODO.md:待确认");
  const todoPath = path.join(missingTodo, "TODO.md");
  const beforeMigrationCheck = hashFile(todoPath);
  const migration = run("migrate-check", missingTodo);
  assert.notEqual(migration.status, 0);
  assert.equal(migration.json.automatic_rewrite, false);
  assert.equal(migration.json.project_knowledge_checked_by_tool, false);
  assert.equal(migration.json.knowledge_review.blocking, false);
  assert.ok(migration.json.migration_items.some((item) => item.code.startsWith("structure_section_missing:TODO.md:待确认")));
  assert.equal(hashFile(todoPath), beforeMigrationCheck, "migrate-check must be read-only");

  const optionalRoutes = createProject("optional-routes");
  mutate(optionalRoutes, "HANDOFF.md", (text) => text.replace(/## 已证伪路线[\s\S]*?(?=## 关键索引)/, ""));
  const optionalResult = run("validate", optionalRoutes);
  assert.equal(optionalResult.status, 0, optionalResult.stderr);
  assert.ok(optionalResult.json.warnings.includes("missing_handoff_falsified_routes"));

  const malformedRoutes = createProject("malformed-routes");
  mutate(malformedRoutes, "HANDOFF.md", (text) => text
    .replace("| 路线/假设 | 证伪证据（一行） | 关闭日期 | 复开条件 |", "| 路线/假设 | 证伪证据（一行） | 复开条件 |")
    .replace("| --- | --- | --- | --- |", "| --- | --- | --- |"));
  expectStructureError(run("validate", malformedRoutes), "structure_columns_missing:HANDOFF.md:已证伪路线");

  const brokenTable = createProject("broken-table");
  mutate(brokenTable, "HANDOFF.md", (text) => text.replace("| 状态 | `STATUS.md` | 当前状态 |", "\n| 状态 | `STATUS.md` | 当前状态 |"));
  expectStructureError(run("validate", brokenTable), "structure_table_discontinuous:HANDOFF.md:关键索引");

  const oldIndex = createProject("old-index");
  mutate(oldIndex, "历史记录/00-历史总目录.md", (text) => text
    .replace("| history-id | 日期 | 标题 | 路径 | 状态 | 自定义列 |", "| history-id | 类型 | 标题 | 位置 | 说明 |")
    .replace("| --- | --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- |"));
  expectStructureError(run("validate", oldIndex), "structure_columns_missing:历史记录/00-历史总目录.md:root");

  const lowSpace = createProject("low-space");
  const beforePadding = run("inspect", lowSpace).json.five_piece.total_bytes;
  const targetBytes = 45 * 1024 - 1024;
  fs.appendFileSync(path.join(lowSpace, "AGENTS.md"), "x".repeat(targetBytes - beforePadding), "utf8");
  const lowSpaceResult = run("validate", lowSpace);
  assert.equal(lowSpaceResult.status, 0, lowSpaceResult.stderr);
  assert.ok(lowSpaceResult.json.warnings.includes("five_piece_remaining_below_2kib"));
  assert.equal(lowSpaceResult.json.report.five_piece.remaining_bytes, 1024);

  const startupRoot = createProject("startup");
  write(startupRoot, "项目物料/无关主题.md", "# 无关主题\n\nUNRELATED_KNOWLEDGE_SENTINEL\n");
  const knowledgeHash = hashFile(path.join(startupRoot, "项目物料", "无关主题.md"));
  mutate(startupRoot, "项目物料/INDEX.md", (text) => `${text}| MAT-20260730-001 | 项目物料/无关主题.md | ${knowledgeHash} | 本地 | 无关主题权威入口 | active |\n`);
  const startup = run("startup", startupRoot);
  assert.equal(startup.status, 0, startup.stderr);
  assert.match(startup.json.startup, /按本 Skill 的状态治理边界/);
  assert.match(startup.json.startup, /具体执行与隔离方式由宿主运行时决定/);
  assert.match(startup.json.startup, /轻量相关性判断/);
  assert.match(startup.json.startup, /仅命中时读取最相关的权威知识入口/);
  assert.match(startup.json.startup, /不递归展开或批量加载知识资产/);
  assert.doesNotMatch(startup.json.startup, /UNRELATED_KNOWLEDGE_SENTINEL/);
  assert.ok(Buffer.byteLength(startup.json.startup, "utf8") < 2048);
  assert.equal(Object.hasOwn(startup.json, "knowledge_assets"), false);
  assert.doesNotMatch(startup.json.startup, /项目总调度/);

  const skillSource = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const stateDoc = fs.readFileSync(path.join(skillRoot, "references", "project-state.md"), "utf8");
  const knowledgeDoc = fs.readFileSync(path.join(skillRoot, "references", "project-knowledge.md"), "utf8");
  const collaborationDoc = fs.readFileSync(path.join(skillRoot, "references", "collaboration.md"), "utf8");
  const cliDoc = fs.readFileSync(path.join(skillRoot, "references", "project-gov-cli.md"), "utf8");
  const taskcardDoc = fs.readFileSync(path.join(skillRoot, "references", "taskcard-evidencebundle.md"), "utf8");
  const troubleshootingDoc = fs.readFileSync(path.join(skillRoot, "references", "troubleshooting.md"), "utf8");
  const interfaceDoc = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  const frontmatterDescription = skillSource.match(/^description:\s*"([^"]+)"\s*$/mu)?.[1] || "";
  assert.ok(frontmatterDescription.includes("必须读取或更新当前项目的持久治理状态"));
  assert.ok(
    frontmatterDescription.indexOf("必须读取或更新当前项目的持久治理状态")
      < frontmatterDescription.indexOf("仅因任务长期"),
    "persistent-state gate must precede long-task exclusions in discovery metadata",
  );
  assert.doesNotMatch(skillSource, /项目总调度/);
  assertTerms(
    paragraphContaining(skillSource, "轻量相关性判断", "knowledge routing"),
    ["现有入口", "相关性判断", "最相关", "不批量"],
    "knowledge routing",
  );
  assertTerms(
    paragraphContaining(skillSource, "knowledge_review", "knowledge review routing"),
    ["治理写入", "判断依据", "空计划"],
    "knowledge review routing",
  );
  assertTerms(skillSource, ["宿主运行时", "主线程", "最终采纳", "不得绕过"], "top-level boundaries");
  assertTerms(
    paragraphContaining(stateDoc, "轻量相关性判断", "state knowledge discovery"),
    ["相关性判断", "最相关", "静默继续", "不批量"],
    "state knowledge discovery",
  );
  assertTerms(
    paragraphContaining(stateDoc, "PROGRESS.md", "progress ledger pointer"),
    ["已有指针", "首次落账", "checkpoint", "意外中断", "实质变化", "不反复改三件套"],
    "progress ledger pointer",
  );
  assertTerms(
    paragraphContaining(stateDoc, "阶段/Gate 收口", "stage close checkpoint"),
    ["未吸收", "实质变化", "checkpoint", "不为阶段结束", "三件套"],
    "stage close checkpoint",
  );
  assertTerms(
    paragraphContaining(stateDoc, "项目根识别方式", "portable project entry"),
    ["PROJECT_START_HERE.md", "项目根识别方式", "启动入口", "固定绝对路径"],
    "portable project entry",
  );
  assert.match(knowledgeDoc, /## 发现与消费/);
  assertTerms(
    paragraphContaining(knowledgeDoc, "不算可发现", "knowledge discoverability"),
    ["五件套", "三个核心索引", "权威文档", "不算可发现", "第四张索引"],
    "knowledge discoverability",
  );
  assertTerms(knowledgeDoc, ["消费知识", "不要求", "使用记录", "知识索引"], "knowledge consumption cost");
  assertTerms(knowledgeDoc, ["知识卡", "使用日志", "第四索引", "历史回填记录"], "temporary review lifecycle");
  assertTerms(
    paragraphContaining(knowledgeDoc, "declaration_only", "declaration-only role"),
    ["knowledge_review.status: updated", "paths", "编译器", "内部角色", "不是可填写的 `status`"],
    "declaration-only role",
  );
  assertTerms(
    paragraphContaining(collaborationDoc, "正式 TaskCard", "formal collaboration scope"),
    ["文件", "代码", "产物写入", "隔离写入", "独立复审", "持久治理记录", "简单只读", "宿主原生任务合同", "证据", "风险", "未覆盖项"],
    "formal collaboration scope",
  );
  assertTerms(collaborationDoc, ["主线程", "裁决", "严重问题", "不得宣布完成"], "review ownership");
  assert.match(collaborationDoc, /不得为了使用 worktree 初始化 Git/);
  assertTerms(collaborationDoc, ["搜索", "长文件", "日志", "限制范围", "完整的读改测循环"], "context budget");
  assert.doesNotMatch(collaborationDoc, /## 路线|## 模型选择|DispatchPlan/);
  assert.match(taskcardDoc, /读取范围：/);
  assert.match(taskcardDoc, /验收要求：/);
  assert.match(taskcardDoc, /停止条件：/);
  assert.match(taskcardDoc, /风险与未覆盖项：/);
  assertTerms(
    paragraphContaining(taskcardDoc, "简单只读协作", "taskcard applicability"),
    ["文件", "代码", "产物写入", "隔离写入", "独立复审", "持久治理记录", "宿主原生任务合同", "证据", "风险"],
    "taskcard applicability",
  );
  assert.doesNotMatch(taskcardDoc, /模型决策/);
  assertTerms(
    paragraphContaining(cliDoc, "transition_incomplete_issue_set", "incomplete transition policy"),
    ["写前", "写后", "问题集合不完整", "完整检查", "完全合规", "拒绝"],
    "incomplete transition policy",
  );
  assert.doesNotMatch(cliDoc, /覆盖不完整、但没有发现明确错误时，才允许完成/);
  assertTerms(
    paragraphContaining(cliDoc, "1024 个 UTF-8 字节", "transaction plan id"),
    ["plan_id", "1024", "UTF-8", "操作计划", "编译计划", "apply", "重新预演"],
    "transaction plan id",
  );
  assertTerms(
    paragraphContaining(cliDoc, "workflow_artifact_too_large", "workflow JSON size"),
    ["文件", "标准输入", "16 MiB", "200", "8 MiB", "512 KiB", "16 KiB"],
    "workflow JSON size",
  );
  assertTerms(
    paragraphContaining(cliDoc, "4096 个 UTF-8 字节", "transaction path size"),
    ["动作路径", "4096", "UTF-8", "事务临时文件名", "创建锁和备份前", "重新预演"],
    "transaction path size",
  );
  assertTerms(
    paragraphContaining(cliDoc, "third_party_state", "third-party transaction state"),
    ["每个文件落盘前", "其他进程", "第三方状态", "不以自动回滚覆盖", "不会宣称提交成功", "锁", "事务备份", "极窄并发窗口"],
    "third-party transaction state",
  );
  assert.match(troubleshootingDoc, /## 出错时怎么处理/);
  assertTerms(troubleshootingDoc, ["停止当前写入", "不要绕过", "propose", "apply"], "troubleshooting entry");
  const noStrictImprovementRow = troubleshootingDoc
    .split(/\r?\n/u)
    .find((line) => line.includes("transition_no_strict_improvement"));
  assert.ok(noStrictImprovementRow, "transition_no_strict_improvement guidance is missing");
  assertTerms(noStrictImprovementRow, ["中间进度", "三件套", "轻量进度账", "project-state.md"], "strict improvement guidance");
  assertTerms(troubleshootingDoc, ["plan_id_exceeds_1024_bytes", "compiled_plan_id_exceeds_1024_bytes", "1024", "重新生成"], "plan id troubleshooting");
  assertTerms(troubleshootingDoc, ["workflow_artifact_too_large", "16 MiB", "8 MiB", "移出 JSON"], "JSON troubleshooting");
  assertTerms(troubleshootingDoc, ["path_exceeds_4096_bytes", "transaction_temp_path_exceeds_4096_bytes", "缩短", "重新生成计划"], "path size troubleshooting");
  assertTerms(
    troubleshootingDoc,
    ["third_party_state", "rollback_incomplete", ".project-gov/apply.lock", "先保全第三方改动"],
    "third-party state troubleshooting",
  );
  assertTerms(troubleshootingDoc, ["机械校验", "业务语义", "不得"], "mechanical versus semantic boundary");
  assert.match(interfaceDoc, /icon_small: ".\/assets\/project-delivery-engine-logo\.png"/);
  assert.match(interfaceDoc, /icon_large: ".\/assets\/project-delivery-engine-logo\.png"/);
  assert.equal(fs.existsSync(path.join(skillRoot, "assets", "project-delivery-engine-logo.png")), true);

  console.log("project-gov structure regression tests: PASS");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
