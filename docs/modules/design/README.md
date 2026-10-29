# design：UI 设计、AI 对话与导出

- status: verified
- source_paths: `web/src/pages/ComfyPage.tsx`, `web/src/components/comfy/`, `server/designs.ts`, `server/design-mcp.ts`, `server/design-capture.ts`, `server/asks.ts`, `shared/design.ts`, `web/src/components/design/`, `web/src/pages/DesignPage.tsx`, `web/src/lib/demo-design.ts`
- entry: `server/designs.ts`
- analyzed_at: 2026-10-24

## 职责

- UI 设计：按 UI 项目组织设计，每个设计有控件树、设计尺寸、风格说明、效果图和切图，和任务分开存储（数据目录下 `designs/`，每个设计一个 JSON，图片放在同一层的设计目录里）。
- AI 对话：用户描述要求，设计 AI 通过 MCP 工具改控件树、加图片和动画、出原画；一轮里可以同时出原画和切图。对话的输出样式和 Chat（任务）对话一模一样：已完成的消息（`DesignChat.tsx` 的 `ChatMessage`）同样给 `web/src/components/tasks/Messages.tsx` 的 `ChatReply` 传 `fold`，回复完成后思考、工具调用和中间的说明收进一个「查看 N 个文件 · 思考 N 次」的折叠行（`web/src/lib/fold.ts` 的 `foldStats`），点开看过程、再点收起。正在输出的 `LiveReply` 不传：它 `live` 恒为真，`FoldedRun` 遇到 `live` 就整段平铺（流式输出要边出边看），收尾后的折叠由已完成的消息负责。
- 原画与图片生成：先出整屏效果图给用户挑、确认模板，再按模板出切图；支持本机 ComfyUI 局部重绘、上传、重试。本机出整屏原画时，已下载 MOSS-Image、工作流选 auto、画布上又已有文字和带描述的图片，就优先用 MOSS-Image 的布局工作流，位置取自画布控件。本机还支持「处理类工作流」（去背景、图生图、放大）和把多个工作流串成一条链出图，见下面「处理类工作流与工作流链」。
- 标注：在效果图或原画上框选、画箭头、圈画、打点、涂蒙版，标出「改 / 新增 / 删除 / 保持」四种意思，随下一条消息把标注说明一起交给 AI；原画上的蒙版还能走「只重绘蒙版区域」。原画面板里的「发送标注给 AI」和对话框发送是同一条路径（见下方「原画标注的可见性与发送」）。
- 导出：导出 ZIP、JSON、React 网页，或把切图和控件树导出到项目目录，给 UE 用的格式见 [umg-export](../../umg-export.md)。
- 页面截图：设计 AI 要「看」页面时，向正在盯着这个设计的页面要一张截图。
- 待确认的提问：AI 和 CLI 的提问、审批走 `server/asks.ts`，对话里弹问题面板，回答作为一条消息发回去。

## 入口与数据流

- 页面入口：`web/src/pages/DesignPage.tsx` 管页面状态、参数和 `send()`；`web/src/components/design/DesignChat.tsx` 是对话面板（输入框、附件、控件引用、提问面板），对话主体用共享的 `ConversationShell` 和 `useConversationScroll`（`web/src/components/chat/ConversationShell.tsx`），设计特化（工具栏、原画/图源/张数、标注、引用、进度、AI 分析、提问面板、排队与补充、停止）仍从 `DesignChat.tsx` 的 `children` 插槽和壳外的输入框区传进去，共享壳里没有设计专用分支；`web/src/components/design/useDesignEditor.ts` 管页面状态和轮询。
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
- 设计对话改用 Chat 模式同一套对话页壳（`web/src/components/chat/ConversationShell.tsx`）：原来 `DesignChat.tsx` 自己维护的 `useLayoutEffect` 贴底和 `<40px` 滚动判定删掉，统一用 `useStickToBottom`（只有用户真的往上滚才松开），并补上「回到底部」；消息区宽度/内边距和任务对话一致。
- 输出样式与 Chat 对话统一（`DesignChat.tsx` 的 `ChatMessage` 传 `fold`）：以前只有任务对话传 `fold`，设计页整轮过程（思考 + 每次工具调用 + 中间的说明）一路平铺，滚动很长。`fold` 只控制过程段的折叠，设计页特有的「需要的图片：n 张」、`DesignAnalysisCard`、`CitationChips`、`StyleTag`、`DeliveryLine`、`AnswerMessage` 走 `ChatReply` 的 `children` 和用户消息分支，不进折叠；`task` / `latest` 设计页没有对应的数据（没有 `Task`、没有「尾部刚发出的用户消息」分段），不传不影响折叠（`foldStats` / `splitFolds` / `segOpen` 都不读它）。生成图片时 `genImages` / `generateImages` 一进来就把 `job.phase` 改成 `images` 并清空 `job.parts`（出原画时同理改成 `concepts`），而 `designing` 要求 `phase === 'design'`，所以 `LiveReply` 和折叠后的 `ChatMessage` 不会同时渲染同一轮。回归：`scripts/ui/04-design.mjs` 的「UI设计-过程折叠」「UI设计-展开过程」。

