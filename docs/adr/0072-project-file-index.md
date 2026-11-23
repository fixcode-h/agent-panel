# ADR 0072：统一的项目文件索引

状态：已接受 · 2026-11-23

## 背景

按名字找文件散在很多地方，各自走目录：文件面板按名字搜（Git 项目每次 `ls-files`，别的项目走到 2 万个文件就截断）、模块地图的小项目判断、找回粘贴的大文件、UE 插件的跳转索引 / 资源文件夹 / Lua 文件清单 / GameTest 和 GM 离线取值用的头文件、表格插件的表格列表和枚举扫描。Agent 找文件靠 `find -maxdepth 4` 加一长串剪枝，大项目上又慢又容易超时。用户 2026-11-23 要求建一个统一的、只记文件名的索引，各处共用。设计稿 `designs/项目文件索引-设计稿.md`，效果图 `designs/项目文件索引-效果图/`。

## 决策

1. **只记目录和文件名**，不读内容、不记大小和时间（要的地方对查出来的那几个自己 stat）。内存里一个根目录一张 `NameTable`（`shared/file-index/table.ts`，服务端和演示共用）；落盘是数据目录 `file-index/<键>.idx.gz`，键是根目录 + 规则的哈希，同一个根同一套规则的几个项目共用一份。
2. **收哪些**：默认按磁盘收，跳过项目的「不收录、也不搜索的目录」（就是 `searchExclude`，AI 初始化分析项目时填的）加内置默认清单，Git 项目再跳过 `.gitignore` 忽略的。「只收版本管理里的」是选项，默认关（用户定：刚建还没 add 的也要找得到）。项目外的文档根自动收，插件可以经 `fileIndexRoots` 报外部目录（UE 插件报引擎的 Engine 目录），默认收。
3. **怎么跟上改动**，四层：面板 / Agent / 插件自己写文件时同步 `touch` 所在目录；Windows、macOS 用递归的系统文件通知（Linux 默认不盯，逐目录 inotify 会碰上限还丢事件）；P4 每 5 分钟看一次 `#have` 的变更号，sync 过就整体核对；查询时按目录修改时间核对（有系统通知 10 分钟一次，没有时超过 1 分钟就先核对），按文件夹取时现场核对那一层。
4. **默认开**，30 分钟没人用的项目停监听、丢内存，只留落盘；下次用时读回再核对。
5. **不拦截 `rg --files`、`find`、Glob 这些命令**（用户 2026-11-23 改主意：拦截太绝对，排除目录里的东西不在索引里）。只在提示词「搜索（这个项目）」一节和 `file_index` 工具说明里写明：按名字找文件先用 `file_index`，C++ 先用 VS 的、Lua 先用 IDEA 的工具；索引不收排除目录，要找那里直接用原命令。提示词里不再教 `rg -g '!目录'`，排除目录照旧经 rg 的配置文件交给 rg。
6. **Agent 工具 `file_index`**：`find` / `list` / `refresh` / `rebuild` / `status`，索引没建好时在工具里等（最多一分钟），返回不超过 4000 字、分页给 `nextOffset`。独立分支不另建索引：查项目目录那份，在对话目录里现场核对在不在，没找到时提示直接用 find。
7. **插件接口 16**：`PluginServerContext.files`（`index(项目 id 或目录)` 拿到 `find` / `list` / `glob` / `has` / `onChange` / `refresh`，`touch(路径)`），`ServerPlugin.fileIndexRoots`。旧面板没有时插件退回自己原来的走法。
8. **设置和数据**：项目设置 →「常规 · 搜索」的「文件索引」（开关、状态卡、增量更新 / 全量重建、收录哪些、盯着改动、额外目录、收不收插件目录）；设置 →「数据」多一类「文件索引」可清理，下面逐份列出、能重建和删除，项目删了留下的标「无主」。

候选方案：

- **拦截按名字找的命令、拿索引结果代答**：做过一半，用户否了（见第 5 条）。
- **索引文件内容**（像 ripgrep 的 trigram 索引）：没选。内容搜索 rg 已经够快，内容索引大、更新贵，和「只记文件名」的要求不符。
- **每个独立分支一份索引**：没选。分支目录多、活得短，建一次的开销不划算；查主索引再现场核对就够。
- **全平台都用系统通知**：没选。Linux 上 Node 的递归 watch 逐目录挂 inotify，大项目碰上限还丢事件，表格插件踩过。

## 与现有实现的关系

- 服务端 `server/file-index/`：`registry.ts`（按项目管根、共用单元、空闲卸下、推状态）、`unit.ts`（一个根：建、读回、核对、监听、写盘）、`walk.ts`、`vcs.ts`、`watch.ts`、`store.ts`、`api.ts`（契约 `shared/api-contract/file-index.ts`）、`agent-tool.ts`、`plugin-files.ts`、`name-search.ts`、`locate.ts`。
- 面板里改用索引的：`server/files.ts` 按名字搜和写文件后 touch、`server/exec/runner.ts` Agent 写成功后 touch、`server/module-map.ts` 小项目判断、`server/locate-file.ts` 找回粘贴的大文件。
- 页面推送 `file-index` 事件（`server/page-events.ts`），项目设置的状态卡跟着变，不轮询。
