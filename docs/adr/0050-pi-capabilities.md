# ADR 0050：Pi 能力扩充——项目信任、插件市场、Pi 自己的设置

状态：已接受（2026-11-04 用户给了能力扩充报告，要求核对、改掉不合理的地方后开发） · 2026-11-04

- 影响范围：`shared/cli-spec.ts`（`trust`、`packages.gallery`、`packages.npmRoot`、`packages.overlaps`、`configSettings`；第四期加 `rpc.commandsQuery`、`rpc.handled`、`packages.oneOff` / `gitRoot` / `changelog` / `resources` / `builtins` / `local`）、`shared/clis/pi.json`、`shared/schema.ts`（`Project.cliTrust`）、`server/exec/runner.ts`、`server/cli/packages.ts`、`server/cli/gallery.ts`（新增）、`server/cli/config-settings.ts`（新增）、`server/cli/trust-api.ts`（新增）、设置页 Pi 分页和项目设置的 CLI 分页
- 依据：Pi 1.5.0 安装包自带的 `docs/*.md`、`CHANGELOG.md` 和 `dist/` 源码；npm 搜索接口 2026-11-04 实测

## 背景

用户给了一份《Pi Agent 能力扩充设计报告》（2026-11-04），列了 9 项扩充、14 个设置参数和一个插件市场。逐条对过 Pi 1.5.0 的文档和源码，大部分属实，下面几处不合理，按核对结果改掉。

| 报告里的说法                                                                       | 核对结果                                                                                                                                                             | 改成                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 「跳过版本检查」`PI_SKIP_VERSION_CHECK=1` 默认开，每次启动少一次请求               | `checkForNewPiVersion` 只在交互模式（`modes/interactive`）里调用，RPC 模式根本不查；面板默认开着的「离线运行」也会顺手设上它（`main.js`）                            | 不做                                                                                         |
| `PI_CODEMODE_MAX_WORKERS` 可以调大，「面板常并行跑子对话」                         | 上限按 **一个 Pi 进程** 算（docs/codemode.md），面板每个对话、子对话各起一个 Pi 进程，互不占用                                                                       | 不做                                                                                         |
| 「不读 AGENTS.md」`--no-context-files`，避免面板放文档时重复                       | 面板不往提示词里放 AGENTS.md（`context.docsMode` 只用来估算上下文），打开后项目规则就没了                                                                            | 不做                                                                                         |
| B 类里写 `httpProxy`，「面板已有检测本机代理，可以一键写进去」                     | 面板的代理只管面板自己的请求；面板跑的 Pi 用 CLI 设置里的环境变量 `HTTPS_PROXY`（Pi 认，见 docs/environment-variables.md）。写进 `settings.json` 还会改到终端里的 Pi | 不做，设置页环境变量示例已经是代理                                                           |
| 插件市场：首次请求把 13341 个包全翻一遍（约 54 次请求），存进缓存                  | 每小时几十次请求、二十来 MB，绝大多数是没人用的包；npm 搜索默认就按热度排，前面几页已经覆盖 pi.dev 的排行                                                            | 只取热度前 1000 个（4 次请求）在本地排序；搜索框直接用 npm 搜索（关键词 + 搜索词，1 次请求） |
| 类型筛选（扩展 / Skill / 提示词 / 主题）对当前页逐个查 `package.json` 的 `pi` 字段 | 每翻一页 50 次请求；npm 关键词里的 `pi-extension` 等只有一部分包写                                                                                                   | 这期不做类型筛选，卡片只显示 npm 关键词里写明的类型                                          |
| 项目信任放进「项目设置」，提示条件是项目里有标记文件                               | 属实；Pi 还会读上级目录里的 `.agents/skills`                                                                                                                         | 标记文件在项目目录和上级目录里找                                                             |

报告第七节需要拍板的四项，按报告的倾向定：项目信任默认「跟随 Pi」只提示；B 类参数做；字段写成通用的，这期只给 Pi 配数据源；功能重复的插件只提示不隐藏。

## 决策

### 1. 项目信任（第一期）

- CLI 定义加 `trust`：`markers` 是 Pi 只在信任后才读的项目文件，`hint` 是提示文案。参数规则里用条件 `trust=approve` / `trust=deny`（Pi：`--approve` / `--no-approve`），不按 CLI 名字写分支。
- 项目加 `cliTrust`（CLI id → `approve` / `deny`，没写就是跟随 CLI 自己的决定）。项目设置里这个 CLI 的分页加一行三选一。
- 选了「跟随」、项目目录（或上级目录）里又有标记文件时，那一行下面写清楚「这个项目里有 Pi 的项目配置（列出找到的），Pi 在面板里默认不会加载」。
- 只在对话和工作流节点（`server/exec/runner.ts`）里带上，这些才在项目目录里跑；设置更改从下一次启动的进程生效，和其它 CLI 设置一样，不重开正在保活的进程。

### 2. 只影响面板调用的开关（第一期）

沿用 `options`（开关 → 环境变量）：

- 「长时间提示词缓存」`PI_CACHE_RETENTION=long`，默认关。
- 「关闭匿名统计」`PI_TELEMETRY=0`，默认关（跟随 Pi）。

### 3. 版本门槛提示（第一期）

`minVersionHints(def)` 从定义里收集带 `minVersion` 的功能（现在是钩子），本机版本低于门槛时，设置页 CLI 头部的版本行下面写一行「本机 1.4.0，钩子要 1.5.0 以上」，旁边已有的「更新」按钮照旧。

