# server：本机 API、JSON 存储、项目和任务管理

- status: analyzed
- source_paths: `server/`
- entry: `server/index.ts`
- analyzed_at: 2026-10-25（本轮核对 `server/store.ts` 的写入/读取路径和 `server/task-store.ts` 的 `load()`，其余内容沿用 2026-10-24 的分析）

## 职责

- 本机 HTTP API：Hono + `@hono/node-server`，只监听 `127.0.0.1`（因为会启动本机 CLI、读写项目目录），同时提供前端静态文件。
- 数据存储：用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件，读写集中在 `server/store.ts`，任务单独存在 `server/task-store.ts`。
- 项目与任务：项目扫描和分类（配合 `shared/project-scan.ts`）、任务创建、排队、停止、续跑、任务快照（`server/tasks.ts`、`server/task-store.ts`）。
- 子对话分派（`server/tasks.ts` 的 `startChild`）：父对话通过 `create_conversation` 派出的子对话立即开始执行，没有子对话并发上限和排队；`startQueue` 只留作短暂的「启动中」标记。工作流节点、合并编译、后台命令等其他占位/排队不变。
- 设置的读取与默认值迁移（`server/settings.ts` 的 `getSettings`）：读到 `backgroundLimit` 正好是旧默认值 16 时改成 64 并写回 `settings.json`，用户显式设过其他值的不动；旧设置里的 `childConcurrency` 读到时忽略。后台命令的全局兜底上限在 `server/background.ts` 的 `MAX_RUNNING`（64）。
- 读一条后台命令的当前样子（`GET /tasks/:id/jobs/:jobId` → `server/background.ts` 的 `view(taskId, id)`，响应体是 `shared/schema.ts` 的 `TaskJobView`）：界面上点后台命令行标题打开的终端窗口按它轮询，命令的输出只在服务端内存的 `BgJob.lines`（`KEEP_LINES` 保留结尾 300 行），不进对话记录，所以必须单独有个读接口。返回 `state` / `code` / `output` / `createdAt` / `startedAt` / `endedAt` / `lastOutputAt`；`output` 是 `lines.join('\n')` 原文，不掺「跑完了」「退出码」这些面板的话（那是推回对话的 `jobOutput` / `resultText` 的事）。排队中、结束后都读得到（用户可能过一阵才点开，结束后要给最终输出和退出码）；归属按 `BgJob.taskId` 校验，跨对话读别人的编号一律当不存在返回 404，和 `/tasks/:id/processes` 只作用于自己子树是同一个口径。回归：`server/background.test.ts`（跑着能读到已输出内容、跑完读得到最终输出和退出码、跨 `taskId` 和不存在的编号读不到）、`server/task-job-view.test.ts`（路由层 404）。
- 进程与内存路由只作用于当前对话的子树：`/tasks/:id/processes`（列表和合计）、`/tasks/:id/processes/:pid/kill`、`/tasks/:id/processes/clean`、`/tasks/:id/processes/suggest`（AI 清理建议）、`/tasks/:id/memory`（内存曲线）都按 `subtreeIdsOf` 算出的「这个对话 + 它的全部后代」过滤（`shared/run-usage.ts` 的 `subtreeTaskIds`）。关闭进程和 AI 建议用同一集合校验 pid，清理只清子树里的登记残留，不会碰到列表外、属于祖先或兄弟对话的进程。合计只算子树的 CLI 进程：`totalMemory` / `MemoryPoint.total` = `cliMemory` / `cli`，面板自身内存走 `serverMemory` / `server`，不计入对话合计。
- CLI 相关：检测本机 CLI、读取模型列表、一键安装 / 更新 / 卸载（`server/detect.ts`、`server/models.ts`、`server/cli-packages.ts`、`server/install.ts`）。
- 面板能力给 Agent 用：进程内 MCP 工具，编排（`server/orch-mcp.ts`）、向用户提问（`server/ask-mcp.ts`）、UI 设计（`server/design-mcp.ts`）。
- 其他：附件和上传、文件系统接口、AI 创建 / 优化的提示词组装（`server/assist.ts`）、项目教训、导出、版本更新。
- Skills / 命令库（`server/library.ts`）：各 CLI 用户目录下的 Skill 和自定义命令的列表、读写、复制、删除；一个 Skill 目录里的多个文件（`SKILL.md` 以外的脚本、参考文档）走 `/library/entry` 的读 / 写 / 删 / 改名，见下面的「技能库的多文件管理」。
- 出网请求（`server/net.ts`）：面板访问 GitHub 的统一入口 `netFetch`，按「设置里的代理 → 环境变量 → 直连」出网，直连或配置的代理失败后自动改用本机正在运行的代理重试；版本更新和安装包下载都用它，见下面的「GitHub 出网与代理回退」。
- 项目更新时的字段保留与校验（`server/index.ts` 的 `parseProject`、`PUT /projects/:id`）：请求没带 `initResult` 时保留旧值（和 `lessons`、`initializedAt` 同一套做法），带上的用 `ProjectProposalSchema` 严格校验，不合法直接拒绝；初始化推荐因此随项目持久化，重开设置还能应用。初始化对话跑完交回结果走单独的 `PUT /projects/:id/init-result`（同文件）：服务端自己读最新项目，再用 `shared/project-init.ts` 的 `withInitResult` 只合并 `initResult` / `initializedAt`（时间取本次完成），不碰别的字段；结果要等对话跑几分钟才回来，整份 PUT 会把客户端手里过期的快照（用户这期间应用的推荐、改过的设置）写回旧值，见 [web 的 Bug 记录](../web/bugs/init-apply-overwritten-by-snapshot.md)。

