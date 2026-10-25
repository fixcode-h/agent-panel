# 设置里找不到「网络代理」开关

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`、WSL 里的 `npm run test:e2e` 均通过；界面检查 `scripts/ui-check.mjs` 暂无覆盖设置页小节菜单的分片）
- 模块：`web`（`web/src/pages/SettingsPage.tsx` 的 `sectionsFor`、`web/src/components/settings/NetworkSection.tsx`），配套 `server`（`server/net.ts` 的 `configuredProxy` / `defaultPlan`）和 `shared/schema.ts` 的 `networkProxyEnabled`
- 关键词：设置、代理、网络代理、找不到、挪到连接分组、启用代理开关、`networkProxyEnabled`、`configuredProxy`、代理回退

## 现象

用户原话：「attachments/截图-212452.png 网页的代理开关那里去了，然后右边的设置页也分下类吧，给个小分类菜单」。

截图里的设置页：左栏一级分类是 通用 / 项目 / Agent 与 AI / 连接 / 生图 / 系统，右边「常规」是一整列设置项（单个步骤最长运行时间、没有输出时提醒、子对话没有输出时自动询问、自动回收闲置 Agent、离开对话后保留多久……），往下翻很远才有一行「网络代理」，而且只有一个地址输入框。用户按「代理开关」去找，既找不到开关，也不知道它埋在哪一节。

## 根因

- 「网络代理」这一行（`SettingsPage.tsx` 约 745 行）混在「常规」的长列表里，位置在一堆和出网无关的设置项中间；同类的事情（`授权`、`外部访问`）都在「连接」分组下，只有它留在「常规」。
- 那一行只有 `Input`（`DEFAULT_PROXY_URL` / `DEFAULT_PROXY_PORT` 做占位和探测默认值），没有开关：`Settings.proxy` 留空就等于不用代理，但界面上没有「用不用」这个可点的东西，用户找的是「开关」。
- 关不掉的后果不只是界面问题：`server/net.ts` 的 `defaultPlan` 直接读 `settings.proxy`，想让面板这次不用代理只能把地址删掉，删掉又得记着原来填的是什么。

## 修复

- `sectionsFor` 里新增一节 `{ id: 'network', label: t('网络与代理'), icon: Network, group: t('连接') }`，排在「外部访问」后面，和「授权」「外部访问」同属「连接」分组；「常规」里原来那一行删掉。
- 新组件 `web/src/components/settings/NetworkSection.tsx`（写法参照 `RemoteSection.tsx`）：两个 `Row`，上面是「启用代理」`Switch`（`Settings.networkProxyEnabled`，默认 true），下面是「代理地址」`Input`（`Settings.proxy`）；开关关掉时输入框 `disabled`，说明文字按服务端的实际行为写（关掉只跳过这里填的地址，仍会走环境变量 `HTTPS_PROXY`，失败后照旧探测本机代理）。
- `shared/schema.ts` 加字段 `networkProxyEnabled: z.boolean().catch(true).default(true)`：加开关之前存下的老设置没有这个字段，按 true 读，升级后代理不会静默失效（`server/settings-migrate.test.ts` 覆盖）。
- `server/net.ts` 新增 `configuredProxy(settings)`：开关关着时返回空串，`defaultPlan` 改用它取「设置里实际生效的地址」，于是 `planFor` 落到「环境变量 → 直连」，失败后的 `localProxies` 自动探测不受影响。`planFor` 本身不看开关，传入的已经是过滤后的地址。
- `server/net.ts` 两处失败文案里的位置名称从「设置 · 常规 · 网络代理」改成「设置 · 网络与代理」，跟新分节对上。
- 在线演示（`VITE_DEMO`）里这一页和「外部访问」一样被 filter 掉，不显示。

## 防线

- `npm run typecheck`：漏翻检查会拦住新文案缺英文（`启用代理`、`代理地址`、说明文字、`网络与代理` 都在 `shared/locales/en/`）。
- `server/net.test.ts` 的「启用代理的开关」用例：开关关着时 `configuredProxy` 返回空串、`planFor` 因此走环境变量或直连，环境变量和自动探测照旧。
- `server/settings-migrate.test.ts` 的「没存过启用代理开关的老设置」用例：老数据读出来是已启用，填过的代理照旧生效。
- 界面检查（`scripts/ui-check.mjs`）目前没有专门的分片覆盖这一页的开关和置灰状态，以后加设置页分片时补。
