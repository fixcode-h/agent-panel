---
paths: server/auth.ts, server/index.ts, server/ask-mcp.ts, server/orch-mcp.ts, server/guard/gate.ts, server/hosts.ts, server/remote.ts
---

# 服务端接口和访问控制

## 给 CLI 调的面板地址要穿过访问令牌，连不上要显示

- 规则：CLI 调的接口（`/api/mcp/*`）没有 Cookie，在 `tokenGuard` 放行、由接口自己核对地址里的随机令牌；桥接（Pi 扩展）连不上面板时报给面板显示，不能只写 stderr。
- 起因：打开「访问令牌」后 `/api/mcp/ask` 一律 401，Pi 一个面板工具都没有，只有模型自己说「没挂上」。
- 防线：`server/auth.test.ts`。

## 把外部程序的报错翻成提示时，按原因分，不按前缀分

- 规则：把 frpc、cloudflared 这类外部程序的日志翻成「该去查什么」的提示时，按错误原因细分（超时、拒绝连接、连上后被断开、本机服务连不上），不能见到同一个前缀（如 `connect to server error`）就套同一句；分不清的原因照原文显示，不猜。每种原因配一条日志样本进测试。
- 起因：8cb7330 把 `connect to server error: session shutdown`（端口已经通了、被对方断开）也提示成「去安全组放行端口」，用户放行后还是这句，排查方向全错。
- 防线：`server/remote.test.ts` 里 `frpcEvent` 的各类日志样本。

## 转发头按「前面是不是自己的反代」决定信不信，不按对端地址

- 规则：`X-Forwarded-For` 这类头只在外网端口前面确实是用户自建的反代（custom 方式）时才信，且取最后一跳；frp、SSH 隧道这类 TCP 直通在本机连进来，对端也是 127.0.0.1，头全由访问者自己写，一律不信。
- 起因：8a1503a 只看对端是不是回环就信转发头，frp 进来的人换着假 IP 就能绕开按来源的输错锁定。
- 防线：`server/guard/gate.test.ts`。