## 入口

- `server/index.ts`：路由登记和启动；第一行先加载 `server/lang.ts` 定界面语言。
- `server/net.ts`：需要访问 GitHub 的请求的统一入口 `netFetch(url, init)`（`init` 是 `RequestInit` 加可选的 `timeoutMs` 和 `onAttempt`）；`timeoutMs` 只限制等到响应头的时间，之后读 body 不受影响，不传就一直等；`onAttempt` 在每次尝试（含回退到另一条路）前调用，供调用方重置自己的空闲计时。
- `server/exec/`：真实调用 CLI 的部分单独成模块，见 [server-exec](../server-exec/README.md)。

## 依赖

`shared/` 的数据结构和 CLI 定义、`hono`、`zod`、`cross-spawn`（Windows 上调用 npm 安装的 `.cmd`）、`undici`（`ProxyAgent` 和走代理的 `fetch`，只在 `server/net.ts` 用）。

## 数据落盘与损坏恢复

用户数据都是数据目录下的 JSON 文件，写入集中在 `server/store.ts` 的 `writeJsonAtomic`，任务记录和对话文件在 `server/task-store.ts`。断电、强制重启后「文件长度对得上、内容全是 `0x00`」是这里必须防住的失败模式（起因见 [bugs/restart-lost-conversations.md](bugs/restart-lost-conversations.md)）。

**写入路径**：`open(tmp)` → `writeFile` → **`fh.sync()`** → `close` → `rename(tmp, file)` → `fsyncDir(父目录)`。

- **每次写都 fsync 临时文件**，不能省：`rename` 是原子的，但它只保证「名字换代」，不保证数据已经在盘上。省掉 fsync 就会在断电后读到空洞文件。
- **fsync 失败就不 rename，直接抛错**：留着旧文件比换成一个可能全 0 的新文件安全。
- **rename 之后刷父目录**（`fsyncDir`）：Windows 上打不开目录句柄，`process.platform === 'win32'` 时直接跳过；其他平台打开或 fsync 失败也静默跳过（部分网络盘、容器挂载不支持）。目录项丢了最坏是回到上一个版本的文件，不会出现内容全 0 的文件。
- **性能**：消息文件前面有 `MSG_GAP`（400ms）合并窗口，流式输出时每秒最多几次写盘，fsync 的代价被摊掉；`compact` 参数只影响是否缩进，走同一条落盘路径。

**读取路径**：三种状态分开。

| 函数                                    | 返回                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `readJsonDetailed(file)`                | `{ state: 'missing' }` / `{ state: 'ok', value }` / `{ state: 'broken', broken: { file, backup, reason, size } }` |
| `readJson(file)`                        | 旧签名，返回 `readJsonDetailed().value`（坏文件和不存在都得到 `undefined`），老调用方不用改                       |
| `archiveBrokenFile(file, reason, size)` | 把文件挪进 `cache/broken/<原文件名>.broken-<时间戳>` 留档，返回同一份 `BrokenJson`（`archived` 说明真的挪走没有） |

