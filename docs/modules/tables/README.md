# tables：表格页（游戏配置表管理）

- 状态：documented
- 职责：按项目设置的表格目录浏览、搜索、查看、在线修改 xlsx / CSV 表格；表头、枚举等结构信息存在表格之外
- 源码：`server/tables/`、`shared/tables.ts`、`shared/csv.ts`、`web/src/pages/TablesPage.tsx`、`web/src/components/tables/`
- 入口：`server/tables/routes.ts`、`web/src/pages/TablesPage.tsx`
- 关键词：表格、配置表、表格目录、绝对路径、目录选择器、xlsx、CSV、表头、枚举、引用、结构文件、内容搜索、原地保存、检查、AI 分析表格风格、版本差异、一格的历史、提交、冲突合并、跨项目对比、table.edit
- 更新：2026-11-11

设计稿在项目共享目录 `designs/表格管理与在线编辑-设计稿.md`。硬约束：**表格文件只在用户保存改动时原地改单元格，结构信息一律不写进表格**。

## 入口

| 文件                                                       | 做什么                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `shared/tables.ts`                                         | 项目设置里的 `TablesConfig`、表格页的数据结构、结构文件 `TableSchema`、通配和表头优先级       |
| `shared/csv.ts`                                            | CSV 的读、写回（保持分隔符 / 换行 / BOM / 结尾换行）                                          |
| `server/tables/files.ts`                                   | 列表格文件、解析（按 mtime + 大小缓存）、锁文件检查、跨文件内容搜索、路径越界检查             |
| `server/tables/schema-store.ts`                            | 结构文件读写：`.agentpanel/tables/` 或数据目录 `tables/<项目 id>/`，拆成 4 个 json            |
| `server/tables/routes.ts`                                  | `/api/tables/:id`（列表）、`/probe`、`/file`、`/search`、`/schema`                            |
| `web/src/lib/tables-api.ts`、`web/src/lib/demo-tables.ts`  | 页面调接口；在线演示的内存实现                                                                |
| `web/src/lib/tables-nav.ts`                                | 侧栏「表格」入口打开哪个项目（上次看的 / 第一个设了表格目录的）                               |
| `web/src/pages/TablesPage.tsx`                             | 表格页：左边文件树 + 名字 / 内容搜索，右边文件页签 + 工作表 + 表头栏 + 表格                   |
| `web/src/components/tables/`                               | `TableTree`、`TableHits`、`TableTabs`、`TableView`                                            |
| `web/src/components/projects/ProjectTablesSection.tsx`     | 项目设置的「表格」页；目录列表是 `projects/DirList.tsx`（设置 → 组件里有样例）                |
| `server/tables/xlsx-write.ts`、`zip.ts`、`write.ts`        | 保存：xlsx 原地改单元格（其余 zip 条目逐字节照抄）、CSV 保持格式、备份、锁 / 改动 / P4 检查   |
| `shared/table-edit.ts`、`components/tables/table-edits.ts` | 改动的表示（行操作 + 格子）、撤销重做、剪贴板；页面和服务端共用同一份 applyRowOps / setCells  |
| `shared/table-struct.ts`                                   | 结构化：每列是什么（类型、枚举、引用、范围、repeated）、下拉选项、按结构检查、整本检查        |
| `server/tables/check.ts`                                   | 全项目检查（`/check`），引用的表从磁盘读                                                      |
| `shared/tables-assist.ts`、`server/tables/sample.ts`       | AI 分析表格风格：样本（`/sample`）、提示词、结果校验、按勾选并进结构文件                      |
| `shared/sheet-diff.ts`                                     | 格子级差异（版本差异、跨项目对比共用）、只看变化的折叠、跨项目「拷到另一边」                  |
| `server/tables/history.ts`                                 | 版本记录（`/history`：git log / p4 filelog / svn log）、取某一版（`/at`：show / print / cat） |
| `server/tables/compare.ts`                                 | 跨项目对比（`/compare?other=`）：按相对路径配对，比解析出来的格子                             |
| `shared/table-agent.ts`、`server/app-actions/tables.ts`    | 给 Agent 的动作 `table.list / query / edit / check`（经 app_actions / app_do）                |

