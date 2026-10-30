---
paths: scripts/ui/**, scripts/ui-check.mjs
---

# 界面检查（scripts/ui-check.mjs）

漏翻、文案类的界面规则在 [ui.md](./ui.md)；e2e 和假 CLI 在 [e2e.md](./e2e.md)；提示条、过渡元素这类会自己消失的东西在 [ui-check-transient.md](./ui-check-transient.md)。

## 定位要 exact，等控件终态而不是等文案

- 规则：`getByRole('button', { name })` / `getByText` 默认子串匹配，页面上别处有这几个字就会被抢走（页内锚点、分组标题都可能）；要点真按钮就加 `exact: true`，改完数一遍命中数量确认。等「操作做完了」等可控件终态（按钮换成删除图标、`data-status` 变了、进度条消失），不等一句文案出现；另加一条「点击真落到了这个操作上」的断言，否则点错地方时只看到「等终态超时」，分不清没开始还是没跑完。
- 起因：「设置-本机生图-已下载」用 `name: '下载'`，第一个命中的是「下载和连接」的页内锚点，点它只滚了页，下载从没开始，单跑 100% 失败。
- 防线：`node scripts/ui-check.mjs 06`（去掉 `exact` 直接报「点击落到别处了」）。

## 提示（toast）会挡住右上角的按钮，点之前先等它退场

- 规则：右上角的提示和标题栏按钮（「任务进度」「对话进程」等）抢同一块位置，点这类按钮前先等提示全部退场（`[data-sonner-toast]` 数量**绝对归零**，不拿总数当基准），同时先把鼠标挪开——sonner 悬停在提示上会冻住 4 秒计时，只等不动手永远等不到。`closeAiWindow()`、删对话这类会弹提示的操作之后尤其要等。
- 规则：这个失败在本地常常不复现（单跑时前面几步够快，提示刚好在点击前到期；分片并行、机器慢一点就撞上）：看到 `subtree intercepts pointer events` 别怀疑定位或语言，就是提示挡着。
- 起因：出包 CI 的 `check / ui` 在 02 分片超时，前面是关掉「AI 排查」窗口（弹「AI 排查继续在后台进行」）。
- 防线：先跑分片脚本本身而不是总入口（总入口在分片成功时会丢掉子进程输出，探针打印不出来）。

## 分片按主题拆开时，收录规则和截图判定一起改

- 规则：太长的一片按主题拆成 `02` / `02b` / `02c`，各片从共享开场（`scripts/ui/task-page.mjs`）重建状态、互不依赖，断言条数拆前拆后一致（`grep -c 'await check('` 三片相加）。分片名带字母后缀时，收录正则和截图前缀正则都要认后缀——`npm run lint` 会检查每个分片都能被 `SHARD_FILE` 收录、截图前缀认得出（`scripts/rules-check.mjs` 第 14 条）。
- 规则：`p.evaluate` 的回调在页面里执行，读不到 Node 侧常量；`settle()` 的等待上限这类值当参数传，直接引用会 `ReferenceError`，而 `check()` 里的 `settle().catch()` 会把它吞成后面大面积断言失败。
- 规则：默认只在失败步骤截图时，判定用「自上次截图以来新增的错误数」，不能只看本条 `check` 期间新增的（console 错误是异步到的）。
- 起因：`02-task.mjs` 3908 行、124 条断言，整轮 168.5s 全被这一片卡住；拆成三片后 61s，截图 399→31 张、68→1.7MB。
- 防线：`node scripts/ui-check.mjs 02b`（单跑新分片）、`SHOTS=all node scripts/ui-check.mjs 02c`（看每一步的样子）。

## 按坐标拖动前把目标滚到可视区中间

- 规则：按坐标拖（`mouse.down` → `move` → `up`）之前用 `el.scrollIntoView({ block: 'center' })` 把目标滚到滚动区中间，不用 `scrollIntoViewIfNeeded`：后者只保证露出来，目标常贴着上下边，拖几格就进了组件的边缘自动滚动区，位移被多算一截。周视图打开时按「现在」定滚动位置，这类失败随跑检查的时刻时好时坏。
- 起因：56cca91 前后「计划拖动」先因 19:00 那一块在可视区外拖落空，补了 `scrollIntoViewIfNeeded` 后又因贴底触发自动滚动，拖两格变成晚两小时（CI 06:00 UTC 复现）。
- 防线：`node scripts/ui-check.mjs 08-misc`。
