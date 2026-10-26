# ADR 0018：测试步骤可以勾「在父对话中执行」，合并后由父对话跑并把结果和耗时回传

状态：已接受 · 2026-10-26

## 背景

项目测试步骤（`Project.testSteps`）现在由每个对话自己跑：子对话在自己的独立分支里改完、跑完整套步骤、通过后 `submit_merge`。
普通检查（类型检查、lint、单测）几秒到几十秒还行，端到端测试不一样——本机的 `npm run test:e2e` 要进 WSL 跑，
一次几分钟，几个子对话同时收尾就是几份 WSL 和几份 CPU 抢同一台机器，机器直接被拖住。

用户 2026-10-26 的要求（原话）：

> 测试步骤增加一个在父对话中执行，这个只针对 git 项目，然后勾选了对应的测试步骤那么就说明这个测试步骤子对话不跑，子对话先把内容合并到父对话分支，然后父对话执行编译，把编译结果返回到子对话，如果编译成功，子对话执行收尾动作，错误则子对话重新修复，且这个报错标记是从哪个子对话来的……这个主要的目的是防止类似 wsl 的 e2e 测试每个子对话都执行，可能性能有点受不了

同一轮补充：子对话的收尾总结要统计编译 / 测试各自消耗的时间，并标明是谁跑的。

UE 项目已经有同类机制：编译归父对话、按编译目录占位（[ADR 0004](./0004-ue-build-by-parent.md)）。
这次要把「父对话替子对话做重活」从编译泛化到任意测试步骤，并且不需要模型记得去申请。

## 事实核对

