# 电脑意外重启后，对话从项目列表里消失

- 状态：已修复（代码和新增的单测随同一批改动落地；恢复效果在真实数据目录的副本上验证过，见「回归验证」）
- 症状：电脑意外重启后，两个对话从项目列表里彻底消失（消息文件完好也没用）
- 入口：`server/store.ts` 的 `writeJsonAtomic` / `readJsonDetailed`、`server/task-store.ts` 的 `load`
- 根因类型：落盘未刷盘 + 损坏被当成不存在
- 模块：`server`（存储 `server/store.ts`、任务记录 `server/task-store.ts`）
- 关键词：重启、断电、对话消失、任务记录丢失、meta 丢失、全 0、空洞文件、fsync、`cache/broken`、重建

## 现象

2026-10-25 约 10:55，Windows 意外重启。重启后打开面板，「Agent 面板」项目下面有两个对话不见了：列表里完全不展示，界面也打不开。

## 查实的证据

数据目录 `C:\Users\17787\.agent-panel`，项目 `67c54a22-7a88-47a0-a8cc-d787a2306ea9`：

| 文件                                                 | 大小      | 内容                                        |
| ---------------------------------------------------- | --------- | ------------------------------------------- |
| `8c674731-00ad-4f5d-8a3d-9be83150525e.messages.json` | 2772726 B | JSON 合法，703 条消息完整                   |
| `d3c7b6be-a123-4d05-bf46-a8d83dce64b7.messages.json` | 4326018 B | 全是 `0x00`（`tr -d '\000' \| wc -c` 为 0） |
| `8c674731-….json`（任务记录）                        | —         | 不存在                                      |
| `d3c7b6be-….json`（任务记录）                        | —         | 不存在                                      |

- `cache/broken/8c674731-….json.broken-1792897691108`（112276 B）和 `cache/broken/d3c7b6be-….json.broken-1792897691116`（55754 B）都是**内容全 `0x00`** 的空洞文件，时间戳 10-25 10:58（重启后首次启动）。大小和原来的任务记录对得上——即任务记录被读成坏文件挪走了，而且挪走的那一刻它已经是全 0。
- 数据目录里没有残留的 `.tmp` 文件。`settings.json`、`projects.json` 等其他 JSON 都正常。

## 触发条件

任务记录（`<id>.json`）或对话文件（`<id>.messages.json`）写入过程中断电或强制重启，磁盘上留下「长度对得上、内容全是 `0x00`」的文件。

## 影响范围

- 任何在消息落盘（或任务记录落盘）途中被切断电源、蓝屏、强制重启的场景。
- 损失是**整个对话从列表里消失**，不是只丢最后一次改动：`.messages.json` 完好也没用，列表根本不看它。
- 同样的空洞文件出现在别的数据文件上时，修复前 `readJson` 会当作「这份数据不存在」继续跑（不崩，但配置、项目等内容会静默回到默认值）；修复后会留档并打日志，但 `readJson` 的返回值仍是 `undefined`，需要区分的地方得用 `readJsonDetailed`。

## 根因

1. **`writeJsonAtomic` 没有 fsync**：原来是 `writeFile(tmp)` → `rename(tmp, file)`。Windows 上断电时，文件长度已经写进元数据、脏数据页还没落盘，于是目标文件保留原长度、内容全是 `0x00`。坏文件大小和原文件对得上就是这么来的。`rename` 是原子的，但它只保证「名字换代」，不保证数据已经在盘上。
2. **`readJson` 把损坏当成不存在**：`JSON.parse` 失败后把文件 `rename` 到 `cache/broken/`，然后 `return undefined`，只打一行 `console.error`。上层拿不到「这里原本有个文件、它坏了」这个信号，任何「文件没有 = 这份数据不存在」的判断都会把损坏误当成不存在。
3. **`load()` 只枚举任务记录**：`server/task-store.ts` 的 `load()` 用 `f.endsWith(MSG)` 跳过 `.messages.json`，只按任务记录建列表。记录一消失，任务就从列表里彻底消失，即使同目录的 `.messages.json` 完好无损；也没有任何「从 `.messages.json` 反推重建任务记录」的兜底。

