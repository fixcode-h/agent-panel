# ADR 0059：插件系统——插件是自包含的包，从插件仓库安装，删掉不影响面板

状态：已接受（2026-11-09 用户定的，已实施） · 2026-11-09

## 背景

面板里有一组只有少数人用的能力：Blender 建模（两个技能、「Blender 建模」角色、「Blender 建模与动画」工作流、模型设计页和 3D 预览，ADR 0025）。用户要求：

- 把它们从核心里拿出来，做成默认不启用的插件；
- 一比一接入 dsh-blender-plugin（https://github.com/sixtysevenlf/dsh-blender-plugin ）的建模能力（6 个模型工具、228 个算子、Gateway、Blender 扩展）；
- 插件有参数，统一放在设置里的一个页面；
- 插件能删除，能从压缩包、GitHub 安装，删除要做到「完全删除不会有影响」；
- 插件都放在 fixcode-h/agent-plugins 仓库，默认从这里获取。

## 决策

1. **插件是自包含的包，装在数据目录 `plugins/<id>/`**。包里有 `plugin.json`（清单：名字、版本、参数声明、技能说明、角色、工作流、MCP 服务名、工具显示名、入口），可选的 `server/`（服务端入口）、`web/`（网页入口和样式）、`skills/`、`locales/en.json` 和其他资源。插件自己的数据在 `plugin-data/<id>/`，开关和参数在设置的 `plugins[id]`。
   - 放弃：插件代码编进面板，只做开关。用户要能删掉、能从别处装，编进去的代码删不掉。
2. **核心只认插件 SDK，不按插件 id 写分支**。服务端 SDK（`server/plugins/sdk.ts`）：`activate(ctx)` 返回 `fetch`（挂在 `/api/plugins/<id>/api/`）、`tools(run)`（按这一轮对话决定挂哪些 MCP 工具，面板统一处理协议和令牌）、`onConfig`、`status`、`stop`。网页 SDK（`web/src/plugins/sdk.ts`）：`activate(host)` 返回设计模式（侧栏下拉里的一类设计，对话按 `task.plugin` 归它）、对话右栏页签、插件页上的状态面板。`host` 只开放登记过的面板组件和数据钩子；React 用面板那一份（插件构建时把 react 系的 import 换成 `globalThis.__agentPanel`）。
   - 放弃：插件直接 import 面板源码。面板内部一重构插件就坏，第三方插件也拿不到源码。
3. **插件从仓库安装，默认市场是 fixcode-h/agent-plugins**。仓库根的 `plugins.json` 列出插件和下载方式（Release 附件或仓库子目录）；没有它的仓库当作一个插件。另外可以上传 zip、链接本机目录（开发用）。安装先预览：服务端下载、校验清单（格式、接口版本、和内置模板的 key 撞没撞），弹窗写明来源、版本、会不会在本机运行代码，用户确认后才写盘。
4. **开、关、删的内容规则**沿用内置模板的来源 `builtin:<key>`：打开时按「添加内置工作流」建出角色和工作流；关掉、删除时没改过、没人用的副本删掉（先备份到 `backup/removed-plugin-content-*.json`），改过的、项目或分类在用的留下并告诉用户；技能删掉和自带一致的副本。删除再删包目录、插件数据和设置里的参数。
5. **完全删除不影响面板**：插件的接口、工具、页面都在包里；对话上的 `task.plugin` 在插件不在时当普通对话显示；以前内置、现在挪进插件的模板（`MOVED_TO_PLUGINS`）在插件没装或关着时按第 4 条清理；旧的 `Settings.blender.path` 迁成 `plugins.blender.config.blenderPath`，旧的 `Task.modelDesign` 读成 `blender.model`。
6. **Blender 整体挪进插件仓库**：dsh-blender-plugin 的副本（运行时、宿主层、Blender 扩展、blender-modeling 技能）、面板原有的两个技能、角色和工作流、模型设计（后台 Blender、`blender_python` / `blender_scene`、3D 预览）都在 agent-plugins 的 `blender/` 里，构建成一个插件包发到 Release。

7. **插件接口 2（2026-11-10，为 UE 插件）**：只加不改，接口 1 的插件照常加载。
   - 网页 `WebPlugin.pages`：插件自己的整页，宽屏在图标栏通用功能下面另起一组，手机在抽屉菜单里，地址 `#/plugin/<插件>/<页面>/<path>`（`host.hooks.usePluginRoute` 读写 path）。
   - 服务端 `PluginRun.projectId / cwd / mode`：按项目挂工具的插件据此决定挂不挂、连哪个项目。
   - `McpCallContext.confirm`：插件工具请用户确认，对话里出「允许 / 拒绝」卡片（复用面板请求卡片），停止对话或这一轮结束按拒绝返回。
   - 放弃：给插件整页单开一个模式（和 Agent / Chat / 设计并列）。插件页是工具页，不属于哪个模式，和角色、工作流页同级。
   - 网页 `host.hooks.useToChat`（2026-11-10 补，只加不改，不升接口版本）：把一段文字接进某个对话（或项目新建对话）的输入框草稿再打开它，不直接发送。插件按有没有这个钩子决定显不显示「发给对话」，旧面板上不显示。

## 影响与风险

- 带代码的插件在面板进程里以用户权限运行，和 Agent 执行命令同级的信任；安装确认里写明，只建议装信任的来源。
- 插件 SDK 是面板对外的契约：改形状要同步插件仓库里的类型副本，不兼容时把 `PLUGIN_API` 加一，旧插件会被拒绝加载并提示升级。
- 网页入口在运行时 import，插件样式由插件自己构建（只出用到的工具类，颜色用面板主题变量）；面板升级换了主题变量名时插件样式会走样。插件的类名必须带自己的前缀（Blender 是 `bl:`）：插件样式表在面板之后加载，不带前缀的 `.flex-col` 会盖掉面板的 `md:flex-row`，打开插件后整个设置页的布局都乱了（试装时遇到过）。
- 在线演示不装插件，插件页显示空列表。
