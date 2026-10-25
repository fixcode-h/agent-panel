# skills：内置 Skill

- status: inferred
- source_paths: `skills/`
- entry: `skills/README.md`
- analyzed_at: 2026-10-24

## 职责

随 Agent 面板一起发布的技能，在「Skills 与命令」页可以安装到用户目录的 `~/.agents/skills`（各 CLI 共用这一份）。
运行用到某个技能的 Agent 时，面板也会自动安装缺的技能。安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理。

技能只写「这件事怎么做好」的规则；什么时候用哪个技能、按什么顺序走、哪一步要人确认，由工作流和 Agent 决定。

## 在界面上看和改技能

内置技能（`skills/` 下）和用户目录里的技能，都能在「Skills 与命令」页看：左边列表按**装在哪几个 Agent** 分组浏览（同一个技能装了几个就出现在几组里），右边详情页能看和改 `SKILL.md`、看这个技能的文件结构（多文件的技能能看到 `references/` 这类子目录，可新建 / 重命名 / 删除附加文件），也能对当前技能做「AI 优化」（建议先看再应用，不直接写文件）。命令（`kind === 'command'`）只有一个命令文件，详情页不显示文件结构。前端的组件划分、路由口径和文件树的排序约定见 [modules/web](../web/README.md) 的「Skills 与命令页」一条。

注意两者的区别：这里说的是**浏览和编辑**，安装规则没变（见上：安装时按 `<技能名>/SKILL.md` 平铺，分类文件夹只用于整理）。

## 入口

`skills/README.md`：分类表和新增技能的规则。当前分类：`workflow/`、`coding/`、`docs/`、`project/`、`vcs/`、`ue/`、`art/`。

## 依赖

不参与应用编译，没有代码依赖。部分技能有运行依赖（Blender、openspec 命令行等），列在 `skills/README.md` 的「运行依赖」表。

## 回归验证

- `npm run typecheck`、`npm run test:unit`（服务端读取内置技能的相关逻辑在 `server/bundled-skills.ts`）。
- 新增或改名后：文件夹名必须等于 frontmatter 的 `name` 且在所有分类里唯一，安装后才能平铺、引用才对得上。

## 待确认

- 技能改名或删除后，内置 Agent 里引用的技能名也要同步（待确认是否有检查覆盖）。
