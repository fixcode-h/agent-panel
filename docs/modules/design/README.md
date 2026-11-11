# design：ComfyUI 工作流、风格库与 UI 设计插件的入口

- 状态：documented
- 职责：ComfyUI 工作流页和工作流链、风格库、浏览器扩展、旧的 UI 设计地址跳转；UI 设计本身在 UI 设计插件里（图标栏里的插件整页）
- 源码：`web/src/pages/ComfyPage.tsx`, `web/src/components/comfy/`, `server/comfy.ts`, `server/styles.ts`, `server/browser-ext-routes.ts`, `shared/local-image.ts`, `shared/comfy-chain.ts`, `shared/moss.ts`, `shared/style-types.ts`
- 入口：`web/src/pages/ComfyPage.tsx`
- 关键词：UI 设计插件、ComfyUI、工作流链、风格库、MOSS、浏览器扩展
- 更新：2026-11-11

## 职责

- 面板没有单独的「设计模式」（2026-11-11 用户要求，插件接口 5 去掉了 `designModes` 和 `#/pdesign`）：侧栏顶上的模式切换只有 Agent、Chat 两个。UI 设计插件（fixcode-h/agent-plugins 的 `ui-design`，2026-11-11 以前是面板自带的）和 Blender 插件的模型设计一样，是图标栏里的插件整页（`#/plugin/ui-design/ui/<设计>/<子页>`），左边的项目列表由插件自己画（`PluginPage.split`）。
- 旧地址：`#/design/<设计稿>/<子页>`（面板自带 UI 设计时）和 `#/pdesign/ui/<设计稿>/<子页>`（设计模式时）在 `App.tsx` 的 `parseHash` 里换成 `#/plugin/ui-design/ui/<设计稿>/<子页>`，地址栏同时改成新地址；对话里旧的 `design` 服务的工具名归 UI 设计插件显示（`shared/tool-names.ts`）。
- ComfyUI 工作流页：内置和自己的工作流、节点图、AI 优化、试生成、工作流链；入口在图标栏的通用功能里，哪个模式下都有。
- 风格库：`/api/styles`（`server/styles.ts`，数据 `styles.json`，旧版的 `designs/_styles.json` 读得到就接着用），设置里管理，对话出图和 UI 设计插件都用。
- 浏览器扩展：`/api/designs/browser`（`server/browser-ext-routes.ts`，地址沿用以前挂在设计接口下的，扩展和旧版本认它），借网页版图片模型出图。
- 插件要用的面板模块按「开放模块」清单给（`shared/plugins/host-modules.json`）：风格库类型、本机出图提示词、浏览器扩展状态、MOSS、ComfyUI 网页弹窗等。

## UI 设计在哪

代码、单测、模块文档（数据流、关键文件、原画还原各期、回归记录）、UMG 导出格式和相关教训都搬到了插件仓库 fixcode-h/agent-plugins 的 `ui-design/`：模块文档是 `ui-design/docs/design-module.md`，导出格式 `ui-design/docs/umg-export.md`，教训 `ui-design/docs/lessons/`。设计稿数据从数据目录的 `designs/` 搬到 `plugin-data/ui-design/designs/`（插件第一次启用时搬）。

## MOSS-Image 布局出图（2026-10-24）

