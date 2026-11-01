---
paths: shared/clis/**, server/cli-packages.ts, web/src/components/settings/CliPackages.tsx, web/src/pages/SettingsPage.tsx
---

# CLI 自带的能力和插件

## CLI 自己有的能力直接用，没有的先找它的插件，不在面板里另做一套

- 规则：联网搜索、打开网页这类 CLI 自带的工具（Claude Code 的 `WebSearch` / `WebFetch`、Codex 的 `web_search`、Command Code 的 Web 工具）照常开着，面板不另做代理、设置页和注入扩展；CLI 没有的先找它自己的插件生态（Pi 的 `pi install`），写进定义的 `packages.recommended` 让用户一键安装。
- 起因：1193d03 给 Pi 做了一整套面板代发的 `web_search` / `web_fetch`（搜索源注册表、密钥、设置页、`-e` 注入的扩展），用户要求去掉，Pi 改成默认推荐联网搜索插件。
- 防线：`shared/cli-spec.test.ts`（Claude Code 不关 `WebSearch` / `WebFetch`；Pi 推荐的第一项是联网搜索插件）。

## 跑 CLI 的管理命令时，别带上会让它空转的开关环境变量

- 规则：装包、更新这类用户点的管理命令，先查设置开关带的环境变量会不会让它什么都不做；会的话在定义里（`packages.env`）盖掉，执行对话时照旧。
- 起因：Pi 的「离线运行」默认带 `PI_OFFLINE=1`，`pi update` 在离线模式下直接跳过、退出码 0，设置里点「更新」显示成功、包其实没动。
- 防线：`server/cli-packages.test.ts`。