留档约定：坏文件**只挪不改**，原始字节原样保留；旁边另写一份 `<backup>.broken.json` 说明（`file` 原路径、`backup` 备份路径、`reason` 原因、`size` 字节数、`at` 时间、`stamp`）。备份名已被占用时自动往后加序号（`-2`、`-3`…），同一毫秒里归档两次同名文件不会覆盖前一份。`archived: false` 表示文件被别的进程占着没挪动，它还在原位，下次启动会再处理一遍——日志会写明，不让调用方以为已经留档。除了 JSON 解析失败，「能读成 JSON 但内容用不了」的文件（任务记录、对话文件）也走 `archiveBrokenFile`，免得每次启动重读同一个用不了的文件。例外：`server/settings.ts` 的「JSON 能解析但字段不合法」分支仍是自己 `rename` 到 `cache/broken/`、不写 `.broken.json` 说明（那里只求不让每个接口都 500）。`cache/broken/` 是缓存目录，设置里清理缓存会一起删掉。

**任务记录丢失时的自动恢复**：`server/task-store.ts` 的 `load()` 在同一次扫描里同时收集 `<id>.json`（任务记录）和 `<id>.messages.json`（对话），对「有对话、但记录缺失或坏掉」的 id 调 `rebuildMeta()`。

- **什么时候重建**：对话文件能读出来、且 `TaskMessage.array().safeParse` 通过，反推出的记录也过 `Task.safeParse`。重建出的记录形态固定：`mode: 'chat'`、`status: 'stopped'`、`stopReason: 'restart'`、`simulated: false`、标题取用户第一句（没有用户消息时 `t('恢复的对话')`）、`createdAt` / `updatedAt` 取首尾消息的 `at`、`messages` 只放用户消息、`turnSeenAt` 取最后一条消息（不亮成未读）。写回磁盘后放进内存的 map，下次启动不用再重建。
- **什么时候只留档不重建**：对话文件本身坏了 / 全 0 / 能读成 JSON 但不是消息数组 / 是空数组，或者反推出的记录过不了 schema。这时不写任何任务记录（不伪造、不写半截），把用不了的文件归档并打出带 id 和字节数的日志。归档后下次启动看不到它，因此不会反复重试。空对话不重建一个 0 条消息的空任务（断电后可能出现「记录全 0 + 对话为 `[]`」）。
- **对话文件读不出来时不拖垮列表**：`rebuildMeta()` 的读取包在 try/catch 里，`EBUSY` / `EPERM` / `EACCES` 这类读错误只跳过这一个任务并打日志，下次启动再试；`all()` 里一次读失败会清掉 `loading`，下一次请求重新读，不让瞬时错误变成永久故障。
- **原记录没能留档时不覆盖**：`archiveBrokenFile` 返回 `archived: false`（文件被占用）时，重建只让任务本次可见、不写盘，原文件一个字节不动，下次启动再处理。日志也据此区分「已留档」和「没能挪进缓存目录」。
- **记录过不了 schema 时先留档再重建**：不直接覆盖原文件，原来那份（可能手修一下还能用）保留在 `cache/broken/` 里。
- **已有任务记录的 id 不会被重建覆盖**（用户自己改过的标题不能被盖掉）。重建写盘失败只打日志，本次启动仍然让它可见，下次启动再试。

**给以后改这块的人**：新增数据文件时用 `writeJsonAtomic`，别直接 `writeFile`；判断「数据不存在」之前先想清楚「文件坏了」和「文件没有」是不是一回事，需要区分就用 `readJsonDetailed`，不要拿 `readJson` 的 `undefined` 同时表示两种含义。

## 技能库的多文件管理

`server/library.ts` 除主文件（Skill 的 `SKILL.md`、命令的 `.md` / `.toml`）外，还能单独读写一个 Skill 目录里的附带文件。前端的文件树、编辑、改名、删除都走这里，契约在 `shared/library.ts`。

**数据结构**：`LibraryFile` 是 `{ content, files, tree? }`。`content` 是主文件内容；`files` 保持旧语义（`tree.entries` 里 `type === 'file'` 的 path 扁平列表，前端老代码照旧能用）；`tree` 是 `{ entries, truncated? }`，`entries` 是 `{ path, type: 'file' | 'dir', size? }` 的扁平列表——**目录和文件混在一张表里**，路径统一用 `/`，前端按 `/` 分段就能画出树。排序约定：**同一层目录在前、再按名字排**，并且用广度优先展开，所以父目录一定排在子项前面，截断时留下的也是浅层。命令（`kind: 'command'`）没有附带目录结构，`tree` 是 `undefined`、`files` 是 `[]`。

**接口**（都在 `libraryApi()` 里，错误统一 `400` + `{ error }` 文案）：

