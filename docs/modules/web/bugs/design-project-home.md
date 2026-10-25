# UI 项目点不进主页，改之前点整行就折叠

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build` 通过）
- 模块：`web`（`web/src/components/layout/SidebarDesigns.tsx` 的 `DesignList`、`web/src/pages/DesignPage.tsx`、新增 `web/src/components/design/DesignProjectHome.tsx`），配套 `scripts/ui/04-design.mjs`
- 关键词：UI 项目、项目主页、点项目名、点整行折叠、折叠按钮、箭头、`id: 'home'`、`designHomeRoute`

## 现象

用户报两件事（原话：「UI 项目点击不能打开 UI 项目主页，增加 UI 项目主页，参考 Agent 的项目主页，然后折叠的话点击最前的折叠按钮才折叠」）：

1. 侧栏「UI 项目」里点项目名「游戏」不会打开项目主页——因为这个模式当时根本没有项目主页这一页。
2. 上一版把项目行改成整行可点切换折叠，点项目名那一行就折叠 / 展开；用户要的是只有最前面那个 `⌄` 箭头按钮能折叠。

## 根因

- 侧栏项目行外层 `div` 带 `onClick={() => ds.length > 0 && toggleFold(p.id)}`，项目名 `button` 上没有任何 `onClick`，只靠冒泡，所以点项目名只能折叠，没有地方可去。
- 路由上也没有「项目主页」这个状态：`web/src/pages/DesignPage.tsx` 是 `route.id && route.id !== 'new' ? <Designer id={route.id}/> : <NewDesign projectId={route.sub}/>`，`design` 页只有设计器和新建设计两种，`id` 认的是设计 id。
- 这是上一次修复（「点项目名没反应」）把语义定成了折叠的结果，见 [design-project-row-click](design-project-row-click.md)；用户这次推翻了这个取舍。

## 修复

- 新增 UI 项目主页 `web/src/components/design/DesignProjectHome.tsx`，参考 Agent 的 `ProjectWorkspace` 信息结构：项目名 + 概况（界面总数、游戏 / 网页各几个、最近改动时间、可选项目目录），顶栏「新建设计」「项目设置」「美术提示词」，下面按类型分组列出这个项目的界面（图标、标题、类型、等你处理 / 执行中 / N 分钟前），点一行进设计器；没有界面时是虚线框加新建按钮。
- 路由沿用已有的「`id` 不是实体 id 时表示页面」这一约定：`id: 'home'` 是项目主页（项目 id 在 `sub`），和 `id: 'new'`（新建设计）并列；`web/src/pages/DesignPage.tsx` 按主页 / 新建设计 / 设计器三段分流。不改 `Route` 类型、不改地址栏格式，`#/design/home/<项目id>`。
- 侧栏项目行不再整行可点：外层 `div` 去掉 `onClick`，箭头按钮自己 `onClick={() => toggleFold(p.id)}` 并保留 `aria-expanded` / `aria-label` / 项目无设计时 `invisible` + `disabled`；项目名 `button` 改成 `go(designHomeRoute(p.id))`，`aria-label` 写「打开项目「{name}」，右键查看更多操作」。项目行里当前所在的项目（主页）加 `bg-sel` 高亮。
- 折叠集合的增删、分类键、项目主页的排序和分组抽到 `web/src/lib/design-projects.ts`：`toggleFoldKey`、`kindFoldKey`、`projectDesigns`、`groupByKind`、`projectSummary`、`kindLabel`，侧栏和主页共用一份口径。
- 删掉右侧 `Plus` 按钮上的 `e.stopPropagation()`——行上已经没有折叠动作了，靠冒泡什么都不会触发。

## 防线

- `web/src/lib/design-projects.test.ts`（8 条）：`designHomeRoute` 的字段和 `'new'` 不冲突、`kindFoldKey` 带项目 id、`toggleFoldKey` 不改传入集合、`designKind` 对老数据兜底、`kindLabel` 跟随语言、`projectDesigns` 的排序稳定、`groupByKind` 只分组不重排、`projectSummary` 的计数。
- `scripts/ui/04-design.mjs` 的「UI设计-项目主页」「UI设计-箭头收起」：点项目名后进 `#/design/home/demo-ui-project`、分类行仍在（没折叠），主页容器里能看到两个设计；点箭头按钮才让 `[data-kind="game"]` 卸载（并断言 `aria-expanded === 'false'`），再点一次恢复。
- 断言全部限在 `[data-design-home="demo-ui-project"]` 里，定位限在 `[data-sidebar]` 里，项目名用 `aria-label` 前缀定位，折叠箭头用 `data-fold={项目id}`（Agent 侧栏的项目行也有同名「收起」按钮，靠 `getByRole('收起').first()` 会点到别的行），分类行按 `data-kind` 而不是文字子串匹配。
- 对照组验证过这两条守卫真的能拦住回归：临时把主页的设计列表整段换成 `[].map(...)`，界面检查在 `getByText('主菜单')` 等待超时失败（不再是假通过）；恢复后重跑通过。

## 评审发现的两个问题（已修复）

- 主页在 `designProjects` 还没取回来时（初值 `[]`）就判「这个 UI 项目已经不在了」：直接从地址打开主页会先闪一下不存在的提示，「返回」还会把人带回新建设计页。修法是 `data.tsx` 新增 `designProjectsLoaded`（`finally` 里置真，取失败也算已问过，不会一直停在加载态），主页未加载完且找不到项目时只渲染带 `data-design-home` 的空壳。
- 界面检查的「项目主页」断言没限定作用域：侧栏先于页面渲染、设计行里也有「主菜单」「背包」，主页完全没画出来这条断言也照样通过。修法是给主页根节点加 `data-design-home` 锚点，断言和点击都限定在该容器内。