| 位置                                                                              | 现状                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/schema.ts` `TestStepFields`                                               | 步骤字段都在这一个对象里；已有 `merge`（合并时编译）、`quick`（小改动也跑）、`appliesTo`、`cwd`、`timeoutSec`；本次新增 `runInParent`                                                                                                                                    |
| `shared/schema.ts` `TaskTestRun` / `Task.testRuns`                                | 一条耗时记录：`stepId` / `stepName` / `by: 'parent' \| 'self'` / `ok` / `durationMs` / `tries` / `at`；随任务持久化                                                                                                                                                      |
| `shared/schema.ts` `Task.wrapRequest.state`                                       | `requested` / `merging` / `failed` / `testing` / `test-failed`：后两个是本次新增的——`testing` 是「已合回、父对话在跑这些步骤」（合回成功不再直接结束），`test-failed` 是「合回了、父对话测试没过、正在退回修复」（和「没合进去」的 `failed` 分开，两侧的说法才不会相反） |
| `shared/test-steps.ts` `parentRunSteps`                                           | 筛选「要由父对话跑」的步骤只这一处：启用、勾了字段、不是 `merge`、有命令                                                                                                                                                                                                 |
| `shared/test-steps.ts` `verifyBlock`                                              | 按 `parentRun`（`child` / `parent`）说法不同；`parentRun` 为空时完全不提这件事                                                                                                                                                                                           |
| `shared/test-steps.ts` `stepCommand` / `matchTestStep`                            | 前者按 `env` + 平台拼真实命令行；后者用命令原文或拼出来的整行比对，认出后台命令对的是哪条步骤                                                                                                                                                                            |
| `shared/test-steps.ts` `mergeTestRun` / `testRunLines` / `TEST_TIME_SUMMARY_RULE` | 同一步骤 + 同一执行方只留最后一次、`tries` 累加；耗时行和收尾总结的要求是同两份                                                                                                                                                                                          |
| `server/parent-tests.ts` `createParentTests`                                      | 队列：全局只有一批、一步在跑；`finishJob` 收结果、`record` 落耗时、`pass` / `fail` 交给调用方                                                                                                                                                                            |
| `server/tasks.ts` `parentRunRole`                                                 | `isolated` 的子对话是 `child`；顶层父对话且项目是 Git 是 `parent`；其它返回空                                                                                                                                                                                            |
| `server/tasks.ts` `finishChildStep`                                               | 合并成功（`integrate`）后有 `runInParent` 步骤时先 `startParentTests`（写 `testing`、计划收尾标等待、排队，保留 worktree）；没有时直接 `childMerged`（标完成、清 `wrapRequest`、收口删分支）                                                                             |
| `server/tasks.ts` 后台命令回调 / `recordSelfTestRun`                              | 回调先问 `parentTests.finishJob`，命中就直接回传给子对话、不推父对话；其余推回发起的对话，`recordSelfTestRun` 按命令匹配步骤记 `by: 'self'` 的耗时                                                                                                                       |
| `server/background.ts` `exclusive`                                                | 独占命令按目录排成一条链，UE 编译已经在用                                                                                                                                                                                                                                |
| `shared/task.ts` `childFlowOf` / `childHoldText`                                  | 子对话的完成判定按 `holds` 一类一项，多了一项 `parentTest`（父对话测试没跑完不能标完成、不能删分支）                                                                                                                                                                     |
| `server/projects-analyze.ts` `detectVcs`、`server/index.ts` `GET /fs/vcs`         | 已经有一套「目录是不是 Git / P4 / SVN」的判定，设置页复用它                                                                                                                                                                                                              |
| `web/src/components/projects/ProjectSettingsDialog.tsx` `TestStepsEditor`         | 每条步骤一行复选框（启用、小改动也跑）；本次加了「在父对话中执行」，非 Git 项目置灰并说明原因                                                                                                                                                                            |
| `server/orch-mcp.ts` `finish_child` / `submit_merge` 的描述                       | 已写明合回后父对话会跑这些步骤、通过才收尾、失败退回（测试提示词和工具描述同一套说法）                                                                                                                                                                                   |

## 决策

**测试步骤新增 `runInParent`：勾了的步骤子对话不跑；子对话照常 `submit_merge`，合回后由面板在父对话目录里按顺序跑，
结果和耗时回传给发起合并的那个子对话；通过才让它收尾，失败就带着报错退回给它修。只对 Git 项目的独立分支子对话生效。**

- 数据：`TestStepFields.runInParent`，默认 `false`，老项目不用迁移；`Task.testRuns` 存耗时；`Task.wrapRequest.state` 多一个 `testing`。
- 生效范围：子对话得先有独立分支（`isolated`）才有「合回」这一步。P4 / SVN / 无版本控制的子对话没有分支可合，字段被忽略；
  设置页里不是 Git 时置灰并说明原因。判定复用 `detectVcs`（设置页走 `GET /fs/vcs`），不另写一套检测。
- `merge`（合并时编译）的步骤不在这批里：它仍按 ADR 0004 由父对话 `request_build` 申请，两边都跑会让 UE 编译编两次。
- 提示词按角色分三种说法：独立分支子对话（`child`，你不用跑）、顶层父对话（`parent`，子对话合并后由面板自动跑，
  但父对话自己改代码时没人替它跑、要自己执行）、其它（不传，步骤照常自己跑）。哪个角色由 `parentRunRoleOf` 判断：
  子对话要有父对话 + 独立分支；顶层对话没有「合回后父对话跑」这一步，即使自己开了独立分支也算 `parent`。
  子对话的「完成」改成「合回 + 父对话测试通过」。
- 收尾链路：`finishChildStep` 合并成功后，如果这个子对话有 `runInParent` 的步骤，不调 `childMerged`（那会标完成、删分支），
  而是把状态写成 `wrapRequest.state = 'testing'`、把计划里的收尾步骤标成等待、排进队列，保留 worktree。
  一批全部通过才走原来的 `childMerged`；失败走 `deps.fail`：状态改 `test-failed`（不复用「没合进去」的 `failed`）、计划收尾步骤退回进行中、
  把「来自子对话「标题」（id）」+ 步骤名 + 用时 + 输出原文推回该子对话。
- 串行：全局一次只跑一批的一步（多个子对话同时合并也排成一条队）；每条后台命令仍走父对话目录的独占队列，
  和 UE 编译共用一条队。结果按后台命令编号回到**发起这一批的那个子对话**，不串台。
- 重跑：子对话修好再 `submit_merge`，这些步骤**全部重跑**，不因为跑过一次就跳过。
- 可观测：后台命令名是「父对话测试：<子对话标题> · <步骤名>」、`taskId` 记在父对话名下，所以父对话运行区能看到谁在跑、跑到哪一步、结果如何；不另做界面。
- 耗时：只从后台命令的真实起止时间取（`jobMs`），不靠 Agent 自报。父对话跑的记 `by: 'parent'`，子对话自己跑的按命令匹配步骤记 `by: 'self'`；
  同一步骤 + 同一执行方只留最后一次，`tries` 记跑了几次。回传消息里附耗时表，子对话收尾总结按它写。

没选的做法：

- **让父对话像 `request_build` 那样「申请制」**：重测试不该靠模型记得申请。漏申请的后果是这台机器又被拖住，正好和这次的目的相反；
  合并成功后由面板自动排队，规则在代码里，不依赖提示词。
- **复用 `merge`（合并时编译）字段**：它的语义是编译，走的是 `request_build` 那条链路，UE 项目的行为已经定死了（ADR 0004）。
  把「跑指定测试」混进去会改变 UE 的编译时机，也说不清失败算编译失败还是测试失败。新字段只负责「谁来跑」，不碰编译链路。
- **让子对话跑完把结果和耗时自报上来**：模型会把耗时估成整数、失败次数记少，总结里就出现编出来的数字。
  现在耗时只从后台命令取，匹配不上步骤的命令不记，收尾总结里写「未记录」。
- **维持现状（每个子对话自己跑）**：这正是用户 2026-10-26 报的性能问题。

## 操作清单 / 契约

| 对象                                           | 约定                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestStep.runInParent`                         | `z.boolean().catch(false).default(false)`；只有 Git 项目的独立分支子对话生效；`merge: true` 的步骤即勾也仍走编译链路                                                                            |
| `Task.testRuns: TaskTestRun[]`                 | `{ stepId, stepName, by: 'parent' \| 'self', ok, durationMs, tries, at }`；随任务持久化，重启后收尾总结还能用                                                                                   |
| `Task.wrapRequest.state`                       | 新增 `testing`（已合回、父对话在跑这些步骤）和 `test-failed`（测试没过、已退回修复）；`info` 写失败步骤和报错                                                                                   |
| `shared/test-steps.ts` `parentRunSteps(steps)` | 唯一筛选：`enabled && runInParent && !merge && command.trim()`；子对话跳过哪些、父对话跑哪些都读它                                                                                              |
| `server/parent-tests.ts` `createParentTests`   | `enqueue` / `finishJob` / `statusOf` / `idle`；依赖由调用方注入（起命令、落耗时、通过、失败）                                                                                                   |
| 后台命令                                       | 名 `父对话测试：<子对话标题> · <步骤名>`，`taskId` 是父对话，`root` 是父对话目录，`exclusive: true`，步骤写了 `timeoutSec` 时按它换算 `timeoutMinutes`（至少 1 分钟），0 时用后台命令的默认上限 |
| `GET /fs/vcs?path=`                            | 设置页判断「是不是 Git」：`detectVcs` 的结果，返回 `{ vcs: 'git' \| 'p4' \| 'svn' \| 'none', root }`                                                                                            |
| `shared/task.ts` `childFlowOf`                 | 多一项 hold `parentTest`（接在 `childStepHolds` 的 pending 分支里）：父对话测试没跑完或没通过（已退回修复）都不能标完成、不能删分支；`childHoldText` 的说法是「父对话的测试还没通过」           |
| 提示词                                         | `verifyBlock` 的 `parentRun` 说明、`TEST_TIME_SUMMARY_RULE`（收尾总结的耗时表）、`finish_child` / `submit_merge` 的工具描述、父对话协作段                                                       |
| 失败回传格式                                   | `【父对话测试未通过】来自子对话「<标题>」（id <子对话 id>）：` + `第 N 步「<步骤名>」失败，用时 <时长>` + 输出结尾 + 已记录的耗时                                                               |

