# tables：表格页（游戏配置表管理）

- 状态：documented
- 职责：按项目设置的表格目录浏览、搜索、查看、在线修改 xlsx / CSV 表格；表头、枚举等结构信息存在表格之外
- 源码：`server/tables/`、`shared/tables.ts`、`shared/csv.ts`、`web/src/pages/TablesPage.tsx`、`web/src/components/tables/`
- 入口：`server/tables/routes.ts`、`web/src/pages/TablesPage.tsx`
- 关键词：表格、配置表、表格目录、绝对路径、目录选择器、xlsx、CSV、表头、枚举、引用、结构文件、内容搜索、原地保存、检查、AI 分析表格风格、版本差异、跨项目对比、table.edit
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

`schemaHeader`：单文件覆盖（`files.json` 的「路径#工作表」）> 例外规则（`style.exceptions` 按通配）> 项目风格（`style.header`）> 自动识别（`shared/sheet-header.ts`）。
表格页里「调整表头」写的是单文件覆盖；文件弹窗（不在表格页）仍记在浏览器 localStorage。

## 结构化（枚举、引用、检查）

- 列是什么由 `columnInfos` 算：类型行的字（`uint32`、枚举类型名……）+ 修饰行（`repeated`）+ 结构文件 `columns.json` 里按「路径#*#字段名」记的覆盖（枚举、引用、最小 / 最大、也允许的值）。
- 枚举值 = 结构文件里手写 / 页面新增的 + 枚举表里按名字列取的（`source`，多个枚举放一张表时按 `match` 筛）；页面「新增枚举值」只写结构文件。
- 检查（`checkSheet`）：类型、枚举（名字和值都算）、引用（被引用的表读到了才查）、范围、主键重复；空格子不查。表格页标红和左栏「检查」、服务端 `/check` 都用它。
- 列结构面板列出这一列在表头里的每一行（`ColInfo.head`）；结构文件 `columns` 里的 `type` 覆盖类型行（表头写错、没写时用），表格不改。
- 通用枚举：结构文件 `enums.json` 就是整个项目共用的枚举库，项目设置 → 表格「通用枚举」和表格页「枚举」管的是同一份。
- 项目级表头：项目设置 → 表格「表头」写 `style.header`（`HeaderRuleEditor`，表格页「调整表头」也用它）；单张表的覆盖在表格页改。
- AI 分析：页面先取 `/sample`——**只是挑出来的几张表的清单**（按目录轮着挑，最多 8 张），放进 `subject.sample` 交给配置助手（`kind: 'tables'`）；CLI 再用面板动作 `table.sample`（`/sample?path=`：一张表的表头 + 前 3 行数据 + 这张表里类型名出现过的值，最多 6000 字）一张一张看。提示词只放清单，不会超过任务提示词 20000 字的上限；多轮对话太长时只留最近的。在项目里开分析对话（记成 `run`，右侧不出项目设置面板）；结果暂存在页面模块里，回到项目设置 → 表格逐项勾选后 `applyTablesDraft` 写进结构文件。

## 版本差异、跨项目对比

- `diffSheet`：列按字段名对齐（没字段名按位置）；行有唯一主键（`style.key`）时按主键对齐，否则按整行内容做 LCS（太大时退成贪心），同一段里删了又加的配成「改」。表头行另外比（`headerChanged`）。
- 版本差异「本地改动」= 基准版（git `HEAD` / p4 `#have` / svn `BASE`）↔ 页面上现在的内容（含没保存的），改过的行能还原成旧值（一次普通编辑）；点一个提交 = 它的上一版 ↔ 它。那一版里还没有这个文件时当空表。
- 跨项目对比：差异方向是 右(旧) → 左(新)。拷行只往右拷：`copyRows` 生成右边文件的行操作 + 格子，先按**右边项目**的结构 `checkTouched`，有问题列出来让用户决定，再走右边项目的原地保存。

## Agent 改表格

动作在 `server/app-actions/tables.ts`（ADR 0011：能力只加进动作表，不加新的 MCP 工具）。`table.edit` 按主键或 Excel 行号改格子、末尾加行、删行，换成和表格页一样的「行操作 + 格子」走 `/save`；写之前 `checkTouched`，不合规就不写并把原因交给模型（`force: true` 只在用户明确要求时用）。

## 不支持的

- 老的 `.xls` / `.et`：只列出、标「只读」，不解析（npm 上的 SheetJS 0.18.5 有已知漏洞，不引入）。
