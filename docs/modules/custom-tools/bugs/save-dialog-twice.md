# 保存工具的确认要点两次

- 状态：已修复（`server/ask-mcp.test.ts` 新增用例，去掉修复时失败、加上后通过）
- 症状：/createtool 生成工具后弹「保存工具」弹窗，点一次保存后入口还在，再打开弹窗确认一次才消失
- 入口：`server/ask-mcp.ts` 的长等待判断、`server/custom-tools/agent.ts` 的 `dispatch`
- 根因类型：等用户的工具没走 SSE 心跳，CLI 断开重试叠出第二张卡
- 模块：`custom-tools`（`server/custom-tools/agent.ts`），接线在 `server/ask-mcp.ts`、`server/panel-tools/registry.ts`
- 关键词：保存工具、custom_tool、action=save、/createtool、点两次、两张卡、LONG_TOOLS、SSE 心跳、waits、AbortSignal.any、HTTP 超时

## 现象

对话里出现「保存工具「Lua 增量编译」」的入口，用户在弹窗里点了保存，对话里记了「你确认了：保存工具「Lua 增量编译」」，但输入框上方的入口还在；再打开弹窗确认一次才没有。

## 根因

- `custom_tool` 的 save 要等用户在弹窗里点完才返回，但它不在 `server/ask-mcp.ts` 的 `LONG_TOOLS` 里，面板按普通工具回一次性 JSON，等待期间一个字节都不写。
- CLI 的 HTTP 客户端长时间收不到数据就断开（例如 undici 的 headersTimeout / bodyTimeout 默认 5 分钟，`ask_user` 早就因为这个走心跳），Agent 拿到失败后再调一次 save，面板又弹一张一样的保存弹窗。
- 第一张卡只跟着这一轮的 signal，CLI 断开不会收掉。用户点的是第一张（工具照样保存了），第二张还在等，所以要再确认一次；第二次确认还会再存一版。

## 修复

- `PanelTool` 加 `waits`，`custom_tool`、`ask_push`、`request_override`、`wait_agents` 标上；`ask-mcp.ts` 按注册表判断长等待，走 SSE 心跳。
- `custom-tools/agent.ts` 的 `dispatch` 把这次调用的 signal 并进卡片的 signal：CLI 断开或取消时保存弹窗、授权卡跟着收掉。
