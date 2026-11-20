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
2. **核心只认插件 SDK，不按插件 id 写分支**。服务端 SDK（`server/plugins/sdk.ts`）：`activate(ctx)` 返回 `fetch`（挂在 `/api/plugins/<id>/api/`）、`tools(run)`（按这一轮对话决定挂哪些 MCP 工具，面板统一处理协议和令牌）、`onConfig`、`status`、`stop`。网页 SDK（`web/src/plugins/sdk.ts`）：`activate(host)` 返回图标栏里的整页、对话右栏页签、插件页上的状态面板（设计模式在接口 5 去掉了，见第 10 条）。`host` 只开放登记过的面板组件和数据钩子；React 用面板那一份（插件构建时把 react 系的 import 换成 `globalThis.__agentPanel`）。
   - 放弃：插件直接 import 面板源码。面板内部一重构插件就坏，第三方插件也拿不到源码。
3. **插件从仓库安装，默认市场是 fixcode-h/agent-plugins**。仓库根的 `plugins.json` 列出插件和下载方式（Release 附件或仓库子目录）；没有它的仓库当作一个插件。另外可以上传 zip、链接本机目录（开发用）。安装先预览：服务端下载、校验清单（格式、接口版本、和内置模板的 key 撞没撞），弹窗写明来源、版本、会不会在本机运行代码，用户确认后才写盘。
4. **开、关、删的内容规则**沿用内置模板的来源 `builtin:<key>`：打开时按「添加内置工作流」建出角色和工作流；关掉、删除时没改过、没人用的副本删掉（先备份到 `backup/removed-plugin-content-*.json`），改过的、项目或分类在用的留下并告诉用户；技能删掉和自带一致的副本。删除再删包目录、插件数据和设置里的参数。
5. **完全删除不影响面板**：插件的接口、工具、页面都在包里；对话上的 `task.plugin` 在插件不在时当普通对话显示；以前内置、现在挪进插件的模板（`MOVED_TO_PLUGINS`）在插件没装或关着时按第 4 条清理；旧的 `Settings.blender.path` 迁成 `plugins.blender.config.blenderPath`，旧的 `Task.modelDesign` 由数据迁移 0009 转成 `plugin: 'blender.model'`。
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
10. **插件接口 5（2026-11-11，去掉设计模式）**：用户要侧栏顶上的模式切换只留 Agent、Chat，UI 设计像模型设计那样做成图标栏的入口。设计模式只剩 UI 设计一家在用，留着它就要多维护一套侧栏下拉和 `#/pdesign` 路由，所以整个去掉：`WebPlugin.designModes`、`DesignMode`、`#/pdesign` 都没了，设计类插件一律用整页（`PluginPage`）。为此整页加两样：`split(path)`（这个位置自己分块，面板不套卡片，插件自己画左边的列表）和带 `/` 的子位置（`#/plugin/<插件>/<页面>/<a>/<b>`，`parseHash` 把第三段以后整个交给插件）。`designModes` 不再读，只用它的旧插件（ui-design 1.0.0）在新面板上看不到入口，所以升了接口版本，ui-design 1.1.0 声明 `api: 5`，旧面板装它会提示先升级面板。旧地址 `#/design/…`、`#/pdesign/ui/…` 都转到 `#/plugin/ui-design/ui/…`。
11. **插件接口 6（2026-11-12，视频截帧拆成插件）**：用户要把视频截帧从面板核心搬成插件（ComfyUI 留在面板）。视频功能和面板缠在两处，各加一个扩展点：输入框附件——`WebPlugin.attachmentIntakes` 让插件按扩展名 / MIME 认领拖进输入框的文件，卡片只引用原路径，点开插件自己的弹窗选好要发的（帧图片），发送时卡片原位换成这些附件（面板只按 `intake` / `picks` 两个通用字段走，不认视频）；给 Agent 的截帧工具——改成插件 `tools()`，原来只在「用户在聊的对话」里给（父对话、子对话、Chat，不给派出的子任务），`PluginRun.mode` 分不出来，所以加 `PluginRun.conversation`，和面板自己的操控软件工具同一个条件。插件要用的面板模块补进开放清单：`server/download.ts`（下载 FFmpeg）、`server/task-files.ts`（帧写进对话目录）、`shared/composer.ts`、`web/src/components/ui/lightbox.tsx`。在线演示不装插件，所以演示里没有视频截帧（用户已接受）。

