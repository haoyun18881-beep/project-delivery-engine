# project-gov 命令行工具

`project-gov` 负责项目文件机械检查、编号、启动语和受控写入；语义与调度裁决由主线程完成。工具返回的通过只表示机械校验通过，不表示语义完整。

所有 JSON（结构化输出）都会带 `skill_version（技能版本）`；单独保存的编译计划也绑定生成它的技能版本。

## 只读命令

```powershell
node "<skill-dir>\scripts\project-gov.mjs" inspect --root "<项目根>" --json
node "<skill-dir>\scripts\project-gov.mjs" validate --root "<项目根>" --json
node "<skill-dir>\scripts\project-gov.mjs" ids --root "<项目根>" --date YYYYMMDD --json
node "<skill-dir>\scripts\project-gov.mjs" startup --root "<项目根>" --text
node "<skill-dir>\scripts\project-gov.mjs" migrate-check --root "<项目根>" --json
node "<skill-dir>\scripts\project-gov.mjs" verify-materials --root "<项目根>" --json
```

- `inspect`：检查五件套、三个索引、索引登记的 Markdown（标记文本）资料、体量、编号、引用、占位符、必需章节和核心表格结构。源码、日志、第三方副本和未登记的普通说明文件不属于默认治理扫描范围，不会因为数量多或文件大而阻止项目接续。编号与引用扫描最多读取 5000 个受管文件、单文件 2 MiB（兆字节）、合计 32 MiB；超限或索引登记的 Markdown 已缺失时停止完整性声明并返回明确错误。
- 各类问题输出最多展示 100 条样本，但工具会在同一次扫描中对全部已发现问题计算总数和稳定摘要。`truncated: true（展示已截断）` 只表示终端没有展开第 101 条以后，不表示工具漏掉了这些问题；只有文件读取失败、非法 UTF-8、索引登记文件缺失、预算耗尽、索引路径歧义或索引无法完整解析等情况，才会把问题集合标为不完整。
- `validate`：返回机械校验结果；输出必须明确语义未验证。
- `migrate-check（迁移检查）`：只读报告旧项目与当前结构版本的差异，不自动改写，也不自动生成迁移计划。输出列出 `checked（已检查）`、`not_checked（未检查）` 和覆盖范围；`project_knowledge_checked_by_tool: false（工具未检查项目知识）` 与 `knowledge_review.status: not_checked（知识审查未执行）` 只披露语义范围未检查，不是结构错误、不要求自动回填，也不影响 `up_to_date（结构是否最新）`。问题样本被截断但完整总数和摘要仍可计算时，不会误报 `indeterminate（无法确定）`；只有受管 Markdown 超过读取预算、文件缺失、非法 UTF-8、路径歧义、索引解析中止或读取错误等真实覆盖不完整情形，才返回 `indeterminate`，且不得宣称项目已经最新。结果中的 `physical_layout（物理布局）` 仅浅层盘点根目录编号 Markdown 文档，供主线程判断；不递归扫描目录、不判定对错，也不影响 `up_to_date`。
- `verify-materials（核验物料）`：先验证物料索引表结构，再按其中的相对文件路径和 SHA-256（文件指纹）逐项重算；表格断裂、重复或歧义、哈希过期、文件缺失或无法机械核验时返回失败。`complete（核验完成）` 只表示索引中登记的行已核验且没有失败；空索引会返回 `indexed_count: 0（登记数量为零）` 和提醒，不能证明未登记物料完整。普通 `inspect/validate` 不读取全部物料正文，不能替代本命令。
- 结构性提醒（不阻断）：`HANDOFF.md` 缺少 `## 已证伪路线` 时，`inspect`、`validate` 和 `startup` 输出的 `warnings` 包含 `missing_handoff_falsified_routes`；仅为提醒，不影响 `ok` 判定。
- 五件套剩余空间低于 2 KiB 时，`warnings` 包含 `five_piece_remaining_below_2kib`；仅提醒，不影响 `ok` 判定。
- `ids`：生成历史、证据、物料和执行批次编号。
- `startup`：内置与 `validate` 相同的机械校验；只有校验通过且 `HANDOFF.md` 声明检查点后变化已核对时才生成启动语。生成启动语前无需再单独运行 `validate`。本命令不写文件，也不验证声明是否真实。`--text` 成功时标准输出只包含可复制的启动语，状态元数据改用 `--json` 查看。

