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
   - 整页管对话 `PluginPage.taskPlugin` 和 `host.ui.TaskComposer`（2026-11-10 补，只加不改，不升接口版本）：Blender 的模型设计从设计模式挪到图标栏的整页，新建不再选项目（对话 `projectId` 为空、`plugin = blender.model`，场景本来就在插件数据目录里）。`task.plugin` 等于某个整页 `taskPlugin` 的对话由那一页列出，Agent 项目和 Chat 列表都不列（`useOwnedByPlugin`）；按项目或聊天地址打开时转到 `#/plugin/<插件>/<页面>/<对话>`。整页里用面板的新建输入框（`TaskComposer standalone plugin`），旧面板没有时插件退回自己的文本框。
8. **插件接口 3（2026-11-11，为 UE 插件的验证）**：只加不改，接口 1、2 的插件照常加载。清单加 `hooks`、`testSteps`、`commands` 三段（格式在 `shared/plugins/contrib-schema.ts`），装进面板已有的三套机制：
   - 钩子：和用户钩子同一套输入输出，只挂 CLI 的四个事件。写了 `script` 用面板的 Node 跑包里的脚本，没写交给服务端入口新增的 `hook(id, input)`（插件进程里连着引擎、桥接，写入后编译用它）。插件打开就生效，设置 →「钩子」里可以单独关（开关记在 hooks.json 的 `builtins`，键 `plugin:<插件>:<钩子>`）；超时上限 10 分钟（用户钩子 60 秒），编译这类慢操作要用。
   - 测试步骤：字段同项目测试步骤（`TestStepShape`），`currentTestSteps` 接在项目步骤后面，按改动筛、谁来跑的规则不变。命令里的 `{config.<参数>}` 换成插件参数；`detect` 写项目根要有的文件（`*.uproject`），对不上的项目不加。项目设置里能按项目关某一条（`Project.pluginStepsOff`）。
   - 「/」命令：md 在包里，和「所有 Agent」的命令一样由面板展开，对所有 CLI 可用。
   - 三处都按「现在开着的插件」现取，不往钩子数据、项目设置、命令目录写副本，所以关掉、删除插件时不用另外撤，也不会留孤儿。
   - 放弃：把插件钩子写进 hooks.json 的用户钩子列表。那样关插件要去删、升级要去改，用户改过的副本和插件的新版本还会打架。
9. **插件接口 4（2026-11-11，为把 UI 设计拆成插件）**：只加不改，接口 1～3 的插件照常加载。设计稿：项目文件 `designs/设计模式拆成插件-设计稿.md`。
   - **开放模块**：插件可以直接 import 面板开放的一组模块，清单在 `shared/plugins/host-modules.json`（网页、服务端各一张），键是面板源码路径（不带扩展名）。面板加载插件前把这些模块挂到 `globalThis.__agentPanel.modules`（网页，`web/src/plugins/host-modules.ts`，按需 `import()`）和 `globalThis.__agentPanelServer.modules`（服务端，`server/plugins/host-modules.ts`）；插件仓库的构建脚本按清单把对应的 import 接到全局上，插件拿到的是面板正在用的同一份（数据、导航、提问、跑 CLI 的状态一致）。`server/plugins/host-modules.test.ts` 核对两张表和清单一致、文件都在。
   - 为什么改第 2 条的取舍：UI 设计约 3 万行，用到面板的对话壳、消息、输入框、附件、提问面板、跑 CLI、出图、提问会话等几十个模块，逐个包进 `host` 要重写一遍接口、插件代码也要大改。开放模块只开清单里的，清单就是契约：面板改名、挪走、改了导出的形状要同步清单和插件（不兼容时 `PLUGIN_API` 加一），不在清单里的照旧不给。
   - `DesignMode.Sidebar` / `Page` / `split`：设计模式自带侧栏和整页（`#/pdesign/<模式>/<id>/<sub>`），数据不是面板对话的设计（UI 设计自己的项目和界面）用它；`NewDialog` 变成可选。
   - `WebPlugin.barePages`：不带面板外壳的独立页 `#/pbare/<插件>/<页面>/<path>`，给无头浏览器截图用（`web/src/plugins/BareHost.tsx`）。
   - 放弃：把面板源码整份打进插件包。状态是两份（数据上下文、提示、提问会话各一套），插件的对话和面板的对不上。
   - 落地（2026-11-11）：UI 设计搬进插件仓库的 `ui-design`（插件 id `ui-design`，设计模式 id `ui`），面板删掉自带的设计代码；旧地址 `#/design/…` 转到 `#/pdesign/ui/…`，设计稿数据由插件第一次启用时从 `designs/` 搬到 `plugin-data/ui-design/designs/`。插件仓库里类型检查和单测从仓库根的 `.panel`（面板源码）取面板模块。

## 影响与风险

- 带代码的插件在面板进程里以用户权限运行，和 Agent 执行命令同级的信任；安装确认里写明，只建议装信任的来源。
- 插件 SDK 是面板对外的契约：改形状要同步插件仓库里的类型副本，不兼容时把 `PLUGIN_API` 加一，旧插件会被拒绝加载并提示升级。
- 网页入口在运行时 import，插件样式由插件自己构建（只出用到的工具类，颜色用面板主题变量）；面板升级换了主题变量名时插件样式会走样。插件的类名必须带自己的前缀（Blender 是 `bl:`）：插件样式表在面板之后加载，不带前缀的 `.flex-col` 会盖掉面板的 `md:flex-row`，打开插件后整个设置页的布局都乱了（试装时遇到过）。
- 在线演示不装插件，插件页显示空列表。
