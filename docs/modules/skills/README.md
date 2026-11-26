# skills：内置 Skill

- 状态：documented
- 职责：随面板发布的内置 Skill，装在面板数据目录，启动时只带角色的，其余由面板按情境推正文
- 源码：`skills/`
- 入口：`skills/README.md`
- 关键词：Skill、技能、SKILL.md、内置技能、技能推送、技能目录、SkillWhen、Agent 工具
- 更新：2026-11-26

## 职责

随 Agent 面板一起发布的技能，装在面板数据目录的 `bundled-skills/<技能名>/`（ADR 0083；以前装在 `~/.agents/skills`，第一次用到时由 `server/skills/store-move.ts` 一次性搬过来，用户改过的那份原样留着）。
运行用到某个技能的 Agent 时，面板也会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理。

## 技能由面板推送（2026-11-26，ADR 0083）

- **启动时只带角色的技能**：每轮的技能目录 `run-skills/<项目>/<CLI>-<指纹>/` 只放角色点名的（含引入的角色、挂载能力）、用户设成「每个对话都带」的、项目打开了的按项目技能（`server/skills/run-skills.ts`，按要带的这组技能分目录，不同角色的对话同时跑互不覆盖）。
- **其余技能按条件推正文**：技能目录 `shared/skills/catalog.ts`（来源注册表：自带、插件；用户改动套在上面），条件 `shared/skills/when.ts`（命令类别在 `commands.ts`），工具调用时的条件生成情境规则（`shared/skills/rules.ts`，由 `server/hooks/situational.ts` 推），开跑时的在 `server/skills/launch-push.ts`。正文读 `server/skills/skill-body.ts`（缓存 60 秒），推送规矩（一次、补推、上限、base）在 `server/skills/push.ts`，推送记录在 `server/skills/push-ledger.ts`（`recordSkillPush` / `skillPushes` 签名固定）。推送文字在 `shared/skills/push-text.ts`。
- **设置**：「Agent 工具 → 技能」（`web/src/components/settings/agent-tools/`，接口 `shared/api-contract/agent-tools.ts`，服务端 `server/skills/api.ts`，演示 `web/src/lib/demo/demo-agent-tools.ts`）。开关、条件、每个对话都带存在 `config/hooks.json` 的 `skills`；上限是内置钩子 `skill-push` 的 `tokens` 参数。
- **会话栏**：「环境 → 技能」读会话用量的 `skills`（`shared/skills/usage.ts`）。
- 入口要短：面板整份推，入口不超过 8000 字，细节放子文件并写明什么时候读（`shared/skills/catalog.test.ts` 核对瘦身过的两个）。入口大改过的技能把发布过的旧版指纹登记在 `server/skills/installed-record.ts` 的 `RELEASED_HASHES`，没改过的旧副本照样自动换新。

技能只写「这件事怎么做好」的规则；什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent 决定。

## 在界面上看和改技能

内置技能（`skills/` 下）和用户目录里的技能，都能在「Skills」页看：左边列表按**装在哪几个 Agent** 分组浏览（同一个技能装了几个就出现在几组里），右边详情页能看和改 `SKILL.md`、看这个技能的文件结构（多文件的技能能看到 `references/` 这类子目录，可新建 / 重命名 / 删除附加文件），也能对当前技能做「AI 优化」（建议先看再应用，不直接写文件）。前端的组件划分、路由口径和文件树的排序约定见 [modules/web](../web/README.md) 的「Skills页」一条。

「自带 Skill」分页能看到每个自带技能带哪些文件：列表点开后右侧详情显示名称、分类、说明、装没装、文件树（后端 `server/bundled-skills.ts` 的 `treeOf` 按内置文件算出 `BundledSkill.tree`，和用户技能同一个 `LibraryTree` 形状），点文件能读内容（只读接口 `/library/bundled/entry`，内容来自仓库 `skills/` 那份、不读用户目录）。**自带技能的内容随面板版本提供，界面上不能编辑**：改了既会被下次更新覆盖，也不影响真正生效的数据目录 `bundled-skills/` 那份；要改就复制一份到自己的技能目录。安装 / 更新在详情页头部和左栏底部（批量）都能做。

注意两者的区别：这里说的是**浏览和编辑**，安装规则没变（见上：安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理）。

## 全局 / 按项目（2026-11-15，工作包 W4）

技能可以标成「按项目」（Skills 页、自带 Skill 详情页的「生效」一行；按技能名切，同名的自带技能和各 CLI 目录里的同名技能一起切，记在数据目录 `config/skill-activation.json`）：

- 按项目的**不放在共用目录**：自带技能从数据目录 `bundled-skills/`（和「部署」的分类目录）撤掉，只撤和自带一模一样的；自己的技能从 CLI 用户目录挪进数据目录 `project-skills/<CLI>/<名字>/`，技能库照样能看、能改。安装、部署、执行前补齐都跳过它们。
- 每轮只给项目「能力」里打开了它（`project.capabilities.skills`）的项目带上，角色点名要用的也带：放进数据目录 `run-skills/<项目>/<CLI>-<指纹>/`，按 CLI 定义的 `runSkills` 交给 CLI（Claude Code `--add-dir`、Codex app-server 的 extraRoots 请求、Pi 和 Command Code `--skill`）；没写 `runSkills` 的 CLI 在提示里列出技能路径。代码在 `server/skills/`。
- 改回全局时挪回原来的 CLI 用户目录；自带技能不自动装回去（在「自带 Skill」页装，或角色用到时补上）。

## 插件带的技能

- 2026-11-18 起开着的插件带的技能每轮全放进技能目录、提示里另列一节；ADR 0083 起不再这样：插件技能进技能目录（来源「插件 · 名字」，默认条件是调这个插件的工具 `<插件 id>_*`），用得上时由面板推正文，角色点名的照旧开跑就带（`server/skills/plugin-skills.ts` 只负责算这个项目能用哪些）。
- 「/」菜单列出开着的插件带的技能和面板自带的技能，由面板把 SKILL.md 展开成要求（`server/plugins/contrib.ts` 的 `pluginSkillCommands`、`server/skills/slash-skills.ts`），对所有 CLI 都一样。

## 入口

`skills/README.md`：分类表和新增技能的规则。当前分类：`workflow/`、`coding/`、`docs/`、`project/`、`vcs/`、`ue/`、`art/`。

## 依赖

不参与应用编译，没有代码依赖。部分技能有运行依赖（Blender、openspec 命令行等），列在 `skills/README.md` 的「运行依赖」表。

## 回归验证

- `npm run typecheck`、`npm run test:unit`（服务端读取内置技能的相关逻辑在 `server/bundled-skills.ts`）。
- 新增或改名后：文件夹名必须等于 frontmatter 的 `name` 且在所有分类里唯一，安装后才能平铺、引用才对得上。

## 待确认

- 技能改名或删除后，内置 Agent 里引用的技能名也要同步（待确认是否有检查覆盖）。
