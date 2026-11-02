# ADR 0039：项目教训存进项目文档目录的 lessons.md

状态：已接受 · 2026-11-02

- 影响范围：`server/project-lessons.ts`（新增）、`server/lessons.ts`、`server/index.ts`、`server/tasks/run.ts`、`server/assist.ts`、`shared/locales/en/server.ts`
- 取代：无

## 背景

项目教训（Agent 在项目里返工后记下的规则）原来存在数据目录 `projects/projects.json` 的 `Project.lessons` 字段里。用户要求把它改成项目文档目录里的一个 Markdown 文件，理由和项目文档一样：跟着项目走、可以读、可以提交到版本管理，换机器或换面板实例也能看到；不再只存在于某个面板的数据目录里。

同时有两条现实约束：

- P4 项目的文档常常放在项目目录外层的 `ProjectDoc/docs`，同一父目录下的项目和分支共用一个文档区；教训也要这样共用，且不能受项目设置「文档」角色里「文档根」下拉的影响。
- SVN 项目的文档根已经由「文档根」设置决定（默认项目外层，也可以选项目内），教训应该跟文档放在一起。

## 事实核对

| 位置                                      | 现状                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `shared/schema.ts` 的 `ProjectFields`     | `lessons: z.array(ProjectLesson).max(200).default([])`，随项目存在 `projects.json`                        |
| `server/index.ts` 的 `createCollection`   | 项目集合是 `createCollection<ProjectInput, Project>('projects.json', Project)`                            |
| `server/lessons.ts` 的 `projectLessons`   | `record` / `review` 读整份项目、`upsertLesson` / `applyReviewItem` 后 `projects.update(..., { lessons })` |
| `server/index.ts` 的 `PUT /projects/:id`  | 请求带 `lessons` 时整份写回项目；没带时保留旧值                                                           |
| `shared/doc-root.ts` 的 `vcsDocRoot`      | 项目外是 `<项目上一级>/ProjectDoc/docs`，项目内是 `<项目>/docs`                                           |
| `shared/doc-root.ts` 的 `resolveDocRoot`  | P4 / SVN 按「文档根」下拉算根；Git / 无版本管理返回 `undefined`                                           |
| `server/tasks/run.ts` 的 `lessons.list`   | 读 `projects.get(task.projectId)?.lessons` 交给提示词                                                     |
| `server/orch-mcp.ts` 的 `project_lessons` | 通过 `Orchestra.lessons.list()` 查（`shared/engine.ts`）                                                  |
| `server/assist.ts` 的 `contextFor`        | `kind: 'lessons'` 时把 `project.lessons` 放进分析上下文                                                   |

## 决策

项目教训改存项目文档目录里的单个 `lessons.md`：

| 项目版本管理 | 教训文件位置                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Git / 无版本 | `<项目目录>/docs/lessons.md`                                                                   |
| P4           | `<项目目录上一级>/ProjectDoc/docs/lessons.md`（同父目录的项目 / 分支共用，忽略「文档根」下拉） |
| SVN          | `resolveDocRoot(项目目录, 'svn', 文档角色参数).root + '/lessons.md'`                           |

旧位置继续读取：`projects.json` 里的 `Project.lessons` 和文件合并，同 id 或同标题以文件为准。任何一次写入都写整份文件，成功后把项目 JSON 的 `lessons` 清空；这样旧条目被删掉后不会再从 JSON 里复活，也不需要额外的墓碑记录。

文件格式由本项目定义（人和面板都能读）：

- 顶部一段维护说明，用 `<!-- panel-lessons:header -->` / `<!-- /panel-lessons:header -->` 包起来；
- 每条教训在 `<!-- lesson -->` 和 `<!-- /lesson -->` 之间；
- `id` / `enabled` / `source` / `taskId` / `createdAt` / `updatedAt` / `tags` / `paths` / `history` 是单行字段，数组和改写记录用 JSON；
- `title` / `rule` / `cause` 用 `|` 开头、正文缩进两行的块，允许任意多行 Markdown；
- 解析失败（缺结束标记、字段不是「名字: 值」、数组不是 JSON、**标记之外还有非空文字**等）时不覆盖原文件，把出错的行号返回给用户。

