---
name: project-delivery-engine
license: Apache-2.0
description: "仅在任务必须读取或更新当前项目的持久治理状态，或用户明确要求项目建档或修复、接续、状态与资料索引整理、checkpoint、项目知识沉淀、探索想法留存、协作结果治理、交接、收尾或启动语时使用。普通源码、测试、配置或工程文档的读改测、单纯讨论灵感，以及仅因任务长期、多轮、使用多智能体或 worktree，均不会单独触发。"
---

# 项目状态治理

维护可核实、可追溯、可接续的项目记忆，让接手者能从项目文件恢复当前基线、真实进度、重要决定和未决事项。五件套保存当前状态与必要入口，实际产物和证据支持其中的结论；记录与事实不一致时先核实再纠正，不能把“已经记录”当作“已经证实”。

## 处理顺序

`SKILL.md` 只保留本 Skill 的路由和硬边界，细则按需读取 references。

1. 以用户最新指令和当前项目文件确定任务边界；只有任务确实依赖持久治理状态，或用户明确要求管理当前项目时才套用本 Skill。普通源码、测试、配置和工程文档的读改测，或者仅仅因为任务较长、多轮、使用多智能体或 worktree，都不得自动建档或进入治理流程。
2. 任务依赖项目状态时，按 [references/project-state.md](references/project-state.md) 检查项目根、五件套和必要索引。接续或继续项目并明确当前任务后，必须用现有入口做一次轻量相关性判断；只有既有项目知识可能改变本轮判断、执行或验收时，才按 [references/project-knowledge.md](references/project-knowledge.md) 读取最相关的权威入口，不批量加载知识资产。新建或修复文件时再读 [references/project-file-templates.md](references/project-file-templates.md)。
3. 当前过程有实际的中断恢复、设计回退或上下文遗忘风险时，按 [references/project-state.md](references/project-state.md) 建立或复用运行中轻量进度账；多轮、多 Agent 或多工作树本身不强制建账。有证据的状态变化及时记录，阶段未收口时不为每笔进度机械改写三件套。
4. 具体执行方式和隔离方式由宿主运行时决定；宿主已经采用协作、独立复审或隔离写入时，按 [references/collaboration.md](references/collaboration.md) 核对授权、范围、证据、复核和最终采纳边界。协作承担文件、代码或产物写入（含隔离写入）、独立复审，或结果将进入持久治理记录时，按 [references/taskcard-evidencebundle.md](references/taskcard-evidencebundle.md) 使用正式 TaskCard / EvidenceBundle；简单只读协作沿用宿主原生任务合同，但仍须明确范围，并返回证据和风险或未覆盖项。
5. 需要保存可复用经验、目标与验收基线、关键决策或探索想法时，按 [references/project-knowledge.md](references/project-knowledge.md) 复用现有入口。未验证想法与已验证知识分开记录，不自动变成待办、已采纳方案或事实；不新增固定必备文件。仅当本轮本来就需要治理写入时，在临时操作计划中用 `knowledge_review（知识审查）` 留下一句判断依据，不为记录判断而制造空计划。
6. 只有尚未吸收的持久状态、下一步或 Gate、重要风险或裁决、交接入口发生实质变化时，才按 [references/project-state.md](references/project-state.md) 写入正式 checkpoint（检查点）。阶段或任务结束只是合适的收口时机，不是单独触发条件。

机械检查、编号、启动语和治理文件受控写入见 [references/project-gov-cli.md](references/project-gov-cli.md)。

`project-gov` 报错时，再读 [references/troubleshooting.md](references/troubleshooting.md)。

## 硬边界

- 本 Skill 中，主线程指负责整体交付的主代理，协作线程指受派遣的子代理，不表示必须新建独立对话。派遣方按风险复核直接子代理的关键证据；主线程负责最终采纳与整体交付。子代理可报告自身任务完成，但子代理、脚本和证据包不能代替主线程宣布整体完成或合并结果。
- 项目 `AGENTS.md` 保存项目身份、专有事实、授权边界和执行时需要的项目规则；必要的开发、测试约定可放在其中或链接到现有文档，不复制本 Skill 的通用流程。当前进度与交接事实留在三件套。
- 对治理范围进行建档、checkpoint（检查点）或交接写入时，必须使用 `project-gov propose（预演）→ apply（执行）`；写入失败或工具无法表达时，停止该写入及依赖其成功的操作，说明具体阻塞并继续必要的只读诊断。其他工作只有在确认不依赖该写入、不破坏相关状态一致性、也不构成替代写入时才可继续；无法确认时暂停相关操作，不得绕过。
- 只选择当前任务需要的引用文件；读取完整的相关章节及其适用条件、例外和必要引用。短文件可全文读，长文件先定位章节；不得只摘取孤立规则而漏掉约束或例外。