## 表格目录

- 设置里一个目录一行（`DirList`，「添加表格目录」弹出本机目录选择器），多层子目录都会找。选到项目目录里的文件夹写成相对路径，项目目录外的（比如策划单独的表格仓库）写绝对路径。
- 文件路径：项目目录里的是相对项目目录的路径；项目目录外的是正斜杠的绝对路径。`safeRel` 只放行相对路径（不带 `..`）和落在某个「项目目录外的表格目录」里的绝对路径；磁盘路径一律用 `tableFull`（`path.resolve`），不要再 `path.join(dir, f.path)`。
- 项目目录外的表格：版本命令在文件所在目录跑（`vcsPath`）；跨项目对比按「目录名/目录里的路径」配对（`pairKey`），两边真实路径在 `TablePair.left / right`；备份路径去掉盘符冒号。
- 设置页改目录时 `POST /probe` 按还没保存的配置（含没保存的项目目录）找一遍，每行下面显示实际找的完整路径和找到几个表格，路径填错一眼能看出来。

## 表格页的显示

- 文件树（`TableTree`）：文件夹默认折叠，只画展开了的；只有一个顶层目录时它默认展开，打开的文件所在的目录自动展开；顶层开头一串单个子目录并成一个节点。一个项目最多列 20000 个文件。
- 表格（`SheetTable`，`fill` + `widthKey`）：数据画不满时接着画空行空列；列名右边线拖动改列宽（记在 localStorage `sheet-colw:<项目>:<文件#工作表>`，双击恢复）；数据区隔行底色 `--c-grid-stripe`；表头每种行一个颜色。
- 版本差异、跨项目对比：差异在后台线程算（`web/src/lib/sheet-diff-async.ts` + `sheet-diff.worker.ts`，小表直接算），`SheetDiffView` 自己带滚动区、只画看得见的行、固定列宽。

## 表头从哪来

`schemaHeader`：单文件覆盖（`files.json` 的「路径#工作表」）> 例外规则（`style.exceptions` 按通配）> 项目风格 > 自动识别（`shared/sheet-header.ts`）。
项目风格是**几套表头**（`style.headers` 数组，各表表头行数不一样时设多套）：每张表用 `pickHeader` 按内容打分（`headerFit`：每行认出的角色和设定的一样加分、像数据扣分）挑最合的一套，一样合取前面的；只有一套时不看内容直接用。
旧版只有单套 `style.header`，读的时候当第一套（`styleHeaders`）；保存时 `header` 仍写第一套，旧版本面板也认得。
表格页里「调整表头」写的是单文件覆盖（项目有多套时弹层里能一键套用其中一套）；文件弹窗（不在表格页）仍记在浏览器 localStorage。

结构文件在页面里只留一份（`web/src/lib/table-schema.ts`）：项目设置的「表头」「通用枚举」「校验」「AI 分析」和表格页共用，谁保存都先重读最新的再改（`saveTableSchema`），其它地方跟着更新；设置表单用 `useSchemaDraft`，没改过的跟着新内容走，改了一半的留着。
AI 分析的结果（`TablesDraft`）也是几套表头，外加数组标记、表头行能填什么；不认识的角色改成「其它」并把原词留作行名，不整份作废。还没应用的结果存在浏览器 localStorage，刷新后还能接着应用。

## 结构化（枚举、引用、检查）

