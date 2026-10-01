# project-gov 故障处理

本文件只在 `project-gov`（项目治理工具）报错时读取。

## 出错时怎么处理

看到错误时先停止当前写入及依赖其成功的操作，不要绕过 `propose → apply（预演→执行）`。继续必要的只读诊断；其他工作只有在确认不依赖该写入、不破坏相关状态一致性、也不构成替代写入时才可继续，无法确认时暂停相关操作。不得直接改写受管文件、另建正式状态副本或借进度账绕过失败；不同文件不代表互不依赖。

下面是常见提示的人话解释：

| 提示关键词 | 它在说什么 | 怎么处理 |
| --- | --- | --- |
| `missing_five_piece_file` / `missing_index_file` | 项目入口或索引缺失 | 先运行迁移检查，再只补缺少的文件 |
| `unresolved_references` | 文件里引用了找不到的编号 | 核对对应索引和引用，不要随手删除记录 |
| `template_placeholder_found` | 模板占位文字还没换成真实内容 | 填入真实状态后重新验证 |
| `handoff_last_semantic_checkpoint_invalid` / `handoff_change_status_missing_or_invalid` | 交接检查点的时间或核对状态格式不正确 | 按交接模板修正两项声明 |
| `five_piece_over_45kb` | 当前入口文件过大 | 把详细过程放入历史或证据层，并保留索引 |
| `before_hash_missing` | 编译计划缺少目标文件的写前指纹 | 放弃旧计划，重新运行 `propose（预演）` |
| `Hash precondition failed` | 预演后目标文件真的发生了变化 | 先核对新内容，再重新运行 `propose（预演）` |
| `Compiled plan version incompatible` | 预演计划来自旧版或不同版本的 Skill | 放弃旧计划，用当前版本重新运行 `propose（预演）` |
| `schema_version_must_be_2` | 操作计划来自旧版格式 | 用当前 Skill 重新生成操作计划，不要手改旧编译计划 |
| `plan_id_required` / `plan_id_exceeds_1024_bytes` / `compiled_plan_id_exceeds_1024_bytes` / `apply_plan_id_invalid_or_exceeds_1024_bytes` | `plan_id` 缺失或超过 1024 个 UTF-8 字节 | 缩短 `plan_id`，重新生成操作计划并预演，不要手改旧编译计划 |
| `workflow_artifact_too_large` / `compiled_workflow_artifact_too_large` / `actions_total_text_exceeds_8388608_bytes` / `compiled_actions_total_text_exceeds_8388608_bytes` | 操作或编译计划超过 16 MiB，或动作文本字段合计超过 8 MiB | 缩小并重新生成计划；把日志、附件、二进制内容和无关正文移出 JSON，不要拆成多个计划绕过同一事务边界 |
| `knowledge_review_object_required` / `knowledge_review_status_invalid` | 治理写入没有声明知识判断，或状态拼写不正确 | 由 AI 按本轮事实补上 `created / updated / none / deferred` 和一句依据 |
| `knowledge_review_deferred_details_not_written_by_plan` / `knowledge_review_deferred_details_not_persisted` | 延后知识判断的依据和复查条件没有由本计划写入同一个状态文件，或写后没有同时保留 | 把依据和复查条件写进本轮实际更新的同一个 `TODO.md` 或 `HANDOFF.md`，再重新预演 |
| `transition_incomplete_issue_set` | 工具因读取失败、预算耗尽或索引解析中止，无法证明写前写后的全部问题 | 先修复读取或索引问题；不要把终端只展示 100 条误当成这个错误 |
| `transition_no_strict_improvement` | 项目仍有旧问题，而本次写入既未严格改善，也不满足轻量 checkpoint 的窄条件 | 若本轮只是未收口的中间进度，不要改三件套，回到运行中轻量进度账。只有已经满足 [project-state.md](project-state.md) 的正式 checkpoint 条件，且确实只需更新 `STATUS.md`、`TODO.md`、`HANDOFF.md` 时，才更新三件套和 `HANDOFF.md` 的语义检查点声明；否则先修复至少一个真实问题 |
| `third_party_state` / `prewrite_target_drift` / `rollback_incomplete` / `transaction_backup_retained` / `interrupted_transaction_recovery_failed` | 写入或中断恢复期间，用户、编辑器或其他进程改变了目标或治理基线，工具无法证明已经精确恢复 | 立即停止对相关目标和治理基线的进一步写入，不要删除 `.project-gov/apply.lock` 或事务备份；核对返回的回滚差异、当前文件和锁内基线，先保全第三方改动，再决定人工恢复或重新预演 |
| `path_exceeds_4096_bytes` / `transaction_temp_path_exceeds_4096_bytes` | 动作路径过长，或没有给事务临时文件名留下足够空间 | 缩短目录或文件名，再重新生成计划并预演；不要手改编译计划 |
| `path_not_allowed` | 写入位置不属于治理范围 | 停止该操作并核对文件职责；确属项目原有工程文档时沿用工程编辑通道，治理记录不得移出受控范围或换路径绕过限制 |
| `Unsupported option(s)` | 命令参数不属于当前版本 | 运行 `--help` 查看当前用法；`prune` 现在只读盘点 |

如果提示不在表里，主线程应先用 `inspect（检查）` 或 `validate（验证）` 获取最小错误信息，再说明具体文件、原因和下一步；不得把机械校验通过说成业务语义已经正确。