- 目的：整屏原画里要出现准确的中英文、并且按设计稿的位置摆放时，把画布上的文字块和主要元素转成 MOSS-Image 的布局 JSON 一起交给工作流，而不是只靠自然语言描述位置。
- 取布局项（`shared/moss.ts` 的 `designLayoutItems`）：只取有实际文字的文字块（跳过默认的 `Text Block` / `Text`）和用到了有 `prompt` 描述图片的控件；文字块的 `caption` 写字号、粗细、对齐和颜色，文字内容放在 `text` 里。坐标按 `CanvasPanelSlot` 逐层累加；非 `CanvasPanel` 容器里的控件和网页 `Frame` 根量不出像素位置，直接跳过；最多 24 项。宁可少给几项，不给错坐标。
- 编译布局（`mossBbox` / `mossLayoutJson`）：设计稿像素按实际出图尺寸等比换算，左 / 上 `floor`、右 / 下 `ceil`，越界裁剪，减画布中心后按 `yxyx` 输出；空框丢弃。输出单行 JSON：`summary.caption` 放这次的正向描述，`items` 里是 `text` / `object`，并带 `bbox_coord_space: "abs_centralized"`、`bbox_format: "yxyx"`。没有有效项时返回 `undefined`。
- 注入（`server/comfy.ts` 的 `localGenerate`）：只有工作流图里含 `{{layout}}` 才编译并注入，宽高用实际出图尺寸（`localSize`，64 的倍数，满足 MOSS 要求的 16 的倍数），不用设计稿尺寸；`auto` 模式下有布局时优先选同一用途里能接 `{{layout}}` 的工作流。工作流不吃 `{{layout}}`、或这次没有布局项时退化成普通文生图，不报错。
- 入口：`ui-design/server/designs.ts` 的 `generateConcepts` 从 `cur.root`、`cur.images`、`cur.designSize` 取布局项传给 `localRun`；还没搭控件树（先出原画阶段）或控件位置量不出来时 `items` 为空，自动回退。`generateImages`（切图）和局部重绘的 `localRun` 不传布局。
- 工作流：内置 `game-moss-layout`（「MOSS-Image：按 JSON 布局出图」，`use: concept`，模型 `moss-image`），正向提示词写 `{{layout}}`；`fillWorkflow` 在没有布局字符串时用描述顶上，`checkWorkflow` 允许只有 `{{layout}}`、没有 `{{prompt}}` 的工作流。
- 验证：`shared/moss.test.ts` 覆盖 bbox 换算、JSON 格式和设计树提取；`server/local-image.test.ts` 覆盖 MOSS 模型文件、`game-moss-layout`、`fillWorkflow` 的 `{{layout}}` 回退和 `pickWorkflow` 的 `prefer`。**未做真实出图验证**：需要本机 ComfyUI 0.42+ 并下载 MOSS-Image 模型，本次没有在真实 ComfyUI 上跑过位置准确度。

## 处理类工作流与工作流链（2026-10-25）

- 目的：原来的内置工作流都是单图文生图，用户要「去背景 → 图生图」这种叠加出图（前一段的输出图当后一段的输入），以及游戏开发常用的去背景、图生图、放大。
- 处理类工作流（`shared/local-image.ts`，都是 `kind: 'both'`，游戏和网页两边都列）：
  - `game-remove-bg`「去背景（透明底 PNG）」：`LoadImage` → `LoadBackgroundRemovalModel` → `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha` → `SaveImage`。节点和接法照 ComfyUI 官方模板 `utility_birefnet_remove_background`（本机 `/object_info` 核对过 6 个节点都存在）：`RemoveBackground` 出前景 mask，`JoinImageWithAlpha` 内部按 `1-mask` 算 alpha，所以必须先 `InvertMask`，否则抠出来的是背景。权重 `Comfy-Org/BiRefNet` 的 `background_removal/birefnet.safetensors`（登记为 `LOCAL_FILES` 的 `birefnet`，`LOCAL_MODELS` 的 `birefnet`，分组「图片处理」）。
  - `game-img2img`「图生图 · 风格复刻」：取 Z-Image 文生图图再用 `imageToImage` 改成从原图出发（`VAEEncode` → 采样器 `denoise: IMG2IMG_DENOISE` 0.6），参数只有一套。
  - `game-upscale`「放大 2 倍」：`ImageScaleBy`（lanczos、`UPSCALE_FACTOR` 2），插值放大不做细节修复；`upscale_models` 目录本机为空、没有可确认的权重地址，所以不做模型放大。
