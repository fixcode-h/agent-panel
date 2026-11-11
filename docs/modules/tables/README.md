# tables：表格页（游戏配置表管理）

- 状态：documented
- 职责：按项目设置的表格目录浏览、搜索、查看、在线修改 xlsx / CSV 表格；表头、枚举等结构信息存在表格之外
- 源码：`server/tables/`、`shared/tables.ts`、`shared/csv.ts`、`web/src/pages/TablesPage.tsx`、`web/src/components/tables/`
- 入口：`server/tables/routes.ts`、`web/src/pages/TablesPage.tsx`
- 关键词：表格、配置表、xlsx、CSV、表头、枚举、结构文件、内容搜索
- 更新：2026-11-11

设计稿在项目共享目录 `designs/表格管理与在线编辑-设计稿.md`。硬约束：**表格文件只在用户保存改动时原地改单元格，结构信息一律不写进表格**。

## 入口

| 文件                                                      | 做什么                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `shared/tables.ts`                                        | 项目设置里的 `TablesConfig`、表格页的数据结构、结构文件 `TableSchema`、通配和表头优先级 |
| `shared/csv.ts`                                           | CSV 的读、写回（保持分隔符 / 换行 / BOM / 结尾换行）                                    |
| `server/tables/files.ts`                                  | 列表格文件、解析（按 mtime + 大小缓存）、锁文件检查、跨文件内容搜索、路径越界检查       |
| `server/tables/schema-store.ts`                           | 结构文件读写：`.agentpanel/tables/` 或数据目录 `tables/<项目 id>/`，拆成 4 个 json      |
| `server/tables/routes.ts`                                 | `/api/tables/:id`（列表）、`/file`、`/search`、`/schema`                                |
| `web/src/lib/tables-api.ts`、`web/src/lib/demo-tables.ts` | 页面调接口；在线演示的内存实现                                                          |
| `web/src/lib/tables-nav.ts`                               | 侧栏「表格」入口打开哪个项目（上次看的 / 第一个设了表格目录的）                         |
| `web/src/pages/TablesPage.tsx`                            | 表格页：左边文件树 + 名字 / 内容搜索，右边文件页签 + 工作表 + 表头栏 + 表格             |
| `web/src/components/tables/`                              | `TableTree`、`TableHits`、`TableTabs`、`TableView`                                      |
| `web/src/components/projects/ProjectTablesSection.tsx`    | 项目设置的「表格」页                                                                    |

## 表头从哪来

`schemaHeader`：单文件覆盖（`files.json` 的「路径#工作表」）> 例外规则（`style.exceptions` 按通配）> 项目风格（`style.header`）> 自动识别（`shared/sheet-header.ts`）。
表格页里「调整表头」写的是单文件覆盖；文件弹窗（不在表格页）仍记在浏览器 localStorage。

## 不支持的

- 老的 `.xls` / `.et`：只列出、标「只读」，不解析（npm 上的 SheetJS 0.18.5 有已知漏洞，不引入）。
