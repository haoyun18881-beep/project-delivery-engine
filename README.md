<p align="center"><img src="assets/project-delivery-engine-logo.png" width="96" alt="Project Delivery Engine"></p>

# Project Delivery Engine · 项目交付引擎

**让项目进度不再依赖聊天上下文。**

用 AI 做项目，代码写出来了，项目管理的问题跟着来了：

- 新开一个对话，得从头解释项目。
- 试过几种方案，分不清哪份文件在用。
- 聊过的决定散在聊天里，修好的功能被改回旧版。
- AI 说“完成了”，项目里找不到结果和验证记录。

Project Delivery Engine 是一个给 AI 编程助手使用的 Skill。它帮助 AI 把**做什么、做到哪、为什么这样做、下一步做什么**写进项目文件。

进度、决定和验证结果保存在你的项目里。聊天变长、上下文压缩、换个对话，接手的 AI 可以读取这些文件，找回工作线索。你有记录可查，有结果可核对。

免费使用，采用 [Apache-2.0](LICENSE) 许可证，允许修改、分发和商用。AI 工具及模型服务的费用由对应服务方收取。

## 用它能得到什么

| 遇到的问题 | 留下的记录 | 下次怎么用 |
| --- | --- | --- |
| 换对话要重讲背景 | 项目目标、当前状态、接续入口 | 让新对话读取记录，接上工作 |
| 改来改去，方案互相覆盖 | 已采纳的决定、理由和适用范围 | 核对现行方案，识别旧方案 |
| 分不清“写完”和“验证通过” | 实际产物、验证结果、未完成项 | 查看完成依据，知道缺口 |
| 资料和文件越堆越多 | 历史记录、证据和物料索引 | 按任务找文件 |
| 多个 AI 协作，结果难以对齐 | 任务范围、证据和主线程采纳结论 | 确认哪些成果进入项目 |

适合用自然语言让 AI 写网站、工具、小程序或其他项目的人。熟悉项目管理的团队可把它用于项目交接和资料留存。

## 三句话开始用

安装后，在 AI 编程助手中打开项目，说出当前需求。

**开始一个项目**

```text
使用 project-delivery-engine 为这个项目建档。
我要做的是：[目标]。
目前已有：[代码、文件或想法]。
请复用现有资料，记录目标、当前状态和下一步。
```

**准备收工或换对话**

```text
使用 project-delivery-engine 整理本轮进展。
记录完成了什么、验证过什么、还有什么没做，并给我下一次对话的接续提示词。
```

**在新对话接着做**

```text
使用 project-delivery-engine 接续这个项目。
项目目录：[你的项目目录]。
读取项目入口和当前交接记录，确认下一步后继续。
```

这些是日常说法，具体读取和操作方式由 AI 助手决定。正常写代码、修 bug、讨论想法，不需要每轮生成一套治理记录。

## 一个接续例子

你用 AI 做了一个记账网站：记账功能完成，导出功能待做。测试发现移动端表格有遮挡，登录方式选用了邮箱验证码。

收尾后，项目记录会交代：

- 当前成果：记账功能及对应文件。
- 验证情况：通过的检查、移动端遮挡问题。
- 已定方案：邮箱验证码及选择理由。
- 下一步：修复遮挡，完成导出。
- 相关资料：设计、代码和验证依据的入口。

换对话后，接手的 AI 可以据此开展工作。你能检查它是否沿用了这些结论。

## 安装

需要支持 Skill、能够读写项目文件和执行本地命令的 AI 助手。运行环境需要 Node.js；本次验证环境见下方“运行与验证”。

### 在 Codex 中安装

把下面这段话发给 Codex：

```text
使用 skill-installer，从这个仓库安装 project-delivery-engine：
https://github.com/haoyun18881-beep/project-delivery-engine
Skill 在仓库根目录。
```

安装入口和本地目录遵循 [Codex 官方 Skills 文档](https://learn.chatgpt.com/docs/build-skills)。已有同名 Skill 时，应核对版本和本地修改，保留一份使用入口。

### 下载后放入 Skill 目录

从 GitHub 的 Code → Download ZIP 下载并解压，将包含下列内容的目录命名为 `project-delivery-engine`，放入所用 AI 助手的 Skill 目录：

```text
project-delivery-engine/
├── SKILL.md
├── references/
├── scripts/
├── examples/
├── agents/
└── assets/
```

保留整个技能目录及 LICENSE。不要把 `SKILL.md` 单独复制出来，脚本和参考文件是运行所需内容。安装后让助手确认能找到该 Skill，并确认 `node --version` 可以运行。

其他 AI 助手的技能目录、命令权限和加载方式以各自文档为准。本项目没有完成各宿主的兼容性验收。

## 它会在项目里留下什么

| 文件 | 用途 |
| --- | --- |
| `AGENTS.md` | 项目规则和边界 |
| `PROJECT_START_HERE.md` | 接手时的阅读入口 |
| `STATUS.md` | 当前成果、验证结果和问题 |
| `TODO.md` | 下一步和待确认事项 |
| `HANDOFF.md` | 交接结论和接续线索 |

历史、证据和交付物通过项目索引定位。源码与原有工程文档保留在原目录。已有项目会复用现有内容；治理记录在状态发生实质变化时更新。

写入治理文件前，内置工具会预演变更、核对写前文件指纹；执行后进行结构检查。它帮助发现文件在操作间被修改、引用失效等问题。**工具检查通过，不等于项目功能通过验收。**

## 能解决什么，边界在哪

- 项目记录帮助 AI 恢复上下文，效果取决于记录内容和助手执行情况。
- 它不替代 Git、备份、测试或人工决策。代码回退和数据恢复仍需对应工具。
- 它不承诺消除 AI 错误、杜绝项目失败或缩短每次整理耗时。
- 内置 CLI 使用本地文件，不包含联网请求或遥测上传。AI 助手读到的内容仍受其平台的数据处理规则约束，项目记录应避开密钥和私人数据。

## 运行与验证

技能内含 `scripts/project-gov.mjs`，使用 Node.js 内置模块，不需要 `npm install`。

```sh
node scripts/project-gov.mjs --help
node scripts/project-gov.mjs inspect --root /path/to/your-project --json
```

将示例路径换成你的项目目录。`inspect` 为只读检查；缺少项目入口文件时会报告缺口。

当前 CLI 版本为 `0.3.8-rc7`。本次在 Windows / Node.js 26 上验证；其他系统与 Node 版本未完成本次验证。测试源码和维护说明见 [测试说明](https://github.com/haoyun18881-beep/project-delivery-engine/blob/main/tests/README.md)，受控写入用法见 [命令行说明](references/project-gov-cli.md)。

## 反馈与贡献

使用问题和改进建议可以提交 [GitHub Issue](https://github.com/haoyun18881-beep/project-delivery-engine/issues)。描述任务、预期结果、实际结果和复现方式；发布前删除项目隐私与凭据。

希望它能帮助初次用 AI 做项目的人，把时间花在产品上，减少因进度丢失、资料混乱和重复解释产生的返工。