## 原画标注的可见性与发送

- 背景：原画阶段的标注能力一直是齐的（`ConceptBoard` 的 `AnnotationToolbar` / `AnnotationLayer`，标注经 `doc.annotations` → `DesignPage.send()` → `annotationText` / `maskOf` 注入服务端），但工具栏原来只有图标、原画面板里没有发送入口，用户看不出那是标注工具，也不知道标完怎么发。
- 工具栏文字（`web/src/components/design/Annotations.tsx`）：`TOOLS` 里标注工具带 `text`（框选 / 箭头 / 画笔 / 打点 / 蒙版），`labels` 打开时 `ToolButton` 在图标下面显示它。只有 `ConceptBoard` 传 `labels`：画布（`Viewport`）和切图预览（`ImagesPanel`）上方已叠着别的控件、放不下两行，保持原来的纯图标。工具栏 `max-w-full` + `flex-wrap`，窄面板换行而不被裁掉；四种「意思」仍然只在选中时显示文字。
- 常显说明：`TOOL_HINTS` 给当前标注工具一句「怎么画」；已经有标注时改成「已经在底部按钮发出去」。蒙版还要勾「只重绘蒙版区域」，那一步由 `ConceptBoard` 底部单独说。
- 发送入口：`ConceptBoard` 底部提示行右侧在 `mine.length > 0` 时出现「发送标注给 AI（n）」，回调 `onSendMarks`。`DesignPage` 把它转成 `request = { id, kind: 'send' }`，并先 `setChatOpen(true)`（对话栏收起时 `DesignChat` 没挂载，`request` 没人消费，不先打开就会点了没反应），`DesignChat` 的请求 effect 见到 `kind: 'send'` 就调输入框的 `send()`——不是只发固定文案，所以输入框里写的补充意见、`inpaint` 勾选、引用和风格都照常带上。原来「确认模板后开始搭界面」走的是同一个 `request`，仍然发 `request.text`。
- 「只重绘蒙版区域」的计数：这个勾选状态提升到 `DesignPage`（`inpaint` + `onInpaint`，按 `doc.annotations` 里有没有 concept 蒙版自动复位），因为走的 `api.inpaintConcept` 分支只发蒙版那一块、只清那一条标注。`ConceptBoard` 另收一个 `inpaintSupported`（`source.kind === 'local'`）：只有真能局部重绘时才把按钮改成「按蒙版重绘（1）」；默认生图方式是图片模型，不支持局部重绘，勾了也是整张重画、全部标注都发，按钮就保持「发送标注给 AI（n）」。三个条件合并到 `shared/design.ts` 的 `sendsMaskOnly({ inpaint, inpaintSupported, marks })`，界面按钮和 `shared/design.test.ts` 的真值表用例读同一份口径。
- 循环：标注 → `send()` 清空 `doc.annotations` → 服务端 `conceptSection` 带着标注说明出一轮新原画（新的一轮进缩略图列表）→ 可以在新图上接着标。确认模板后原画标注由 `approve()` 清掉。

## 回归验证

