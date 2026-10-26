# 计划写着「已完成」，展开后还有一步是等待中

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过；`scripts/ui/02-task.mjs` 的「执行计划-提前结束」覆盖，已用「回退到冲突写法会报错、改后通过」两轮界面检查确认断言拦得住）
- 模块：`web`（`web/src/components/tasks/PlanPanel.tsx`）+ `shared`（`shared/plan.ts`）
- 关键词：执行计划、计划已完成、计划已结束、doneAt、finish_plan、残留等待中、leftSteps、planHeadline

## 现象

计划面板折叠头写着「✓ 计划已完成」，点开以后最后一步「推送前复验」还是橙色虚线圆环的**等待中**，副标题「lint + 单测」，右侧耗时 4m 48.6s。整份计划说已结束、里面却有一条还在等，状态自相矛盾（用户原话：「计划完成为啥还有一个等待中」）。

## 根因

`Plan` 的 `doneAt` 有两种来路，界面只看 `doneAt`，分不出这两种：

- `shared/plan.ts` 的 `closeIfDone()`：**全部步骤都 `done`** 时自动写 `doneAt`，这是真正的「全部做完」。
- 同文件的 `finishPlan()`（Agent 调 `finish_plan` 主动结束）：`plan.doneAt ||= now` 直接写上，不管还有几步没做完；它自己已经算出 `left` 并在返回文案里写了「它们留在计划里」，但 `doneAt` 照样写。

`web/src/components/tasks/PlanPanel.tsx` 的 `PlanButton` 里 `const finished = !!plan?.doneAt`，于是「提前结束 + 有遗留步骤」也被说成「计划已完成」；而列表项按各自真实状态画（`PlanIcon` 的 `waiting` 分支是 `plan-wait-ring` 橙色虚线环），两者同时出现在一屏。

这次的具体数据里那一步其实是在等后台命令（lint + 单测），父对话没把它结算成完成就直接 `finish_plan` 结束了计划——操作上也确实可以更规范，但**产品层面**计划已经结束后还挂着「等待中」的步骤会让用户困惑，界面说过头才是要修的地方。

## 修复

- `shared/plan.ts` 新增 `leftSteps(plan)`（还没做完的主步骤 + 子步骤）、`unfinishedSteps(plan)`（只数主步骤）和 `planHeadline(plan)`：返回 `'open'`（还在做）/ `'done'`（全部做完收起）/ `'closed'`（提前结束但还有遗留）。判据只在这几处定义，界面不再自己拼 `!!doneAt`。折叠头说的「n 步没做完」取 `unfinishedSteps`，和同屏的 `planProgress` 的 `total - done` 是同一套计数（评审指出过：直接拿 `leftSteps` 的条目数套「步」字文案，带子步骤的计划会同时出现「3 步没做完」和「1/2」）。
- `finishPlan` 的提示文案改用 `leftSteps`，和界面同一份口径（以前只统计主步骤，子步骤没做完时不提）。
- `PlanPanel.tsx`：`PlanButton` 按 `planHeadline` 分三种显示——`done` 是绿勾 +「计划已完成」，`closed` 是 `CircleSlash` 灰斜杠 +「计划已结束」+ `data-plan-left` 的「{n} 步没做完（已保留）」。`PlanWindow` 把 `settled`（计划已结束）传给 `PlanStepRow`，没做完的步骤经 `PlanIcon` 画成静止空心圆、读作「未完成」，小字也不再是 warning 色；`OldPlan` 的头图标同样按 `planHeadline` 取，提前结束的历史计划不画勾。
- **没有改数据语义**：那一步的状态原样留着。评估过把没做完的步骤在结束时改成 `skipped` / 新加 `abandoned` 状态，或者让 `finish_plan` 在有遗留时直接报错——前者会抹掉「它当时真的还在等」这个事实、把持续中的链路挂在已完成计划上，后者改变工具行为、影响面大；两者都比「让界面说实话」风险高。

## 防线

- `shared/plan.test.ts`：「提前结束还有没做完的步骤：doneAt 写上、步骤状态原样留着，leftSteps 报得出来」、「折叠头说的「几项没做完」和进度是同一套计数：带子步骤时不打架」、「全部做完收起后 leftSteps 是空的」、「折叠头该说哪件事（open / closed / done）」。
- `scripts/ui/02-task.mjs` 的「执行计划-提前结束」：直接把演示数据改成「前面几步完成、最后一步等待中、`doneAt` 有值」，断言折叠头不出现「计划已完成」、写了「计划已结束」和「n 步没做完」；展开后没有读作「等待中」的图标、没有 `.plan-wait-ring`、有「未完成」；并单独断言「计划已完成 + 等待中」不同屏；还断言折叠头的「n 步没做完」和窗内进度 `done/total` 对得上。**那条数字断言的前提是最后一步带子步骤**：只数一步时「数条目」和「数主步骤」结果相同，断言是空的（最初就是这样，改前验证跑过了却没拦住）。改这条用例、或给计划面板加同类断言时，先确认两种计数口径在构造的数据下真的不同。
- 以后再往计划面板加「结束」相关的显示，一律读 `planHeadline`，不要直接用 `doneAt` 判「全部做完」。
