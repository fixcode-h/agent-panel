---
paths: server/tasks.ts, shared/test-steps.ts, shared/test-steps.test.ts, web/src/components/projects/**, docs/agent-test-steps.md, scripts/e2e/12-parent-tests.mjs
---

# 项目设置怎么作用到执行

## 项目设置类配置在执行点现读，不靠保存时同步、不在任务上长缓存

- 规则：任务上从项目拷来的字段（`Task.testSteps` 这类）只作项目被删、读不到时的兜底；用一个纯函数决定用哪份（`shared/test-steps.ts` 的 `currentTestSteps`），所有判断点都走它，不在每个点上各写一个「长度为 0 就用快照」的分支。判断 / 派发前用 `deps.projects.get` 现取一次，同一判断只用这一份；命令在 `background.start` 派发那一刻算定，一轮之内不重读。
- 规则：不要做成「保存项目设置时遍历改写跑着的对话」（那是同步机制），也不要把项目对象挂在任务上跨轮缓存。改这类语义时同提交同步 `docs/agent-test-steps.md` 的「项目设置对进行中的对话生效」、设置页那句说明和 `shared/locales/en/` 的英文，否则界面还在说「改了不影响进行中的对话」。
- 起因：用户报「项目设置里勾了禁止子对话执行，已经开始的子对话还是自己跑 e2e」（任务里存的是创建时的快照）；先按「策略位实时、内容仍快照」设计，用户纠正为「调用前先读配置判断怎么调用」。
- 防线：`shared/test-steps.test.ts` 的「项目设置以项目当前为准，任务快照只在读不到项目时兜底」；`scripts/e2e/12-parent-tests.mjs` 的「改项目设置立即生效」。
