# ADR 0062：前后端接口契约写在 shared，演示后端的业务口径调 shared 同一份函数

状态：已接受（2026-11-12，重构文档第 9 条、第 10 条短期部分；第一批已实施） · 2026-11-12

## 背景

- `web/src/lib/api.ts` 一千多行，每个接口手写 `request<T>(url)`：T 和服务端路由的实际返回没有编译期关联，服务端少带一个字段，前端类型照样通过。
- 原来的任务接口契约（这次挪进 `shared/api-contract/tasks.ts`）只覆盖任务列表、详情、子对话、发消息四个接口。
- 演示后端（`web/src/lib/demo-*.ts`，约 9000 行）把服务端的业务口径又写了一遍：子对话栏的一行、父对话的三项子对话计数各有两到三份。界面检查跑的是演示后端，口径一漂移，截图里看到的分支就和真机不一样（例如演示版的子对话栏不排除回收站里的子对话、等孙对话时 `childWait` 少传了 `childNeeds`）。

## 决策

1. **契约按模块写在 `shared/api-contract/<模块>.ts`**，一个接口一条 `endpoint({ method, path, body?, res })`（`define.ts`）。`path` 是相对 `/api` 的路径，`:name` 是参数。
   - `res` 能用完整 schema 时直接用（角色、工作流、设置这类直接回存盘记录的）；只能写界面必读字段时用 `looseObject` 加 `shaped<T>()`：运行时按 schema 查，类型用前后端共用的函数产出的 T（例如 `ChildRow = ReturnType<typeof childRow>`）。
   - 放弃：Hono RPC（`hc<typeof app>`）。路由分散在几十个子 app 里，还有不少写在 `server/index.ts` 里，要先把类型串起来；演示后端也用不上它的类型。
2. **前端按契约调**：`web/src/lib/api/call.ts` 的 `call(ep, { params, query, body })` 拼地址、带方法，返回类型从 `res` 推出。新接口和改到的接口都走 `call`，不再新写 `request<T>`。
3. **入参校验用契约里那一份 schema**：路由直接 `xxxContract.yyy.body.safeParse(...)`（契约里引用的就是原来的 `AgentInput` 这类 schema，不另写）。
4. **出参在测试里查，不在运行时查**：`contractProblems(schema, value)` 除了 parse 失败，还把「schema 用默认值补上的字段」算成对不上——Task、Agent 这类 schema 带大量默认值，单靠 parse 拦不住少字段。同一份探查流程（`shared/api-contract/probe.ts`）在两边跑：正式后端 `scripts/e2e/17-contracts.mjs`，演示后端 `web/src/lib/demo-contract.test.ts`。
   - 放弃：运行时校验每个响应。热点接口（任务列表 2.5 秒一次、子对话栏 4 秒一次）多一次整份 parse 不值得，漂移在测试里拦下就够。
5. **演示后端的业务口径调 shared**：两边都要的业务口径（子对话栏的一行、父对话的三项计数、子对话按记录算在不在运行）放进 shared（`shared/children/row.ts`），只把「真进程、真 git」这类只有一边有的值当参数传。正式后端和演示后端里不再各拼一份。

## 分期

- 第一批（本次）：任务（列表、详情、子对话、停止子对话、发消息、新建）、设置、分类、标签、角色、工作流、项目分类、项目（列表、新建、排序、删除）、定时计划；子对话行和计数共用。
- 之后按模块分批：每批把一组接口写进契约、api.ts 改成 `call`、探查里加上，演示后端顺带改调 shared。优先读写面大的：项目设置、子对话操作、后台命令、文件、表格。
- 长期（重构文档第 10 条）：演示只保留样本数据和模拟 CLI 输出，执行部分复用 shared 的引擎。等 Task 拆成存盘 / 运行时 / 摘要（第 1 条）之后再评估。

## 风险与代价

- 契约分批覆盖期间，api.ts 里新旧两种写法并存。新写的接口一律走 `call`，评审时看到新的 `request<T>` 就要求改。
- 探查会在数据目录里建再删一个分类、标签、角色副本；e2e 和演示测试都是一次性的临时数据，不影响用户数据。
- `contractProblems` 对「旧数据缺字段、靠默认值补」也会报。探查跑的是新建的数据，不会误报；以后如果要拿它查用户的真实数据，要先过迁移（第 6 条）。

## 开放问题

- 要不要给 api.ts 加一条规则检查，统计 `request<` 的个数只许变少（像 file-caps 那样）。倾向加，等第二批做完、剩下的数量稳定后再加。
