# tables：表格页（游戏配置表管理）

- 状态：documented
- 职责：按项目设置的表格目录浏览、搜索、查看、在线修改 xlsx / CSV 表格；表头、枚举等结构信息存在表格之外
- 源码：`server/tables/`、`shared/tables.ts`、`shared/csv.ts`、`web/src/pages/TablesPage.tsx`、`web/src/components/tables/`
- 入口：`server/tables/routes.ts`、`web/src/pages/TablesPage.tsx`
- 关键词：表格、配置表、xlsx、CSV、表头、枚举、引用、结构文件、内容搜索、原地保存、检查、AI 分析表格风格
- 更新：2026-11-11

设计稿在项目共享目录 `designs/表格管理与在线编辑-设计稿.md`。硬约束：**表格文件只在用户保存改动时原地改单元格，结构信息一律不写进表格**。

## 入口

| 文件                                                       | 做什么                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `shared/tables.ts`                                         | 项目设置里的 `TablesConfig`、表格页的数据结构、结构文件 `TableSchema`、通配和表头优先级      |
| `shared/csv.ts`                                            | CSV 的读、写回（保持分隔符 / 换行 / BOM / 结尾换行）                                         |
| `server/tables/files.ts`                                   | 列表格文件、解析（按 mtime + 大小缓存）、锁文件检查、跨文件内容搜索、路径越界检查            |
| `server/tables/schema-store.ts`                            | 结构文件读写：`.agentpanel/tables/` 或数据目录 `tables/<项目 id>/`，拆成 4 个 json           |
| `server/tables/routes.ts`                                  | `/api/tables/:id`（列表）、`/file`、`/search`、`/schema`                                     |
| `web/src/lib/tables-api.ts`、`web/src/lib/demo-tables.ts`  | 页面调接口；在线演示的内存实现                                                               |
| `web/src/lib/tables-nav.ts`                                | 侧栏「表格」入口打开哪个项目（上次看的 / 第一个设了表格目录的）                              |
| `web/src/pages/TablesPage.tsx`                             | 表格页：左边文件树 + 名字 / 内容搜索，右边文件页签 + 工作表 + 表头栏 + 表格                  |
| `web/src/components/tables/`                               | `TableTree`、`TableHits`、`TableTabs`、`TableView`                                           |
| `web/src/components/projects/ProjectTablesSection.tsx`     | 项目设置的「表格」页                                                                         |
| `server/tables/xlsx-write.ts`、`zip.ts`、`write.ts`        | 保存：xlsx 原地改单元格（其余 zip 条目逐字节照抄）、CSV 保持格式、备份、锁 / 改动 / P4 检查  |
| `shared/table-edit.ts`、`components/tables/table-edits.ts` | 改动的表示（行操作 + 格子）、撤销重做、剪贴板；页面和服务端共用同一份 applyRowOps / setCells |
| `shared/table-struct.ts`                                   | 结构化：每列是什么（类型、枚举、引用、范围、repeated）、下拉选项、按结构检查、整本检查       |
| `server/tables/check.ts`                                   | 全项目检查（`/check`），引用的表从磁盘读                                                     |
| `shared/tables-assist.ts`、`server/tables/sample.ts`       | AI 分析表格风格：样本（`/sample`）、提示词、结果校验、按勾选并进结构文件                     |

## 表头从哪来

`schemaHeader`：单文件覆盖（`files.json` 的「路径#工作表」）> 例外规则（`style.exceptions` 按通配）> 项目风格（`style.header`）> 自动识别（`shared/sheet-header.ts`）。
表格页里「调整表头」写的是单文件覆盖；文件弹窗（不在表格页）仍记在浏览器 localStorage。

## 结构化（枚举、引用、检查）

- 列是什么由 `columnInfos` 算：类型行的字（`uint32`、枚举类型名……）+ 修饰行（`repeated`）+ 结构文件 `columns.json` 里按「路径#*#字段名」记的覆盖（枚举、引用、最小 / 最大、也允许的值）。
- 枚举值 = 结构文件里手写 / 页面新增的 + 枚举表里按名字列取的（`source`，多个枚举放一张表时按 `match` 筛）；页面「新增枚举值」只写结构文件。
- 检查（`checkSheet`）：类型、枚举（名字和值都算）、引用（被引用的表读到了才查）、范围、主键重复；空格子不查。表格页标红和左栏「检查」、服务端 `/check` 都用它。
- AI 分析：页面先取 `/sample`（几张表开头几行 + 各类型名出现过的值），放进 `subject.sample` 交给配置助手（`kind: 'tables'`），在项目里开分析对话（记成 `run`，右侧不出项目设置面板）；结果暂存在页面模块里，回到项目设置 → 表格逐项勾选后 `applyTablesDraft` 写进结构文件。

## 不支持的

- 老的 `.xls` / `.et`：只列出、标「只读」，不解析（npm 上的 SheetJS 0.18.5 有已知漏洞，不引入）。
