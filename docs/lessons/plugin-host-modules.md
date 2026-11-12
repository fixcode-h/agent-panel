---
paths: shared/plugins/host-modules.json, server/image.ts, server/exec/invoke.ts, shared/assist.ts, shared/cli-spec.ts
---

# 插件开放模块的导出

## host-modules.json 里列的模块，导出就是插件的接口，不当「转手导出」删

- 规则：清理「拆走后照旧导出」的转出时，先查 `shared/plugins/host-modules.json`：列在里面的模块被插件仓库（fixcode-h/agent-plugins）直接 import，它的导出形状就是插件接口，转出也要留着，并在那几行写明是给插件的。
- 起因：65f4874 删了 `server/image.ts` 转出的 `crop`、`resize`、`Img` 等，UI 设计插件编不过，PR #284 的 CI `plugins` 检查红了。
- 防线：CI 的 `plugins` 检查（用当前面板代码跑插件仓库的类型检查和单测）。