| 方法 | 路径 | 参数 | 返回 |
| --- | --- | --- | --- |
| GET | `/library/file` | `cli` / `kind` / `name` | `LibraryFile` |
| GET | `/library/entry` | `cli` / `kind` / `name` / `path` | `{ path, exists, binary?, content, size, mtime? }` |
| PUT | `/library/entry` | body：`cli` / `kind` / `name` / `path` / `content` | `{ path, bytes }` |
| DELETE | `/library/entry` | `cli` / `kind` / `name` / `path` | `{ path, deleted }` |
| POST | `/library/entry/rename` | body：`cli` / `kind` / `name` / `from` / `to` / `overwrite?` | `{ from, to }` |

路径都放在 query 和 body 里、不拼进 URL，所以 `..` 不会在路由层被 normalize 掉，全交给下面那道校验判断。读一个还不存在的文件不报错，返回 `exists: false`（新建前先看一眼很方便）。

**路径安全**（`shared/library.ts` 的 `libraryEntryPath` + `server/library.ts` 的 `entryOf`，两道关）：

1. 字符串层：`..`、`.`、空段、绝对路径、盘符（`C:`）、`\0` 和 Windows 非法字符（`< > : " | ? *`）一律拒绝；反斜杠统一当 `/`，末尾斜杠去掉。
2. 真实路径层：把路径拼到 `realpath(Skill 目录)` 上，再对「已存在的那一段」`realpath` 一次，确认它仍在 Skill 目录里（`insideDir`）。只靠第 1 道挡不住软链接——Skill 目录里放一个指向外面的目录链接，`link/secret.txt` 字符串上完全合法。找「已存在的那一段」用的是 **`lstat`**：`existsSync` 会跟随软链接，断链时报「不存在」而一路退到 Skill 目录本身，校验就放行了，真正写的时候 OS 会把链接解开、在目录外创建文件。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径。

**软链接**：Skill 目录本身是链接时，附件的读写落到**链接指向的真实目录**（`skillRootOf` 先 `realpath`），删文件不动原文件夹——和 `deleteLibrary` 只删链接的约定一致。

Skill 目录**里面**的软链接按「看得见、删得掉、改不了」处理，读、写、删、树四处口径一致：

- 树里标成 `type: 'link'`（不是 `file`，也不给 `size`），不跟进去（可能是链到外面的大目录）；`files` 只放普通文件，不含链接。
- 读接口返回 `{ exists: true, link: true, content: '', size: 0 }`——**不给内容**：链接的目标可能是目录、可能在 Skill 目录外，给一份前端改完又存不回去的正文只会让人困惑。
- 写接口拒绝，文案「这是个链接，不能直接改内容」（不是「路径不合法」，用户能据此知道该去改目标文件）。
- 删接口删的是链接本身，不动目标：链接（文件链接、目录链接、junction）统一走 `rm`——Node 的 `rm` 对链接只删链接本身、不跟进，而且 Windows 上删目录重解析点**不能**走 `unlink`（`DeleteFile` 会报 `EPERM`，必须让 rmdir 系来删）。

**路径校验只校验父目录**（`entryOf`）：把「最后一段的父目录」`realpath` 后要求仍在 Skill 目录内，拦住 `link/secret.txt` 这种穿过软链接目录的访问；最后一段本身是不是链接，交给各操作按 `lstat` 自己决定。最后一段也一起 `realpath` 的话，树里列出来的链接一读就报「路径不合法」，和上面那条口径打架。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径——否则一条断链的软链接就能让写入落到目录外。

**二进制与大小**：单个附带文件上限 `LIBRARY_FILE_MAX_BYTES`（1 MiB），读写超限都直接报错、不截断。报错文案按 `LIBRARY_FILE_MAX_KIB`（1024 KB）说，和前端「1.0 MB」的显示口径一致——用 1048 KB 会和 MB 那条自相矛盾。链接和目录的判断放在大小检查**之前**：一个超限的链接该说「这是个链接」，不该让人以为要去删内容。二进制靠「头部有 `\0` 字节」判定（和 `server/files.ts` 的 `readInDir` 一致）：大多数图片、压缩包、可执行文件都带 `\0`，比按扩展名白名单稳（无扩展名的文本不会误判），也不依赖 UTF-8 解码是否报错（非法 UTF-8 会被静默替换成 U+FFFD，判不出来）。命中时返回 `binary: true`、`content: ''`，**`size` 照常返回**（前端要显示「二进制文件，{kb} KB」）。误请求一个目录时返回 `size: 0`，不把目录的元数据大小（64 / 4096 这类）当成文件大小。