`HANDOFF.md` 必须且只能有一个 `## 语义检查点` 章节，并把它作为 `# HANDOFF.md` 标题后的第一个内容区块；两项声明必须紧随其后且各出现一次。工具会拒绝放在代码、注释、HTML（网页标记）、旧记录或其他位置的声明，也会拒绝重复、冲突、尖括号占位符、无效日历日期和非法时区。时间格式为 `YYYY-MM-DD HH:mm 时区`，时区可用 `Z`、`UTC`、`+08:00` 这类偏移量或 `Asia/Shanghai` 这类 IANA 时区名。这仍只是结构和格式检查，不代表工具理解或证明了项目语义。

三个核心索引各使用一张标准索引表；项目可以保留额外自定义列，但标准列不得重复，编号不得重复。带中文说明的明确同义表头可识别；多张都像标准索引的表会报告歧义，不会任选一张后宣称迁移完成。旧项目需要合并或保留分类旧表时，由主线程先核对记录覆盖关系，再提出受控修改，工具不会自动压平历史数据。

`verify-materials` 只核验索引中的普通项目内相对文件路径和标准 SHA-256 值；外部链接、目录、绝对路径、路径重定向、超过 256 MiB 的单文件或非标准哈希会明确列为无法核验，不会猜测或静默通过。项目外、绝对或不安全路径默认隐藏正文，只返回物料编号、索引行、路径类型和原因；同一行可机械发现多个前置问题时，`reasons（多个原因）` 一次列出，同时保留旧的 `reason（首个原因）` 字段。

## 受控写入

`propose` 是工具预演，不是新增的用户审批闸门。已有授权覆盖本次写入且预演通过时可继续 `apply`，不重复索要授权；超出范围或当前规则确实要求确认时仍按相应边界处理。

`propose（预演）` 内置只读检查和写前基线计算，生成带写前指纹的执行计划，不修改项目正文；正常执行前无需先单独运行 `inspect`。每份操作计划必须带一个临时 `knowledge_review（知识审查）`，防止治理写入完全漏掉知识判断。它只约束本来就需要受控写入的任务：普通任务、只读接续和状态未变化的任务不创建空计划。只有预演通过时才会写入 `--out` 指定的计划文件，失败结果只输出到终端，不占用重试路径。预演成功后，位于 `.project-gov/operations` 或 `.project-gov/ops` 的本次操作文件会自动删除；其他位置的输入文件不会删除。`apply（执行）` 会重新校验审查声明和动作后写入项目内容；执行成功或失败后完整恢复时，位于 `.project-gov/plans` 的本次编译计划会自动删除。执行前拒绝、恢复不完整或清理失败时保留文件并明确报告。

默认扫描范围固定为五件套、三个索引及索引中登记的项目内 Markdown 资料；不读取 `.rgignore（搜索忽略配置）` 来决定治理真相。只有这些受管资料的编号与引用扫描耗尽文件数或字节预算，或登记文件已经缺失时，`inspect/validate/startup/ids/migrate-check（检查/校验/启动/编号/迁移检查）` 才会停止完整性声明；其中 `ids` 停止分配编号，`migrate-check` 返回无法确定。`apply` 写后发现明确的机械错误（例如编号引用找不到）时必须回滚。写前或写后任一问题集合不完整时，只有写后达到完整检查且完全合规才允许提交；否则以 `transition_incomplete_issue_set` 拒绝，不得用残缺结果证明“没有新增问题”。

旧项目已有大量机械问题时，工具仍默认要求本次写入带来严格改善。只有一个自动识别的窄例外：计划仅更新 `STATUS.md`、`TODO.md`、`HANDOFF.md`，`HANDOFF.md` 的有效语义检查点声明（最后语义检查点或检查点后变化）必须真实变化，并且写前写后全部已知机械问题的总数与摘要、编号定义与引用关系、三个核心索引指纹都完全不变，才允许记录一次轻量 checkpoint。该结果会标记为 `legacy_checkpoint_noncompliant（旧问题未修复的检查点）`，不等于项目合规，也不代表工具完成了语义检查。只改普通正文不能冒充 checkpoint；任何新增、替换或隐藏旧问题，任何核心索引变化，或任何读取/预算/解析不完整，都会回到严格门并拒绝。

`propose` 的终端和 `--json` 输出都只显示审查状态、动作类型、路径、数量、体量变化、警告和错误；审查依据、权威路径与动作正文只保存在 `--out` 指定的编译计划中，错误详情也有长度上限，避免把整文件重复展开到日志和上下文。