- `npm run typecheck`（含漏翻检查）
- `npm run lint`
- `npm run test:unit`
- `shared/design.test.ts` 的「只重绘蒙版要求「勾了 + 生图方式支持 + 真有蒙版」三个条件同时成立」：`sendsMaskOnly` 的真值表（三个条件单独缺失各一条，外加与 `canInpaint` 口径一致）；去掉 `inpaintSupported` 判断后这条用例会失败。
- `npm run test:e2e:wsl`（Windows 上在 WSL 里跑）；本次覆盖 `scripts/e2e/06-assist.mjs` 的「设计补充测试」（插话成功、无 job 时直接开一轮）、「设计接续测试」（CLI 没有插话通道时消息进对话并在这一轮结束后自动接着处理）和「设计停止测试」（停止时排队消息标 `lost`、停止后再发的消息能接着开始新一轮）。
- `npx vite build --mode demo` + `node scripts/ui-check.mjs`：`scripts/ui/04-design.mjs` 开头断言设计对话用的是共用消息区（`[data-conversation-scroll="messages"]`）；「UI设计-原画张数」断言右键菜单能改一次出几张原画、选中状态跟着变。
- 输出样式与 Chat 对话一致：`scripts/ui/04-design.mjs` 在「UI设计-引用消息」之后断言回复收尾后出现过程的折叠行，按可访问名定位（`getByRole('button', { name: /(其他操作|思考) \d+ 次/ })`，和 `02-task.mjs` 同一套口径，不依赖中文 `title`）；折叠行文字是这一段按实际做了什么拼出来的（设计工具不属于 read/edit/run/search/web，设计页常见的是「其他操作 N 次 · 思考 N 次」）。展开后看到「思考过程」，再收起后它卸载、「需要的图片：n 张」仍在（设计页特有的内容不跟着折叠没掉）；同时截图「UI设计-过程折叠」「UI设计-展开过程」。
- 原画标注：`scripts/ui/04-design.mjs` 的「UI设计-原画标注工具」断言原画阶段工具栏上框选 / 箭头 / 画笔 / 打点 / 蒙版五个文字标签可见；「UI设计-原画标注」在图上框一块、写说明后断言底部出现「发送标注给 AI（1）」且说明显示在标注卡片上；「UI设计-原画标注发出」点这个按钮，断言标注随用户消息出现在对话里、随后出第 2 轮原画；「UI设计-原画标注-收起对话」先收起 AI 对话栏再点这个按钮，断言对话栏自动打开、消息发出；「UI设计-原画标注-不支持局部重绘」画一个蒙版 + 一个框选后勾上「只重绘蒙版区域」，断言按钮仍是「发送标注给 AI（2）」而不是「按蒙版重绘（1）」（演示环境没有本机 ComfyUI，默认生图方式不支持局部重绘）。`ConceptBoard` 的根元素带 `data-concept-board`，用例按它定位，不和画布上的同类型工具栏混。

## 处理类工作流与工作流链（2026-10-25）

- 目的：原来的内置工作流都是单图文生图，用户要「去背景 → 图生图」这种叠加出图（前一段的输出图当后一段的输入），以及游戏开发常用的去背景、图生图、放大。
- 处理类工作流（`shared/local-image.ts`，都是 `kind: 'both'`，游戏和网页两边都列）：
  - `game-remove-bg`「去背景（透明底 PNG）」：`LoadImage` → `LoadBackgroundRemovalModel` → `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha` → `SaveImage`。节点和接法照 ComfyUI 官方模板 `utility_birefnet_remove_background`（本机 `/object_info` 核对过 6 个节点都存在）：`RemoveBackground` 出前景 mask，`JoinImageWithAlpha` 内部按 `1-mask` 算 alpha，所以必须先 `InvertMask`，否则抠出来的是背景。权重 `Comfy-Org/BiRefNet` 的 `background_removal/birefnet.safetensors`（登记为 `LOCAL_FILES` 的 `birefnet`，`LOCAL_MODELS` 的 `birefnet`，分组「图片处理」）。
  - `game-img2img`「图生图 · 风格复刻」：取 Z-Image 文生图图再用 `imageToImage` 改成从原图出发（`VAEEncode` → 采样器 `denoise: IMG2IMG_DENOISE` 0.6），参数只有一套。
  - `game-upscale`「放大 2 倍」：`ImageScaleBy`（lanczos、`UPSCALE_FACTOR` 2），插值放大不做细节修复；`upscale_models` 目录本机为空、没有可确认的权重地址，所以不做模型放大。
