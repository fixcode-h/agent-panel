---
paths: server/tasks/**, shared/test-steps.ts, shared/test-steps.test.ts, web/src/components/projects/**, docs/agent-test-steps.md, scripts/e2e/12-parent-tests.mjs, scripts/ui/07-projects.mjs
---

# 项目设置

## 项目设置类配置在执行点现读，不靠保存时同步、不在任务上长缓存

- 规则：任务上从项目拷来的字段（`Task.testSteps` 这类）只作项目被删、读不到时的兜底；用一个纯函数决定用哪份（`shared/test-steps.ts` 的 `currentTestSteps`），所有判断点都走它，不在每个点上各写一个「长度为 0 就用快照」的分支。判断 / 派发前用 `deps.projects.get` 现取一次，同一判断只用这一份；命令在 `background.start` 派发那一刻算定，一轮之内不重读。
- 规则：不要做成「保存项目设置时遍历改写跑着的对话」（那是同步机制），也不要把项目对象挂在任务上跨轮缓存。改这类语义时同提交同步 `docs/agent-test-steps.md` 的「项目设置对进行中的对话生效」、设置页那句说明和 `shared/locales/en/` 的英文，否则界面还在说「改了不影响进行中的对话」。
- 起因：用户报「项目设置里勾了禁止子对话执行，已经开始的子对话还是自己跑 e2e」（任务里存的是创建时的快照）；先按「策略位实时、内容仍快照」设计，用户纠正为「调用前先读配置判断怎么调用」。
- 防线：`shared/test-steps.test.ts` 的「项目设置以项目当前为准，任务快照只在读不到项目时兜底」；`scripts/e2e/12-parent-tests.mjs` 的「改项目设置立即生效」。

## 会被角色或后台改动的数据，弹窗打开时重新取

- 规则：会被角色或后台改动的数据（如项目教训）别只用页面缓存，弹窗打开时重新请求合进草稿，否则 `record_lesson` 记的教训在项目设置里看不到。
- 防线：人工。

## 弹窗外的 AI 会话记住结果该存到哪个对象

- 规则：关掉弹窗还在跑的 AI 会话（项目设置的 `AiSession`）要记下途中建好的对象（`projectId`），应用时打开那个对象；没保存的新建草稿暂存在弹窗外壳。不能靠重开空白的新建弹窗来应用，保存时会多建一个同名项目。
- 起因：新建项目时 AI 初始化 → 关掉设置 → 点「查看推荐并应用」，多出同名项目、目录也丢了（0e1df58 修复）。
- 防线：人工（`scripts/ui/07-projects.mjs` 的「AI初始化」截图只覆盖已有项目，新建项目时关掉设置再应用这条要手动点一遍）。

## 改了什么才编译、测试什么，不要「没命中就全跑」

- 规则：步骤按改动的文件类型筛，所有项目通用：改 C++ 才编 C++，只改 Lua 只跑 `luac -p`，只改配置、表格、资源、文档不编译。认得出类型的编译 / 语法检查命令没填 `appliesTo` 时按命令推断（`shared/test-steps.ts` 的 `commandGlobs`），`always` 也不例外；有改动清单但一条都没命中就不跑，只有清单取不到时才全跑。UE 编译申请（`submit_merge` 的 `build`、`request_build`）走同一份 `buildStepsFor`。
- 起因：用户 2026-10-31 纠正「只改了 Lua、配置也去编 UE 的 C++」——默认的 `nothingMatched → 跑全部` 兜底、没填适用改动的自建编译步骤、`build` 默认 true 三处都会触发。
- 防线：`shared/test-steps.test.ts` 的「改了什么才编译什么」。
