# 开了代理，自动更新下载还是很慢

- 状态：已修复（`server/net.test.ts`、`server/download.test.ts` 通过）
- 症状：设置页自动更新下载 GitHub 上的包（约 34 MB）时，本机开着 Clash / v2rayN 的系统代理，进度仍长时间停在 0.5 MB 左右
- 入口：`server/net.ts` 的 `defaultPlan` / `planFor`；`server/download.ts` 的 `downloadFile`
- 根因类型：系统代理只在直连失败后才用，而直连被限速时并不失败；固定 16 MB 分片让小文件用不满并发
- 模块：`server`
- 关键词：更新下载慢、系统代理、直连限速、planFor、systemProxies、分片、autoChunk、release-assets

## 现象

用户报：「目前开启了代理下载都很慢」，截图是设置 · 版本更新，v0.28.2481 下载中 0.5 MB / 34.1 MB。

## 根因

1. `planFor` 的出网优先级是「设置里的代理 → 环境变量 → 直连」，系统代理（Windows 注册表 / macOS scutil）只在第一次尝试失败后的回退里才读。
2. 大多数人开代理软件只是打开「系统代理」，设置里没填、也没有 `HTTPS_PROXY`，于是更新下载先走直连。
3. 国内直连 `github.com` → `release-assets.githubusercontent.com` 往往能连上、能拿到响应头，只是被限速到很低；请求没有失败，分片的空闲超时（45 秒没数据）也不会触发，所以永远不会换到代理，整个下载都在龟速的直连上。
4. 叠加：分片固定 16 MB，34 MB 的包只有 3 片，8 条并发连接实际只用上 3 条。

## 修复

- `planFor` 加系统代理一档，放在直连前面：设置 → 环境变量 → 系统代理 → 直连。`defaultPlan` 只在设置和环境变量都没有时读系统代理（有 60 秒缓存）。系统代理连不上时照常探测回退、最后直连，报错里按「本机代理」显示。
- `downloadFile` 没指定片大小时用 `autoChunk`：至少切成连接数片，每片 1–16 MB。

## 防线

- `server/net.test.ts`：「设置和环境变量都没有、系统开着代理：先走系统代理，不先直连」「系统代理连不上：回退到探测到的本机代理和直连」。
- `server/download.test.ts`：「没指定片大小：按连接数切开」。