- 列是什么由 `columnInfos` 算：类型行的字（`uint32`、枚举类型名……）+ 修饰行（`repeated`）+ 结构文件 `columns.json` 里按「路径#*#字段名」记的覆盖（枚举、引用、最小 / 最大、也允许的值）。
- 枚举值 = 结构文件里手写 / 页面新增的 + 枚举表里按名字列取的（`source`，多个枚举放一张表时按 `match` 筛）；页面「新增枚举值」只写结构文件。
- 检查（`checkSheet`）：类型、枚举（名字和值都算）、引用（被引用的表读到了才查）、范围、主键重复；空格子不查。表格页标红和左栏「检查」、服务端 `/check` 都用它。
- 列结构面板列出这一列在表头里的每一行（`ColInfo.head`）；结构文件 `columns` 里的 `type` 覆盖类型行（表头写错、没写时用），表格不改。
- 通用枚举：结构文件 `enums.json` 就是整个项目共用的枚举库，项目设置 → 表格「通用枚举」和表格页「枚举」管的是同一份。
- 项目级表头：项目设置 → 表格「表头」写 `style.header`（`HeaderRuleEditor`，表格页「调整表头」也用它）；单张表的覆盖在表格页改。
- AI 分析：页面先取 `/sample`——**只是挑出来的几张表的清单**（按目录轮着挑，最多 8 张），放进 `subject.sample` 交给配置助手（`kind: 'tables'`）；CLI 再用面板动作 `table.sample`（`/sample?path=`：一张表的表头 + 前 3 行数据 + 这张表里类型名出现过的值，最多 6000 字）一张一张看。提示词只放清单，不会超过任务提示词 20000 字的上限；多轮对话太长时只留最近的。在项目里开分析对话（记成 `run`，右侧不出项目设置面板）；结果暂存在页面模块里，回到项目设置 → 表格逐项勾选后 `applyTablesDraft` 写进结构文件。

## 校验规则

- 列结构里的规则（`TableColumn`）：`pattern` 正则（整格匹配，数组列逐项，`patternRe` 缓存编好的正则，写错的不查）、`required` 必填、`requiredWhen` 条件必填（同一行另一列是某些值时必填）。必填类是行内检查，和格子检查一起按行缓存。
- 组合唯一：`style.uniques`（通配 + 至少两个字段名，项目设置 → 表格「校验」），`checkSheet` 的 `uniques` 参数由 `uniquesFor(schema, file)` 给；重复记在这组第一列上。
- 保存前检查：`style.saveCheck`（warn 默认 / block / off），保存确认里列出改到的行里不合规的格子，block 时保存按钮不可点。
- 检查结果导出：左栏「检查」的「导出」重新查一遍（`/check?all=1`，每张表列全部），存成带 BOM 的 CSV。
- 枚举值改名：枚举对话框保存时 `findEnumRenames`（同一位置名字变了、旧名字不在新列表里）找出改名，问要不要替换所有表里的旧值；`POST /enum-rename` 先预览每个文件几格，确认后逐个文件走 `saveTable`（只改格子、备份、P4 先签出），失败的列出原因。

## 版本差异、跨项目对比

