# server · 数据落盘、对话日志与附件

[server 模块](README.md)的子页面：原子写入与损坏恢复、对话专属日志、附件落盘。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

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

## 对话专属日志

每个对话在对话文件旁边有一份自己的日志：`tasks/projects/<项目 id>/<对话 id>.log`（聊天在 `tasks/chats/`），由 `server/task-log.ts` 的 `taskLog(id, 事件, 字段)` 写，一行一件事：`2026-10-30 09:07:12.123 [收到消息] messageId=… live=true status=running awaitingUser=true`。全局日志（`server/log.ts`）按启动分文件、各对话混在一起且主要记报错；这一份只回答「这个对话经历了什么」，查「消息发出去却没了」这类问题时先看它。

- 记的事件：收到消息（当时的执行位、状态、是否在等下一句）、走了哪条交付路径（等下一句 `wait=ok/none/stale`、插话 `how=steer/notes/held`、卡住重开、新开一轮、执行位被占被拒）、最后「消息已记下 / 消息没有记进对话」、启动 / 执行结束（状态、停止原因）、对话 CLI 进程启动和结束、停下等下一句 / 等子任务及其结束、取消等待、标成卡住、停止（原因）、预热、激活 / 关闭 Agent、用户停止。
- 不记模型输出；消息正文只留开头 80 字，字段超过 200 字截断。写满 2 MB 改名成 `.log.1`（只留一份旧的）。删除对话时连同日志一起删（`task-store` 的 `remove`）。
- 路径由任务存储注册（`setTaskLogPath`），只认内存里已知的对话；写失败吞掉，不影响执行。
- 新加会改变消息去向或对话状态的路径时，同时在这里补一行 `taskLog`。

## 附件落盘：只有图片拷一份进对话目录根，其它文件只引用原路径

