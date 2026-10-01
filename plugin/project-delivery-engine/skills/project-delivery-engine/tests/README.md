# 维护者测试说明

运行依赖是 Node.js，CLI 使用内置模块。以下命令在仓库根目录执行，无需 npm install。

## 本地夹具测试

```sh
node tests/project-gov-structure.mjs
node tests/project-gov-write-edge.mjs
node tests/project-gov-v027-regressions.mjs
node tests/project-gov-v038-adversarial.mjs
node tests/project-gov-v038-authority-model.mjs
node tests/project-gov-v038-context-actions.mjs
node tests/project-gov-v038-index-compat.mjs
node tests/project-gov-v038-schema-edge.mjs
node tests/project-gov-v038-transaction-integrity.mjs
node tests/project-gov-v038-transition-binding.mjs
```

测试创建临时项目夹具，不要将测试中的占位路径改成私人项目路径。Windows 的部分边界用例需要 PowerShell 7（pwsh），部分测试使用 Git。缺少环境时，应按测试输出记录失败或跳过，不能当作通过。

## 依赖历史证据的检查

`project-gov-v038-index-compat.mjs` 中的真实项目迁移检查需要维护者提供的冻结材料。未设置相关环境变量时，测试会标记对应检查为跳过。

`project-gov-v038-sync-integrity.mjs` 用于历史 rc 验收，依赖 source/active/mirror 和冻结证据、验收清单等材料。它不属于用户安装步骤，也不能用当前源码代替缺失材料后宣称历史验收通过。

本仓库不分发私人项目、冻结证据或个人环境配置。请勿为了运行这两类检查而复制他人的真实目录。

## 验证范围

本次公开候选在 Windows / Node.js 26 验证。Linux、macOS 和其他 Node 版本尚未完成本次验证。新版本的支持范围应以对应版本的测试结果为准。

