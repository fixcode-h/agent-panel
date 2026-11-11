# plugins：插件系统

- 状态：documented
- 职责：插件包的安装、删除、开关、参数，插件服务端和网页部分的加载，插件给 Agent 的 MCP 工具
- 源码：`server/plugins/`, `shared/plugins/`, `shared/builtin/plugin-content.ts`, `web/src/plugins/`
- 入口：`server/plugins/index.ts`
- 关键词：插件、插件市场、安装插件、删除插件、插件更新、升级插件、plugin.json、agent-plugins、Blender 插件、设计模式
- 更新：2026-11-10

## 职责

决定见 [ADR 0059](../../adr/0059-plugin-system.md)。插件是自包含的包，装在数据目录 `plugins/<id>/`；面板只通过清单和 SDK 认识插件，删掉插件面板照常工作。插件源码在插件仓库 fixcode-h/agent-plugins（默认的插件市场），第一个插件是 Blender（dsh-blender-plugin 的建模能力 + 模型设计）。

## 关键文件

| 文件                                                      | 做什么                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/plugins/types.ts`                                 | 清单 `PluginManifest`（zod）、参数声明、来源、`PLUGIN_API`                                                                                                                         |
| `shared/plugins/index.ts`                                 | 装着的插件和开着的插件（前后端共用），参数补默认值，工具显示名、技能说明的查找                                                                                                     |
| `shared/builtin/plugin-content.ts`                        | 打开时建角色和工作流（`addPluginContent`），关掉时算要删和要留的副本（`planPluginRemoval`），以前内置现在挪进插件的 key（`MOVED_TO_PLUGINS`）                                      |
| `server/plugins/store.ts`                                 | 读包、校验清单（格式、接口版本、和内置模板重名、保留 id）、写包（临时目录换入）、链接本机目录、删包                                                                                |
| `server/plugins/zip.ts`                                   | 读 zip（存储和 deflate，限单文件和总大小）                                                                                                                                         |
| `server/plugins/github.ts`                                | 读仓库的 `plugins.json`，下载 Release 附件或源码包                                                                                                                                 |
| `server/plugins/updates.ts`                               | 检查更新：从 GitHub 装的插件按仓库读一次 `plugins.json`（没有就读安装分支上的 `plugin.json`），和装着的版本比                                                                      |
| `shared/plugins/version.ts`                               | 插件版本比较（semver，含 `-alpha.1` 这类预发布段；面板自己的 `compareVersions` 只认 `-dev`，不能拿来比插件）                                                                       |
| `web/src/plugins/updates.ts`、`PluginUpdates.tsx`         | 「已安装」上方的检查更新（打开插件页自动查，十分钟内不重复）、卡片里的升级提示；升级走安装预览和确认                                                                               |
| `server/plugins/manager.ts`                               | 启动加载、开关和参数变化、删除、关着的插件的副本清理；核心数据的读写由 `server/index.ts` 交进来                                                                                    |
| `server/plugins/runtime.ts`                               | 服务端入口的启动和停止、每轮对话问插件要工具、插件状态                                                                                                                             |
| `server/plugins/mcp.ts`                                   | 插件 MCP 工具的协议（每轮一个令牌地址 `/api/plugins/mcp/<令牌>`）                                                                                                                  |
| `server/plugins/api.ts`                                   | `/api/plugins`：列表、市场、安装预览和确认、开关参数、删除、包里的静态文件、插件自己的接口                                                                                         |
| `server/plugins/sdk.ts`                                   | 服务端 SDK 类型（插件仓库有副本）                                                                                                                                                  |
| `web/src/plugins/sdk.ts`、`host.ts`                       | 网页 SDK 类型和交给插件的宿主（组件、数据钩子、接口）                                                                                                                              |
| `web/src/plugins/registry.ts`                             | 读插件列表、加载网页入口、设计模式和右栏页签的登记                                                                                                                                 |
| `web/src/plugins/PluginsSection.tsx`、`PluginCard.tsx`    | 设置 →「插件」：已安装、插件市场、其他安装方式、安装确认、关掉 / 删除确认                                                                                                          |
| `web/src/plugins/PluginParamsNav.tsx`、`PluginParams.tsx` | 设置 →「插件参数」：开着的插件各占一页（二级列表，页 id `pparam:<插件>`），按清单 settings 生成参数表单，带运行状态                                                                |
| `web/src/plugins/DesignPage.tsx`                          | 插件设计模式页 `#/pdesign/<模式>/<对话>`                                                                                                                                           |
| `web/src/plugins/file-viewers.ts`、`PluginFileDialog.tsx` | 插件的文件查看器（`WebPlugin.fileViewers`）：按扩展名认领文件，弹窗外壳和文件预览一样，内容交给插件画；入口在对话的文件标记（`FileRefLayer`）和文件浏览页（`ProjectFileExplorer`） |
| `web/src/plugins/PluginPage.tsx`                          | 插件整页 `#/plugin/<插件>/<页面>/<path>`（接口 2）；图标栏、手机抽屉里的入口在 `ActivityBar.tsx`、`Sidebar.tsx`                                                                    |
| `server/exec/plugin-run.ts`                               | 每轮对话问插件要工具（带项目、目录、模式），插件工具的确认卡片（`confirm`）                                                                                                        |
| `server/plugins/effects.ts`                               | 插件工具按声明（`McpTool.effect`，接口 3）记下改了哪些文件、验证通过没有，end_turn 时交给完成依据和验证门禁                                                                        |

