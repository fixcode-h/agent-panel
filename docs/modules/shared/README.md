# shared：前后端共享的数据模型、流程图和执行引擎

- status: inferred
- source_paths: `shared/`
- entry: `shared/schema.ts`、`shared/clis.ts`
- analyzed_at: 2026-10-24

## 职责

- 数据结构：Agent、工作流、流程、项目、任务、设置等的 zod schema 和类型（`shared/schema.ts`）。
- CLI 注册表：内置 CLI 定义在 `shared/clis/*.json`，由 `shared/clis.ts` 加载；参数拼装、输出解析方式、支持的能力、Skill 和说明文件位置都写在定义里，面板其他地方按字段走。
- 流程图逻辑：节点、连线、子流程、引用解析、布局和任务规划（`shared/flow.ts`）。
- 工作流执行引擎：按流程图调度节点，处理开始 / 验收 / 结束流程、步骤串行、续跑和主 Agent 调度（`shared/engine.ts`）；真实执行和在线演示的模拟执行共用。
- 内置内容：内置角色和工作流模板在 `shared/builtin/`，界面文案的英文在 `shared/locales/en/`。
- 项目级测试步骤、搜索排除目录、子对话交接摘要等前后端共用的规则（`shared/test-steps.ts`、`shared/search-exclude.ts`、`shared/handoff.ts`）。
  搜索排除除了写进提示词，还由 `server/exec/runner.ts` 写成 ripgrep 配置、用 `RIPGREP_CONFIG_PATH` 交给 CLI，rg 和 CLI 内置搜索不靠提示词也会跳过（显式把排除目录当起点时照样能搜）。
- 定时计划（`shared/schedule.ts`）：`Schedule` / `ScheduleInput` 的 schema（名称、提示词、项目、角色、`once` / `daily` 重复规则、下次执行时间、启用开关、状态和上次结果），以及到点判定的纯函数——`pickDue` 分出该执行的和错过的，`afterRun` / `afterMiss` / `afterFail` 给出执行后、错过、失败后的字段变化，`nextDailyAt` 按本地日历推到下一次，`workdayTemplate` 是「今日工作」模板（每天 19:00）。前后端共用同一份规则：服务端按它轮询启动对话，界面按它显示下次执行时间。单测在 `shared/schedule.test.ts`（注入固定时钟，覆盖到点触发一次、每天重算、错过不补跑、模板时间和 `datetime-local` 互转）。
  和任务里的「执行计划」（`shared/plan.ts` 的 `task.plans`）不是一回事。
- 子对话收尾的评审门禁（`shared/review-gate.ts`）：评审通过，或执行角色对每条 🛑 写了处置（`review_triage`）才放行，评审只出意见（[ADR 0009](../../adr/0009-review-findings-triaged.md)）；验收结论的读法在 `shared/verdict.ts`（`parseVerdict` 取最后一条、`leadVerdict` 首行优先），引擎、门禁、执行报告共用。

## 入口

- `shared/schema.ts`：所有跨前后端的数据结构。
- `shared/clis.ts`：CLI 列表和能力的统一出口。
- `shared/engine.ts`：执行引擎，被 `server/` 和在线演示的模拟实现调用。

## 依赖

只依赖 `zod`，不引用 `server/` 和 `web/`。前端通过 Vite 别名 `@shared` 引用（见 `vite.config.ts`）。

## 回归验证

- `npm run typecheck`（包含漏翻检查，改了文案必须同时补英文）
- `npm run test:unit`（覆盖 `shared/**/*.test.ts`：流程图、执行引擎、CLI 定义、内置模板等）

## 待确认

- `shared/engine.ts` 与 `shared/flow.ts` 的职责边界在文件头注释里写了，但两者都涉及「节点怎么排、怎么跑」，新增逻辑前先确认应该落在哪一边（待确认）。