## 修法

### 落盘：数据刷到盘上再 rename

`writeJsonAtomic`（`server/store.ts`）现在的顺序是 `open(tmp)` → `writeFile` → **`fh.sync()`** → `close` → `rename(tmp, file)` → `fsyncDir(父目录)`。

- **fsync 不能省**：省掉它就会出现「rename 生效了但数据没落盘」这个具体失败模式，就是这次的空洞文件。所以每次写都 fsync 临时文件，不是只对大文件或只对小文件。
- **fsync 失败不 rename，直接抛错**：写不下去时留着旧文件比换成一个可能全 0 的新文件安全。
- **rename 后刷目录**：`fsyncDir` 让目录项本身落盘。`process.platform === 'win32'` 时直接 `return`（Windows 打不开目录句柄，做不到就跳过；数据在上一步已经 fsync 过，目录项丢失最坏是回到上一个版本的文件），其他平台打开失败也静默跳过（部分网络盘、容器挂载不支持对目录 fsync）。
- **为什么性能可以接受**：消息文件的写入有 `server/task-store.ts` 的 `MSG_GAP`（400ms）合并窗口挡在前面，流式输出时每秒最多几次写盘，fsync 的代价被摊掉了；任务记录、设置这类小文件本来就写得少。

### 读取：区分「没有」和「坏了」

- 新增 `readJsonDetailed(file)`，返回三种状态：
  - `{ state: 'missing', value: undefined }`：文件不存在（`ENOENT`）。
  - `{ state: 'ok', value }`：正常解析出的值。
  - `{ state: 'broken', value: undefined, broken: { file, backup, reason, size } }`：存在但坏了。`file` 是原路径、`backup` 是留档路径、`reason` 是解析错误、`size` 是按字节读到的原始大小（全 0 的空洞文件靠它和原文件对上）。
- `readJson` 保持旧签名（返回 `.value`），老调用方不用改；要区分损坏的调用方用 `readJsonDetailed`。
- 新增导出的 `archiveBrokenFile(file, reason, size)`：把文件挪进 `cache/broken/<原文件名>.broken-<时间戳>`，旁边写一份 `<backup>.broken.json` 说明（`file`、`backup`、`reason`、`size`、`at`、`stamp`）。**只挪不改**，坏文件的原始字节原样保留，需要时能手工恢复。备份名已被占用时自动加序号（`-2`、`-3`…），同一毫秒里归档两次同名文件不会盖掉前一份（有用例拦）。返回的 `archived` 说明文件真的挪走没有：被别的进程占着挪不动时是 `false`，日志会写明「下次启动会再处理一遍」，不让调用方误以为已经留档。除了 JSON 解析失败，「能读成 JSON 但内容用不了」的文件也走这里，避免每次启动重读同一个用不了的文件。
- `cache/broken/` 属于缓存目录，在设置里清理缓存会一起删掉，不会留在数据目录里当垃圾。

### 任务记录：缺了就按对话重建

`server/task-store.ts` 的 `load()` 在**同一次** load 里同时收集任务记录和 `.messages.json`（`all()` 里 `loading ??= load()` 的并发保护不变，没有第二次扫描），然后对「有 `.messages.json` 但记录缺失 / 记录坏掉」的 id 调 `rebuildMeta()`：