## 数据流

- 启动：`ensureProjectWorkflows` 先 `initPlugins`（读包 → `setInstalledPlugins` → 按设置 `setEnabledPlugins` → 启动开着的插件的服务端入口），再装内置模板（开着的插件带的角色和工作流算内置），最后 `cleanupDisabledPlugins`。
- 安装：`POST /api/plugins/install/{github,zip,dir}` 下载、校验，返回预览和令牌；`POST /install/confirm` 写盘、重读，开着的插件补上新版本多出来的内容。
- 更新：`GET /api/plugins/updates` 只读不装，返回有新版本的插件和去哪儿装（`install`）；点「升级」用它调 `/install/github` 拿预览，确认后同安装。装好后 `loadPlugins` 按装着的版本去掉过期的提示。
- 开关、参数：`PUT /api/plugins/:id`。设置页整份保存（`PUT /settings`）不改 `plugins`，免得自动保存盖掉插件页的改动。
- 开关、参数：`PUT /api/plugins/:id`（开关在「插件」页，参数在「插件参数」页）。设置页整份保存（`PUT /settings`）不改 `plugins`，免得自动保存盖掉插件页的改动。
- 对话：`runner` 在 `def.mcp` 的 CLI 上调 `pluginRunTools`（`server/exec/plugin-run.ts` → `pluginToolsForRun`），插件按项目、模式返回 MCP 服务和提示，面板开令牌地址传给 CLI，这一轮结束关掉；插件工具调 `confirm` 时出请求卡片，这一轮结束还没回答的作废。
- 工具的作用（接口 3）：插件工具在解析层一律是「其他」，面板的守卫、完成依据、改动归属都按工具类别判断，所以工具要自己声明 `effect`。`edit` 的工具执行前由 `mcp.ts` 交 `targets(args)` 算出的路径给工具前守卫（`dispatch.ts` 的 `editGuard`：只读身份、Bug 先诊断、独立分支越界、凭据、用户钩子），结果里的 `changed` 记成这一轮的改动（`file-events` 同一条路，进改动卡片和归属）；`verify` 的结果 `verified` 进完成依据，通过的文件不再要求走项目的测试步骤，失败时验证门禁拒绝 end_turn。`changed` / `verified` 不交给 Agent。记录只在内存里，面板重启后进行中那一轮的插件改动不再补进完成依据。
- 文件：对话里的文件标记、文件浏览页点到开着的插件认领了扩展名的文件（UE 插件的 `.uasset`）时，`fileViewerFor` 找到查看器，`PluginFileDialog` 把完整路径、项目和对话 id 交给它；没有插件认领时照旧（面板能看的在面板里看，别的交给系统默认程序）。
- 网页：`App` 启动时 `loadPlugins`；开着的插件 import 包里的 web 入口（地址带安装时间），登记设计模式、整页和右栏页签；关掉、删除后从登记里撤下。整页声明了 `taskPlugin` 时，它管的对话不进 Agent 项目和 Chat 列表，从别的地址打开时转到那一页（`registry.ts` 的 `useOwnedByPlugin`、`ownedPage`）。

## 已知限制

- 在线演示不装插件（`demo-backend` 回空列表）。
- 插件样式由插件自己构建，类名必须带插件自己的前缀（Blender 是 `bl:`），不然插件的 `.flex-col` 排在面板之后会盖掉面板的 `md:flex-row`；面板换了主题变量名时插件样式会走样。