- 输入图约定：处理类工作流的入口是 `LoadImage` 读 `{{image}}`（`IMAGE_PLACEHOLDER`）。`needsInputImage(graph)` 判定「这张图要外部输入」，`pickWorkflow` 的 auto 模式**不选**这类工作流（自动流程手里没有原图，选了只能失败）；设计页「生成图片的方式」（`web/src/components/design/DesignChat.tsx` 的 `SourceSelect`）同样不列它们，ComfyUI 工作流页和链里手动指定时照样能用。`fillWorkflow` 新增 `image` 参数，不传时保留 `{{image}}` 交给链接力；`importableWorkflow` 导入 ComfyUI 时填 `example.png`。
- 工作流链（`shared/comfy-chain.ts`）：`ComfyChain = { id, name, steps: [{ workflowId, prompt, denoise? }] }`，1~6 段（`CHAIN_MAX_STEPS`）。纯函数：`chainNeedsImage`（第一段要不要外部原图）、`checkChain`（每段有没有 SaveImage、节点类型对不对、锚点会不会被当蒙版用）、`chainNotes`（能跑但结果可能不对的提示，例如去背景夹在链中间会丢 alpha）、`chainGraph`（合并成一张图）。
- 合并规则：第 i 段的节点 id 加 `s{i}_` 前缀；非最后一段的 `SaveImage` / `PreviewImage` 去掉（中间图不落盘、不重复上传）；下游的输入锚点节点被删除，它原来的消费者（`RemoveBackground.image`、`VAEEncode.pixels` 等）直接接上游出口 `[s{i}_节点id, 序号]`；第一段的锚点保留并填外部传进来的文件名。纯文生图的段接在链中间/末尾时用 `imageToImage` 现场加锚点（有 `KSampler` 设 `denoise`，`SamplerCustomAdvanced` 用 `SplitSigmasDenoise` 只走后半段）。
- 执行（`server/comfy.ts`）：`localGenerate` 里原样的「上传 → 提交 → 轮询 → 交图」抽成 `uploadImage` 和 `submitGraph`，`localGenerate` 改为调用它们（行为不变）；新增 `localGenerateChain`，复用这两个函数，先校验链（`checkChain`）、把第一段的原图上传一次，再 `chainGraph` 合并 + `fillChainPrompts` 填各段描述 + `fillWorkflow` 统一替换其余占位符，最后一次提交。进度、取消、队列、`markSavePrefix` 全部走现成逻辑。
- 接口：`GET /local-image/chains`（链 + 可用工作流 + 就绪集合）、`PUT /local-image/chains/:id`（保存前 `checkChain`，不合法直接 400）、`DELETE /local-image/chains/:id`、`POST /local-image/chains/:id/run`（传链 + 一张原图的 data URL，返回输出图 data URL）。链存在数据目录的 `comfy-chains.json`，和 `comfy-workflows.json` 分开，读写互不影响。
- 段的失效处理：链里存的某个工作流被删掉时，`checkChain` 收 `workflow: ComfyWorkflow | undefined`，按**原下标**报「第 n 段的工作流已经不在了」，不压缩数组（第一段要不要原图、锚点检查都依赖下标）；界面不 `filter` 掉失效段，单段链也照样校验。
- 链的描述口径：`localGenerateChain` 每段取「段自己的描述 → 本次传进来的描述 → 该工作流自己的说明」，链名（常是「新链」）不当提示词；试跑接口没填描述时传空串，由上面这条兜底。
- 前端：`web/src/components/comfy/ComfyChainPanel.tsx` 挂在 ComfyPage 的队列面板下面。可以新建链、选段（只列该分类或 `both` 的工作流，模型没下载的标出来）、上下移、删段、给图生图段单独写描述，上传一张原图试跑并看原图和输出图的预览。新建链的默认段由 `defaultChainSteps` 按特征挑「不吃提示词的纯处理段 → 吃提示词的段」（即「去背景 → 图生图」），不按 id 写死。不合法时显示 `checkChain` 的问题、`chainNotes` 的提醒；第一段要原图却还没选时提示。演示版 `web/src/lib/demo-backend.ts` 的 `chains` 分支能存链，试跑返回「演示版没有真的 ComfyUI」。
- ComfyUI 工作流页（`web/src/pages/ComfyPage.tsx`，2026-10-29 照设计稿 ComfyUI 画板重排）：
  - 入口：宽屏在最左图标栏（`web/src/components/layout/Sidebar.tsx` 的 `DESIGN_NAV`，`ActivityBar` 只在 `isDesignPage` 时画这一组），是设计模式的功能页——`isToolPage` 算它，打开时会话侧栏让开；图标栏顶上的「回到主页」从这里回到最近的设计页（`homeRoute(page)`），不跳回 Agent 模式。手机抽屉里仍列在设计模式的导航下。
  - 左栏：工作流按 `kind` 分「游戏 UI / 网页 UI / 图片处理（`both`）」三组，来源筛选「全部 / 内置 / 我的」，缩略块按用途上色（`USE_LOOK`），角上的点是模型下载了没有；底下常驻 ComfyUI 运行状态和「本机设置」。旧链接 `#/comfy/web` 没带工作流 id 时选第一个网页工作流。AI 生成、导入弹窗里自己选游戏 / 网页（`KindPick`），默认跟当前工作流。
  - 画布：`ComfyGraphView` 的 `fill` 撑满整块，`inset` 让开上面浮着的标题 + 工具条（量出实际高度，放不下一行时折成两行）和下面的试生成条；工具条的次要按钮在画布窄于 1000px 时只留图标。节点头和连线按 `nodeTone`（class_type 归到模型 / 条件 / 潜空间 / 图片）上色；点节点 → 右栏「节点」页签显示参数（`ComfyValueField` 和画布上同一个输入组件）；「整理」用 `layoutToken` 把手动拖乱的节点摆回 `layoutComfyGraph` 的位置。
  - 试生成：把当前工作流当成一段的工作流链走 `POST /local-image/chains/:id/run`（1024²、1 张），结果只记在这一页的「队列」页签里；没保存、或工作流要 `{{image}}` 原图时按钮禁用并写明原因（服务端按 id 取存下来的那份）。出错原样 toast，演示版返回「演示版没有真的 ComfyUI」。
  - 来源：`ComfyWorkflow.origin`（`import` 从 ComfyUI 导入、`template` 模板商店加的、`ai` AI 生成的；手动建、复制、旧数据为空），`importedWorkflow` 判「导入的」；列表筛选「全部 / 内置 / 我的 / 导入的」按它分，服务端 `addTemplate` 写 `template`。试生成可选比例（1024² / 3:2 / 2:3 / 16:9，只定比例，服务端 `localSize` 按模型基准边长换算）和张数 1~4，经 `POST /local-image/chains/:id/run` 的 `width` / `height` / `count`（`chainSize` 把坏值退回 1024，不传仍是 1024² 一张）。
  - 右栏页签：说明（字段、用途块、占位符、问题、三条「AI 优化」快捷要求）/ 节点 / 模型（当前工作流用到的内置模型的文件、下载状态和进度，缺的一键下载；外接 ComfyUI 或自己的模型不检查）/ 队列（试生成、`ComfyQueuePanel`、`ComfyChainPanel`）。
  - 回归：`scripts/ui/04-design.mjs` 的 ComfyUI 段（图标栏入口只在设计模式出现、节点图适应、点节点出参数、从图标栏切回 Agent 模式）、`scripts/ui/08-misc.mjs`（模板商店、工作流链）。