**文件树上限**：`LIBRARY_TREE_MAX_ENTRIES`（1000 项，**目录也算一项**），超过就截断并在 `tree.truncated` 标出来。排除规则分两张表：`LIBRARY_TREE_EXCLUDE_DIRS`（依赖和版本库目录：`node_modules`、`.git`、`.svn`、`__pycache__`、`.venv`、`venv`）**只对目录生效**，`LIBRARY_TREE_EXCLUDE_FILES`（`.DS_Store`、`Thumbs.db`）**只对文件生效**。不拿搜索用的 `DEFAULT_SEARCH_EXCLUDE`：那份清单的语义是「搜代码时跳过的噪音目录」，会把技能里真放内容、刚好叫 `logs` / `build` / `out` 的目录一起抹掉。主文件 `SKILL.md` 不进树（大小写无关判，`skill.md` 也算它），它单独用 `content` 返回。

**删目录与改名**：删目录是递归删，但先用 `countEntries` 数一遍，超过 `LIBRARY_DIR_MAX_DELETE_ENTRIES` 就拒绝（让用户先清掉里面的文件），数条目时不跟进软链接。改名默认 `overwrite: false`，目标已存在报「「{name}」已经有了」；目录不能并进已存在的目录（单独一条文案），也不许把目录移到它自己里面。覆盖时**不先删目标再 rename**：先把目标挪到 `.old-<pid>-<时间戳>` 留底，rename 成功再删留底，失败就把留底改回去，否则 rename / mkdir 任一步失败（Windows 上目标被占用很常见）旧内容就找不回来了；回滚本身也失败时，错误文案带上留底文件名，让用户能自己找回来。源和目标是不是同一个文件用 `sameFile` 判——比 `dev` + `ino`（真实文件身份），**不按字符串小写归一**：小写归一会把 Linux 上 `Notes.md → notes.md` 这种合法改名当成同一文件、返回成功却什么都没做。只差大小写的改名走「先改到临时名、再改到目标」两步，真把名字换掉，也不会在覆盖分支里删掉源文件；第二步失败时把名字改回去，回滚也失败就用「改名失败，原内容留在 {name}」把临时文件名告诉用户，不让文件「改名成功一半」。

**主文件保护**：`entryOf` 用 `rel.toLowerCase() === 'skill.md'` 判（主文件不许走附件接口），文件树也同样大小写无关——NTFS / APFS 不区分大小写，只比大写会让人用 `skill.md` 覆盖或删掉 `SKILL.md`。

**回归**：`server/library.test.ts`（文件树排序与截断、`files` 与 `tree` 一致、路径穿越各种写法、软链接越界与软链接 Skill 的读写落点、二进制识别、读写超限、增删改往返、目录删除上限、命令没有附件）、`server/project-skills.test.ts`（项目技能的 `files` / `tree` 两个字段一致）、`npm run test:e2e` 里「Skills / 命令库」那段（附件写读改删和路径穿越）。

## GitHub 出网与代理回退

Node 自带的 `fetch` 不走代理，国内常常连不上 GitHub。`server/net.ts` 把「用哪条路、失败了再试哪条」收在一处，调用方只管传 `timeoutMs` / `signal`。

**出网优先级**（`defaultPlan` → 纯函数 `planFor`）：

1. 设置里的 `proxy`（在「设置 · 网络与代理」），但先过 settings 的「启用代理」开关（`Settings.networkProxyEnabled`，默认 true，加开关之前的老设置按 true 处理，迁移见 `server/settings-migrate.test.ts`）：`server/net.ts` 的 `configuredProxy(settings)` 在开关关闭时返回空串，于是这一条等于没填，直接落到第 2 条环境变量、第 3 条直连。地址没写协议时用 `httpProxy` 补 `http://`，否则 `ProxyAgent` 解析不了；socks 这类不支持的地址照原样交给回退，由请求失败后的回退处理。本机代理自动探测（`localProxies`、`discover`）在第一次尝试失败后照旧执行，不受开关影响。
2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，此时 `NO_PROXY` 照常生效。
3. 直连。

本机地址（`127.0.0.1`、`localhost`、`[::1]`）永远直连，失败也不探测。`NO_PROXY` 只在走环境变量代理时参与判断：命中时直接直连、不进入回退；设置里填了 `proxy` 时以设置为准，不受 `NO_PROXY` 影响。

