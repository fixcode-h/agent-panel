# 推荐设置点「全部应用」后按钮和「N 项待应用」计数都没变化

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`、WSL 里的 `npm run test:e2e` 通过；界面检查 10 个分片全过，含新增的「AI初始化-全部应用后状态」）
- 症状：项目设置「AI 初始化」的推荐设置里点「全部应用」，分组里的「应用」按钮和标题上的「N 项待应用」都不变，看起来像没点
- 入口：`web/src/components/projects/ProjectInitReport.tsx` 的 `apply`、`web/src/components/projects/ProjectSettingsDialog.tsx` 的 `deliver` / 保存确认、`server/index.ts` 的 `PUT /projects/:id/init-result`
- 根因类型：客户端拿「打开弹窗时的整份项目快照」PUT 回去，把刚应用的推荐覆盖成旧值（后写的旧快照胜出）
- 模块：`web`（报告面板、子对话结果交回）+ `server`（`server/index.ts`）+ `shared`（`shared/project-init.ts`），跨到三个模块
- 关键词：推荐设置、全部应用、应用按钮没反应、N 项待应用、状态没调整、AI 初始化、整份快照写回、旧快照覆盖、initResult、initializedAt、`withInitResult`、`PUT /projects/:id/init-result`、初始化对话结果交回

## 现象

项目设置弹窗的「AI 初始化」页列出推荐的设置分组，每组有「应用」按钮、标题上写着「N 项和项目现在的设置不同」。用户点「全部应用」，只看到一条「已应用 N 项设置」的 toast，随后补一句「状态也没有调整」——按钮和计数的显示、以及分组里各项的当前值都没有变成推荐值；在初始化对话结束前应用过的，结果交回时还会被写回一次。

## 复现

1. 对一个还没应用过推荐的项目打开项目设置 →「AI 初始化」→「重新初始化」，等初始化对话跑出推荐。
2. 推荐出现在对话右侧的报告面板里，此时能看到「N 项待应用」和各分组的「应用」按钮。
3. 点「全部应用」：分组里的当前值和「N 项待应用」都不变，看起来像没点（应用只发出了「已应用 N 项设置」的 toast）。
4. 在初始化对话结束前应用过推荐的项目上更明显：结果交回项目或用户在设置页点「确认」后，项目名、简介、测试步骤等又变回应用前的值。
5. 反复点「应用」结果一样——写回的总是旧快照，问题不在点击和渲染。

## 根因

两条写路径都把**打开弹窗那一刻的整份项目** PUT 回去：

- `ProjectSettingsDialog.tsx` 的 `deliver`：项目对话里做完的初始化结果交回来时调 `api.updateProject(projectId, …)`，参数是组件里的 `project` 快照。
- `ProjectInitReport.tsx` 的 `apply`（报告面板的「应用 / 全部应用」）：草稿 `draft = toInput(project)` 同样是打开面板时的快照，`api.updateProject` 把整份 `draft` 连同 `initResult` 一起写回。
- 设置页「确认」保存走的也是 `draft`（打开弹窗时读的项目）。

初始化对话要跑几分钟，推荐在这期间就可能被应用；结果交回或再次保存时，手里的快照早于应用那一次写入，整份 PUT 按字段覆盖，于是把用户刚应用的推荐写回旧值——摘要又算出「N 项待应用」，按钮和分组里的当前值跟着回到应用前。**不是点击没触发，也不是 React 没重渲染**：数据真的被写回旧值了。

## 修复

- 新增 `PUT /projects/:id/init-result`（`server/index.ts`）：服务端自己 `projects.get(id)` 读最新项目，再用 `shared/project-init.ts` 的 `withInitResult(cur, saved.data)` 只合并 `initResult` / `initializedAt`（时间取本次完成时间），其它字段一律用刚读到的那份。请求体只带 `{ initResult }`，用 `ProjectProposalSchema` 校验，不合法返回 400（`z.prettifyError`），项目不存在 404。
- `ProjectSettingsDialog.tsx` 的 `deliver` 改调 `api.saveProjectInitResult`（`web/src/lib/api.ts`），不再把整份项目发回去；演示版后端 `web/src/lib/demo-backend.ts` 同步实现了同一个路由（`withInitResult`，返回字段和正式后端一致）。
- `ProjectInitReport.tsx` 的 `apply` 与 `ProjectSettingsDialog.tsx` 的「确认」改为带版本的保存：请求体带 `expectedUpdatedAt`（打开时读到的 `updatedAt`），服务端 `PUT /projects/:id` 用 `staleProjectWrite`（`server/project-lock.ts`）比对刚读到的最新值，不一致返回 409 并提示；不再「先 GET 一次再整份 PUT」，也不再在 GET 失败时回落到面板上的旧草稿。演示后端 `web/src/lib/demo-backend.ts` 同步这条校验（409 文案一致）。
- 409 之后有可用的恢复路径：两处先 `api.projects()` 刷新项目列表（`updatedAt` 拿到最新），草稿 / 面板上的推荐都保留，用户再点一次「确认」或「全部应用」就能保存；提示文案按所在位置分开（设置页「请再点一次『确认』」，报告面板「请再点一次『全部应用』」）。`updatedAt` 为空串的旧数据也当「读到的版本」参与比对，不会静默退化成无锁；非字符串的版本值直接 400。
- 界面检查补了「应用后状态」断言（见下），把「应用了又变回去」变成能拦住的回归。

## 验证

- `npm run typecheck`、`npm run lint` 通过。
- `npm run test:unit`：1612 个用例，唯一失败的 `server/exec/process.test.ts` 的 `taskCliAlive` 单独跑 3/3 通过（并行竞态，与本改动无关）。
- `npm run build` 成功；WSL 里的 `npm run test:e2e` 全部通过。
- 界面检查（`npx vite build --mode demo` + `node scripts/ui-check.mjs`）：10 个分片全过；projects 分片 39 张截图，包含新增的「AI初始化-全部应用后状态」。
- `scripts/ui/07-projects.mjs` 的新断言：点「全部应用」后等报告面板 `[data-analysis-panel="init"]` 出现「全部推荐都已和项目设置一致」，并且面板里不能再有「项待应用」，「全部应用」按钮变成不可点。
- 真实数据脚本对照（本机数据目录的副本）：修复前同样的保存会让「0 项待应用」变回 8 项、项目名被回滚；修复后保持 0 项、名称不回滚；坏 `initResult` 返回 400。
- 乐观锁补修（`server/project-lock.ts`、`server/project-lock.test.ts`、`PUT /projects/:id`、报告面板与设置页的保存调用）：`npm run typecheck`、`npm run lint` 通过；`node --test server/project-lock.test.ts` 6 个用例通过（未带版本不校验、一致放行、不一致冲突、空串版本不可退化、服务端也无版本不拦、项目已删不算冲突）。

## 已知限制

以下这一点写在这里是**没修**的，别当成已解决：

- **报告面板的 `todo` 和基线可能不同步**：`apply` 的 `todo` 来自渲染时的草稿 `same` 判定。现在保存带 `expectedUpdatedAt`，期间项目被别处改过会 409 并刷新项目列表，重试时 `same` 按新项目重算，风险已经大幅降低；但「期间仅本地其他改动」这类不推进 `updatedAt` 的情况仍可能漏判，彻底做法是应用时显式重算一遍 `buildGroups` 的 `same`。

## 防复发

- **「只改一项」的写入不要整份 PUT 回去**：客户端手里的快照只适合渲染，提交时让服务端读最新再按字段合并（这次这类字段就是 `initResult` / `initializedAt`，`PUT /projects/:id/lessons` 早就是这么做的）。
- **整份覆盖的写路径要带版本**：确实要整份保存时（项目设置页），请求体带上打开时读到的 `expectedUpdatedAt`，让服务端比对最新值后 409；不要用「保存前先 GET 一次」当保护——GET 和 PUT 之间仍有窗口，GET 失败回落到旧快照时窗口更大。
- **409 必须给出恢复路径**：前端的项目列表只在启动时拉一次，只提示「重新打开」拿不到新 `updatedAt`，保存会一直失败到整页刷新；命中 409 时要先刷新列表再让用户重试，两个入口的提示文案按各自的按钮写。
- 给初始化推荐加界面断言时要断言**写完之后的显示状态**（计数清零、按钮不可点），只断言「出现了『已应用』的 toast」拦不住旧快照覆盖——这次是先有 toast 断言、问题照样过。
