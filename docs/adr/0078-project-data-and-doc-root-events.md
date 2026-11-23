# ADR 0078：项目数据统一入口和文档根变化事件

状态：已接受 · 2026-11-23

## 背景

「可统一能力盘点」第 7 项：按项目存的数据各定各的位置——UE 插件的收藏、片段、GM 扫描放 `文档根/AgentPanel/`（2026-11-21 定），表格的结构文件放项目目录 `.agentpanel/tables/` 或数据目录 `tables/<id>/`；每处各写一份原子写入，写的时候都不知道 P4 要先签出。UE 插件缓存文档根时只能按时间过期，用户改了文档根要等一会儿才生效。

## 决策

1. `server/project-data/index.ts`（开放给插件）：`projectData(projectId, name)` 给 `shared`（`文档根/AgentPanel/<name>`）、`local`（`<数据目录>/project-data/<name>/<id>`）和按 P4 签出规则的 `write`。签出规则复用 `server/vcs/p4-plan.ts`（ADR 0073），和 Agent 改文件、UE 保存资源同一份。
2. `server/docs/root-cache.ts` 加 `onDocRootChange`：保存项目设置后马上重算文档根，变了就通知；整体失效时通知「不知道了，自己重算」。
3. 表格结构文件迁到 `文档根/AgentPanel/Tables`（用户 2026-11-23 定）：用到时如果新目录没有任何 `.json`，把旧目录的复制过去，旧文件不删。

候选方案：

- **SDK 加 `ctx.projectData`**：暂不做，开放模块已经够用，不为此升插件接口版本（同 ADR 0076）。
- **在面板的数据迁移里搬表格结构文件**：不行。旧位置有一份在项目目录里、跟着版本控制，同事拉下来的分支里才有，只能用到时再搬。
- **迁移后删掉旧文件**：不做。旧文件可能在版本控制里，删除要进 changelist，由用户决定什么时候提交。

## 影响

- 新功能要按项目存数据时用 `projectData`，不再自己拼 `.agentpanel/…` 或数据目录路径（AGENTS.md「先找能共用的」）。
- 表格设置里「存放位置」的 `project` 值含义变成文档根，值名沿用，不改存盘格式。
- 旧的 `.agentpanel/tables/` 迁移后不再读，用户可以自己删。
