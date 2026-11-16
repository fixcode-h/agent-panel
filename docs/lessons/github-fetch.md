---
paths: server/plugins/**, web/src/plugins/**, server/update/**, web/src/lib/app-update.ts, web/src/components/settings/UpdateSection.tsx
---

# 拉 GitHub 的地方

## 拉 GitHub 只能由用户手动触发，打开页面只显示缓存

- 规则：插件市场、插件更新、版本更新、UEKit 插件目录这类读 GitHub 的地方，打开页面、定时器、缓存过期都不自动请求；只显示上次缓存（写明多久前），从没读过就提示点「刷新」/「检查更新」。安装、换仓库这类用户点的动作可以顺带读。设置里用户自己打开的「自动检查更新」开关（默认关）除外。
- 起因：插件页打开时缓存超过一小时就自动重读市场、自动查更新（market.ts 的 STALE_MS、updates.ts 的 auto），UE 插件页也按 1 小时 / 6 小时自动重读，用户要求全部改成手动（插件仓库 ccec0ef）。
- 防线：`server/plugins/market-cache.test.ts`（cacheOnly 不去 GitHub）；其余人工。