```powershell
node "<skill-dir>\scripts\project-gov.mjs" propose --root "<项目根>" --plan "<operation.json>" --out "<项目根>\.project-gov\plans\<plan-id>.json" --json
node "<skill-dir>\scripts\project-gov.mjs" apply --plan "<项目根>\.project-gov\plans\<plan-id>.json" --json
```

最小操作计划：

```json
{
  "schema_version": 2,
  "plan_id": "run_YYYYMMDD_HHMMSS_topic",
  "knowledge_review": {
    "status": "none",
    "basis": "本轮只更新当前状态，没有产生可跨任务复用的已核实知识。"
  },
  "actions": [
    {
      "kind": "replace_line_contains",
      "path": "HANDOFF.md",
      "contains": "- 检查点后变化：",
      "replacement": "- 检查点后变化：已核对"
    }
  ]
}
```

`plan_id` 必须非空，并控制在 1024 个 UTF-8 字节以内；操作计划规范化、编译计划校验和 `apply` 建锁前都会执行同一检查。超限时返回对应的 `plan_id_exceeds_1024_bytes`、`compiled_plan_id_exceeds_1024_bytes` 或 `apply_plan_id_invalid_or_exceeds_1024_bytes`，应缩短标识并重新预演。

操作计划和编译计划 JSON 无论来自文件还是标准输入，最多读取 16 MiB，超限返回 `workflow_artifact_too_large`。预演生成的编译计划也受同一上限约束：超限返回 `compiled_workflow_artifact_too_large`，不输出计划，并保留原操作文件。动作最多 200 个；所有动作文本字段合计不得超过 8 MiB，单个文本字段不得超过 512 KiB，锚点不得超过 16 KiB。日志、附件、二进制内容和无关正文应留在计划之外。

`knowledge_review.status` 只允许四种值：

- `created（已创建）`：本轮创建了项目知识的权威入口；除单行 `basis（依据）` 外，必须用 `paths（路径列表）` 指向已存在或同计划新建的项目内文件。
- `updated（已更新）`：本轮更新了现有权威入口；字段要求同 `created`。工具只核实权威路径存在或会由本计划创建，不要求为了证明本轮修改而重复触碰已有文件。
- `none（无需沉淀）`：已经判断，但“未来可能复用”和“已核实到可采用”没有同时成立；只需一句具体 `basis`。
- `deferred（暂缓判断）`：证据不足、来源冲突或仍需用户裁决；除 `basis` 外必须给出单行 `recheck（重新判断条件）`，并把这两段实际写进同一计划更新后的 `TODO.md` 或 `HANDOFF.md`。只有交接语义本身尚未对账时，才把 `HANDOFF.md` 的“检查点后变化”保持为“待确认”；仅在 `TODO.md` 持久化已知的重新判断条件，不会单独阻断 `startup`。

工具只能机械检查字段、单行长度、路径和暂缓状态是否被持久记录，不能证明 `none` 的理由真实，也不能判断 `created/updated` 的知识质量。该对象随临时计划清理，不进入项目正文；不得为填写它而额外创建知识库、知识卡、索引或空 checkpoint（检查点）。

仅保存明确标注为未验证的探索候选时，按 [project-knowledge.md](project-knowledge.md) 使用 `none` 并说明依据，不把候选标成已验证知识；这类候选若已影响当前事实、基线或交接判断且仍无法确认，则按 `deferred` 持久记录未决事项。其他知识审查仍按上述四种状态判断，不因存在探索记录而省略。候选本身未验证不构成绕过交接对账的理由。

五种动作的最小字段：

```jsonl
{"kind":"mkdir","path":"历史记录/变更记录"}
{"kind":"write_file","path":"STATUS.md","content":"# STATUS.md\n","overwrite":true}
{"kind":"append_after","path":"TODO.md","after":"## 下一步","match":"exact","content":"- 待处理事项"}
{"kind":"replace_line_contains","path":"HANDOFF.md","contains":"- 检查点后变化：","replacement":"- 检查点后变化：已核对"}
{"kind":"replace_block_exact","path":"STATUS.md","old_block":"旧文本块\n","replacement":"新文本块\n"}
```

`append_after` 的 `match` 可用 `exact` 或 `contains`；追加和替换的锚点都必须只命中一次。

`replace_line_contains（按包含内容替换行）` 的替换文本只能是一行；多行修改必须使用 `replace_block_exact（精确替换文本块）`。后者会先统一比较 Windows/Unix 换行格式，旧文本块必须且只能精确命中一次；`replacement` 可为空字符串，用于删除该文本块。编译与执行阶段使用同一匹配规则。三种文本编辑动作都保留目标文件原有的 CRLF/LF（Windows/Unix 换行）风格。