**失败后的回退**（`netFetchWith` + `attemptOrder`）：第一次尝试失败、且调用方没有中止自己的 signal 时，先探测本机代理，再把没试过的路试完：从直连起步时依次试探测到的本机代理；从配置的代理起步时依次试本机代理、最后再试直连。任何一条成功就返回它的响应，配置的代理也在回退链里，所以「配置了但连不上」不会直接判死。

**本机代理怎么找**（`localProxies`）：

- 系统代理：Windows 读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`reg query`，https 优先于 http，分号格式也认）；macOS 跑 `scutil --proxy`；Linux 没有统一读法，交给环境变量。解析函数是纯函数：`windowsProxy`、`parseWindowsProxy`、`parseScutilProxy`。
- 常见端口：顺序和取值只看 `shared/proxy.ts`（`LOCAL_PROXY_PORTS` 与默认端口 `DEFAULT_PROXY_PORT`），文档不重复枚举。按常见程度排依次是（不写具体数字）：Clash / mihomo 的混合端口、v2rayN 的默认入站、老版 v2rayN 的 http 入站、Clash 的 socks 口（历史兼容，探测大概率失败）、Clash Verge Rev 的混合端口、通用的 1080。探测时全部并发跑一遍，真正拿去请求时本地端口最多 `MAX_LOCAL_PROXIES`（3）个、系统代理不算在内，由 `pickLocalProxies` 按顺序挑，所以默认端口必须排在前几个，不会被 Clash 的端口挤掉。默认代理地址只在 `shared/proxy.ts` 定义一次（`rules-check` 会拦住别处再写的字面量）。
- 只认 http 代理：`undici` 的 `ProxyAgent` 只处理 http/https，socks5 地址传进去也用不了（`httpProxy` 会把非 http(s) 的筛掉，`probeProxy` 同样只认 http/https）。默认端口在不同客户端里可能是纯 socks（v2rayN 默认入站就是 `socks`，它的 mixed 入站在 10814）、也可能是 socks+http 的 mixed 同口，就看客户端怎么配的；是纯 socks 时探测会失败，按「没找到代理」回退直连，用户需要在设置里填 http 入站端口。
- 只连上端口不算数：`probeProxy` 向候选发 `CONNECT api.github.com:443`，返回 200 或 407（要认证）才算在运行的代理。所有候选并发探测，单个握手超时 `PROBE_TIMEOUT_MS`（1200ms），另有一条独立的硬超时兜底（连接阶段卡住时也会结束）；系统代理读取本身最多 2 秒，所以没代理时一次探测在几秒内结束。
- 一个都没探测到就保持直连失败，不会强行走代理。
- 缓存：探测到代理缓存 60 秒，没探测到缓存 30 秒（用户刚开代理软件也能较快用上），系统代理读取缓存 60 秒；某条代理请求失败会经 `markProxyBad` → `dropBadProxy` 从缓存里去掉，列表因此变空时把间隔改成「没找到」的 30 秒，代理软件关掉后能重新检测。

**超时与取消**：每次尝试单独计时（`attemptControl`），上一次因为 `timeoutMs` 超时了，下一次会重新计时；`timeoutMs` 只覆盖等响应头，body 由调用方自己管。调用方自己的 `signal` 被中止（主动取消，或用 `AbortSignal.timeout` 给自己的总预算用完）时不再换路径，把原因原样报出去；换路径只由每次尝试自己的 `timeoutMs` 触发。

**失败文案**（`failure` + `netError`）：保留原始原因（连接超时 / 无法解析域名 / 代理拒绝连接等）。最后一条失败的是直连时，附上原来的 `访问不了 GitHub 时，可以在「设置 · 网络与代理」里填写本机代理`；最后一条是代理时，先用 `当前使用代理 xxx，请确认代理能访问 GitHub`，再补一句同样的设置页提示。试过多条路时追加 `尝试过的路径：直连、本机代理 http://…`；探测过、但没有任何本机代理进入尝试列表时追加「没有发现运行中的本机代理。」。报错里的代理地址会去掉账号密码。

**谁在用**（都因此共用同一套回退）：

