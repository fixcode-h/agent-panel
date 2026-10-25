# 侧栏普通对话行有一圈虚线边框

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过）
- 症状：侧栏普通对话行四周有一圈虚线边框，看着像选中态
- 入口：`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`
- 根因类型：保活状态被画成整行边框
- 模块：`web`（`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`）
- 关键词：侧栏、对话列表、虚线边框、border-dashed、TaskRow、data-cli-online、CLI 存活、cliAlive

## 现象

左侧栏「最近」下面的聊天列表里，有些行四周有一圈虚线边框，有些行没有。用户报的是「普通对话这个怎么还有虚线，去掉吧」——这一行并不是选中态，用户也不希望普通对话行有任何整行边框。

## 根因

`TaskRow` 当时给「CLI 进程还开着、但这一轮没在处理」的对话画一圈虚线边框：

```tsx
const online = !!task.cliAlive && !busy && state !== 'needs'
...
data-cli-online={online || undefined}
className={cn('... border border-transparent ...', online && 'border-dashed border-line-strong')}
```

`cliAlive` 是服务端按真实进程算的运行时字段（对话页开着、进程保活等下一句时为 true）。它表达的是一段时间内的进程状态，跟这一行是不是当前对话无关，画成整行边框会被当成选中态或异常态。

## 修复

- 去掉 `online && 'border-dashed border-line-strong'`，行保持 `border border-transparent`，不换成任何别的可见边框或背景。
- `online` 只用来算这条虚线，一并删掉；`data-cli-online` 全仓没有消费方（`git grep` 确认，`scripts/` 里也没有用例用它定位），一起去掉，不留没有意义的属性。
- `task.cliAlive` 本身的其它用途全部保留：`CliAlive.tsx` 的 `cliTreeAlive` / `cliAliveHint`（标题流光和悬停说明）、`TaskStatusIcon` 的「等待你的下一条消息」、`data-cli-alive`、项目工作区里的进程状态，都不受影响。
- AI 分析对话的强调色标签（`isAnalysisTask` → `AnalysisMark`）不动，用户没说它有问题。

## 防线

- 没有自动化用例盯这条虚线的样式（界面检查只按标题定位这一行，没有断言边框），所以这次没加用例：删掉的是纯样式 class，typecheck / lint / 单测覆盖不到视觉结果，验证方式是跑完三项快速检查再加人工对截图（删掉后普通对话行与其它行一致，只有 `active` 行常驻 `bg-sel` 背景，非 `active` 行仅 hover 时有 `bg-sel/70` 淡背景）。
- 以后要在侧栏行上加「进程状态」这类提示时，不要画整行边框：行右边的时间、标题流光是既有位置，整行边框会和选中态混在一起。