- `diffSheet`：列按字段名对齐（没字段名按位置）；行有唯一主键（`style.key`）时按主键对齐，否则按整行内容做 LCS（太大时退成贪心），同一段里删了又加的配成「改」。表头行另外比（`headerChanged`）。
- 版本差异「本地改动」= 基准版（git `HEAD` / p4 `#have` / svn `BASE`）↔ 页面上现在的内容（含没保存的），改过的行能还原成旧值（一次普通编辑）；点一个提交 = 它的上一版 ↔ 它。那一版里还没有这个文件时当空表。
- 切换到某一版（`server/tables/checkout.ts`，`POST /checkout`）：`rawAt` 取那一版的原始字节（git show / p4 print / svn cat），整个替换本地文件。不动版本控制状态（不 checkout、不 p4 sync），切完就是一处本地改动；替换前和保存一样查只读、Excel / WPS 占用、备份、P4 只读先 `p4 edit`。页面上没保存的改动作废。
- 任意两版对比：版本弹窗里「和哪一版比」可以选最近一次提交、上一版或列表里任意一版。
- 一格的历史（`shared/table-blame.ts` + `server/tables/cell-history.ts`，`GET /cell-history`）：服务端沿版本记录取每一版（并发 3），按主键（没设用第一列有字段名的）找同一行、按字段名找同一列，值和更早一版不同的提交列出来。不把几十版整表传给页面。
- 提交（`server/tables/vcs-ops.ts`，`POST /vcs-submit`）：只提交这一个文件。git `commit -- <文件>`（只到本地仓库，不推送，暂存区别的文件不动）；p4 没打开的先 `reconcile -e -a` 再 `submit -d`；svn 新文件先 `add` 再 `commit`。有冲突、没改动、项目只读都拒绝。
- 冲突三方合并（`shared/table-merge.ts`，`POST /merge-start`、`/vcs-resolve`）：base / theirs 从 git 暂存区 `:1` `:3`、p4 `fstat -Or` 的 resolveBase/From、svn `info --xml` 的 prev-base-file / cur-base-file 取；ours 是工作区文件——CSV 冲突时 git/svn 往里写了冲突标记，先备份再换成干净的 ours（git `:2`、svn `.mine`），页面重新载入。合并在页面上算：按主键对齐行、按字段名对齐列，一边改的自动合、两边改成不同才让用户挑；结果作为一次改动（`replaceIn`，行操作 + 格子）放进表格，用户看过走正常保存，再「标记已解决」（git add / p4 resolve -ay / svn resolve --accept working）。不直接写盘，保存那条路的读回校验照样生效。对方新加的工作表合不了，只提示。
- 跨项目对比：差异方向是 右(旧) → 左(新)。拷行只往右拷：`copyRows` 生成右边文件的行操作 + 格子，先按**右边项目**的结构 `checkTouched`，有问题列出来让用户决定，再走右边项目的原地保存。

- 跨项目批量同步（`server/tables/sync.ts` + `shared/table-sync.ts`，`POST /sync`）：对比窗口「批量同步…」勾文件，整文件（字节原样拷，右边没有就新建，走 `replace.ts` 和切换版本同一套：占用检查、P4 edit、备份、临时文件改名）或只同步一列（右边结构的主键对行，只改已有行，走 `saveTable`）。先 `apply:false` 预览每个文件（差几格 / 改几格 / 右边少几行），再写；每个文件单独成败、原因列出来。右边项目只读拒绝。
- 对比报告：对比窗口「导出清单」（文件和状态）、一对文件的「导出差异」（工作表、变化、主键、字段、右边旧值、左边新值），都是带 BOM 的 CSV（`compare-report.ts`）。

## 左栏

- 收藏、最近打开（`use-table-marks.ts`）：按项目记在本机存储（个人习惯，不进项目），文件没了就不列。文件树右键「收藏 / 取消收藏」「复制路径」「在文件管理器中显示」（`POST /reveal` → `server/open.ts` 的 `revealItem`）。
- 名字搜索认拼音首字母（`shared/pinyin.ts`）：不带字库，用 `Intl.Collator('zh-Hans-CN-u-co-pinyin')` 按声母分界字定字母；环境没有中文排序数据时自动退回只按原文匹配。每个路径的首字母算一次缓存。
- 左栏宽度（`ListPane` 的 `resizeKey`）、底部检查结果高度（`ResizeHandle side="top"`）可拖，记在本机，双击恢复默认。

## 导入导出

- 「导表」菜单下面：这张工作表存成 CSV（含表头原样）、数据行存成 JSON（键是字段名，数字 / 布尔按列类型转，数组列拆成数组，备注列不要）。纯前端，`shared/table-io.ts`。
- 从 CSV 粘贴导入：第一行一半以上是字段名就按名字对列，否则按位置；有主键时可选「主键已有的更新」，新主键追加到末尾。结果是一次改动（插行 + 格子，一次撤销），看过再保存。

