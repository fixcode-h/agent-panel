---
paths: scripts/ui/**, scripts/ui-check.mjs
---

# 界面检查（scripts/ui-check.mjs）

漏翻、文案类的界面规则在 [ui.md](./ui.md)；e2e 和假 CLI 在 [testing.md](./testing.md)。

## 定位要 exact，等控件终态而不是等文案

- 规则：`getByRole('button', { name })` / `getByText` 默认子串匹配，页面上别处有这几个字就会被抢走（页内锚点、分组标题都可能）；要点真按钮就加 `exact: true`，改完数一遍命中数量确认。等「操作做完了」等可控件终态（按钮换成删除图标、`data-status` 变了、进度条消失），不等一句文案出现；另加一条「点击真落到了这个操作上」的断言，否则点错地方时只看到「等终态超时」，分不清没开始还是没跑完。
- 起因：「设置-本机生图-已下载」用 `name: '下载'`，第一个命中的是「下载和连接」的页内锚点，点它只滚了页，下载从没开始，单跑 100% 失败。
- 防线：`node scripts/ui-check.mjs 06`（去掉 `exact` 直接报「点击落到别处了」）。

## 提示（toast）会挡住右上角的按钮，点之前先等它退场

- 规则：右上角的提示和标题栏按钮（「任务进度」「对话进程」等）抢同一块位置，点这类按钮前先等提示全部退场（`[data-sonner-toast]` 数量**绝对归零**，不拿总数当基准），同时先把鼠标挪开——sonner 悬停在提示上会冻住 4 秒计时，只等不动手永远等不到。`closeAiWindow()`、删对话这类会弹提示的操作之后尤其要等。
- 规则：这个失败在本地常常不复现（单跑时前面几步够快，提示刚好在点击前到期；分片并行、机器慢一点就撞上）：看到 `subtree intercepts pointer events` 别怀疑定位或语言，就是提示挡着。
- 起因：出包 CI 的 `check / ui` 在 02 分片超时，前面是关掉「AI 排查」窗口（弹「AI 排查继续在后台进行」）。
- 防线：先跑分片脚本本身而不是总入口（总入口在分片成功时会丢掉子进程输出，探针打印不出来）。

## 退场 / 过渡元素不算数：等活着的条数和具体元素，量不到要降级

- 规则：数列表 / 提示条数时先排除正在退场的（sonner 是 `data-removed="true"`），拿 DOM 总数当基准会把它们算进去；判「关掉了一条」等句柄 `el.isConnected === false`；判「补位发生了」等存活条数回到期望值。重新造工况先清空、再一次性连发满额（各自到期时间接近），不拿剩余寿命各不相同的提示当背景。
- 规则：比「还是那几条」在页面里用 `p.evaluate` 传句柄比 DOM 节点，不要在 Node 侧用 `===` / `includes`（`elementHandles()` 每次返回新的包装对象，永远不相等）；条数相等也要确认身份，一条到期 + 一条新进也能凑满额。
- 规则：取快照不要在 Node 侧逐个句柄 evaluate（N 次 round-trip 会拉长判定链，到期窗口就在这段里），一次 `p.evaluate` 拿存活标记、再按同一索引挑句柄。
- 规则：页面里用 rAF 循环等条件时要同时给脚本侧硬超时（`Promise.race` + `setTimeout`）：页面不可见 / 主线程被长任务占住时 rAF 不回调、`page.evaluate` 又会一直挂着（它不吃 `setDefaultTimeout`），否则不是「等超时」而是整个分片挂死。
- 规则：只活几百毫秒的过渡面板（加载日志 `MIN_VISIBLE_MS` + `FADE_MS` 约 650ms）要用带超时的 `boundingBox({ timeout })` 量，量不到就 console 提一句跳过布局检查、靠 detached 断言覆盖「收起」；公共的 `shotOf()` 里的 `boundingBox` 也带短超时（`harness.mjs` 的 `SHOT_BOX_TIMEOUT_MS`），别让 Playwright 的 30 秒默认超时把整片拖成 `TimeoutError`。菜单按键前先等焦点进 `[role="menu"]`，等不到就关掉重开一次再等，不要对着一屏没焦点的地方盲按方向键。
- 规则：验证「补位」这种会跟自动到期抢目标的链路时，把鼠标悬停在提示上能冻住 4 秒计时（`expanded` 是页面级状态）；冻结点必须在**投递之前且中间不离开提示区**——右键点菜单、点别处都会让 `onMouseLeave` 恢复计时（实测先弹 1 条再 hover 补满，第 1 条仍在 4.0s 到期）。离不了提示区时把判定链缩短到远小于 TTL。
- 起因：「提示-补位」把正在播 200ms 退出动画的条算进基准而偶发失败；合并后全量 12 片并发跑时 `02-task` 两次失败点不同（方向键没走到别的子对话 / `[data-load-trace]` 的 `boundingBox` 超时），单跑该分片都通过。
- 防线：`node scripts/ui-check.mjs 10`（反向验证补位和名额上限）；`node scripts/ui-check.mjs 02-task` 单跑 + 全量 `node scripts/ui-check.mjs`（并发才复现）。

## 分片按主题拆开时，收录规则和截图判定一起改

- 规则：太长的一片按主题拆成 `02` / `02b` / `02c`，各片从共享开场（`scripts/ui/task-page.mjs`）重建状态、互不依赖，断言条数拆前拆后一致（`grep -c 'await check('` 三片相加）。分片名带字母后缀时，收录正则和截图前缀正则都要认后缀——`npm run lint` 会检查每个分片都能被 `SHARD_FILE` 收录、截图前缀认得出（`scripts/rules-check.mjs` 第 14 条）。
- 规则：`p.evaluate` 的回调在页面里执行，读不到 Node 侧常量；`settle()` 的等待上限这类值当参数传，直接引用会 `ReferenceError`，而 `check()` 里的 `settle().catch()` 会把它吞成后面大面积断言失败。
- 规则：默认只在失败步骤截图时，判定用「自上次截图以来新增的错误数」，不能只看本条 `check` 期间新增的（console 错误是异步到的）。
- 起因：`02-task.mjs` 3908 行、124 条断言，整轮 168.5s 全被这一片卡住；拆成三片后 61s，截图 399→31 张、68→1.7MB。
- 防线：`node scripts/ui-check.mjs 02b`（单跑新分片）、`SHOTS=all node scripts/ui-check.mjs 02c`（看每一步的样子）。
