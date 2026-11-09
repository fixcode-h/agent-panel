# Tailscale 没开启 Serve：外部访问一直转圈、状态显示未启用

- 状态：已修复（`server/tailscale.test.ts`「tailnet 没开 Serve……」通过）
- 症状：外部访问选 Tailscale，「重新连接」一直转圈、状态显示「未启用」；过一会儿变成出错，报 Serve is not enabled on your tailnet，链接点不了
- 入口：`server/tailscale.ts` 的 `tailscaleStart`；`server/remote.ts` 的 `startTailscale`
- 根因类型：外部命令等用户操作时阻塞，被当成普通命令按超时等
- 模块：`server`（`server/tailscale.ts`、`server/remote.ts`）、`web`（`web/src/components/settings/RemoteSection.tsx`）
- 关键词：Tailscale、serve、funnel、Serve is not enabled、转圈、重新连接、未启用、开启链接

## 现象

用户报：外部访问选 Tailscale，状态「未启用」，右边「正在重新连接…」一直转圈连不上；之后出错信息是 `tailscale serve 没有成功：Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=…`。

## 根因

1. tailnet 没开 Serve 时，`tailscale serve --bg` 打出开启链接后不退出，一直等用户去后台开好（tailscale 源码 `enableFeatureInteractive`，`ShouldWait` 为真时阻塞监听 IPN 总线）。面板用 `capture` 按 15 秒超时等它，等满被杀掉才报错。
2. 等的这段时间 `doApply` 已经把状态置成 `off`，`startTailscale` 没改成 `starting`，所以界面显示「未启用」、按钮一直转圈；再点、或改设置自动保存，又排队重来一遍，看起来一直转。
3. 出错原文里的链接是纯文字，点不了。

## 修复

- `tailscaleStart` 按行读输出，见到开启链接就回调 `onNeedEnable`、不再按 15 秒杀；命令在后台继续等，用户开好后它自己配完退出，状态转为已连接。换设置时用 `AbortSignal` 停掉。
- `startTailscale` 一开始就置 `starting`，见到链接就返回（「重新连接」不再转圈），链接放进状态 `enableUrl`；设置页显示「等你在 Tailscale 开启」和「去 Tailscale 开启 Serve / Funnel」按钮。
- 出错原文里的网址都做成可点的链接。