## 与现有实现的关系

- 新增 `server/parent-tests.ts`（队列，纯逻辑，能脱离后台队列和存储单测）和设置页的复选框；`server/tasks.ts` 里把队列接到
  `finishChildStep`、后台命令回调、重启恢复（`recoverParentTests`）和完成判定（`advanceChildTo` 的 `parentTest` hold）上。
- `shared/test-steps.ts` 是这批规则的唯一出处：筛选、耗时记录合并、耗时行、收尾总结要求、提示词里的步骤行（`testStepsText` 标「在父对话中执行」）。
- 启动器、`submit_merge` 门禁（父对话测试进行中拒绝重复请求）和 `finish_child` 的说明都只是复用现有链路，没有换合并 / 完成判定。
- UE：ADR 0004 不变——编译仍由父对话 `request_build` 发起、按编译目录占位；这次只复用后台独占队列，不动 `request_build` 的行为。
- 和 ADR 0002 / 0003 的关系：`submit_merge` 仍然是子对话的收尾请求、面板合并、合并后不立刻回收分支（0003）；
  这次只是把「合并后到彻底完成之间」多插一段父对话测试，`holds` 多一类。

## 运行时

1. 项目设置存 `runInParent`；新建对话时步骤快照进 `Task.testSteps`。
2. 子对话执行时 `parentRunRole` 给出 `parentRun: 'child'`，提示词里写明这些步骤它不跑、完成条件是「合回 + 父对话测试通过」；
   `recordSelfTestRun` 按命令匹配步骤，记 `by: 'self'` 的耗时。
3. 子对话调用 `submit_merge` → 父对话 `finish_child` → `finishChildStep` 合并成功（`integrate`）。
4. 有 `parentRunSteps` 时 `startParentTests`：状态写 `testing`、计划收尾步骤标等待、`parentTests.enqueue`。
5. 队列一次起一条后台命令（父对话目录、独占）；结果回到后台回调 → `parentTests.finishJob` → `record` 写 `Task.testRuns`；
   继续下一步，或全部通过走 `pass`（`childMerged`：标完成、清 `wrapRequest`、按 `childFlowOf` 收口删分支），或失败走 `fail`（`test-failed`、退回子对话）。
