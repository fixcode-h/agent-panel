# ADR 0058：外部访问改成密码登录门，去掉 Cloudflare 隧道，加 Tailscale 和反向代理配置

状态：已接受（2026-11-07 用户定的，已实施） · 2026-11-07

## 背景

外部访问（2026-11-01，见 `docs/modules/server/network.md`）有四种方式：Cloudflare 临时地址、Cloudflare Tunnel、frp 一键配置云服务器、自建反向代理。外网一律靠访问令牌：用 `…/?token=<48 位十六进制>` 打开一次换 Cookie。问题：

- 别的设备必须先拿到带令牌的完整地址，没法手输一个口令登录；
- 令牌泄露只能删文件重生成，所有设备一起失效，看不到谁在用、也踢不掉单个设备；
- 输错没有限流和日志；
- 外网专用端口只听 127.0.0.1，局域网直连、自己做 HTTPS 都不行；
- Cloudflare 在国内经常连不上（代码里本来就提示「建议改用 frp」）。

用户要求参考开源项目 [dsh-web-guard](https://github.com/lvxianchao/dsh-web-guard)（MIT）重做。它是 DeepSeek Harness 的插件：另开一个端口，先用一个密码 + 可吊销的会话 Cookie 挡住所有请求，登录后再转发给只听回环的服务；它不做内网穿透，外网靠用户自己的公网 IP 或 Caddy / NPM。用户本机没有公网 IP，所以穿透要保留。

## 决策

- **外网一律走密码登录门**（`server/guard/`）：从外网专用端口进来的请求，没有会话就跳 `/login`（接口回 401 并带 `login`，页面据此跳转）。密码 scrypt 哈希，会话令牌服务端只存 SHA-256、滑动过期、落盘，按来源 IP 连续输错锁定，另有全局上限（经过 frp 时来源都是 127.0.0.1）。外网不再认访问令牌；本机主端口不变，仍按「访问令牌」开关走。
- **门在进程内，不再转发一次**：dsh-web-guard 要改写 Host / Origin 骗过 DSH 的回环检查；我们的外网端口和主端口是同一个 Hono 应用，请求带 `EXTERNAL_ENV` 标记，中间件直接拦，效果一样。
- **初始密码**：第一次打开外部访问时自动生成，明文存在数据目录的 `guard.json`（0600，和 `access-token` 同级），只在本机打开设置页时显示，改过密码后清空。托盘用户看不到终端，所以不能像 dsh-web-guard 那样只打一行日志。
- **方式只留三种**：frp（一键配置云服务器）、Tailscale（`tailscale serve`，可选 `funnel` 开到公网）、自建反向代理（可监听 `0.0.0.0` 直连，可填证书自己做 HTTPS）。老设置的 `quick` / `token` 读进来按 frp，`tunnelToken`、`command` 丢掉。cloudflared 的下载留给「授权外部工具」用（`server/cloudflared.ts`）。
- **反向代理给配置**：设置页按访问地址拼好 Caddy、Nginx Proxy Manager、nginx 的配置（`shared/remote.ts` 的 `proxySnippet`）：Host 原样转发、带 X-Forwarded-*、关缓冲（SSE）、放大上传上限。frp 方式下给的是装在云服务器上的配置（转到 frps 开的面板端口）。
- **frp 连接测试**：按「配置 → 本机外网端口 → 云服务器 frp 端口 → frpc → 经云服务器打开面板」逐段试，断在哪一段停在哪，按错误原因给提示（`server/frp-test.ts`）。最后一段请求面板自己的 `/api/remote/guard/session`，回的不是面板就说明端口被别的程序占着。
- 主端口只认本机 Host：以前 custom / token 方式允许用访问地址直接打到主端口，现在外网只能走外网专用端口。

## 不做

- 不做多用户、不分权限：和 dsh-web-guard 一样一个密码一个权限级别，登录进来就能在这台电脑上跑 CLI。
- 不往页面注入脚本探测掉线：面板自己的接口层收到带 `login` 的 401 就跳登录页。
- 不碰用户自己的 `tailscale serve` 配置：只开、关面板用的那个 https 端口，不 reset。

## 后果

- 升级后外网设备上旧的令牌 Cookie 不再有效，要用访问密码登录一次；本机不受影响。
- 用 Cloudflare 隧道的用户升级后外部访问会报「还没配置云服务器」，需要换成 frp、Tailscale 或反向代理。
- 设置里 `remoteAccess` 多了 `listenHost`、`tlsCert`、`tlsKey`、`sessionDays`、`maxAttempts`、`lockMinutes`、`tailscale`。
