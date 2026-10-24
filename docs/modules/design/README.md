# design：UI 设计、AI 对话与导出

- status: verified
- source_paths: `server/designs.ts`, `server/design-mcp.ts`, `server/design-capture.ts`, `server/asks.ts`, `shared/design.ts`, `web/src/components/design/`, `web/src/pages/DesignPage.tsx`, `web/src/lib/demo-design.ts`
- entry: `server/designs.ts`
- analyzed_at: 2026-10-24

## 职责

- UI 设计：按 UI 项目组织设计，每个设计有控件树、设计尺寸、风格说明、效果图和切图，和任务分开存储（数据目录下 `designs/`，每个设计一个 JSON，图片放在同一层的设计目录里）。
- AI 对话：用户描述要求，设计 AI 通过 MCP 工具改控件树、加图片和动画、出原画；一轮里可以同时出原画和切图。
- 原画与图片生成：先出整屏效果图给用户挑、确认模板，再按模板出切图；支持本机 ComfyUI 局部重绘、上传、重试。本机出整屏原画时，已下载 MOSS-Image、工作流选 auto、画布上又已有文字和带描述的图片，就优先用 MOSS-Image 的布局工作流，位置取自画布控件。
- 导出：导出 ZIP、JSON、React 网页，或把切图和控件树导出到项目目录，给 UE 用的格式见 [umg-export](../../umg-export.md)。
- 页面截图：设计 AI 要「看」页面时，向正在盯着这个设计的页面要一张截图。
- 待确认的提问：AI 和 CLI 的提问、审批走 `server/asks.ts`，对话里弹问题面板，回答作为一条消息发回去。

## 入口与数据流

- 页面入口：`web/src/pages/DesignPage.tsx` 管页面状态、参数和 `send()`；`web/src/components/design/DesignChat.tsx` 是对话面板（输入框、附件、控件引用、提问面板）；`web/src/components/design/useDesignEditor.ts` 管页面状态和轮询。
- 发起一轮（没在跑）：`send()` 先 `api.saveDesign` 回写页面状态，再 `POST /designs/:id/chat` → 路由校验 `DesignChatInput` 和 CLI 是否启用 → `beginChat()`。
- `beginChat()`（`server/designs.ts`）：`recordMessage()` 记用户消息 → 保存 → 非分析时先存一个版本 → `startJob()`。
- `beginChat()` 在进入 `save` / `addVersion` 前先用进程内的 `starting` 集合占住这个设计，同时往 `jobs` 放一个占位 job（`status: 'running'`、`phase: 'design'`、没有 `control`）：准备期间页面（`GET /designs/:id`）看到的是「在跑」，轮询不会因为上一轮 `done` 停掉；这一轮真正开始时 `startJob()` 覆盖它，取消或出错时在 `finally` 里删掉。
- 准备期间（`starting`）`/chat` 不返回 409：消息照样记进对话（`delivery: held`）、放进 `pendingTurns` 并返回 `queued: true`，等这一轮结束自动接着处理；只有 `jobs` 里真的是 `running` 才返回 409。`/steer` 同样把 `starting` 算作「在跑」，记成待处理，避免两个 CLI 同时改同一份设计。
- 执行：`startJob()` 把 job 放进进程内的 `jobs`（状态、阶段、abort、插话通道），`chat()` 用 `openDesignSession` 起设计工具、`invokeCli` 跑 CLI，`resolveDesignResult` 校验结果后保存设计；需要时接着出原画和切图。
- 一轮结束：`startJob` 的 then / catch 里调 `finish()` → `drainTurns()`，有等待处理的补充消息就自动开始下一轮；失败原因写成 `role: 'system'` 的错误消息进对话。`drainTurns()` 先看 `jobs` 和 `starting`，开始不了新一轮时把消息放回队首、把 `delivery` 改回 `held`。
- 运行中补充：`POST /designs/:id/steer`（输入和 `/chat` 是同一份 `DesignChatInput`）按下面的顺序处理：
  1. `job.status === 'running'`、`job.phase === 'design'` 且有插话通道、`steer()` 成功：`recordMessage(..., 'steer')`，整条消息交给正在跑的这一轮。
  2. 还在跑但收不下（CLI 不支持插话、这一轮刚结束、正在出图等）：`recordMessage(..., 'held')`，同一条输入放进 `pendingTurns`，并补调一次 `drainTurns()`；这一轮结束后自动开下一轮。
  3. 已经没在跑（`starting` 也算在跑）：直接 `beginChat()`，按新的一轮处理。