12. **插件接口 6 续（2026-11-12，表格拆成插件）**：表格（游戏配置表）也搬成插件，它和面板缠的地方比视频多，同在接口 6 里再加三个扩展点：面板动作——`ServerPlugin.actions` 进 `server/app-actions` 的同一张动作表（`createRegistry` 的 `extra` 每次现取开着的插件，名字不合规或和面板重名的不收），Agent 经 `app_actions` / `app_do` 照旧能按主键改格子；项目设置分页——`WebPlugin.projectSections` 在项目设置导航里加一项，设置存在 `project.plugins[<插件 id>]`（`shared/schema.ts`，面板不解析内容），跟项目设置一起点保存，插件删了数据照留；组件示例——`WebPlugin.specimens` 进设置 →「组件」，守住「共用组件都要在设置里看到和微调」的规则。表格的「AI 分析表格风格」不再占配置助手的 `kind`，开放 `web/src/lib/assist-conv.ts` 的 `runPromptInProject`，插件自己出提示词、自己解析回复。评审里 xlsx 的语义差异改由插件的 `textify` 给：`Textifier` 加可选的 `diff`（插件自己写两版的差异，表格按主键对齐、逐格比）和 `how`，文件参数多带 `project`（插件读项目自己的设置）。表格页要一直挂着（打开的表、没保存的改动、滚动位置切走后都留着，回来不重新读几千张表的目录），整页加 `PluginPage.keep`，`Page` 多收一个 `active`；表格页的快捷键组经开放的 `ShortcutsHelp` 的 `first` 传进去。项目上原来的 `project.tables` 由数据迁移 0005 挪进 `project.plugins.tables`；结构文件和保存前的备份还在原来的位置，插件照旧读那里。旧地址 `#/tables/<项目>` 转到 `#/plugin/tables/tables/<项目>`。在线演示不装插件，所以演示里也没有表格页了。

13. **插件接口 7（2026-11-12，插件推送通道）**：表格插件原来每 4 秒请求一次 `/stat` 看打开着的文件被外面改了没有，违反「前端要实时数据用推送，不加轮询」，而插件此前没有推送的路。新增推送通道：服务端 `PluginServerContext.pages`（`push(event, data, to?)`、`open(conn)`、`onClose(fn)`，`server/plugins/pages.ts`），网页 `host.events`（`on` / `useEvent` 订阅、`conn` / `onConnect` 拿连接 id，`web/src/plugins/events.ts`）。事件走已有的页面事件流 `/api/app/events`（一个页面只开一条连接），不另开 SSE；每条连接在 `hello` 里带一个 id，插件按它只推给登记过的页面，连接断了经 `onClose` 清掉登记，断线重连的页面在 `onConnect` 里拿新 id 重新登记。插件 id 由面板填，插件只能推给自己的网页部分；插件关掉时它登记的回调一起撤掉。表格插件用它把外部改动检测换成 `fs.watch`（盯所在目录，Excel / WPS 先写临时文件再改名的保存方式也认得出）加推送。

14. **插件接口 8（2026-11-13，设置 →「MCP」能力菜单，[ADR 0064](./0064-mcp-capability-catalog.md)）**：插件工具加 `guide`（作用、什么时候用 / 别用、分组，面板拼进交给 Agent 的说明）和设置页徽标用的 `confirms` / `irreversible`；面板动作加 `useWhen` / `avoidWhen`；`ServerPlugin.catalog()` 不开对话也能列出工具；`tools(run)` 不挂时可以返回 `{ skip: 原因 }`；`PluginRun.dryRun` 表示是设置页的自检，插件不起进程、不改数据；`PluginRunTools.servers[].summary` 作为 MCP 握手的 `instructions`。开放模块加 `shared/mcp-catalog/describe.ts`。

15. **分析报告扩展点（2026-11-14，接口号不变）**：表格插件的「AI 分析表格风格」用 `runPromptInProject` 开分析对话，结果只能回项目设置的「表格」页去勾选，分析窗口右侧没有功能面板（用户反馈「分析后右侧并没有功能面板应用分析结果到表格设置中」）。加可选的 `WebPlugin.reports`：插件登记代码块语言名（`lang`）、页签名字和 `Report` 组件，`findReport` 在 AI 分析对话里按语言名认出这条回复，`AnalysisPanel` 画插件的 `Report`（收 `task`、`messageId`、`text`），对话区经 `stripPluginReports` 去掉这个代码块。只加了可选项，旧插件不受影响；旧面板忽略它，所以插件要照旧留着别处的应用入口，接口号不加。