- 读 `.messages.json`，用 `TaskMessage.array().safeParse` 校验。
- 反推出的记录再用 `Task.safeParse` 校验，**不通过就不重建、不写半截**——宁可不重建，也不能「修」出新问题。
- 重建出的记录形态：`mode: 'chat'`、`status: 'stopped'`、`stopReason: 'restart'`（当作被重启打断的旧对话，用户可以继续）、`simulated: false`（真实数据不能按演示数据画）、标题取用户第一句（`taskTitle`，没有用户消息时用 `t('恢复的对话')`）、`createdAt` / `updatedAt` 取首尾消息的 `at`、`messages` 只放用户消息（`head()`，完整对话在消息文件里）、`turnSeenAt` 取最后一条消息，不把恢复出来的对话亮成一片未读。
- **对话文件本身坏了 / 全 0 / 不是消息数组 / 是空数组**：不重建、不伪造，把它也归档到 `cache/broken/` 并打出带 id 和字节数的日志。归档后下次启动目录里看不到它，所以不会反复重试。空对话不造一个 0 条消息的空任务（断电后可能出现「记录全 0 + 对话为 `[]`」）。
- **对话文件读不出来**（`EBUSY` / `EPERM` / `EACCES`，Windows 上被杀软、索引服务占着）：读取包在 try/catch 里，只跳过这一个任务并打日志，不让整个任务列表抛错。`all()` 里一次读失败会清掉 `loading`，下一次请求重新读。
- **原记录没能留档时不覆盖**：`archiveBrokenFile` 返回 `archived: false` 时原 meta 还在原位，重建只让它本次可见、不写盘，原文件一个字节不动，下次启动再处理。
- 记录能读成 JSON 但过不了 schema（`parseTask` 失败）时，先 `archiveBrokenFile` 留档再重建，不直接覆盖原文件——原来那份手修一下可能还能用。
- 重建后写盘失败（磁盘满、文件被占用）只打日志，**本次启动仍然让它可见**（用户至少能把对话打开、导出），下次启动还会再试一次。
- 重建完成后打一行汇总日志：`这些对话的任务记录丢失，已从对话内容重建：<id>…`。

## 防复发护栏

- `server/store.test.ts`
  - `writeJsonAtomic：写成功后能读回，临时文件不残留`
  - `writeJsonAtomic：覆盖写之后读到的是新内容，且不留临时文件`
  - `readJson：文件不存在时返回 undefined，且不算损坏`
  - `readJson：坏 JSON 被留档，调用方能拿到「存在但坏了」和原路径、字节数`（同时断言 `.broken.json` 说明里的 `file` / `size` / `reason`，以及旧签名 `readJson` 仍返回 `undefined`）
  - `readJson：全 0 的空洞文件判成损坏，并记下真实字节数`
  - `同一毫秒里归档两次同名文件：不覆盖前一份留档`（备份名撞车时往后加序号，两份原始内容都在）
- `server/task-store.test.ts`
  - `只有 .messages.json、没有任务记录：从对话重建任务，列表里出现且内容完整`（还断言重建出的记录写回磁盘、记录里只有用户消息、`store.get()` 能读到完整对话）
  - `任务记录损坏（全 0 的空洞文件）：从对话重建，坏文件留档`
  - `对话文件也是全 0：不重建、不伪造，留档后不抛错也不再重试`（第二次启动不再产生新留档）
  - `对话文件能读成 JSON 但内容不是消息列表：不重建，留档`
  - `已经有任务记录的不会被重建覆盖`（用户自己改过的标题不会被盖掉）
  - `对话文件读不出来（权限 / 占用这类错误）：跳过这一个任务，整个列表照样能用`
  - `任务记录过不了 schema 且没能留档：本次可见但不覆盖原文件`
- `server/store-concurrency.test.ts` 既有的三条用例继续守着「读快照 → 改 → 写盘」整体串行的不变量（见项目教训 `lmvity8e3l26f`），这次改 `writeJsonAtomic` 没有破坏它。

## 回归验证

