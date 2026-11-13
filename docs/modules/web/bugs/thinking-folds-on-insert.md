# 这一轮还在思考，插一句话进去思考过程就被折叠

- 状态：已修复（`web/src/lib/latest-turn.test.ts` 通过）
- 症状：Agent 正在输出思考过程时，用户再发一条消息（显示「已插进当前这一轮」），那段思考立刻收成「思考过程 Xs」一行，整轮回复也按做完折叠，实际还在接着输出
- 入口：`web/src/components/tasks/view/TaskMessages.tsx` 的 `ChatTurn` `live`；`web/src/lib/latest-turn.ts` 的 `liveTurnIndex`
- 根因类型：「这一轮在输出」按「最后一段」认，插进来的用户消息自成一段排在后面
- 模块：`web`（`web/src/lib/latest-turn.ts`、`web/src/components/tasks/TaskView.tsx`、`web/src/components/tasks/view/TaskMessages.tsx`）
- 关键词：思考过程、折叠、插话、已插进当前这一轮、steer、live、流式

## 根因

对话按段画：一轮回复是一段，用户消息各自一段。`ChatTurn` 的 `live` 原来是 `working && 是最后一段`。
用户在这一轮进行中插话，这条消息成了最后一段，前面那轮就被当成已经结束：`Thinking` 收起、`ChatReply` 按做完折叠。
和模型无关，Claude 和非 Claude（如 DeepSeek 的 Anthropic 接口）的思考流都会这样。

## 修复

`liveTurnIndex` 从尾部往前找：跳过仍属于这一轮的用户消息（交付状态是插进当前这一轮、这一轮结束后处理、发送中等，按 `deliveryStatus` 判断，不看文字），遇到的那一轮回复就是在输出的一轮；尾部是新起一轮或没送出去的消息时和以前一样不算。

## 防线

- `web/src/lib/latest-turn.test.ts`：「在输出的一轮」几条用例。