## 编辑效率

- 新增行（行号右键插入、工具栏 +）主键列自动填「最大的整数 + 1」（`nextKey`，`shared/table-tools.ts`）；「复制这一行插到下方」同样重新编号。插行和填格子是一次撤销（`rowOpWithCells`）。
- Ctrl+D 向下填充（复制选中区第一行），Ctrl+Shift+D 按序列（前两行的差，只有一行数字时 +1）；改格子时 Ctrl+Enter 把值填进选中的每一格。
- 查找替换（Ctrl+H、工具栏「替换」）：范围是选中区域 / 当前列 / 整张表，只算筛选后看得见的数据行，跳过表头和隐藏的列；实时预览，「全部替换」一次撤销。
- 列名右键冻结到某列、隐藏列（`use-col-layout.ts`，按「项目:文件#工作表」记在 localStorage，表格文件不动）。冻结列在列虚拟化之外一直画，`sticky` 钉在行号列右边，底色换成不透明色（`sheet-frozen`）。
- 格子右键（整个表格只挂一个菜单，`CellMenu`）：引用列跳到被引用表的那一行（`findRefTarget`），被引用的表可以查「谁引用了这一行」（`findBackRefs`：结构文件里 ref 指向这张表的列，数组列按分隔符拆开整项比）。
- 快捷键（`use-grid-edit.tsx`）：Ctrl+方向键跳到这一段数据的边缘、Ctrl+Home / End、Shift+空格 / Ctrl+空格选整行整列、Ctrl+Shift+= 在上方插行、Ctrl+- 删选中的行（`rowOpsIn` 一次撤销）。F1 / Ctrl+/ 打开共用的快捷键一览（`ShortcutsHelp` 的「表格」组；全局的 `?` 在格子里是打字，`useShortcuts` 跳过已经 `preventDefault` 的键）。
- 查找条（Ctrl+F，`TableFindBar`）：只查筛选后显示的行和没隐藏的列，打字防抖 120ms，最多 5000 处；可以只查当前列。Ctrl+G 跳转：先按主键找，找不到再当行号。
- 编辑栏（工具栏「查看」里开关，`TableEditBar`，localStorage `table-edit-bar`）：看全、修改长文本，右边是这一列的规则（`ruleText`）。
- 快速筛选（`TableQuickFilter`）：只看不合规 / 改过的 / 引用缺失 / 空着的必填，几个一起是「或」，只过滤行号数组；当前的筛选、排序、快速筛选能存成视图（localStorage `table-views:<项目>:<文件#工作表>`）。
- 引用列「ID · 名称」（localStorage `table-ref-names`）：只改显示（`SheetEditing.display`），名称取被引用表同一行里像名字的列（`refOptions` 的 desc）。
- 检查结果（`ProblemsBar`）按「列 + 种类」分组（`shared/table-problems.ts`；种类是 `Problem.rule`，同一列「引用的表里没有 X / Y」算一组）。每组批量修：超出范围改成边界值、改成「也允许」的值、清空（必填 / 主键不给），先预览再一次放进表格；或让 AI 修这一组。滚动条右边一条 canvas 标出不合规、改过、查找命中的位置（`ScrollMarks`，按像素合并，点一下跳到最近的一处）。
- 内容搜索结果（`TableHits`）每条带字段名（服务端 `searchTables` 按结构文件的表头算，`sheetFieldNames`，只在这张表有命中时算一次），按文件分组、组头吸顶能折叠，上下键在结果里走、表格跟着跳。
- 行高三档（工具栏「查看」→ 行高，localStorage `table-density`）：紧凑 22、标准跟着设置、宽松 32，通过 `SheetTable` 的 `rowHeight` 传。双击列边线按看得见的 200 行 + 表头量宽（`fitWidth`），不扫整列。
- 导表输出在表格页底部的「输出」面板（`TableOutput.tsx`），不再是弹窗：每次执行一个 `ExportRun` 一直挂着（切去看别的一次只是藏起来，不会停），留最近 20 次；关面板才停掉在跑的。
- 版本差异、跨项目对比：改过的格子只显示新值，悬停看旧 / 新；摘要里「改 / 加 / 删」能点，只看那一种行（`DiffOnly`）。
- 打开表格还在读时画骨架（`TableSkeleton`）；没有项目设表格目录时是引导卡（`TablesSetupCard`），一键打开项目设置 → 表格。
- 项目设置 →「表格」分子页：目录 · 表头 · 枚举 · 校验 · 导表 · AI 分析；底下写这一页跟着「确认」还是单独存。有没处理的 AI 分析结果时「AI 分析」上有红点（`useTablesAnalysisPending`）。
- 外部改动：当前打开的文件每 4 秒（页面在前台时）看一次修改时间（`/stat`），变了且没有没保存的改动就直接重新载入；有改动时表格上方提示，可以载入新内容并把改过的格子按位置写回（只改格子、没插删行时）、丢掉改动、或先不管（保存时仍有修改时间检查）。

