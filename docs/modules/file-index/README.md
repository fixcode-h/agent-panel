# file-index：项目文件索引

- 状态：documented
- 职责：按项目维护只记文件名的索引：按名字找、按文件夹取、跟上改动；文件面板、Agent 的 file_index、插件共用
- 源码：`server/file-index/`、`shared/file-index/`、`shared/api-contract/file-index.ts`
- 入口：`server/file-index/registry.ts`
- 关键词：文件索引、file_index、按名字找文件、NameTable、fileIndexRoots、ctx.files
- 更新：2026-11-23

为什么这么定见 [ADR 0072](../../adr/0072-project-file-index.md)。这里只写现在怎么工作、怎么接。

## 入口

| 文件                                | 做什么                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `shared/file-index/table.ts`        | `NameTable`：目录表 + 文件名，`find` / `list` / `glob` / 落盘行；演示后端也用它                                                |
| `shared/file-index/rules.ts`        | 排除规则：目录名任意层、带斜杠的按路径通配，Windows 不分大小写                                                                 |
| `shared/file-index/types.ts`        | 项目设置 `FileIndexSettings`（默认值）、状态、查询结果                                                                         |
| `server/file-index/registry.ts`     | 按项目算根清单（项目、文档根、额外目录、插件报的），同根共用 `IndexUnit`，空闲卸下，推状态                                     |
| `server/file-index/unit.ts`         | 一个根：读回落盘或全量建、目录核对、系统通知、touch、写盘                                                                      |
| `server/file-index/api.ts`          | `/api/file-index`（数据页）和 `/api/projects/:id/file-index…`（状态卡、查、核对、重建）                                        |
| `server/file-index/agent-tool.ts`   | `file_index` 工具的服务端：等索引、分页、4000 字上限、独立分支现场核对                                                         |
| `server/file-index/plugin-files.ts` | 插件接口 16 的 `ctx.files`                                                                                                     |
| `server/file-index/indexed.ts`      | 开放给插件的帮助函数：`readyIndex`（等就绪最多 3 秒）、`indexedTree`（带 ext 取整棵、换相对路径）、`indexedDirs`、`extsOfGlob` |
| `server/plugins/file-roots.ts`      | 问打开了的插件要 `fileIndexRoots`                                                                                              |

## 怎么用

- 服务端代码：`projectIndex(projectId)` 拿到 `ProjectIndex`（关着返回 undefined，调用方走老路）；先 `ready(ms)` 再 `find` / `list`。项目里的路径是相对项目根的写法，其他根是绝对路径。
- 自己写了文件：`touchFiles([绝对路径], 'panel')`，返回时已经进索引。
- 插件：用开放模块 `server/file-index/indexed` 的 `indexedTree(ctx.files, root, { ext })` / `indexedDirs`，取不到（旧面板、关了索引、没建好）返回 undefined 时退回自己走目录；写了文件 `touchIndexed(ctx.files, [...])`。不要自己再写一份等就绪、换相对路径的适配（UE、表格以前各有一份）。
- 取整棵子树一定带 `ext` 或 `dirsOnly`：大项目整棵几十万个路径，几个请求一起就是几个 GB（2026-11-23 面板内存耗尽）。表格的列表另有 `list-index.ts` 记修改时间和大小（索引只记名字），不是重复。

## 注意

- 索引不收排除目录：要找那里的文件直接读目录，不要因此去掉排除。
- 按文件夹取会现场核对那一层；按名字找用的是上次核对的结果，太久没核对会在后台补核对。