6. 失败后子对话修好再 `submit_merge`：合并成功时又从第一步重跑一遍。
7. 面板重启：`recoverParentTests` 扫 `wrapRequest.state === 'testing'` 的任务重新排队（从第一步跑）；步骤已经被删掉时直接收尾。
8. 用户丢弃独立分支（`/tasks/:id/worktree/discard`）：取消这一批（`createParentTests` 的 `cancel`）、停掉父对话目录里那条命令、清掉 `testing` / `test-failed`，之后按普通「没有分支可合」收尾——不然这两个状态会把标记完成、`finish_child`、`submit_merge` 三条路都堵死。

## 分期

一次做完。出口条件：上面「运行时」7 步在 Git 项目上跑通（成功、失败退回、重跑、两个子对话排队不串台），
非 Git 项目字段不生效且设置页说明原因，UE 的 `request_build` 回归不破，`npm run typecheck` / `lint` / `test:unit` / `build` /
界面检查和端到端测试全过。

## 风险与代价

- **子对话看不到即时反馈**：合回去之后才知道测试结果，失败要再修再合，一个来回比原来长。认这个代价——重测试本来就不该每个对话跑一遍；
  回传里带报错原文、失败步骤和耗时，减少第二次来回的摸索。
- **父对话成为瓶颈**：多个子对话同时合并时重测试排队，后面的子对话要等。这是这次的目的（机器只有一份）。
- **父对话被打断**：测试结果只回传子对话，不推给父对话；父对话计划里等这个子对话的步骤保持等待，靠状态上报变化。父对话不需要盯着跑。
- **重启要重跑**：从第一步重跑，多花时间；比丢掉安全（测试可重复）。原来跑过的耗时记录留着，`tries` 会累加。
- **分支被丢弃时批次要一起取消**：`testing` / `test-failed` 的 hold 只在还有独立分支时才算；丢弃分支的路径主动取消批次、清掉状态，避免队列还在替一个没有分支的子对话跑测试。
- **耗时只认能匹配上的命令**：Agent 自己拼的查看命令不记；收尾总结要求写「未记录」，不编数字。表里因此可能有缺行，这是有意的。
- **非 Git 项目勾了也不生效**：设置页置灰并说明原因；从 Git 改成 P4 的项目，字段还留着但不生效，不去改用户数据。

## 开放问题

- **队列要不要按父对话分开**：现在全局一条队，同一面板多个顶层父对话时也是串行的。倾向保持——整机资源只有一份，分开只会让两个父对话同时抢。
  定下来之前先这样实现（`server/parent-tests.ts` 里 `current` 只有一个）。
- **父对话测试的总时长上限**：现在只用步骤自己的 `timeoutSec`（0 表示不限），没有「一批最多跑多久」。倾向先观察真实耗时，需要时再加；
  定下来之前超时由后台命令自己收尾，结果按失败回传。
- **界面上要不要显示排队位置**：现在只有后台命令名和运行区，用户在运行区看得到「谁在跑、跑到哪一步」。先不动界面；
  要加就放在子对话的合并状态行上（队列里得先加一个按子对话查批次的接口）。

## 后续

- 2026-10-26：步骤改成「调用前现读项目设置」，任务快照退化成兜底（`shared/test-steps.ts` 的 `currentTestSteps`）。
  起因是用户报「设置里勾了禁止子对话执行，已经开始的子对话合并时还是自己跑 e2e」：原来的快照语义不会把新设置带到创建过的对话。
  现在的判断点：`parentRunRole`、`testStepsOf`（含 `parentStepsOf` 和耗时匹配）、engine host 的 `verify.steps`；
  项目读不到才用 `Task.testSteps`。一条命令在派发时算定，所以一轮之内不会前后不一致。
  仍按快照的只有工作流编排（`Task.workflows` / `skillSlots`），见 `docs/agent-test-steps.md` 的同名一节。
- 2026-10-27：界面文案由「在父对话中执行」改为「禁止子对话执行」，语义未变，只是表述更贴切——这个参数**只针对子对话**，
  父对话自己改代码验证时照常跑这些步骤（父对话侧的步骤清单不走 `parentRunSteps`）。字段名 `runInParent` 保留不改，避免数据迁移。
- 2026-10-28：`parent` 步骤也按改动清单筛（`stepApplies` 不再对 `parent` 恒返回 true）：
  子对话合并后由父对话跑的那一批先用子对话的 `changes` 筛（`parentTestStepsOf`，一条都没命中跑全部）；
  父对话自己验证时同样按自己的改动清单筛。上面 2026-10-27 那句「父对话照常跑这些步骤」指的是
  「不会被禁止跑」，不是「无条件全跑」——两种场景都遵守 `CHANGED_FILES_RULE` 的「先按改动清单筛」。
