# 内置 Skills

随 Agent 面板一起发布的技能。在「Skills」页可以把它们安装到用户目录的 `~/.agents/skills`（各 CLI 共用这一份）；运行用到某个技能的 Agent 时，面板也会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，下面的分类文件夹只用于整理。

技能只写「这件事怎么做好」的规则。什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent（Agent 里列出它用的技能名）决定。

## 分类

| 分类             | 技能                               | 用途                                                                                                                                                                     |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 流程 `workflow/` | `brainstorming`                    | 动手前澄清需求、比较方案、形成设计并取得批准                                                                                                                             |
|                  | `grilling`                         | 按设计树分轮追问，压测计划和决策                                                                                                                                         |
|                  | `openspec`                         | OpenSpec 各阶段的产物、门禁、回流和归档规则                                                                                                                              |
|                  | `task-records`                     | 按任务规模维护 tasks / design / acceptance / handoff 记录                                                                                                                |
| 编码 `coding/`   | `coding-standards`                 | 通用编码规范：跟随已有写法、数值配置化与单一事实源、设计模式的判断与落地、扩展点与框架设计、交付前自查                                                                   |
|                  | `systematic-debugging`             | 先查历史 Bug，从模块逐层定位，找到根因再修、修完就停                                                                                                                     |
|                  | `verification-before-completion`   | 没有新鲜验证证据不声称完成                                                                                                                                               |
| 文档 `docs/`     | `project-documentation`            | DOC_ROOT、AGENTS.md 分工、模块地图与文档骨架、更新规则                                                                                                                   |
| 项目 `project/`  | `project-structure`                | 所有项目通用：陌生项目的目录、构建、测试、运行方式和常见坑                                                                                                               |
|                  | `ue-project-structure`             | `project-structure` 的 UE 特化，只补引擎部分：模块与插件、UHT/UBT、自动化测试、Gameplay 框架、Cook、资产规则；用到它时面板自动带上 `project-structure`                   |
|                  | `project-testing`                  | 测试先行（红-绿-重构）、怎么写好测试、按改动选测试、找项目自己的验证命令、写验收证据                                                                                     |
| 版本控制 `vcs/`  | `project-vcs`                      | 版本控制与交付的唯一入口：识别 Git / P4 / SVN，保护既有改动；Git 的分支、worktree 与合并方向、P4 的 pending 分桶、SVN 的本地纳管分在技能内的 `git.md`、`p4.md`、`svn.md` |
| UE `ue/`         | `cpp-code-style`                   | C++ / UE C++ 格式、日志格式、模块导出规则                                                                                                                                |
|                  | `lua-code-style`                   | Lua 日志格式与排版                                                                                                                                                       |
| 美术 `art/`      | `blender-model-animation-workflow` | Blender 建模与动画的阶段和交付约定                                                                                                                                       |
|                  | `blender`                          | 无头 Blender 建模、体检、多视角截图与 UE FBX 导出                                                                                                                        |

## 新增技能

- 放在合适的分类下：`<分类>/<技能名>/SKILL.md`。
- 文件夹名必须等于 frontmatter 的 `name`，且在所有分类里唯一（安装后是平铺的）。
- frontmatter 只写 `name`、`description`，需要时加 `user-invocable: true`。`description` 不超过 1024 字，写清楚做什么、什么时候用。
- 脚本、模板、参考资料都放在技能文件夹里，正文用「本技能目录下的 `scripts/…`」引用，不引用仓库里其他位置的文件。
- 同一个能力块的细则放在一个技能里：入口 `SKILL.md` 只管识别和路由，具体规则放同目录的子文件（例如 `project-vcs` 的 `git.md`、`p4.md`、`svn.md`），不拆成多个顶层技能。
- 针对某类项目的特化技能（例如 `ue-project-structure`）只写和通用技能的差异，并在 `shared/skill-guide.ts` 的 `SKILL_BASE` 登记它扩展的通用技能，Agent 用到特化技能时面板会把通用的一起带上。
- 下线技能时在 `shared/skill-guide.ts` 的 `RETIRED_SKILL_MAP` 写上接替它的技能，在 `server/bundled-skills.ts` 的 `RETIRED_BUNDLED` 记下旧文件的 sha256（用户机器上没改过的旧副本会被清掉）。
- 不在技能里写「加载某某技能」「每轮默认使用」之类的编排；引用别的技能写成「需要时配合 X 技能」，X 必须是这里已有的技能。
- 文本文件用 UTF-8（无 BOM）和 LF 换行。

## 运行依赖

| 技能                   | 依赖                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `blender`              | Python 3、Blender（`BLENDER_PATH`、PATH 或常见安装位置）；`reference_frames.py` 还需要 ffmpeg |
| `systematic-debugging` | bash（`find-polluter.sh`，Windows 上用 Git Bash）                                             |
| `openspec`             | `openspec` 命令行和 `/opsx-*` 斜杠指令                                                        |