- 停止：`POST /designs/:id/stop` 清空 `pendingTurns`，把还没处理的那些消息的 `delivery` 改成 `lost`，界面提示重新发一次；正在 `starting` 窗口里（还没 `startJob`）时还要设置 `cancelled`。`beginChat()` 在存文件、存版本之后、`startJob()` 之前检查 `cancelled`，命中就不启动这一轮，并把这条消息的 `delivery` 改成 `lost`；`finally` 里清 `cancelled`、删占位 job，并补一次 `drainTurns()`，让停止期间新登记进 `pendingTurns` 的消息能接上，不会一直停在 `held`。
- 界面显示：消息上的 `delivery` 是事实记录，取值为 `steer` / `held` / `next` / `lost`：`held` 是「结束后自动处理」，排队消息真正开始新一轮时改成 `next`（「按新的一轮处理」），用户点停止时还没处理的改成 `lost`。对话里用共享的 `deliveryText` 显示去了哪里，不再有页面自己维护的排队卡片。

## 关键文件

| 文件                                       | 内容                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `server/designs.ts`                        | 全部 `/designs` 接口；设计数据、job 与 `pendingTurns`、对话轮、原画和切图、版本、截图、导出   |
| `server/design-mcp.ts`                     | 交给设计 AI 的 MCP 工具：控件增删改、组件、图片、动画、数据、`ask_user`、出原画、截图、检查   |
| `server/design-capture.ts`                 | 页面截图请求和长轮询，这一轮结束时取消还在等的截图                                            |
| `server/asks.ts`                           | 提问和审批会话，回答作为一条消息回到对话                                                      |
| `shared/design.ts`                         | `Design`、`DesignMessage`、`DesignJob`、`DesignChatInput`、`buildDesignPrompt` 等结构和提示词 |
| `shared/design-ops.ts`                     | 控件树的操作和校验                                                                            |
| `shared/anim.ts`、`shared/design-data.ts`  | 动画、画板预览数据                                                                            |
| `shared/umg.ts`                            | 导出 UE 的控件树格式                                                                          |
| `shared/moss.ts`                           | 从设计稿控件树取布局项，换算成 MOSS-Image 的布局 JSON（中心原点、像素、yxyx）                 |
| `web/src/pages/DesignPage.tsx`             | 页面、`send()`、生成参数、导出                                                                |
| `web/src/components/design/DesignChat.tsx` | 对话、发送、附件、控件引用、提问面板                                                          |
| `web/src/lib/demo-design.ts`               | 在线演示版在浏览器里模拟同一套接口和发送/接续行为                                             |

## MOSS-Image 布局出图（2026-10-24）

- 目的：整屏原画里要出现准确的中英文、并且按设计稿的位置摆放时，把画布上的文字块和主要元素转成 MOSS-Image 的布局 JSON 一起交给工作流，而不是只靠自然语言描述位置。
- 取布局项（`shared/moss.ts` 的 `designLayoutItems`）：只取有实际文字的文字块（跳过默认的 `Text Block` / `Text`）和用到了有 `prompt` 描述图片的控件；文字块的 `caption` 写字号、粗细、对齐和颜色，文字内容放在 `text` 里。坐标按 `CanvasPanelSlot` 逐层累加；非 `CanvasPanel` 容器里的控件和网页 `Frame` 根量不出像素位置，直接跳过；最多 24 项。宁可少给几项，不给错坐标。
- 编译布局（`mossBbox` / `mossLayoutJson`）：设计稿像素按实际出图尺寸等比换算，左 / 上 `floor`、右 / 下 `ceil`，越界裁剪，减画布中心后按 `yxyx` 输出；空框丢弃。输出单行 JSON：`summary.caption` 放这次的正向描述，`items` 里是 `text` / `object`，并带 `bbox_coord_space: "abs_centralized"`、`bbox_format: "yxyx"`。没有有效项时返回 `undefined`。
- 注入（`server/comfy.ts` 的 `localGenerate`）：只有工作流图里含 `{{layout}}` 才编译并注入，宽高用实际出图尺寸（`localSize`，64 的倍数，满足 MOSS 要求的 16 的倍数），不用设计稿尺寸；`auto` 模式下有布局时优先选同一用途里能接 `{{layout}}` 的工作流。工作流不吃 `{{layout}}`、或这次没有布局项时退化成普通文生图，不报错。
- 入口：`server/designs.ts` 的 `generateConcepts` 从 `cur.root`、`cur.images`、`cur.designSize` 取布局项传给 `localRun`；还没搭控件树（先出原画阶段）或控件位置量不出来时 `items` 为空，自动回退。`generateImages`（切图）和局部重绘的 `localRun` 不传布局。
- 工作流：内置 `game-moss-layout`（「MOSS-Image：按 JSON 布局出图」，`use: concept`，模型 `moss-image`），正向提示词写 `{{layout}}`；`fillWorkflow` 在没有布局字符串时用描述顶上，`checkWorkflow` 允许只有 `{{layout}}`、没有 `{{prompt}}` 的工作流。
- 验证：`shared/moss.test.ts` 覆盖 bbox 换算、JSON 格式和设计树提取；`server/local-image.test.ts` 覆盖 MOSS 模型文件、`game-moss-layout`、`fillWorkflow` 的 `{{layout}}` 回退和 `pickWorkflow` 的 `prefer`。**未做真实出图验证**：需要本机 ComfyUI 0.42+ 并下载 MOSS-Image 模型，本次没有在真实 ComfyUI 上跑过位置准确度。