- `server/update.ts`：检查 releases（`GET /repos/.../releases`，`timeoutMs: 15_000`）和下载 `SHA256SUMS`（同样 15 秒）。
- `server/download.ts`：探测（`probe`）、单连接下载（`stream`）、分片下载（`fetchSpan`）都经过 `DownloadOptions.fetch`（默认就是 `netFetch`，测试可以替换），每处都带 `HEAD_TIMEOUT_MS`（20 秒）的响应头超时，这一段超时会换下一条路。下载中途「太久没收到数据」由 `watch` 计时（分片 45 秒、单连接 90 秒）；`netFetch` 每次换一条路重试前会调用 `init.onAttempt`，下载借此重置空闲计时，所以空闲预算只管单条路径，不会因为整轮回退把「body 卡住」的判定拉长。
- `server/update.ts` 和 `server/download.ts` 不再用 `AbortSignal.timeout`（触发一次后就永久处于中止状态，没法用同一条 signal 重试），改用 `netFetch` 的 `timeoutMs`；其它调用方（例如 `server/comfy-templates.ts`、`server/remote.ts`）仍可用自己的 signal，中止后按上面的规则停止回退。

## 账号与登录

路由把 `server/accounts.ts` 的 `accountsApi()` 挂在 `/accounts` 下（账号列表、`/:cli/login` 的起 / 查 / 取消、粘贴授权码、`/:cli/save`、切账号、登出、凭据检查、API 模型、模型探针与余额）。CLI 定义里 `auth` 各个字段的含义见 [cli-config.md](../../cli-config.md) 的「账号登录 `auth`」，这里只记服务端的做法。

- 全局 API 的三个出网接口都在服务端带密钥请求（页面不直连第三方）：`fetchApiModels`（`POST /accounts/api-models`，列模型）、`probeApiModel`（`POST /accounts/api-probe`，用一个模型真的跑一次最小推理）、`fetchApiBalance`（`POST /accounts/api-balance`，查余额）。探针按协议构造请求：anthropic `/v1/messages`（地址自带 `/v1` 时不重复）、openai-responses `/v1/responses`、openai-chat `/v1/chat/completions`、gemini `/v1beta/models/<模型>:generateContent`；认证头跟着 `authHeader`（`x-api-key` / `bearer`）和协议走，不写死。提示词只有 `ping`、输出 1 个 token，避免探测花额度。
- 探针的失败一律透传上游原因（`errorDetail` 兼容 `error.message` / `error` / `message` 几种写法，`error` 是对象但没有 `message` 时退到 `type` / `code`，都没有才用状态文本，避免输出 `[object Object]`；截 200 字），200 但正文里没有模型输出也算不通（`looksLikeAnswer` 按协议看 `content` / `candidates` / `output` / `choices`），超时用 `PROBE_TIMEOUT_MS`（60 秒）换成人话，不重试、不把密钥拼进文案。**读 body 阶段的超时单独处理**：上游先回 200、body 迟迟不吐时 `AbortSignal.timeout` 在 `res.text()` 阶段触发，不能 `.catch(() => '')` 吞成空正文，否则会掉进「不是模型回复」分支把超时报成内容不对。Gemini 的模型名先剥 `models/` 前缀再拼路径（和 `fetchApiModels` 同一套归一），手填官方全名也能测。列模型和余额原先各自内联的取错误原因写法也收敛到同一个 `errorDetail`。回归：`server/api-config.test.ts` 的「API 探针」几条（成功 / 404 模型不存在 / 401 带上游原因 / 200 非模型回复 / 读 body 阶段超时 / Gemini 带 `models/` 前缀 / 错误体无 message 时不输出 `[object Object]` / 没填地址、密钥、模型时不发请求）。