## 导表脚本

项目设置 → 表格「导表脚本」写进 `TablesConfig.exports`（`shared/table-export.ts`）：名字、命令、执行目录、最长分钟数。命令里的占位 `{file}` `{files}` `{rel}` `{name}` `{folder}` `{project}` 执行时才换成真实路径（`fillCommand`）：按设置里选的命令行环境加引号（sh / cmd / PowerShell），已经写在引号里的只转义会打断引号的字符；WSL 下盘符路径换成 `/mnt/<盘>/`。有 `{files}` 时所有表一次传进去，没有时每张表执行一次，一条失败后面的不跑。
入口：表格页工具栏「导表」（当前这张表）和文件树右键（文件或整个文件夹）。`POST /export` 用 NDJSON 一行一个 `ExportEvent` 边跑边推（`Cache-Control: no-transform` 避开压缩攒包），页面断开就停掉命令；窗口里按帧批量刷新，每条命令只留最后 3000 行。导表读磁盘上的文件，有没保存的改动时窗口顶上提醒。

## Agent 改表格

动作在 `server/app-actions/tables.ts`（ADR 0011：能力只加进动作表，不加新的 MCP 工具）。`table.edit` 按主键或 Excel 行号改格子、末尾加行、删行，换成和表格页一样的「行操作 + 格子」走 `/save`；写之前 `checkTouched`，不合规就不写并把原因交给模型（`force: true` 只在用户明确要求时用）。

## AI（表格页工具栏「AI」）

- 照着描述加几行、让 AI 修这张表的不合规：在项目里开一个分析对话（`createAnalysisTask` + AI 窗口），提示词在 `shared/table-ai.ts`，要求 Agent 用 `table.propose`。
- `table.propose`（`server/app-actions/tables.ts`）：参数同 `table.edit`，同样 `planEdit` + `checkTouched`，不合规拦下交给模型；通过后不写文件，`POST /proposal` 存进内存（`server/tables/proposals.ts`，每个文件只留最新一份，重启就没）。
- 表格页打开文件、AI 对话结束时取 `GET /proposal`：上方提示条「看差异」按表头和主键出差异，「放进表格」用 `replaceIn` 成为一次改动（还要用户保存），然后 `DELETE /proposal`。提出之后文件 mtime 变了或页面上有没保存的改动时不让放（行号对不上）。状态只看工具调用存下的提议，不读模型回复的文字。
- 解释一列 / 这张表：只读提示词，结果就在 AI 窗口的对话里。

## 不支持的

- 老的 `.xls` / `.et`：只列出、标「只读」，不解析（npm 上的 SheetJS 0.18.5 有已知漏洞，不引入）。