16. **插件接口 10（2026-11-15，插件之间的依赖）**：Comfy 页面搬成插件后，UI 设计插件里「打开 Comfy 页」要靠它，用户定「插件依赖就安装也需要安装依赖插件」。清单加 `requires`（`{ "<插件 id>": ">=最低版本" }`，只认下限：插件之间都经开放模块和面板接口打交道，没有「不能太新」的情况）。安装预览列出要一起装的依赖，市场里找不到、版本不够时预览就报错；确认时先装依赖（依赖的依赖一并装，绕成圈的只装一次），依赖装不上就停下、插件本身不装；装着但关着的依赖一起打开。一键更新走同一个确认，所以新版本要求更新的依赖时也会先升级依赖。依赖没满足的插件不加载，列在「出错」里写明缺什么（链上一环缺了，后面依赖它的连带不加载）。被依赖的插件删除、关掉前拦下，写明是谁在依赖。依赖从同一个市场仓库找，找不到再找默认市场；从压缩包、本机目录装的直接找默认市场。`shared/plugins/requires.ts`（按清单算）、`server/plugins/requires-install.ts`（下载和安装顺序）。

17. **插件接口 11（2026-11-15，声明式的运行时字段）**：为了把普通 GitHub 仓库包装成插件（设计稿「GitHub项目一键变插件与网页页签」第 5 节，包装器和来源分级见 ADR 0068），清单加 5 个可选字段，插件不写代码也能接进面板，用了任何一个都要写 `api: 11`。格式在 `shared/plugins/runtime-schema.ts`，值里能用占位符 `{config.<key>}`、`{port}`、`{dir}`、`{data}`（`shared/plugins/placeholders.ts`）。
    - `env`：给 Agent 的环境变量，`PATH` 只能写 `{ "prepend": [包里的目录] }`。注入点只有跑 CLI 时组环境变量那一处（`server/exec/launch-options.ts` → `server/plugins/declared-env.ts`），只在这个插件对这一轮生效时带（全局插件每轮带，按项目的只在打开了它的项目带，`project-gate.ts` 判断）；放在账号设置的变量前面，同名时账号设置的赢。凭据类（`*_API_KEY`、`*_AUTH_TOKEN`、`*_SECRET`、`GITHUB_TOKEN`……）和面板自己的变量（`AGENT_PANEL_*`、`ANTHROPIC_*`、`OPENAI_*`、`GIT_*`、`HOME`）直接拒装。
    - `mcp`：外部 MCP 服务，形状同 MCP 库条目。和 MCP 库的按项目条目一样每轮注入（`server/plugins/declared-mcp.ts`，用户库里同名的以用户的为准），关掉、删掉插件时没有要撤的；CLI 定义里没有 `mcpStore.inject` 的（Pi）退回全局写入（`declared-sync.ts`，记在 `config/plugin-mcp-fallback.json`，只删自己写的，不覆盖用户同名的），插件卡片上注明。
    - `services`：托管进程（`server/plugins/services.ts`，接口契约 `shared/api-contract/plugin-services.ts`）。端口只绑 127.0.0.1（`auto` 时面板分）、按 `health` 等起来、日志写 `plugin-data/<id>/logs/`、`on-open` 的空闲 `stopAfterIdleMin` 分钟停、插件关掉和面板退出时停；起不来原样报原因，不重试；环境变量用 `childEnv`，不带账号设置里的凭据。状态走插件推送通道（事件 `service`）。网页页签、沙箱源经 `serviceOrigin()` 拿地址（顺带记「有人在用」）。
    - `webPages`：声明式网页页面，`url` 是 `service:<进程>/…`、`file:<包里的路径>` 或外部网址，面板用网页页签的组件画；`scope` 同接口 9。
    - `wrap`：包装记录（上游仓库、固定的提交、怎么查更新、配方、类型、来源分级），给界面徽标和更新比对用。
18. **插件接口 12（2026-11-15，角色参数和每轮说明）**：Blender 建模要按用户选的模型风格给 Agent 约束（设计稿「Blender建模风格」）。`PluginRun.params` 是这一轮的角色参数（对话里选的、工作流节点上填的，和拼角色设定用的同一份），插件按自己角色声明的参数决定说明；`PluginRunTools.turnNote` 是续接的会话也带的说明（`hint` 只在新会话带），只在有新情况时给（例如用户刚在页面上换了风格），交没交过由插件自己记。开放模块加了风格选择和参考图组件（`web/src/components/ui/style-picker.tsx`、`style-thumb.tsx`）和风格约束拼说明（`shared/style/rules-text.ts`）。