## 本次行为变化（2026-10-24）

- 运行中发消息不再进页面本地队列：`DesignChat.tsx` 原来的 `queue` / `enqueue` 和「排队中，这一轮结束后发送」卡片已删除，`send()` 在 `running` 时统一交给 `onSend`。
- `send()`（`DesignPage.tsx`）在运行中不再 `saveDesign` 回写页面状态（AI 正在改树，写回去可能盖掉它刚改的部分），直接 `POST /designs/:id/steer`；没在跑才走 `/chat`。
- 带附件、标注、控件引用、风格的消息和纯文字走同一条补充通道：`steerText()` 把文字、附件、标注、原画标注、引用和风格说明拼给这一轮，`recordMessage()` 把原始输入记进对话。
- 收不下时消息马上进对话并记 `delivery.how = 'held'`，由 `startJob` 结束时的 `drainTurns()` 自动开始下一轮，真正开始时改成 `next`；用户点停止则还没处理的这些消息记为 `lost`，需要重新发。
- `beginChat()` 用进程内的 `starting` 占住设计并放一个占位 job：`save` / `addVersion` / `startJob` 之间的空档里 `/chat` 记进对话并排到这一轮结束后（`queued: true`）、`/steer` 记成待处理；`drainTurns()` 也先看 `starting`，没能开始新一轮时把消息放回队首、`delivery` 改回 `held`。
- 原画张数和「每张几版」拆成两个设置：`DesignChatInput` 新增 `conceptCount`（1–4，默认 3，见 `shared/design.ts`），只给「先出原画」用；`count` 仍然只表示每张图生成几版。前端「原画」按钮右键菜单设置原画张数（`design-concept-count`，按设计用 `useScopedSetting` 记住，第一次打开沿用当前 `count`），底部下拉永远显示「每张 N 版」；服务端 `chat()` 把 `input.conceptCount` 传给 `openDesignSession` 的 `conceptCount`，也作为 `buildDesignPrompt` 的原画张数（`conceptSection` 的「这一轮出 N 张」，原来传 `input.count`）；`input.count` 只用在 `generateImages` 生成切图，两者不互相覆盖。演示版 `demo-design.ts` 的 `runConcepts` 也用它。
- 演示版 `web/src/lib/demo-design.ts` 同步：`steer` 分支、`pendingChats` 接续、`pushUser` 记 `delivery`、`flushPending()` 把排队的 `held` 改成 `next` 再开下一轮、`stop` 改 `lost`。
- 插话时附件给的是上传目录里的绝对路径，不是这一轮工作目录里的副本；`delivery` 记的是服务端实际做成了什么，不能用界面本地队列冒充已送达。

## 回归验证

- `npm run typecheck`（含漏翻检查）
- `npm run lint`
- `npm run test:unit`
- `npm run test:e2e:wsl`（Windows 上在 WSL 里跑）；本次覆盖 `scripts/e2e/06-assist.mjs` 的「设计补充测试」（插话成功、无 job 时直接开一轮）、「设计接续测试」（CLI 没有插话通道时消息进对话并在这一轮结束后自动接着处理）和「设计停止测试」（停止时排队消息标 `lost`、停止后再发的消息能接着开始新一轮）。
- `npx vite build --mode demo` + `node scripts/ui-check.mjs`：`scripts/ui/04-design.mjs` 的「UI设计-原画张数」断言右键菜单能改一次出几张原画、选中状态跟着变。

## 待确认

- `pendingTurns` 只存在进程内，服务重启后不会自动接续这些消息；是否需要落盘（待确认）。
- 插话时附件用的是上传目录的绝对路径，如果这一轮的 CLI 被限制在工作目录里，可能读不到（待确认）。
