# 自带 Skill 的卡片点不开，右边永远是同一段引导文字

- 状态：已修复（界面检查 `scripts/ui/03-library.mjs` 的「自带Skill-详情」「自带Skill-详情-文件内容」「自带Skill-目录折叠」「自带Skill-刷新后选中项还在」）
- 症状：「自带 Skill」分页的卡片点不开，右侧永远是同一段引导文字
- 入口：`web/src/components/library/BundledSkills.tsx`、`web/src/components/library/BundledDetail.tsx`、`web/src/pages/LibraryPage.tsx`、`server/bundled-skills.ts` 的 `treeOf` / `readBundledEntry`、`server/library.ts` 的 `/library/bundled/entry`
- 根因类型：该分页只渲染列表、没有选中回调和详情；后端 `BundledSkill` 也只有文件个数没有清单
- 模块：`web` + `server`（`web/src/components/library/BundledSkills.tsx`、新增 `web/src/components/library/BundledDetail.tsx`、`web/src/pages/LibraryPage.tsx`、`server/bundled-skills.ts` 的 `treeOf` / `readBundledEntry`、`server/library.ts` 的 `/library/bundled/entry`）
- 关键词：自带 Skill、点不开、没有详情、整行不可点、BundledSkills、空态、文件结构、只读、`~/.agents/skills`

## 现象

用户在「自带 Skill」分页（截图 `attachments/截图-073204.png`）报「自带技能不能点击打开详情面板」：卡片（`brainstorming` / `grilling` / `openspec` / `task-records` / `coding-standards` …）整张点不动，右栏固定显示同一段引导「这些是面板自带的技能，统一装在 ~/.agents/skills…」，看不到某个技能带哪些文件、装没装。

## 原因

上一轮把技能页改成「左列表 + 右详情」时，只给普通 Skill / 命令做了详情，自带 Skill 分页留成了老的单列列表：

- `web/src/pages/LibraryPage.tsx` 里 `tab === 'bundled'` 分支只渲染 `<BundledSkills query={query} />`，没有任何选中 / 打开回调；右栏是写死的 `DetailEmpty`。
- `BundledSkills`（旧实现）是一条条带「安装 / 更新」按钮的 `<li>`，正文不是按钮，没有 `onClick`。
- 后端 `BundledSkill` 只有 `files: number`（文件个数），没有文件清单，前端想画文件树也没有数据。

## 修复

- 后端：`BundledSkill` 增加可选 `tree?: LibraryTree`，由 `server/bundled-skills.ts` 的 `treeOf(e)` 用内置文件算出（排除 `SKILL.md`；排序和上限交给 `shared/library.ts` 的 `treeFromPaths`，和用户技能同一套规则）。`files` 改成从树里数文件，口径和详情页显示的一致。
- 新增只读内容接口 `GET /library/bundled/entry?name=&path=`（`readBundledEntry`）：内容来自内置的那份（仓库 `skills/`，出包后在 `server.mjs` 里），**不读用户目录**；`path` 空表示 `SKILL.md`。二进制只给大小，超 1 MB 报错，文案和用户技能一致。
- 前端：`BundledSkills` 改成可点的 `ListItem`（按分类分组、右侧显示安装状态），选中项记在同一个 `#/library/<名字>` 路由里（自带技能不分 Agent，`sub` 为空）；新增 `BundledDetail` 显示名称、分类、说明、`~/.agents/skills/<名字>/SKILL.md`、安装状态、只读文件树与内容，并明确写「自带技能的内容由面板随版本提供，不能在这里编辑」；安装 / 更新按钮在详情页头部，批量操作收在左栏底部 `BundledBulkBar`。
- 列表与安装动作抽到 `web/src/lib/use-bundled-skills.ts` 的 `useBundledSkills`，左栏和详情页共用一份状态，装完两边同时刷新。

### 顺带修掉的一条同源问题：刷新丢选中项

「自带 Skill 的选中项也走 `route.id`」之后暴露出一条老问题：`useEffect(..., [tab])` 里那句
`if (route.id) go({ page: 'library' })` 会在**组件挂载时**也执行一次，于是刷新页面或从链接打开
`#/library/coding-standards` 会把名字清掉，紧接着「自动选第一项」再把它顶成 `brainstorming`。
普通 Skill 页（`#/library/<名字>/<cli>`）一直是同一个毛病，只是没人刷新试过。

修法：把清地址挪到**切换分页的动作**上（`pickTab`，`Select` 的 `onChange` 调它），effect 只负责
`setData(null)` / `setQuery('')` / `writeTab` / `load`。**不要**在 effect 里用「首次执行」标记判断：
开发模式启用了 `<StrictMode>`（`web/src/main.tsx`），effect 会跑两遍，标记在第二遍就被消费掉、
把「挂载」误判成「换分页」——这个坑按标记写法改过一次才确认，之后改成事件处理器才干净
（事件处理器不会被 StrictMode 重跑）。

## 回归

- `server/builtin.test.ts`（自带 Skill 那条）：断言 `tree` 不含 `SKILL.md`、树里文件数等于 `files`、父目录排在子文件前面。
- `scripts/ui/03-library.mjs`：「自带Skill-详情」断言点卡片后地址带 `#/library/coding-standards`、详情里有「编码」「文件结构」「~/.agents/skills」、有「由面板随版本提供」的说明、**没有**可编辑的正文框；「自带Skill-详情-文件内容」点 `design-patterns.md` 和 `SKILL.md`，断言 `pre` 里的内容对得上；「自带Skill-目录折叠」点 `templates/` 收起再展开；「自带Skill-刷新后选中项还在」点卡片后 `reload()`，断言 hash 和右侧详情都还是原来那个技能。

## 防复发

- 一个分页里同时有两种「可打开的项」时，选中状态要走同一个路由字段，不要给某一类单独开 state：`route.id` 在 Skill 页是技能名、在自带 Skill 页也是技能名，切换分页时地址统一清掉。
- 只读的来源（仓库里随版本发布的内容）和用户目录里的内容是两个事实源，界面上必须分开口径说清楚；不要给只读内容放编辑框，也不要复用用户技能那套写接口。
- **依赖是 `[tab]` 这类「挂载时也会跑」的 effect 里不要写「清掉地址」这类有副作用的动作**：刷新、复制链接都会走到它。要在「用户真的切了分页」时才清，就把清地址放进切换动作本身；也不要靠 effect 内部的首次执行标记——StrictMode 下开发模式会跑两遍。
- 界面检查跑的是 `vite build --mode demo` 的生产产物，**拦不住只在开发模式（StrictMode 双跑 effect）出现的问题**：这类逻辑要么放事件处理器，要么自己用 `npm run dev` 手测一次，别只看分片绿。