19. **插件接口 13（2026-11-19，插件测试步骤带自己的脚本）**：UE 插件的「改了蓝图要编译通过」要按项目找引擎（`.uproject` 的 EngineAssociation、UE 页手填的引擎目录），用户同时有 5.4 和 5.8 的项目，第 8 条设想的「命令用 `{config.xxx}` 引用编辑器路径」是全局一个值，管不住；`.uproject` 的文件名每个项目也不一样，命令里写不死。所以插件测试步骤的命令里加两个占位符：`{dir}` 插件包目录、`{data}` 插件数据目录（和接口 11 声明式字段的同名占位符一个意思），插件可以带一个自己的 Node 脚本当步骤（`node "{dir}/bin/x.mjs" --data "{data}"`），脚本里按项目自己找引擎。目录只有服务端知道，由 `server/plugins/contrib.ts` 注入 `shared/plugins/contrib.ts` 的 `setPluginPaths`；网页上显示原样的 `{dir}`。旧面板不换这两个占位符、命令跑不起来，所以接口号加一，用到的插件写 `api: 13`，旧面板装它会提示先升级面板。

20. **插件接口 14（2026-11-19，对话类型分开）**：用户报子对话里没有 `ue_*` 工具。根因是项目里的对话、子对话和 Chat 页的对话都存 `task.mode = chat`，面板原样交给 `PluginRun.mode`，UE 插件按「Chat 页不挂」把所有项目对话都跳过了（设置 →「MCP」的自检交的是 `workflow`，所以一直显示能挂）。用户定「普通的 Chat 模式和 Agent 的对话类型要分开」：`TaskMode` 加 `agent`，项目里的对话和子对话存 `agent`，只有 Chat 页没有项目的对话存 `chat`（迁移 0012，新建、重建、导入都走 `shared/conv-mode.ts` 的 `convMode`）。Agent 下各种对话的类型也统一成一个分类 `convKind`（parent、child、bug、fix、analysis、plugin、chat、workflow、flow-run），从存盘字段推出来、不另存；`PluginRun.kind` 给插件。插件判断对话类型看 `kind`，旧面板没有这个字段时退回看 `mode` 和 `projectId`。
21. **插件接口 15（2026-11-20，插件拿项目的文档根）**：用户报 P4 项目的 UE 页 GM 一直提示「还没设置 Lua GM」，而扫描脚本早就让 AI 写过、存在项目文档里。根因是 UE 插件自己按「.uproject 所在目录的上一级有 ProjectDoc/docs 就用它」猜文档根，和面板的文档根对不上：P4 / SVN 项目各分支共用一个文档根（ADR 0052，可能在别的分支目录下，项目设置里还能改），UE 项目也常在面板项目的子目录里，换个分支或子目录插件就找不到。用户定「只需分析一次、存进项目 Docs、下次直接复用」。`PluginServerContext.projects.docRoot(projectId)` 返回面板算好的文档根（和「文档」角色、模块文档同一个，`server/module-map.ts` 的 `docRootOf`，项目里填的「文档根」参数也算上），插件要存团队共用的分析结果时用它，不再自己猜。方法是可选的，旧面板没有时插件退回自己的旧规则，所以插件清单不必写 `api: 15`。

## 影响与风险

- 带代码的插件在面板进程里以用户权限运行，和 Agent 执行命令同级的信任；安装确认里写明，只建议装信任的来源。
- 插件 SDK 是面板对外的契约：改形状要同步插件仓库里的类型副本，不兼容时把 `PLUGIN_API` 加一，旧插件会被拒绝加载并提示升级。
- 网页入口在运行时 import，插件样式由插件自己构建（只出用到的工具类，颜色用面板主题变量）；面板升级换了主题变量名时插件样式会走样。插件的类名必须带自己的前缀（Blender 是 `bl:`）：插件样式表在面板之后加载，不带前缀的 `.flex-col` 会盖掉面板的 `md:flex-row`，打开插件后整个设置页的布局都乱了（试装时遇到过）。
- 在线演示不装插件，插件页显示空列表。