动作只支持 `mkdir`、`write_file`、`append_after`、`replace_line_contains` 和 `replace_block_exact`。写入范围限于五件套、三个最小索引、`历史记录/`、`证据库/` 和 `项目物料/`。项目原有 `docs/` 或其他工程目录中的架构、知识和说明文档继续走项目自己的编辑与测试通道；只有五件套或索引中的发现性指针属于本工具的受控写入范围。

`mkdir` 只用于治理根目录下的子目录，例如 `历史记录/变更记录`；不接受单独的 `历史记录`、`证据库` 或 `项目物料`。新建目录必须在同一计划中有实际写入的后代文件；已有目录不受此限制。建档时直接 `write_file` 写入三个最小索引，工具会自动创建必要的上级目录，不预建无内容空目录。

对上述治理范围进行建档、checkpoint（检查点）或交接写入时，必须按 `propose → apply` 执行。写入失败或工具无法表达时，停止该写入及依赖其成功的操作，说明具体阻塞并继续必要的只读诊断。其他工作只有在确认不依赖该写入、不破坏相关状态一致性、也不构成替代写入时才可继续；无法确认时暂停相关操作，不得直接修改、另建正式状态副本或借进度账绕过受控写入。不同文件不代表互不依赖。

## 执行边界

- 路径必须留在项目根内，不得经绝对路径、父级跳转、符号链接或目录联接逃逸；即使目录联接仍指向同一项目内的其他位置，也视为路径重定向并拒绝。
- 动作路径不得超过 4096 个 UTF-8 字节；文件写入还必须为事务临时文件名预留空间。超限计划会在创建锁和备份前拒绝，应缩短目录或文件名后重新预演。
- 执行前核对写前指纹；文件已变化时停止。
- `apply` 在总核对后还会在每个文件落盘前再次核对。检测到用户、编辑器或其他进程改变了目标或治理基线时，工具会停止，不以自动回滚覆盖该第三方状态，也不会宣称提交成功；锁与事务备份会保留供人工核对。出现 `third_party_state`、`prewrite_target_drift`、`rollback_incomplete` 或 `interrupted_transaction_recovery_failed` 时不得手动删除后重试。受文件系统限制，单文件核对与随后的原子替换之间仍有极窄并发窗口，因此 `apply` 期间仍应避免同时保存相同文件。
- 当前操作计划结构版本为 `schema_version: 2`；旧版操作计划必须用当前规则重新生成。
- `apply` 会在创建锁、备份或写文件前检查编译计划绑定的技能版本和计划结构版本；版本不同或缺失时直接拒绝并要求重新预演。随后再检查工具标识、项目根、`knowledge_review`、动作和写前指纹；字段不完整或重新编译后不一致的旧计划同样必须重新预演。
- 写入使用项目锁、事务日志和原子替换；普通失败时恢复原文件。进程或电脑在事务中断时，下一次 `apply` 会先核对锁、备份、日志和目标指纹：能够证明已完整提交或完整恢复才清理事务；无法证明时保留锁与备份并停止，不猜测、不覆盖。
- 本次事务备份只服务于回滚：写入成功且机械验证通过后自动删除；失败但完整回滚成功后也自动删除；只有回滚不完整或清理失败时才保留，并在结果的 `backups_retained（保留备份）` 与 `backup_cleanup（备份清理）` 中明确报告。
- `apply` 会分开报告“项目写入结果”和“锁文件清理结果”；锁清理异常不得把已经成功提交的写入伪报成失败。
- 回滚只能处理本次创建的空目录，不得移除原有目录或用户文件。
- 五件套已超限时，写入计划必须使其变小；未超限时不得写到超过 45 KiB。

## 治理缓存盘点

`prune` 是只读盘点命令：列出 `.project-gov/plans`、`.project-gov/backups`、`.project-gov/operations` 和 `.project-gov/ops` 中超过指定天数的非符号链接直接子项，返回真实总数和有界样本，不递归展开正文，也不删除任何文件。符号链接和目录联接不会被跟随或展开。

本次操作文件、编译计划和事务备份按上文规则在流程完成后自动清理。旧缓存需要处理时，先用 `prune` 定位，再由用户明确授权单独处理；项目正文和锁文件不属于盘点范围。

```powershell
node "<skill-dir>\scripts\project-gov.mjs" prune --root "<项目根>" --older-than-days 30 --json
```