真实数据验证（`C:\Users\17787\.agent-panel\tasks\projects\67c54a22-7a88-47a0-a8cc-d787a2306ea9\`）：

1. 验证前先把整个项目目录复制一份到系统临时目录做保险，`cache/broken/` 里原有文件不删。
2. 在副本上跑一次性脚本调 `createTaskStore()`（不常驻服务、不占端口），脚本用完即删；副本的 `AGENT_PANEL_DATA` 指向临时目录，真实数据目录全程只读。

| 指标                 | 恢复前                                | 恢复后                                                                                                                                               |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目目录里的任务记录 | 32 个                                 | 33 个（补回 `8c674731`，32773 字节）                                                                                                                 |
| 项目目录里的消息文件 | 34 个                                 | 33 个（`d3c7b6be` 的全 0 文件被归档走）                                                                                                              |
| 列表里的对话         | 32 个，`8c674731` / `d3c7b6be` 都不在 | 33 个，`8c674731` 回来，`d3c7b6be` 仍然不在                                                                                                          |
| `8c674731`           | 打不开                                | 标题「UI设计，这个对话框在运行，用户发送消息不要放到排队，参照现在的…」、`status: stopped`、`stopReason: restart`、`store.get()` 读到 703 条消息完整 |
| `d3c7b6be`           | 打不开                                | 不伪造：`messages.json`（4326018 B 全 0）归档为 `cache/broken/d3c7b6be-….messages.json.broken-1792898963149`，旁边有 `.broken.json` 说明             |
| 第二次启动           | —                                     | 幂等：不重复归档、不再重建，列表仍是 33 个                                                                                                           |

`d3c7b6be` 救不回来是数据本身没了（消息文件 4326018 字节全是 `0x00`，没有任何可解析内容），不通过伪造数据让它出现在列表里。

自动检查（提交前必跑；存储层和启动迁移属大改动，五项都要跑）：

```bash
npm run typecheck && npm run lint && npm run test:unit
npm run build
npm run test:e2e:wsl   # 改了存储和启动迁移，在 WSL 里跑
```

## 排查路径（下次定位同类问题的顺序）

1. 先看**文件本身**：`ls -la` 看大小，`tr -d '\000' | wc -c` 看有没有内容。长度和正常文件对得上、非 0 字节数为 0，就是断电留下的空洞文件，直接查写入路径有没有 fsync。
2. 再看**文件去哪了**：数据目录里没有了，就去 `cache/broken/` 找同名 `.broken-<时间戳>`。有备份说明代码把它当成坏文件挪走了，不是被删除。
3. 再确认**列表是怎么建的**：`load()` 枚举哪些文件？少一类文件（例如只认任务记录、不认消息文件）就会让某个数据从列表里整条消失。
4. 最后看**读失败被怎么处理**：`return undefined` 和 `state: 'broken'` 对上层是完全不同的信号，判断「不存在」之前先问一句「文件坏了是不是也走这条路」。

## 落地改动

| 位置                          | 改了什么                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/store.ts`             | `writeJsonAtomic` 改成同句柄 `fsync` 后再 `rename`，失败不 rename；新增 `fsyncDir`（Windows 跳过）；新增 `readJsonDetailed`、`archiveBrokenFile` 和 `JsonResult` / `BrokenJson` 类型；`readJson` 改为返回 `readJsonDetailed().value`，签名不变 |
| `server/task-store.ts`        | `load()` 同一次扫描里同时收集任务记录和 `.messages.json`；新增 `rebuildMeta()`（校验后重建、写回、放进 map）和 `archiveBadMeta()`（schema 不过的记录先留档）；坏对话文件归档并打带 id、字节数的日志                                            |
| `shared/locales/en/server.ts` | 补 `恢复的对话` 的英文 `Recovered conversation`                                                                                                                                                                                                |
| `server/store.test.ts`        | 新增：写入可读回、覆盖写、tmp 不残留、坏 JSON 留档与三态、全 0 空洞文件、同一毫秒归档两次不覆盖前一份                                                                                                                                          |
| `server/task-store.test.ts`   | 新增 5 条：只有消息文件时重建、记录全 0 时重建、消息全 0 时不重建只留档、消息不是消息数组时不重建、已有记录不被覆盖                                                                                                                            |

## 待确认

- 无。修法一节按最终代码核对过（`server/store.ts` 的 `writeJsonAtomic` / `fsyncDir` / `readJsonDetailed` / `archiveBrokenFile`，`server/task-store.ts` 的 `load()` / `rebuildMeta()` / `archiveBadMeta()`）。
