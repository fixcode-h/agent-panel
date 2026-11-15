# skills：内置 Skill

- 状态：documented
- 职责：随面板发布的内置 Skill，安装时平铺到用户目录
- 源码：`skills/`
- 入口：`skills/README.md`
- 关键词：Skill、技能、SKILL.md、内置技能
- 更新：2026-11-15

## 职责

随 Agent 面板一起发布的技能，在「Skills」页可以安装到用户目录的 `~/.agents/skills`（各 CLI 共用这一份）。
运行用到某个技能的 Agent 时，面板也会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理。

技能只写「这件事怎么做好」的规则；什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent 决定。

## 在界面上看和改技能

内置技能（`skills/` 下）和用户目录里的技能，都能在「Skills」页看：左边列表按**装在哪几个 Agent** 分组浏览（同一个技能装了几个就出现在几组里），右边详情页能看和改 `SKILL.md`、看这个技能的文件结构（多文件的技能能看到 `references/` 这类子目录，可新建 / 重命名 / 删除附加文件），也能对当前技能做「AI 优化」（建议先看再应用，不直接写文件）。前端的组件划分、路由口径和文件树的排序约定见 [modules/web](../web/README.md) 的「Skills页」一条。

「自带 Skill」分页能看到每个自带技能带哪些文件：列表点开后右侧详情显示名称、分类、说明、装没装、文件树（后端 `server/bundled-skills.ts` 的 `treeOf` 按内置文件算出 `BundledSkill.tree`，和用户技能同一个 `LibraryTree` 形状），点文件能读内容（只读接口 `/library/bundled/entry`，内容来自仓库 `skills/` 那份、不读用户目录）。**自带技能的内容随面板版本提供，界面上不能编辑**：改了既会被下次更新覆盖，也不影响真正生效的 `~/.agents/skills` 那份；要改就复制一份到自己的技能目录。安装 / 更新在详情页头部和左栏底部（批量）都能做。

注意两者的区别：这里说的是**浏览和编辑**，安装规则没变（见上：安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理）。

## 全局 / 按项目（2026-11-15，工作包 W4）

技能可以标成「按项目」（Skills 页、自带 Skill 详情页的「生效」一行；按技能名切，同名的自带技能和各 CLI 目录里的同名技能一起切，记在数据目录 `config/skill-activation.json`）：

- 按项目的**不放在用户目录**：自带技能从 `~/.agents/skills`（和「部署」的分类目录）撤掉，只撤和自带一模一样的；自己的技能从 CLI 用户目录挪进数据目录 `project-skills/<CLI>/<名字>/`，技能库照样能看、能改。安装、部署、执行前补齐都跳过它们。
- 每轮只给项目「能力」里打开了它（`project.capabilities.skills`）的项目带上，角色点名要用的也带：放进数据目录 `run-skills/<项目>/<CLI>/`，按 CLI 定义的 `runSkills` 交给 CLI（Claude Code `--add-dir`、Codex app-server 的 extraRoots 请求、Pi 和 Command Code `--skill`）；没写 `runSkills` 的 CLI 在提示里列出技能路径。代码在 `server/skills/`。
- 改回全局时挪回原来的 CLI 用户目录；自带技能不自动装回去（在「自带 Skill」页装，或角色用到时补上）。

## 入口

`skills/README.md`：分类表和新增技能的规则。当前分类：`workflow/`、`coding/`、`docs/`、`project/`、`vcs/`、`ue/`、`art/`。

## 依赖

不参与应用编译，没有代码依赖。部分技能有运行依赖（Blender、openspec 命令行等），列在 `skills/README.md` 的「运行依赖」表。

## 回归验证

- `npm run typecheck`、`npm run test:unit`（服务端读取内置技能的相关逻辑在 `server/bundled-skills.ts`）。
- 新增或改名后：文件夹名必须等于 frontmatter 的 `name` 且在所有分类里唯一，安装后才能平铺、引用才对得上。

## 待确认

- 技能改名或删除后，内置 Agent 里引用的技能名也要同步（待确认是否有检查覆盖）。