- 只有图片（`shared/composer.ts` 的 `attachChip` 判出的 image：mime 是 `image/` 或扩展名是 png/jpeg/gif/webp/bmp）由 `server/attachments.ts` 的 `placeAttachments()` 拷进任务执行目录（对话目录）根下，提示里给的就是这个相对文件名（`截图-132004.png`）：Agent 的 cwd 就是这个目录，直接能读。重名时加序号（`note (2).png`），**对话目录里本来就有同名文件时也不覆盖**，同样加序号另起一个名字；同一个源文件再次放置时沿用任务上记的那份，不会越攒越多副本。超过 `MAX_ATTACHMENT_BYTES` 的图片不拷、保留原绝对路径。**其它文件（文本、代码、PDF、压缩包、音视频）一律不拷**，直接把原来的本机绝对路径交给 Agent；上传的文件只有 `~/.agent-panel/uploads/<uuid>/<名字>` 一份，任务目录里不出现第二份。`ref`（粘贴回来的路径）和 `quote`（引用原文落成的文件）本来就不拷。
- 拷进来的文件名记在任务上（`Task.placedAttachments`：源文件绝对路径 → 对话目录里的文件名，由 `server/tasks.ts` 的 `placeInTask` 合并进去）。面板自己的文件不算 Agent 的改动：`server/exec/git.ts` 的 `gitNumstat` / `gitChanges` / `gitSnapshot` / `reviewDiff` 都收这份名单，统计「更改」、评审差异时排除它们。不按文件名或 `attachments/` 前缀猜（图片搬到根目录后 `PANEL_DIR` 正则已经失效，已删掉）；名单只认对话目录里的相对路径，绝对路径和带 `..` 的不算。旧任务没有 `placedAttachments`：`placedFiles()` 按消息里记的 `attachments/名字` 原样补进名单（仍是按记录推，不是靠前缀猜），升级后当年拷进子目录的图片也不会重新冒进「更改」列表。回归：`server/exec/git-ignore.test.ts`、`server/attachments.test.ts` 的排除名单用例。
- 小文件的后台拷贝（`server/uploads.ts` 的 `POST /uploads/copy`、`POST /uploads/discard`）：浏览器选 / 拖 / 粘的文件只有文件名和大小，页面先走 `/uploads/locate` 找回原路径，再让服务端拷一份到 `~/.agent-panel/uploads/<uuid>/<名字>`（和上传同一套命名）。**只接受面板确认过的路径**：`pick` / `resolve` / `locate` 返回时把路径登记进内存里的 `confirmed`（24 小时、最多 5000 条），`/copy` 和 `/discard` 都只认这些路径——不能凭前端传来的一段任意字符串让服务端拷或删本机的文件。拷贝失败（被占用、权限、源文件在查找之后没了）或超过 `MAX_ATTACHMENT_BYTES` 的不在结果里返回，页面降级成引用原路径、不拦发送；`/discard` 只删附件目录里那一个副本目录（`uploadDirOf` 判过在 `UPLOADS_DIR` 下），没确认过的路径不删。回归：`server/uploads-copy.test.ts`。
- 两种形态在提示里的说明由 `shared/task.ts` 的 `withAttachments` 按实际内容写：只有相对路径时说「图片已放进对话目录」，有绝对路径时说「本机绝对路径、直接读取」，免得模型把绝对路径当相对路径去找。
- 用绝对路径的附件在执行目录之外，要放行的目录由 `attachmentAddDirs()` 按附件实际位置算：上传的合并成 uploads 根，粘贴路径引用的文件（`ref`）各自放行它所在的目录，执行目录里的和相对路径不放行。`server/exec/runner.ts` 建 `addDirs` 时取整个对话里的附件，设计会话（`server/designs.ts`）也调它，不再固定只放行 `UPLOADS_DIR`（以前 `ref` 引用的、在 worktree 执行时项目原目录里的文件会被挡掉）。实际用到的参数只有 Claude Code 的 `--add-dir`（`shared/clis/claude.json` 里 `each: addDirs` 的那条规则）；Codex 的 `--sandbox` 限制的是写和命令、读文件不受目录白名单限制，Command Code / Pi 的 CLI 定义里没有目录参数（permission 是工具批准模式），所以它们读绝对路径不需要额外参数。
- 源文件被删掉或移走时读不到，附件只保留原路径：CLI 自己报找不到，不静默换成别的路径、也不把附件从消息里去掉——不拷贝的代价就是「源文件没了就读不到」，报错就是如实告知用户。设计会话（`designs.ts` 每轮建临时工作目录、结束后删）仍把附件复制进那个临时目录，因为设计工具按工作目录内的路径找图，和任务附件不是一回事。
- 附件图片的缩略图（`server/thumbnail.ts`，挂在 `/api/uploads/raw` 的 `?w=` 上，`server/uploads.ts`）：消息里的卡片只有 1.25em 见方，却一直取原图（单张 100–300KB）。这里用 `server/image.ts` 已有的 PNG 解码 / 缩放 / 编码，**不引入图片库**：服务端要打成单文件（`scripts/package.mjs` 的 esbuild `bundle`），原生模块带不进去，纯 JS 的 JPEG 解码又要多一份依赖。缩略图缓存在 `<DATA_DIR>/cache/thumbs/<sha1(路径+大小+mtime+宽)>`（按文件大小和 mtime 而不是文件内容算 key，不用为了判断缓存是否新鲜先读一遍原图），同一张图的并发请求只算一次、解码缩放串行做（它是同步计算，一起来会把服务端卡住），响应带 `cache-control: private, max-age=86400`。解不开的格式（JPEG / WebP / 隔行扫描 PNG）和比目标还小的图返回 null，接口退回原图；看大图、复制图片、任务目录里的图（`/uploads/raw/file`）都不带 `w`。回归：`server/thumbnail.test.ts`。
- 回归：`server/attachments.test.ts`（文本/PDF 不拷、图片拷到对话目录根、超上限的图片不拷、重名图片加序号、目录里已有同名文件不覆盖、同一源文件复用、`ref` / `quote` 不拷、放行目录的计算）、`server/task-text.test.ts`（两种形态的说明）、`server/exec/git-ignore.test.ts`（面板图片不进更改列表和评审差异）、`scripts/e2e/05-workflow-edge.mjs` 的附件段（图片拷进对话目录根、提示里给相对文件名；文本文件不拷、给了原绝对路径）。
