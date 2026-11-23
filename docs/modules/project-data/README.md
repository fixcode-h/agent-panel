# project-data：按项目存数据的统一入口、文档根变化事件

- 状态：documented
- 职责：给面板功能和插件按项目分「团队共享 / 只在本机」两个目录，写文件时照 P4 签出规则；文档根变了通知订阅方
- 源码：`server/project-data/`、`server/docs/root-cache.ts`
- 入口：`server/project-data/index.ts`、`server/docs/root-cache.ts`
- 关键词：projectData、文档根、AgentPanel 目录、writeTracked、onDocRootChange、表格结构文件、收藏、GM
- 更新：2026-11-23

为什么这么定见 [ADR 0078](../../adr/0078-project-data-and-doc-root-events.md)。

## 入口

- `projectData(projectId, name)`（开放给插件）：
  - `shared`：`文档根/AgentPanel/<name>/`，项目没有文档根时是 `<项目>/docs/AgentPanel/<name>/`；跟着文档提交给团队。
  - `local`：`<数据目录>/project-data/<name>/<项目 id>/`，只在这台机器上。
  - `write(file, data)`：原子写；文件在 P4 工作区里时先 `p4 edit`（已经在别的 changelist 里的不动），新文件写完 `p4 add`。
  - `name` 只许字母数字和 `- _ .`，拼进路径不能跳出目录。
- `writeTracked(file, text)`：同上的写入规则，单独用。
- `onDocRootChange(fn)`（`server/docs/root-cache.ts`，开放给插件）：项目设置里改了文档根、或重新计算出的文档根和缓存的不一样时回调 `(projectId, root)`；`forgetDocRoots()`（设置里整体改了规则）对每个项目回调 `(id, undefined)`，订阅方下次用时自己重算。返回取消订阅的函数。

## 谁在用

- 表格插件：结构文件（表头、枚举、扫描结果、AI 分析）在 `projectData(id, 'Tables')` 的 `shared`（设置选「只存本机」时 `local`）；旧位置 `.agentpanel/tables/`、`<数据目录>/tables/<id>/` 的文件在新目录还空着时复制过去，旧文件不删（`plugins/tables/server/tables/schema-legacy.ts`）。
- UE 插件：文档根缓存不再按时间过期，改订阅 `onDocRootChange`（`plugins/ue/server/doc-root.ts`）。

## 启动

`server/index.ts` 在初始化文件索引之前调 `initProjectData({ getProject, docRoot })`；没初始化就调 `projectData` 会抛错（单测里要自己接线，见表格插件的 `actions.test.ts`）。
