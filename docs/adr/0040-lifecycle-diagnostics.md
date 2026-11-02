# ADR 0040：对话的 CLI 生命周期诊断——事实分三层收集，结论只在一个纯函数里下，问题交付成一个文件

状态：已接受 · 2026-11-02

- 影响范围：`shared/lifecycle.ts`（新增）、`server/exec/cli-trace.ts`（新增）、`server/tasks/lifecycle.ts`、`server/tasks/lifecycle-routes.ts`（新增）、`server/exec/invoke.ts`、`server/exec/process.ts`、`server/exec/orphans.ts`、`server/locate-file.ts`、`web/src/components/tasks/LifecycleDialog.tsx`、`web/src/components/tasks/LifecycleDetail.tsx`、`server/tasks/lifecycle-ai.ts`、`web/src/components/tasks/diag-dialogs.tsx`
- 取代：无

## 背景

用户反复报对话「卡死在等待模型」：这一轮说完了在等子对话却一直不动；全部做完了还显示在等；上一秒还在输出、下一秒就「等待模型」，发消息也进不去。界面只给「等待模型 · 已 54s」，日志里只有「CLI 进程启动 / 结束」「交付」「停止」，说不清是网关没回、CLI 自己卡住还是面板的执行位卡住。每次排查都要用户描述现象、开发猜原因，改了好几轮。

用户要求：对话菜单加「状态」，点开能看到整棵对话树（子对话、子任务）每个 CLI 的生命周期、是否还活着、为什么不活着、谁把它停了；能导出；「复制」复制的是文件不是文本，复现后直接交给开发分析。

## 决策

1. **事实分三层，各取各的，不另存一份状态**
   - 现场快照（只在内存）：执行位（`live` 表、`Live.stopAt`）、排着的消息（`heldCount`）、进程登记（`taskCliAlive`、`trackedClis`）、页面在不在看（presence）。
   - 落盘状态：任务 JSON（状态、停止原因、计划、子任务步骤）。
   - 生命周期事件：对话日志（`taskLog`），这次补上缺的节点——每次模型请求的开始、第一段输出、CLI 自己的重试、这一轮结束（`server/exec/cli-trace.ts`），进程的启动和退出（退出码、信号、是不是面板结束的、活了多久、stderr 尾部，`server/exec/process.ts`）。
2. **结论只在一个纯函数里下**：`shared/lifecycle.ts` 的 `verdictOf` 输入一个节点的事实，输出一句话结论、进程为什么不在、异常列表（每条带稳定编号，例如 `model-silent`、`child-idle-parent-waiting`、`held-unhandled`）。前后端、演示后端共用，能单测；状态判定复用 `convState` / `stopReasonText`，不另写一套「算不算在跑」。
3. **模型请求轨迹按「对话 + 步骤」分开记**：`TrackedOwner.step` 标出是对话本身这一轮还是哪个子任务 / 工作流节点，子任务的请求不覆盖对话自己的。挂在 `invokeCli` 里包一层 `onEvent`，runner 不动。不报「请求开始」的 CLI（Codex、Pi）用这次调用的开始时间和每轮开头的 `turn` 事件代替。
4. **交付成一个文件**：`POST /tasks/:id/lifecycle/file` 把整棵树的报告（完整日志，单个上限 1 MB）写到数据目录 `diagnostics/`，去掉疑似密钥，再用系统剪贴板放「文件」（Windows `Set-Clipboard -Path`、macOS osascript、Linux xclip / wl-copy 的 `text/uri-list`）。放不进去时给路径和「打开所在文件夹」。格式带 `format: agent-panel-lifecycle/1`。
5. **入口**：对话菜单「状态」；「等待模型 · 已 Ns」和「等待子任务 / 等你的下一条消息」那一行可点，点了直接打开。弹窗用通用弹窗外壳（`ModalHeader`），左边对话树、右边选中节点的结论、异常、事件计数、执行 / 模型 / 进程三张卡和最近 200 行日志，开着时每 2 秒刷新；「AI 分析」「下载」「复制诊断文件」在标题栏右上角。
6. **事件计数在服务端按完整日志算**：`shared/lifecycle.ts` 的 `eventKind` 把日志事件归成模型请求、重试、出错、停止、进程退出五类，`countEvents` 记数量和最近一次；弹窗只拿到最近 200 行，自己数会少。弹窗的计数块、日志配色和筛选都按 `eventKind`，新增日志事件时在那里归类。
7. **AI 分析交给统一的 AI 分析窗口**：`POST /tasks/:id/lifecycle/analysis` 先写一份诊断文件，再把选中节点的结论、异常、计数、最近 150 行日志和文件路径整理成 `FixInput`（topic `task-lifecycle`，`server/tasks/lifecycle-ai.ts` 补判定规则说明），页面走 `openAiFix`，对话按归属规则开在这个对话所属的地方；要求只分析不改文件。

## 操作清单 / 契约

| 接口                                 | 用途                                                |
| ------------------------------------ | --------------------------------------------------- |
| `GET /tasks/:id/lifecycle`           | 弹窗用：整棵树，每个节点最近 200 行日志             |
| `POST /tasks/:id/lifecycle/file`     | 生成诊断文件并放进剪贴板，返回 `{ path, copied }`   |
| `GET /tasks/:id/lifecycle/download`  | 下载同一份文件                                      |
| `POST /tasks/:id/lifecycle/reveal`   | 打开诊断文件所在目录                                |
| `POST /tasks/:id/lifecycle/analysis` | 「AI 分析」选中节点：写诊断文件、返回 AI 处理的输入 |

## 放弃的方案

- **复制成文本**：用户明确不要；文本动辄几百 KB，粘进对话会被截断，也丢了结构。
- **只做弹窗不补日志**：现场快照只在面板活着时有，用户复现后往往已经停止、重启过；没有事件日志，事后什么都看不出来。
- **在 runner 里直接记**：`runner.ts` 已到行数上限，且轨迹是 CLI 调用这一层的事，放 `invokeCli` 更准。

## 风险与代价

- 每次模型请求多写两行日志（开始、第一段输出），流式内容不逐条记，体积可控。
- 去密钥按常见形态（`sk-…`、`Bearer …`、`key=…`）宁多遮；设置只带进程存活相关的几项，不带账号、API、代理。
- Linux 没有 xclip / wl-copy 时放不进剪贴板，靠路径兜底。