- 输入图约定：处理类工作流的入口是 `LoadImage` 读 `{{image}}`（`IMAGE_PLACEHOLDER`）。`needsInputImage(graph)` 判定「这张图要外部输入」，`pickWorkflow` 的 auto 模式**不选**这类工作流（自动流程手里没有原图，选了只能失败）；设计页「生成图片的方式」（`ui-design/web/src/components/design/DesignChat.tsx` 的 `SourceSelect`）同样不列它们，ComfyUI 工作流页和链里手动指定时照样能用。`fillWorkflow` 新增 `image` 参数，不传时保留 `{{image}}` 交给链接力；`importableWorkflow` 导入 ComfyUI 时填 `example.png`。
- 工作流链（`shared/comfy-chain.ts`）：`ComfyChain = { id, name, steps: [{ workflowId, prompt, denoise? }] }`，1~6 段（`CHAIN_MAX_STEPS`）。纯函数：`chainNeedsImage`（第一段要不要外部原图）、`checkChain`（每段有没有 SaveImage、节点类型对不对、锚点会不会被当蒙版用）、`chainNotes`（能跑但结果可能不对的提示，例如去背景夹在链中间会丢 alpha）、`chainGraph`（合并成一张图）。
- 合并规则：第 i 段的节点 id 加 `s{i}_` 前缀；非最后一段的 `SaveImage` / `PreviewImage` 去掉（中间图不落盘、不重复上传）；下游的输入锚点节点被删除，它原来的消费者（`RemoveBackground.image`、`VAEEncode.pixels` 等）直接接上游出口 `[s{i}_节点id, 序号]`；第一段的锚点保留并填外部传进来的文件名。纯文生图的段接在链中间/末尾时用 `imageToImage` 现场加锚点（有 `KSampler` 设 `denoise`，`SamplerCustomAdvanced` 用 `SplitSigmasDenoise` 只走后半段）。
- 执行（`server/comfy.ts`）：`localGenerate` 里原样的「上传 → 提交 → 轮询 → 交图」抽成 `uploadImage` 和 `submitGraph`，`localGenerate` 改为调用它们（行为不变）；新增 `localGenerateChain`，复用这两个函数，先校验链（`checkChain`）、把第一段的原图上传一次，再 `chainGraph` 合并 + `fillChainPrompts` 填各段描述 + `fillWorkflow` 统一替换其余占位符，最后一次提交。进度、取消、队列、`markSavePrefix` 全部走现成逻辑。
- 接口：`GET /local-image/chains`（链 + 可用工作流 + 就绪集合）、`PUT /local-image/chains/:id`（保存前 `checkChain`，不合法直接 400）、`DELETE /local-image/chains/:id`、`POST /local-image/chains/:id/run`（传链 + 一张原图的 data URL，返回输出图 data URL）。链存在数据目录的 `comfy-chains.json`，和 `comfy-workflows.json` 分开，读写互不影响。
- 段的失效处理：链里存的某个工作流被删掉时，`checkChain` 收 `workflow: ComfyWorkflow | undefined`，按**原下标**报「第 n 段的工作流已经不在了」，不压缩数组（第一段要不要原图、锚点检查都依赖下标）；界面不 `filter` 掉失效段，单段链也照样校验。
- 链的描述口径：`localGenerateChain` 每段取「段自己的描述 → 本次传进来的描述 → 该工作流自己的说明」，链名（常是「新链」）不当提示词；试跑接口没填描述时传空串，由上面这条兜底。
- 前端：`web/src/components/comfy/ComfyChainPanel.tsx` 挂在 ComfyPage 的队列面板下面。可以新建链、选段（只列该分类或 `both` 的工作流，模型没下载的标出来）、上下移、删段、给图生图段单独写描述，上传一张原图试跑并看原图和输出图的预览。新建链的默认段由 `defaultChainSteps` 按特征挑「不吃提示词的纯处理段 → 吃提示词的段」（即「去背景 → 图生图」），不按 id 写死。不合法时显示 `checkChain` 的问题、`chainNotes` 的提醒；第一段要原图却还没选时提示。演示版 `web/src/lib/demo-backend.ts` 的 `chains` 分支能存链，试跑返回「演示版没有真的 ComfyUI」。
- ComfyUI 工作流页（`web/src/pages/ComfyPage.tsx`，2026-10-29 照设计稿 ComfyUI 画板重排）：
  - 入口（2026-11-11 起）：图标栏的通用功能里（`web/src/components/layout/Sidebar.tsx` 的 `NAV`），哪个模式下都有；视频画质增强也用 ComfyUI，设计模式又要拆成插件，所以不再挂在设计模式下。打开时会话侧栏让开，「回到主页」回到最近的会话页。
  - 左栏：工作流按 `kind` 分「游戏 UI / 网页 UI / 图片处理（`both`）」三组，来源筛选「全部 / 内置 / 我的」，缩略块按用途上色（`USE_LOOK`），角上的点是模型下载了没有；底下常驻 ComfyUI 运行状态和「本机设置」。旧链接 `#/comfy/web` 没带工作流 id 时选第一个网页工作流。AI 生成、导入弹窗里自己选游戏 / 网页（`KindPick`），默认跟当前工作流。
  - 画布：`ComfyGraphView` 的 `fill` 撑满整块，`inset` 让开上面浮着的标题 + 工具条（量出实际高度，放不下一行时折成两行）和下面的试生成条；工具条的次要按钮在画布窄于 1000px 时只留图标。节点头和连线按 `nodeTone`（class_type 归到模型 / 条件 / 潜空间 / 图片）上色；点节点 → 右栏「节点」页签显示参数（`ComfyValueField` 和画布上同一个输入组件）；「整理」用 `layoutToken` 把手动拖乱的节点摆回 `layoutComfyGraph` 的位置。
  - 试生成：把当前工作流当成一段的工作流链走 `POST /local-image/chains/:id/run`（1024²、1 张），结果只记在这一页的「队列」页签里；没保存、或工作流要 `{{image}}` 原图时按钮禁用并写明原因（服务端按 id 取存下来的那份）。出错原样 toast，演示版返回「演示版没有真的 ComfyUI」。
  - 来源：`ComfyWorkflow.origin`（`import` 从 ComfyUI 导入、`template` 模板商店加的、`ai` AI 生成的；手动建、复制、旧数据为空），`importedWorkflow` 判「导入的」；列表筛选「全部 / 内置 / 我的 / 导入的」按它分，服务端 `addTemplate` 写 `template`。试生成可选比例（1024² / 3:2 / 2:3 / 16:9，只定比例，服务端 `localSize` 按模型基准边长换算）和张数 1~4，经 `POST /local-image/chains/:id/run` 的 `width` / `height` / `count`（`chainSize` 把坏值退回 1024，不传仍是 1024² 一张）。
  - 右栏页签：说明（字段、用途块、占位符、问题、三条「AI 优化」快捷要求）/ 节点 / 模型（当前工作流用到的内置模型的文件、下载状态和进度，缺的一键下载；外接 ComfyUI 或自己的模型不检查）/ 队列（试生成、`ComfyQueuePanel`、`ComfyChainPanel`）。
  - 回归：`scripts/ui/04-design.mjs` 的 ComfyUI 段（图标栏入口在 Agent 模式下也有、节点图适应、点节点出参数、从图标栏切回 Agent 模式）、`scripts/ui/08-misc.mjs`（模板商店、工作流链）。
- 回归：`shared/comfy-chain.test.ts`（两段 / 三段链的接线、中间图不落盘、纯文生图段改写成图生图、四种组合合并后无断线）、`shared/local-image.test.ts`（三个处理类工作流的节点和连线、`imageToImage` 两种采样器、auto 不选需要输入图的工作流、`{{image}}` 填空与保留）、`server/local-image.test.ts`（内置工作流通过 `checkWorkflow`）。
- 真实 ComfyUI 验证（本机 0.42.0，`/object_info` 核对 6 个节点存在）：把合并后的链直接 `POST /prompt` 提交——「图生图 → 放大」带一张真实 PNG 时**被 ComfyUI 接受**（节点图和连线合法）；含去背景的链只报 `bg_removal_name: 'birefnet.safetensors' not in []`，即 `models/background_removal` 没装权重，与节点图无关。**完整出图未跑通**：去背景要下载 BiRefNet 权重（设置 → 本机生图 → 「图片处理」），且 Z-Image 权重是否就绪本次未确认。
