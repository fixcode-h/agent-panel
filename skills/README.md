# 内置 Skills

随 Agent 面板一起发布的技能。在「Skills 与命令」页可以把它们安装到用户目录的 `~/.agents/skills`（各 CLI 共用这一份）；运行用到某个技能的 Agent 时，面板也会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，下面的分类文件夹只用于整理。

技能只写「这件事怎么做好」的规则。什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent（Agent 里列出它用的技能名）决定。

## 分类

| 分类             | 技能                               | 用途                                                      |
| ---------------- | ---------------------------------- | --------------------------------------------------------- |
| 流程 `workflow/` | `brainstorming`                    | 动手前澄清需求、比较方案、形成设计并取得批准              |
|                  | `grilling`                         | 按设计树分轮追问，压测计划和决策                          |
|                  | `openspec`                         | OpenSpec 各阶段的产物、门禁、回流和归档规则               |
|                  | `task-records`                     | 按任务规模维护 tasks / design / acceptance / handoff 记录 |
| 编码 `coding/`   | `test-driven-development`          | 红-绿-重构，先写失败的测试                                |
|                  | `systematic-debugging`             | 先查历史 Bug，再四阶段找根因后修复                        |
|                  | `verification-before-completion`   | 没有新鲜验证证据不声称完成                                |
|                  | `software-architecture-design`     | 项目、子系统架构的设计与评审（含 UE、Lua、C# 参考）       |
| 文档 `docs/`     | `project-documentation`            | PROJECT_ROOT / DOC_ROOT、模块文档、bugs.md 与文档更新规则 |
| 项目 `project/`  | `project-structure`                | 陌生项目的目录、构建、测试、运行方式和常见坑              |
|                  | `ue-project-structure`             | UE 模块与插件、UHT/UBT、自动化测试、Cook、资产规则        |
|                  | `project-testing`                  | 按改动选测试、找项目自己的验证命令、写验收证据            |
| 版本控制 `vcs/`  | `project-workflow`                 | 识别 Git / P4 / 无版本控制，保护既有改动，收尾核对        |
|                  | `git-workflow`                     | Git 基线、限定 diff、按需本地提交，不推送                 |
|                  | `p4-workflow`                      | P4 default changelist、pending 分桶、中文描述编码安全     |
| UE `ue/`         | `cpp-code-style`                   | C++ / UE C++ 格式、日志格式、模块导出规则                 |
|                  | `lua-code-style`                   | Lua 日志格式与排版                                        |
|                  | `lua-luac-compiler`                | LuacPacker 编译 .luac 与 Lua 语法检查                     |
|                  | `ue-multi-agent-coordination`      | UE 项目多 Agent 并行时的资源锁与编译排队                  |
| 美术 `art/`      | `blender-model-animation-workflow` | Blender 建模与动画的阶段和交付约定                        |
|                  | `blender`                          | 无头 Blender 建模、体检、多视角截图与 UE FBX 导出         |

## 新增技能

- 放在合适的分类下：`<分类>/<技能名>/SKILL.md`。
- 文件夹名必须等于 frontmatter 的 `name`，且在所有分类里唯一（安装后是平铺的）。
- frontmatter 只写 `name`、`description`，需要时加 `user-invocable: true`。`description` 不超过 1024 字，写清楚做什么、什么时候用。
- 脚本、模板、参考资料都放在技能文件夹里，正文用「本技能目录下的 `scripts/…`」引用，不引用仓库里其他位置的文件。
- 不在技能里写「加载某某技能」「每轮默认使用」之类的编排；引用别的技能写成「需要时配合 X 技能」，X 必须是这里已有的技能。
- 文本文件用 UTF-8（无 BOM）和 LF 换行。

## 运行依赖

| 技能                   | 依赖                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `blender`              | Python 3、Blender（`BLENDER_PATH`、PATH 或常见安装位置）；`reference_frames.py` 还需要 ffmpeg |
| `lua-luac-compiler`    | Python 3 和 `lupa`（语法检查）；VS Code 的 LuacPacker 扩展（编译）                            |
| `systematic-debugging` | bash（`find-polluter.sh`，Windows 上用 Git Bash）                                             |
| `openspec`             | `openspec` 命令行和 `/opsx-*` 斜杠指令                                                        |
