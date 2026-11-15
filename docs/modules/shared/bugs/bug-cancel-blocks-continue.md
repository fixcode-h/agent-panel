# 诊断报告点了「不修了」，同一个对话里再让它继续就被拦住

- 状态：已修复（`shared/bug/diagnosis.test.ts`「不修了之后用户在同一个对话里让它接着查」通过）
- 症状：Bug 子对话的诊断报告上点了「不修了」，之后在这个对话里让 Agent 继续，交报告、改文件都被拒，说报告已关闭、要回父对话重新报，这个对话再也起不了新的报告
- 入口：`shared/bug/diagnosis.ts` 的 `submitOnce`、`diagnosisGate`，`shared/bug/phase.ts` 的 `editScope`，`server/hooks/guards.ts` 的 `bugDeny`
- 根因类型：按旧决定写死的关闭规则，没有给用户回头接着做留路
- 模块：`shared`（`shared/bug/`）
- 关键词：诊断报告、不修了、取消修复、cancelled、closedInfo、继续、重新打开、submit_diagnosis

## 现象

用户点「不修了」后又想接着找这个 Bug，在同一个子对话里说「继续」。Agent 调 `submit_diagnosis` 被拒（「这份诊断报告已经关闭：不能再交新一版……在父对话里重新报」），改文件被工具前钩子拦，收尾也被拦，对话卡在原地。

## 根因

2026-11-07 定的规则（ADR 0045「入口只在消息流、不修了就关闭」）：最新一版是 `cancelled` 时，`submitOnce` 无条件拒交，`editScope`、`diagnosisGate` 都返回同一句 `closedInfo`。这三处只看最后一版的状态，不管用户之后有没有在这个对话里开口，所以取消后这个对话永远起不了新报告。普通对话里就地查的 Bug 再发 /bug 也被 `server/tasks/routes/conversation/send.ts` 拒成「新开一个对话」。和 dev 84c8d2f（等确认时退出 / 停止后回到等确认）无关：那条只处理 `pending`，取消后的状态是清干净的。

## 修复

- 新增 `shared/bug/reopen.ts`：取消（有临时日志的从核对完算）之后用户在这个对话里亲口发过消息（不算 peer、面板推的），就算重新打开。只看有没有消息，不读文字。
- 重新打开后：`submitOnce` 放行，新一版照常按阶段算；`editScope`、`diagnosisGate` 在新报告交上来之前仍拦，说法换成「重新交报告」（`reopenInfo`）。
- 用户还没开口时 `closedInfo` 改成「现在不交，用户说要接着查时面板会重新打开」，不再让它叫用户回父对话。
- 取消确认框的说明、普通对话的 /bug 拦截、完整流程里普通对话那段一起改。

## 防线

- `shared/bug/diagnosis.test.ts`「不修了之后用户在同一个对话里让它接着查」。
- `server/hooks/guards.test.ts`「Bug 先诊断」里重新打开后的拦截说法。