- 回归：`shared/comfy-chain.test.ts`（两段 / 三段链的接线、中间图不落盘、纯文生图段改写成图生图、四种组合合并后无断线）、`shared/local-image.test.ts`（三个处理类工作流的节点和连线、`imageToImage` 两种采样器、auto 不选需要输入图的工作流、`{{image}}` 填空与保留）、`server/local-image.test.ts`（内置工作流通过 `checkWorkflow`）。
- 真实 ComfyUI 验证（本机 0.42.0，`/object_info` 核对 6 个节点存在）：把合并后的链直接 `POST /prompt` 提交——「图生图 → 放大」带一张真实 PNG 时**被 ComfyUI 接受**（节点图和连线合法）；含去背景的链只报 `bg_removal_name: 'birefnet.safetensors' not in []`，即 `models/background_removal` 没装权重，与节点图无关。**完整出图未跑通**：去背景要下载 BiRefNet 权重（设置 → 本机生图 → 「图片处理」），且 Z-Image 权重是否就绪本次未确认。

## 待确认

- `pendingTurns` 只存在进程内，服务重启后不会自动接续这些消息；是否需要落盘（待确认）。
- 插话时附件用的是上传目录的绝对路径，如果这一轮的 CLI 被限制在工作目录里，可能读不到（待确认）。

## 页面布局与设计类型下拉（2026-10-29）

- 照设计稿 `Design.dc.html`：打开的设计是三块圆角面板并排（`App.tsx` 的 `splitPage` 把 `page: 'design'` 且 `id` 不是 `new` / `home` 的路由算进去）——左边 AI 对话（默认 320，拖动条在右缘）、中间画板、右边检查器（默认 280）。
- 设计名和保存状态在对话栏标题行，收起对话栏后回到画板标题行；收起按钮在对话栏标题行，打开按钮在画板标题行。
- 画板标题行夹在两栏中间，只放阶段条（`StageSteps`：原画 → 界面，就是原来的「原画 / 界面」切换，确认模板后原画打勾）、尺寸、风格、版本、撤销重做、「更多」（动画面板开关 + 本机 ComfyUI）和导出；用 `@container` 在窄的时候收起风格文字和阶段圆点，放不下时横向滚动兜底。
- 侧栏 `SidebarDesigns.tsx` 顶部是「UI 设计 / 模型设计」下拉（选择记在本机 `agent-panel:design-mode`）。模型设计列的是 Agent 项目里 `Task.modelDesign` 的顶层对话（ADR 0025），按项目分组，点进对话页；新建模型对话的入口还没有接到界面上，空时只显示说明。
- 回归：`scripts/ui/04-design.mjs` 在项目行折叠检查之后切到「模型设计」再切回。
