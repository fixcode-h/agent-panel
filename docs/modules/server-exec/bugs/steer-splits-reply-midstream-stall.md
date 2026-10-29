# 插话把 Agent 正说的一句话劈成两半；输出到一半断流时一直「等待模型」

- 状态：已修复（`server/exec/steer-note.test.ts`、`server/exec/parsers.test.ts` 通过）
- 症状：执行中插话后，Agent 正在说的那句话前半句在用户消息上面、后半句跑到用户消息下面；之后模型输出半句就停住，页面一直停在「等待模型」，没有提醒，只能自己停下
- 入口：`server/exec/runner.ts` 的 `accepted`（插话收下）、`apply` 开头的 `cutAfter`、没有响应的检测（`heard` / `stallTimer`）；`server/exec/parsers.ts` 的 `claudeParser`
- 根因类型：插话收下就断开当前消息；没有响应的检测只看「交出后有没有开始输出」，开始输出后就不再计时
- 模块：`server-exec`（`server/exec/runner.ts`、`server/exec/parsers.ts`）
- 关键词：插话、steer、打断、一句话劈开、等待模型、卡住、断流、半句、第三方网关、input_json_delta

## 现象

对话「远端报错了，看看修复下」执行中（Claude Code + 第三方网关的模型），用户先后插了两句话：

1. Agent 正在输出「用户补充的「修复后合并」，用户的插话出现在它下面，下一条是「到主干」记下了……」。
2. 下一次回应只出了「用户提到的截图我先」半句，之后两分钟没有任何输出，页面一直是「等待模型」，用户点了停止。

## 根因

1. 没有延迟取插话的 CLI（Claude Code 的 stream-json）收下插话后，`accepted` 立刻把 `cur` 清掉，下一段正文增量就另起一条，排在刚 push 进去的用户消息后面。但 CLI 并没有打断模型，模型会把这段话说完，下一次请求才看到插话。
2. 没有响应的检测在交出一句话、工具结果、开始一次模型请求时开始计时，`heard()` 一有输出就把计时清零且不再计时。模型流到半句断了（进程还活着、没有 result、没有在跑的工具）时，检测不再计时，界面无声地挂着。Claude Code 的解析也没有把工具入参的流（`input_json_delta`）报出来，写大文件时同样没有输出事件。

## 修复

- 插话收下时只记 `cutAfter`：同一段正文、思考的增量接着写在原来那条，等到工具、新一次模型回应（Claude Code 的 `message_start` 现在报 `request_start`）、正文后又开始思考时再另起一条。Pi、Command Code 这类延迟取插话的仍按 `request_start` 断开。
- `heard()` 在这一轮还在跑（`working`）时从这次输出重新计时，`result` 时停表；到点写「输出到一半停了，N 秒没有新的内容」的警告（和「没有任何输出」同一套，再发一条消息会停掉它、接回会话重开）。
- Claude Code 的 `input_json_delta` 报成 `gen`，写工具入参算在输出。

## 防线

- `server/exec/steer-note.test.ts`：「插话收下时正说到一半……」。
- `server/exec/parsers.test.ts`：「Claude Code：出错的结果、Bash 的退出码；每次模型回应开头报 request_start，写工具入参算在输出」。
