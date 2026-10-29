---
paths: scripts/ui/10-toast.mjs, scripts/ui/harness.mjs, scripts/ui/02-task.mjs
---

# 界面检查：会自己消失的元素

## 退场 / 过渡元素不算数：等活着的条数和具体元素，量不到要降级

- 规则：数列表 / 提示条数时先排除正在退场的（sonner 是 `data-removed="true"`），拿 DOM 总数当基准会把它们算进去；判「关掉了一条」等句柄 `el.isConnected === false`；判「补位发生了」等存活条数回到期望值。重新造工况先清空、再一次性连发满额（各自到期时间接近），不拿剩余寿命各不相同的提示当背景。
- 规则：比「还是那几条」在页面里用 `p.evaluate` 传句柄比 DOM 节点，不要在 Node 侧用 `===` / `includes`（`elementHandles()` 每次返回新的包装对象，永远不相等）；条数相等也要确认身份，一条到期 + 一条新进也能凑满额。
- 规则：取快照不要在 Node 侧逐个句柄 evaluate（N 次 round-trip 会拉长判定链，到期窗口就在这段里），一次 `p.evaluate` 拿存活标记、再按同一索引挑句柄。
- 规则：页面里用 rAF 循环等条件时要同时给脚本侧硬超时（`Promise.race` + `setTimeout`）：页面不可见 / 主线程被长任务占住时 rAF 不回调、`page.evaluate` 又会一直挂着（它不吃 `setDefaultTimeout`），否则不是「等超时」而是整个分片挂死。
- 规则：只活几百毫秒的过渡面板（加载日志 `MIN_VISIBLE_MS` + `FADE_MS` 约 650ms）要用带超时的 `boundingBox({ timeout })` 量，量不到就 console 提一句跳过布局检查、靠 detached 断言覆盖「收起」；公共的 `shotOf()` 里的 `boundingBox` 也带短超时（`harness.mjs` 的 `SHOT_BOX_TIMEOUT_MS`），别让 Playwright 的 30 秒默认超时把整片拖成 `TimeoutError`。菜单按键前先等焦点进 `[role="menu"]`，等不到就关掉重开一次再等，不要对着一屏没焦点的地方盲按方向键。
- 规则：验证「补位」这种会跟自动到期抢目标的链路时，把鼠标悬停在提示上能冻住 4 秒计时（`expanded` 是页面级状态）；冻结点必须在**投递之前且中间不离开提示区**——右键点菜单、点别处都会让 `onMouseLeave` 恢复计时（实测先弹 1 条再 hover 补满，第 1 条仍在 4.0s 到期）。离不了提示区时把判定链缩短到远小于 TTL。
- 起因：「提示-补位」把正在播 200ms 退出动画的条算进基准而偶发失败；合并后全量 12 片并发跑时 `02-task` 两次失败点不同（方向键没走到别的子对话 / `[data-load-trace]` 的 `boundingBox` 超时），单跑该分片都通过。
- 防线：`node scripts/ui-check.mjs 10`（反向验证补位和名额上限）；`node scripts/ui-check.mjs 02-task` 单跑 + 全量 `node scripts/ui-check.mjs`（并发才复现）。
