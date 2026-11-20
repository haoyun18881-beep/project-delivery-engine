# 配置实际目录与计划任务

## 配置自己的目录

先用合成示例跑通，再换成自己有权处理的目录。建议把运行目录放在本地私有位置。以下 PowerShell 示例把三份 Skill 安装到一个工程的 `.agents/skills` 中。要供本机多个工程共用，可改用自己的用户级 Skills 目录，参见 [Codex Skills 文档](https://learn.chatgpt.com/docs/build-skills)。

```powershell
# 在 project-delivery-engine 的检出目录运行。按实际路径替换示例值。
$project = Read-Host "你的项目目录"
$vault = Join-Path $env:USERPROFILE "Documents/My Wiki"
$runtime = Join-Path $env:LOCALAPPDATA "ProjectDeliverySuite"
$sessions = Read-Host "允许采集的 Codex 会话目录"
python -B suite/setup.py install --skills-dir "$project/.agents/skills" --vault "$vault" --sessions "$sessions" --runtime "$runtime"
```

- `--sessions` 必须指向你明确选择的、已有的 Codex 本地 Session 目录。首次采集覆盖该目录里符合格式的主对话；有多个保密等级时，请只给本套装可以处理的一组。
- 可以额外用 `--supplement-sessions <目录>` 指定另一个有权读取的归档会话目录。此目录只供选中某个文件时补查，日更不会对它全量采集。
- `--vault` 已存在时沿用目录。目录不存在时复制本仓库的 Wiki 模板。模板的 `00-AI入口.md` 指向经验、项目历史和主题目录。日更条目默认进入 `10-经验库/每日提炼/`，已有自己的目录时可用 `--notes-dir` 指定另一个 Wiki 内相对路径。
- `--entry` 可重复指定优先读的入口，如 `--entry Home.md`；`--restricted` 可重复排除现有 Wiki 中的私有目录或文件。默认排除 `60-个人档案`、`75-归档`、`80-来源档案`。这些区域在周检中不计入覆盖。移动仓库或数据目录后需相应重新配置；已有同名 Skill 或运行目录时，安装器会停止，由你核对版本与本地修改。
- 安装器复制随包组件，将三份 Skill 放入指定目录并生成本地配置。`workflow.py` 会装到运行目录，日后可以直接在那里执行。Skill 里的实际 `local-config.json`、运行态、证据、笔记和审阅文件留在本机。
- 上游的 QA ID、时间和最终回答来自 Codex 本地会话格式。若宿主变更后丢记，需单独核对采集器。整理后的日记可能有截断或临时回答标记，引用时保留范围。

手动采集和定向取证（将会话编号换成已知的编号）：

```powershell
python -B "$runtime/workflow.py" collect
python -B "$runtime/workflow.py" evidence --session "<会话编号>"
```

也可以使用 `evidence --id <定位编号>` 或 `evidence --day YYYY-MM-DD --query "关键词"`。若已确认日记缺了一条，先在允许范围内找到那份会话文件，再补查和登记。

```powershell
$qaFile = Read-Host "允许补查的单个会话文件路径"
python -B "$runtime/workflow.py" evidence --raw-session "$qaFile" --query "唯一关键词"
python -B "$runtime/workflow.py" supplement --raw-session "$qaFile" --query "唯一关键词"
```

只有第二条命令会把命中的一条最终回答登记给日更。它保留来源指纹。若原件后来变化或缺失，补证需要复核；已经有正式日记的同一条问答由日记优先。

## 在 Codex 中设定计划

先在普通本地对话用下面两份提示分别试跑，再到桌面版的计划任务页面创建两项独立任务。使用本机运行模式并选择能访问运行目录和 Wiki 的项目。在提示中替换 `<RUNTIME>`（安装生成的运行目录），确认宿主有权访问所选目录，并选好时区。需要本机文件时保持电脑与桌面应用运行。参见 [Codex 计划任务说明](https://learn.chatgpt.com/docs/automations)。

建议先给任务一个试用 Wiki 和限定输入；确认首次日志与条目符合预期后，再用在自己的目标库。两项任务分时运行。遇见另一项正在运行或文件变化，保留本轮结果并在下次重新取快照。

### 每日增量同步与提炼（例如每天 10:00）

```text
使用运行目录 <RUNTIME> 内的 workflow.py 和 suite-config.json。只处理配置里指定的会话、Wiki 和运行目录。
先运行 python -B "<RUNTIME>/workflow.py" daily。它会增量生成本地 QA 日记，并输出本批要审阅的 snapshot_id 和 JSON 路径。以快照内的 id 和 sha256 逐条审阅。调用 evidence --id <id> 读取该条，原始会话只在明确请求或确认缺漏时定向补证。
把私人原文、凭据、普通寒暄、通用常识、这两项维护任务自己的例行回报和仅有过程信息的问答作 skip。只留下能改变今后某个具体行动、来源可回查且有适用条件的短结论。先查 Wiki 里已有的条目，已经覆盖的作 skip。冲突、临时回答、出处不全或需用户裁决的作 defer。当前项目进度和待办归还工程项目，条目中只保存适合复用的历史经验。
将本批每条的判断写到运行目录里的单独审阅 JSON。精确覆盖该批，不猜测内容；按下节格式同时记录 id、sha256 和 reason。仅在用户已经授权此任务写入所选 Wiki 时执行 apply-daily；否则交付审阅稿。成功后再运行 daily，直到 total_pending 为 0 或遇到明确阻塞。报告待审、已写和跳过情况，不回传问答全文。无变化时保持安静。
```

审阅文件的最小形状（字段取自实际快照，以下内容仅为示意）：

```json
{
  "snapshot": "daily-<快照编号>",
  "items": [
    {
      "id": "<定位编号>",
      "sha256": "<快照中的指纹>",
      "decision": "keep",
      "reason": "有明确的现场约束和可复用做法",
      "title": "断网时保留离线核对名单",
      "takeaway": "预先导出本地 CSV，使现场断网后仍可核对名单。",
      "applies_when": "签到不依赖实时更新且现场网络不稳定。",
      "limits": "多人并发更新或名单高度敏感时，另行验证权限、同步和离线保存方式。"
    }
  ]
}
```

`skip` 和 `defer` 只需要 `id`、`sha256`、`decision`、`reason`。`apply-daily --snapshot <编号> --review <绝对审阅文件>` 核对每条来源和指纹，再登记判断。新经验采用独立文件，遇到已有内容不同会停下并交人工复核。遇到中断时，保留同一快照和审阅文件，核对现有成果后按原参数续做。待人工判断的 `defer` 与待处理增量分别计数。

### 每周全库语义体检（例如周日 14:00）

```text
使用本地运行目录 <RUNTIME>。运行 python -B "<RUNTIME>/workflow.py" weekly，读取返回的快照编号和 JSON 文件。用快照里列出的每一个 Wiki Markdown 路径和 sha256 做逐页审阅，直到本次纳入范围全部处置。
核对重复、矛盾、可能过时的结论、断链、孤立页、缺失的来源，以及是否误放了项目当前状态。标记有直接证据的问题，阅读失败就记 read-failed。查看来源只按需走取证 Skill，避开配置排除的目录和真实会话转储。
按下节格式把每页的 path、sha256、decision 和 reason 写到运行目录中的独立 JSON，运行 apply-weekly 提交。有 qa_source 为 missing 或 changed 的页必须记录问题。检查报告覆盖数、read_failed、source_gaps 和具体发现。报告给出可定位路径和建议，保留知识正文。没有新增问题时保持安静。覆盖缺页、读取失败或发现需裁决的问题时报告。
```

审阅文件使用同样的 `snapshot` 和 `items` 结构。每项包含 `path`（Wiki 内相对路径）、`sha256`、`decision`、`reason`。可用结论为 `healthy`、`duplicate`、`conflict`、`stale`、`broken-link`、`orphan`、`wrong-layer`、`source-gap`、`read-failed`。

用 `apply-weekly --snapshot <编号> --review <绝对审阅文件>` 记录这轮覆盖与发现。漏判一页或期间改变了 Wiki 都需重新核对。工具会对每日提炼目录中带来源编号的笔记检查证据指纹。其他笔记的语义与来源由审阅者核对。要采取合并、改写或删除建议时，单独复核出处、存活引用和已有备份。