- 现在登录着的是谁：`server/accounts.ts` 的 `readLive` 按定义读 `auth.files`、`auth.fields` 和 macOS 钥匙串，一个都读不到就返回空（= 没登录）；`identityOf` 从凭据里认邮箱（认不出的返回空），`fingerprint` 只看凭据内容（sha256(files + keychain) 截 16 位）用于比对和去重。`matchSlot` 把现在的凭据对上已存的账号，`sync` 顺手把变了的凭据写回槽位、更新 active，`saveAs` 存成账号（同邮箱或同指纹的不重复存）。
- 登录的判定：`startLogin` 先 `sync` 一次，现在登录着但还没存下来的账号先 `saveAs` 存好（否则登录新账号会把旧的弄丢），记下 `before = fingerprint(live)` 后跑 `auth.login`。结局由纯函数 `loginOutcome` 定，共五种：`done`、`spawn-error`、`cancelled`、`no-credential`、`unchanged`。
- 默认按「凭据变没变」判：`poll`（600ms）里指纹一变就成功（Gemini CLI 登录后不自己退出也能判对），进程结束时 `.then` 再比一次。
- `auth.loginAlreadyLoggedIn` 为 `true` 的 CLI（目前只有 Command Code）：退出码 0 且 `readLive` 读得到凭据就算成功，不看指纹。因为这个 CLI 发现已经登录时只打印一句 `Already logged in` 就以退出码 0 结束，凭据文件一个字节都不改，只看指纹会把用户本来好好的登录报成「登录没有完成（退出码 0）」。界面上的「登录」和「登录其他账号」走的是同一个登录流程（`POST /accounts/:cli/login`）：已登录时它同样直接说已登录，结论是「现在仍是这个账号」——`finish(true)` 里 `readLive` 拿到的还是原凭据，`saveAs` 按邮箱或指纹去重，账号列表不会多出一条，也不算失败。
- 真正的失败照旧报失败：退出码非 0，或退出码 0 但读不到凭据（后者是 `登录没有完成：没有找到登录凭据`）。
- 输出：stdout / stderr 经 `onLine` / `onStderr` 进 `take`，`take` 先调 `shared/ansi.ts` 的 `stripAnsi` 再拼进 `job.output`（留最后 4000 字符），并从中找登录网址。存进 `job.output` 之前就清 ANSI，界面 `<pre>`、失败文案的尾部 3 行、「AI 处理」拿到的才是同一份干净文本——CLI 发现标准输出接终端就上色，浏览器不认识 ESC 只会吞掉，留下 `[32m` 这种残码。`stripAnsi` 只清 CSI / OSC / 两字符转义和 `\r`，普通方括号文本（没有 ESC 的 `[32m`、Markdown 链接 `[文字](...)`）原样保留。

## 回归验证

- `npm run typecheck`
- `npm run test:unit`（`server/**/*.test.ts`，每个模块基本都有同名测试）
- `server/settings-migrate.test.ts`：旧默认值 16 迁移成 64 并写回、已删掉的 `childConcurrency` 被忽略
- 动了存储和落盘：`server/store.test.ts`（`writeJsonAtomic` 写成功后 `readJson` 能读回、覆盖写读到新内容、tmp 不残留；`readJson` 对不存在的文件报 `missing`；坏 JSON 被留档且调用方拿到「存在但坏了」和原路径、字节数，旁边有 `.broken.json` 说明；全 0 的空洞文件判成损坏并记下真实字节数）、`server/task-store.test.ts`（只有 `.messages.json` 时重建任务、记录全 0 时空洞文件留档后重建、对话文件全 0 时不重建不伪造且第二次启动不重复归档、对话内容不是消息数组时不重建只留档、已有记录不被重建覆盖）、`server/store-concurrency.test.ts`（集合的「读快照 → 改 → 写盘」整体串行）
- 动了任务执行、项目、设置等跨界面流程时跑 `npm run test:e2e`（Windows 上在 WSL 里）
- 动了账号与登录：`server/accounts.test.ts`（`loginOutcome` 的各种结局、`loginFailure` 的文案分支、Command Code 的 `loginAlreadyLoggedIn`）、`shared/ansi.test.ts`（SGR 颜色、加粗 / 暗色开关、8 位 CSI、普通方括号文本不被改），以及 `npm run test:e2e` 里「已登录再登录」和「退 0 但没凭据」两条用例（模拟 CLI 用 `scripts/fake-cli/fake-cli.mjs` 的 `FAKE_AUTH_ALREADY` / `FAKE_AUTH_NO_CREDENTIALS`）
- 动了出网 / 代理：`server/net.test.ts` 覆盖系统代理解析（Windows 注册表输出、macOS `scutil --proxy`）、候选列表与 `pickLocalProxies` 的挑选顺序（默认端口在尝试范围内、只开默认端口也能被选中）、`planFor` 的优先级 / 无协议补全 / `NO_PROXY`、缓存失效（`markProxyBad`）、本机地址识别、直连失败换代理、配置代理失败后回退、全部失败时的文案、本机地址不探测、用户取消或总预算用完时停止、超时后重试、代理握手探测（起真实只处理 CONNECT 的本地服务）。`netFetch` 的回退路径通过 `netFetchWith` 注入 `NetDeps`（`plan` / `direct` / `viaProxy` / `discover` / `proxyFailed`）来测，不用真的连代理。`server/download.test.ts` 通过 `DownloadOptions.fetch` 断言探测、单连接下载和每个分片都经过统一入口、都带 20 秒响应头超时，并带 `onAttempt` 供回退时重置空闲计时；`net.test.ts` 另有用例确认每次尝试前会调用它。

## 待确认

- `server/` 下文件较多（API 路由集中在 `server/index.ts`），新增接口前先确认应该加在路由里还是拆成独立模块（待确认）。