写入用临时文件、fsync、rename；同一路径的写入在进程内排队，P4 共用文件时也不会交错。项目设置里的整份保存（`PUT /projects/:id` 带 `lessons`）和 `record_lesson` / 评审应用走同一个队列，并在队列内再核对一次 `expectedUpdatedAt`，避免用设置页打开时的旧快照覆盖这期间 Agent 刚记的条目。读取点统一走 `server/project-lessons.ts` 的 `loadProjectLessons`，返回合并后的列表。

候选方案和没选的原因：

- **继续放 `projects.json`，只额外导出一份 Markdown**：两份数据会不一致，用户改了 Markdown 面板不认，等于没解决问题。
- **每个项目存自己的 JSON 数据文件**：机器好读，但不是用户要的可读 Markdown；而且 P4 分支共用文件的需求仍要单独处理。
- **P4 也按「文档根」下拉走**：用户明确要求 P4 固定放 `ProjectDoc/docs`，且同一父目录下所有项目 / 分支共用一个文件；下拉里有「项目内 docs」，按它走会分裂成多个文件。
- **用墓碑记录处理删除**：要多设计一套数据，且旧 JSON 会一直是权威来源之一；写入后清空旧 JSON 更简单，删除语义也自然成立。

## 操作清单 / 契约

- 新增 `server/project-lessons.ts`：`projectLessonsFile`、`renderProjectLessons`、`parseProjectLessons`、`readProjectLessonsFile`、`mergeProjectLessons`、`loadProjectLessons`、`saveProjectLessons`、`projectWithLessons`。
- `server/lessons.ts` 的 `projectLessons(projects, deps)` 增加可选的 `deps.agents`（找「文档」角色，算 SVN 文档根）；`record` / `review` 改为读写文件，写成功后把项目 JSON 的 `lessons` 置空。
- `server/index.ts`：`GET /projects` 返回合并后的项目；`PUT /projects/:id` 带 `lessons` 时先写文件再保存项目；`POST /projects/:id/lessons`、`POST /projects/:id/lessons/review` 的返回值带合并后的教训。
- 读取点 `server/tasks/run.ts`、`server/assist.ts` 改用 `loadProjectLessons`；`GET /projects` 一处覆盖界面和 `projectWithLessons`。
- 没有目录（项目路径为空）的项目没有文件可写，继续存回项目 JSON，行为与原来一致。
- 全局教训不变，仍在数据目录 `config/global-lessons.json`。

## 与现有实现的关系

`Project.lessons` 字段保留：旧数据要能读，没目录的项目也还要用它。新写入不再往里存条目。`shared/lessons.ts` 的提示词预算、按文件取全文、标签页签等逻辑不变，只换数据来源。

## 运行时

- 写入：`record_lesson`（对话）、`POST /projects/:id/lessons`（界面「记成教训」）、`POST /projects/:id/lessons/review`（评审应用）、`PUT /projects/:id` 带 `lessons`（项目设置保存）都走文件；同一项目 / 同一文件的写入经 `projectLessons` 的队列和 `saveProjectLessons` 的路径队列串行。
- 读取：`GET /projects`、对话提示词、`project_lessons`、AI 分析（`kind: 'lessons'`）读合并结果；文件读不出来时退回旧 JSON 条目并写运行日志，不影响对话。
- 失败：文件解析失败时写入被拒绝并返回出错行；磁盘写入失败返回错误，不动原文件；项目 JSON 清空失败时返回错误，但文件已经是新的，下一次读取按 id / 标题去重，不会出现重复条目。

## 分期

一次做完，没有分期。

## 风险与代价

- **降级不兼容**：旧版面板只读 `projects.json`，看不到新文件里的教训。这是把数据迁出数据目录的必然代价；旧 JSON 条目在新版被写过后会被清空。
- **P4 共用文件**：同一父目录下的项目 / 分支共用一个 `lessons.md`，A 分支的教训会出现在 B 分支。这是用户明确要求的；写入按路径排队避免交错。
- **用户手改格式**：格式坏掉时面板拒绝写入并提示行号，不会静默覆盖；用户需要按提示修好。
- **每个项目多一次文件读取和版本管理探测**：`GET /projects` 会为每个有目录的项目探测版本管理（`detectVcs` 有 P4 探测缓存）；项目数量级不大，暂不额外缓存路径结果。

## 开放问题

- 用户手写的条目没写 `id` 时按「标题 + 规则」的哈希生成 id；如果之后同时改了标题和规则，会被当成新条目。倾向保持现状，等真有人手写大量条目再考虑显式要求写 id。
