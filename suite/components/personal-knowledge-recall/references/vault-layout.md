# Vault layout

The Skill does not require a fixed Obsidian structure. `entry_files` defines only the first files to try; all later reads should be selected from the current task.

## Optional starter layout

```text
00-AI入口.md
10-经验库/
20-项目/
30-主题/
70-待确认/
```

- `00-AI入口.md`: a short map of the vault and its important indexes.
- `10-经验库/`: reusable troubleshooting and working experience.
- `20-项目/`: historical summaries, completed decisions, and reusable experience.
- `30-主题/`: concepts and knowledge that span projects.
- `70-待确认/`: candidates, conflicts, and material awaiting verification.

This is an example, not a requirement. Never infer that a similarly named directory exists without checking the configured vault.

## Retrieval practice

1. Read the smallest useful entry or index.
2. Search only the relevant area and cap search output.
3. Open a small number of best-matching notes.
4. Stop when the answer is supported.
5. Preserve labels such as `candidate`, `unverified`, `stale`, and `superseded` in the answer.

Do not recursively dump the vault into model context.
