# 内置 Skills

随 Agent 面板一起发布的技能。装在面板数据目录的 `bundled-skills/`（不再装进 `~/.agents/skills`，那里各 CLI 会启动时全部读进去）；运行用到某个技能的 Agent 时，面板会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，下面的分类文件夹只用于整理。

**启动时只带角色的技能，其余由面板推**（ADR 0083）：每轮只把角色点名的、用户设成「每个对话都带」的技能交给 CLI；其他技能在用得上的那一刻（改某类文件、跑某类命令、命令失败、要收尾、项目里有某种文件、节点参数……）由面板把 `SKILL.md` 正文直接推给模型。每个技能的默认条件写在 `shared/skills/catalog.ts`，用户在设置「Agent 工具 → 技能」里改。

技能只写「这件事怎么做好」的规则。什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent（Agent 里列出它用的技能名）决定。

## 分类

| 分类             | 技能                             | 用途                                                                                                                                                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 流程 `workflow/` | `brainstorming`                  | 动手前澄清需求、比较方案、形成设计并取得批准                                                                                                                             |
|                  | `grilling`                       | 按设计树逐个追问（一问配几个选项），压测计划和决策                                                                                                                       |
|                  | `openspec`                       | OpenSpec 各阶段的产物、门禁、回流和归档规则                                                                                                                              |
|                  | `task-records`                   | 按任务规模维护 tasks / design / acceptance / handoff 记录                                                                                                                |
| 编码 `coding/`   | `coding-standards`               | 通用编码规范：跟随已有写法、数值配置化与单一事实源、设计模式的判断与落地、扩展点与框架设计、交付前自查                                                                   |
|                  | `systematic-debugging`           | 先查历史 Bug，从模块逐层定位，找到根因再修、修完就停                                                                                                                     |
|                  | `verification-before-completion` | 没有新鲜验证证据不声称完成                                                                                                                                               |
| 文档 `docs/`     | `project-documentation`          | DOC_ROOT、AGENTS.md 分工、模块地图与文档骨架、更新规则                                                                                                                   |
| 项目 `project/`  | `project-structure`              | 所有项目通用：陌生项目的目录、构建、测试、运行方式和常见坑                                                                                                               |
|                  | `ue-project-structure`           | `project-structure` 的 UE 特化，只补引擎部分：模块与插件、UHT/UBT、自动化测试、Gameplay 框架、Cook、资产规则；用到它时面板自动带上 `project-structure`                   |
|                  | `project-testing`                | 测试先行（红-绿-重构）、怎么写好测试、按改动选测试、找项目自己的验证命令、写验收证据                                                                                     |
| 版本控制 `vcs/`  | `project-vcs`                    | 版本控制与交付的唯一入口：识别 Git / P4 / SVN，保护既有改动；Git 的分支、worktree 与合并方向、P4 的 pending 分桶、SVN 的本地纳管分在技能内的 `git.md`、`p4.md`、`svn.md` |
| UE `ue/`         | `cpp-code-style`                 | C++ / UE C++ 换行与格式、日志、模块导出                                                                                                                                  |
|                  | `lua-code-style`                 | Lua 换行、写法、日志                                                                                                                                                     |

## 新增技能

- 放在合适的分类下：`<分类>/<技能名>/SKILL.md`，并在 `shared/skills/catalog.ts` 的 `BUILTIN_SKILLS` 加一行：什么时候用（guide）和默认的推送条件（when）。只在用户主动走流程时才用的，不写条件、`autoPush: false`（单测核对每个技能都有一行）。
- 文件夹名必须等于 frontmatter 的 `name`，且在所有分类里唯一（安装后是平铺的）。
- frontmatter 只写 `name`、`description`，需要时加 `user-invocable: true`。`description` 不超过 1024 字，写清楚做什么、什么时候用。
- 脚本、模板、参考资料都放在技能文件夹里，正文用「本技能目录下的 `scripts/…`」引用，不引用仓库里其他位置的文件。
- 同一个能力块的细则放在一个技能里：入口 `SKILL.md` 只管识别和路由，具体规则放同目录的子文件（例如 `project-vcs` 的 `git.md`、`p4.md`、`svn.md`），不拆成多个顶层技能。面板推送时整份推入口，**入口不超过 8000 字**，入口里写明什么时候读哪个子文件。入口大改时在 `server/skills/installed-record.ts` 的 `RELEASED_HASHES` 登记发布过的旧版指纹，用户没改过的旧副本才会自动换新。
- 针对某类项目的特化技能（例如 `ue-project-structure`）只写和通用技能的差异，并在 `shared/skills/catalog.ts` 那一行的 `base` 写它扩展的通用技能，Agent 用到特化技能时面板会把通用的一起带上。
- 下线技能时在 `shared/skill-guide.ts` 的 `RETIRED_SKILL_MAP` 写上接替它的技能，在 `server/bundled-skills.ts` 的 `RETIRED_BUNDLED` 记下旧文件的 sha256（用户机器上没改过的旧副本会被清掉）。
- 不在技能里写「加载某某技能」「每轮默认使用」之类的编排；引用别的技能写成「需要时配合 X 技能」，X 必须是这里已有的技能。
- 文本文件用 UTF-8（无 BOM）和 LF 换行。

## 运行依赖

| 技能                   | 依赖                                              |
| ---------------------- | ------------------------------------------------- |
| `systematic-debugging` | bash（`find-polluter.sh`，Windows 上用 Git Bash） |
| `openspec`             | `openspec` 命令行和 `/opsx-*` 斜杠指令            |