### 4. 插件市场（第二期）

- 定义：`packages.gallery = { npmKeyword, sourcePrefix, pageUrl }`，`packages.overlaps = [{ match, note }]`，`packages.npmRoot` 是 npm 包装到哪（读已装版本）。
- 服务端 `server/cli/gallery.ts`：`GET /api/clis/:id/gallery?q=&sort=&page=`。
  - 没有搜索词时取 npm 搜索的前 1000 个（`size=250`，4 页），缓存进数据目录 `cache/cli-gallery/<cli>.json`，1 小时有效；有搜索词时直接问 npm（`keywords:<关键词> <搜索词>`，250 个），再在本地按「每个词都出现在名称、描述、关键词或作者里」过滤（npm 按相关度排，但会带回关键词下不相关的热门包），按搜索词缓存 10 分钟。
  - 本地按月下载（默认）/ 周下载 / 最近发布 / 被依赖数 / 名称排，每页 50 个。
  - 联网失败用旧缓存，并照实返回「没能更新：原因」；没有旧缓存就报错。走面板的出网（`server/net.ts`），和 Pi 的「离线运行」无关。
- 卡片：名称、发布者、描述、月下载、发布时间、npm / 仓库链接、安装（已装显示「已安装」）。`overlaps` 命中的写一句和面板哪项功能重复；`flags.insecure`、没有仓库链接的标出来（npm 搜索结果里只有最近一次发布的时间，看不出首次发布，报告里的「7 天内才首次发布」不做）。
- 已装列表多显示当前版本，和 npm 的 `latest` 比，有新版本时标出来。
- 原来的「推荐」保留，市场是另一个页签。

### 5. 写进 Pi 自己配置文件的设置（第三期）

- 定义加 `configSettings`（`shared/cli/config-settings.ts`）：每项写 `file`、`at`（点分路径）、`type`（`boolean` / `number` / `choice`）、默认值和范围，`unit` / `scale` 让界面用秒、文件里写毫秒。改了马上写，不等设置页的「保存」。
- 设置页读文件里的当前值；没写过显示「跟随 Pi（默认值）」，只有用户改了才写，「恢复默认」删掉这个键，别的键原样保留。分组标题写明「写在 ~/.pi/agent/settings.json，终端里的 Pi 也会变」。
- Pi 这期放：自动重试开关和次数、请求空闲超时、Pi 自己的自动压缩开关（说明和面板「自动压缩」的关系）、缓存预热、codemode 呈现方式、不发图片、传输方式。

### 6. 第四期（2026-11-04 用户要求接着做）

- **「/」菜单里的插件命令**：定义里 `rpc.commandsQuery`，起一次 Pi（`--mode rpc --no-session`，带上项目的信任参数）问 `get_commands`，5 分钟缓存、装删插件后清掉（`server/cli/commands.ts`）。插件包里带的模板和 Skill 按返回的文件路径由面板照常展开；插件命令（`source: extension`）只有 Pi 能执行，这一轮原样只发这一句（`server/slash.ts` 的 `slashInput`）。Pi 自己处理掉、不开新一轮时回 `disposition: handled`，面板按 `rpc.handled` 等 3 秒没收到 `agent_start` 就结束这一轮；命令自己开了一轮（开始记录可能先到）就照常等它跑完（`server/exec/rpc/spec.ts`）。插话（`steer`）里 Pi 不认插件命令，仍按普通文字。
- **角色级插件**：`Agent.plugins` + 定义里 `packages.oneOff`（Pi：`-e {source}`），角色编辑页「运行」里选，执行时加参数、命令预览里看得到。第一次用到时 Pi 要下载，那一轮启动会慢，靠已有的「环境性卡住重试一次」兜底，界面上写明。
- **插件更新说明**：定义里 `packages.changelog`（读包里 `pi.changelogPath`，默认 `CHANGELOG.md`）、`packages.gitRoot`（git 来源的安装目录）。已装列表每行一个「更新说明」，单个包更新后版本变了自动展开新增的条目。说明文件只认包目录里面的。
- **资源开关、自带扩展、项目级插件**：`packages.resources`（按类型开关，写对象写法的空数组；不细到单个文件）、`packages.builtins`（`-builtin:<名字>`）、`packages.local`（`pi install -l --approve`，装进项目的 `.pi/settings.json`；项目配置没选「信任」时提示不会加载）。

### 7. 第五期（以后做）

P2 里的导出 HTML、刷新模型目录、实际应答模型、插话投递方式、MCP OAuth 提示，等前几期用起来再排。

## 放弃的做法

- **在桥接扩展里处理 `project_trust` 事件**：要改扩展模板，而且扩展本身在信任之前加载的时机不好保证；命令行参数更直接。
- **全量抓 npm 关键词下的包、或者抓 pi.dev 网页**：见背景表格。
- **把 Pi 的设置都改成单次运行的覆盖**：Pi 没有覆盖单个设置的参数，`PI_CODING_AGENT_DIR` 会连账号一起换掉。

## 后果

- 项目信任默认不变，用户不选就和现在一样；选了「信任」后项目里的扩展代码会在 Pi 里执行，项目设置那一行写明。
- 插件市场依赖 npm 搜索接口的字段（`downloads`、`dependents`、`flags`），接口变了只影响市场，装、删照旧走 `pi install`。
- 第三期会写用户全局的 Pi 配置；只写用户改过的键，恢复默认就删掉。
