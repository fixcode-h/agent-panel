# 点 UI 设计侧栏的项目名没有反应

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`、WSL 里的 `npm run test:e2e`、`npx vite build --mode demo` + `node scripts/ui-check.mjs 04` 均通过）；交互语义后来按用户要求改成「点项目名进主页、只有箭头折叠」，见 design-project-home
- 症状：UI 设计侧栏点项目名「游戏」完全没反应，只有很小的折叠箭头能点
- 入口：`web/src/components/layout/SidebarDesigns.tsx` 的 `DesignList`
- 根因类型：行上没绑点击、可点区域只有小按钮
- 模块：`web`（`web/src/components/layout/SidebarDesigns.tsx` 的 `DesignList`），配套 `scripts/ui/04-design.mjs`
- 关键词：UI 项目、点项目名没反应、只有小箭头能点、折叠 / 收起、整行可点、cursor-pointer、冒泡、stopPropagation

## 现象

左侧栏「UI 项目」区块里的一行是 `⌄ 📂 游戏 …… 1`，下面缩进着 `> 🌐 网页 UI …… 1`。
点项目名「游戏」这两个字没有任何反应，点行内的空白也一样；只有点行最左边那个很小的折叠箭头（`h-6 w-6`，约 24px）才能展开 / 收起。用户报的是「UI 项目的项目名称点击无效」。

## 根因

- 项目行外层 `div` 上没有任何 `onClick`，项目名的图标和文字是纯文本 `span`，所以点项目名、点行内空白都没有响应。
- 唯一绑了折叠逻辑的是左侧箭头按钮自己的 `onClick`（里面 `setFolded` 增删这个项目 id），可点区域只有那个很小的按钮。
- 同一文件里的设计项行（`designRow`）早就改成了整行可点，并写了注释说明原因（「以前只有文字能点，点到图标或空白处没反应，像是要点两次」）；项目行漏了这一步。

## 修复

- 项目行外层 `div` 加 `onClick`，行为与左侧箭头一致：切换这个项目的折叠状态，且只在项目下有设计（`ds.length > 0`）时才响应；补 `cursor-pointer` 和 `hover:text-fg`，和设计项行的 `text-muted hover:bg-sel/60 hover:text-fg` 对齐。
- 有设计时项目名（图标 + 文字）换成 `button`，承接键盘聚焦并带 `aria-expanded`，点击冒泡到整行去折叠，按钮上不另写 `onClick`；项目下没有设计时退化成 `span`，免得多出一个按了没反应的 tab stop。
- 左侧箭头按钮去掉自己的 `onClick`，折叠只靠冒泡（两处都写会折叠两次，看起来像点了没反应）；保留按钮本身是为了 `aria-expanded` 有落点、键盘可聚焦，`disabled` 和 `invisible`（无设计时）照旧。
- 右侧「新建设计」的 `Plus` 按钮加 `e.stopPropagation()`：行内自己的动作不冒泡成折叠。
- 项目行和分类行（折叠集合的 key 是 `项目id:分类id`）里重复的 `setFolded` 抽成 `toggleFold(key)` 共用；分类行补 `data-kind={k.id}` 方便定位，它本来就是整行 `button`，只换了调用方式。
- 交互语义定为「折叠」而不是「跳转」：UI 设计的 `PageId`（`web/src/lib/data.tsx`）里只有 `design` 页，`route.id` 认的是设计 id，没有项目详情页；Agent 侧栏点项目名能进项目页是因为那边有 `projects` 页。这两处语义不同，不能照抄。

## 防线

- `scripts/ui/04-design.mjs` 的「UI设计-点项目名收起」「UI设计-点项目名展开」：点项目名后分类行（`[data-kind="game"]`）消失 / 回来，并断言 `aria-expanded`，用来区分「点了没反应」和「本来就收着」。
- 同一处再点左侧箭头按钮，断言只折叠一次——冒泡和按钮各写一份 `onClick` 时会折叠两次，这条断言就是拦它。
- 定位都限在 `[data-sidebar]` 里，项目名用 `exact: true` 定位，分类行按 `data-kind` 而不是文字子串匹配，避免被同名内容抢走。
