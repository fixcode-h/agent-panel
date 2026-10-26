# shared：前后端共享的数据模型、流程图和执行引擎

- status: inferred
- source_paths: `shared/`
- entry: `shared/schema.ts`、`shared/clis.ts`
- analyzed_at: 2026-10-25（本轮新增「派子对话一定挂到计划步骤」（`ensureChildStep` / `auto` 步骤）关联 `reopenedAt` 用时重算、`send_to_conversation` 带标题和复用已完成步骤；合并语义和等待项种类沿用同日上一轮分析）

## 职责

- 数据结构：Agent、工作流、流程、项目、任务、设置等的 zod schema 和类型（`shared/schema.ts`）。
- 设置 schema 和默认值：后台命令并发 `backgroundLimit` 默认 64（范围 1–64，`shared/schema.ts`）；子对话并发上限已去掉，`Settings` 没有 `childConcurrency`、`Task` 没有 `childLimit`，旧 settings.json / task JSON 里的这两个字段由 zod 读时剥离、不报错。
- 本机代理的默认值（`shared/proxy.ts`）：`DEFAULT_PROXY_PORT` / `DEFAULT_PROXY_URL` 是设置页「网络代理」的占位符和说明、CLI 环境变量示例（`PROXY_ENV_EXAMPLE`）、自动探测端口顺序（`LOCAL_PROXY_PORTS`）的唯一出处；`shared/schema.ts` 的 `proxy` 字段注释也指向它。要换默认代理端口只改这一处，别处一律 import（`npm run lint` 的 `rules-check` 会拦住 ts / tsx / mjs / json 里再写的字面量）。默认端口在 v2rayN 里默认跑 socks，mixed 在 10814，纯 socks 时 `ProxyAgent` 用不了、探测会失败。`LOCAL_PROXY_PORTS` 里除了默认端口还有 Clash 的混合端口、老版 v2rayN 的 http 入站、Clash 的 socks 口、Clash Verge Rev 的混合端口和通用的 1080；`MAX_LOCAL_PROXIES`（3）决定真正尝试几个，所以默认端口必须排在前几位。具体顺序和取值只看 `shared/proxy.ts`。
- CLI 注册表：内置 CLI 定义在 `shared/clis/*.json`，由 `shared/clis.ts` 加载；参数拼装、输出解析方式、支持的能力、Skill 和说明文件位置都写在定义里，面板其他地方按字段走。Agent 的回复语言跟随面板设置，完整规则（正文和思考过程）、提示词末尾的提醒句、Command Code 通过 mod 追加系统提示词时的插件源码都在 `shared/prompt-lang.ts`。
- 流程图逻辑：节点、连线、子流程、引用解析、布局和任务规划（`shared/flow.ts`）。
- 工作流执行引擎：按流程图调度节点，处理开始 / 验收 / 结束流程、步骤串行、续跑和主 Agent 调度（`shared/engine.ts`）；真实执行和在线演示的模拟执行共用。
- 对话的执行计划（`shared/plan.ts`）：Agent 用 `set_plan` 交步骤，这里把交上来的列表和面板自己的状态对齐，界面画计划弹窗、服务端改状态都用它。规则逐条写在文件头注释里：最多两层（主步骤和子步骤）；整份列表和只交变更（`partial`）两种提交方式；完成的步骤锁死，改它删它都无效；全部完成就收起计划（`doneAt`）；等待中的步骤由 `settleWait` 按 `kind` + `ref` 收口；收尾（`wrapUp`）由面板加在最后，Agent 漏写、删掉、挪到中间都会被放回。
  2026-10-25 修掉的合并语义、新加的等待项种类，以及对应的回归，之后改这个文件要守住：
  - 合并一层列表时，`partial: true` 下**位置由计划原有顺序决定，交上来的顺序只决定谁被更新**，这次新加的步骤追加到最后。以前漏写项按旧下标 `splice` 回去，模型把新步骤写在前面时两条会互换位置（id 顺序和数组顺序不一致），界面上的计数跟着来回变。
  - 交上来的项对回已有项：先按 `id`，其次标题**完全一致**，再次归一化后一致（`normTitle`：NFKC + 去掉空白 / 标点 / 符号 + 小写）。更大幅度的标题改写**不猜**——把「修登录文案」并到「修登录超时」会把没做完的步骤标成完成，比多出一条步骤更糟；这时新加一步，并在返回给 Agent 的说明里点名那些没对上的未完成步骤「这次没交上来，还按原来的状态留在计划里」。
  - `settleWait` 成功时清掉 note 里面板写的过时说明（前缀是导出的常量 `HOLD_PREFIX`「还在等它：」），Agent 自己写的备注不动。
  - 等待项 `PlanWait.kind` 有三种：`background`（后台命令编号）、`child`（子对话 id）、`helper`（`spawn_agents` 派出的子任务步骤 id）。`helper` 由 `shared/engine.ts` 的 `spawn` 用 `bindWait` 登记，`settleHelpers` 里的 `settleHelperWaits` 按子任务的真实结果收口：成功标完成，失败或被终止退回进行中并写清原因。
  - 回归：`shared/plan.test.ts`（标题改写对回旧步、`id` 顺序与数组顺序不一致加 `partial`、note 清理、子任务等待）和 `server/orch-mcp.test.ts`（`spawn_agents` 的 `step`）。
  - 收尾步骤的种类由 `wrapUpKind`（`shared/plan.ts`）一个纯函数判定，口径和提示词「授权情况」那段一致：子对话在独立分支里是 `merge`（合回父对话所在的分支）、P4 工作区共用目录是 `p4`（按文件类型分 changelist）；**父对话**在 Git 仓库、配了远端，并且明确授权推送（项目设置「允许直接推送」，或这个对话里用户已经同意）时是 `push`（`收尾：推送到远端`）。`deny` 和 `answered: 'denied'` 不加，「第一次问一次」还没回答时也不加（等回答完、下一轮再加）；P4 工作区、SVN、没有远端的仓库也不加——P4 建在 git 仓库目录下时也会认到 `.git`，推上去的是旧历史；没有远端的仓库这一步永远做不了。种类、标题、备注集中在 `WRAP_UP`，改文案只改这一处。
    `applyPlan` 的 `wrapUp` 参数有三种取值，别混：不传是「这个对话不用收尾」（合回、分 changelist 这类一次性收尾就不做了）、`'none'` 是「明确不推送」（只有它会把计划里还挂着的推送收尾删掉，连同 Agent 照抄的那条同标题步骤）、`undefined` 以外的空值都不算。`server/tasks.ts` 的 `planWrapUp` 只在策略是 `deny` 或用户 `denied` 时回 `'none'`；项目目录没取到时回 `undefined`，这一轮算不出来就保持收尾原样，否则会误删、还告诉模型「不用推了」。
    推送收尾不像合回那样只加一次：只要这份计划里还没有 `push` 收尾、又有步骤，就会加上——一轮就把事做完、步骤全标完成时新开的计划 `first` 必然是 false，只看 `first` 会漏，那一轮的改动就永远不推。已经有推送收尾的（做完也好、挂着也好）仍按 `todo || open.length` 决定要不要重新打开。
  - 完成由谁标：`merge` 是面板在执行合并的地方标（Agent 自己标会被退回，`applyPlan` 里那段特判）；`p4` 和 `push` 是 Agent 做完自己 `set_plan` 标完成——面板拿不到 `git push` 的结果，不像合并那样有事件可依。`WRAP_UP.push.note` 里写清了「推成功后把这步标完成」。
  - 授权中途变了（用户拒绝推送、设置改成不推送）时，`applyPlan` 在没有 `wrapUp` 的那次调用里用 `dropWrapUp` 删掉还没做完的 `push` 收尾并在返回说明里讲一句：留着一步永远做不了的收尾，父对话的计划就永远算没做完。
  - **派子对话一定挂到计划里的某一步**（`ensureChildStep`，用户 2026-10-25 报「一堆子对话在跑、计划面板还停在上次已完成」）：`create_conversation` / `send_to_conversation` 没点名 `step` 时走它——有进行中的计划就复用 `childStepId`（标题对上某一步、或已在等这个子对话）；对不上就**补一步**（标题 `子对话：<子对话标题>`，标 `auto: true`）；上一份计划已经 `doneAt` 就**重开它**（清 `doneAt`）再补，不新开一份——这些子对话属于同一次统筹，用户要看的是同一个计划列表。以前 `childStepId` 在 `activePlan()` 为空时返回空串，`bindWait` 的 `if (!id) return ''` 静默跳过，子对话一个都挂不上。
    - 补步骤时 `childStepId` 传 `fallback: false`：不去退回「正在做的那一步」，否则几个同时派的子对话全挤在同一格。
    - `auto` 步骤在 `applyPlan` 里受保护（照 `ensureWrapUp` 的模式）：Agent 交整份计划时不知道有这一步、不会写它，合并后没交上来的按原索引插回，也不计入 `dropped`（不提示「已从计划里去掉」）、不计入 `left`（不点名让它交）。Agent 自己写了同标题的步骤会按标题对回自动那一步，不会出现两条。
    - `auto` 步骤不参与 `childStepId` 的标题比对：它们的标题都带 `子对话：` 前缀，互相会误配成同一步。
    - 收尾永远在最后：补的步骤插在 `wrapUp` 那一步前面（已做完的收尾也算——它仍是这份计划的最后一步）。
    - `finish_plan`（`finishPlan`，多带一个 `kids` 参数，`shared/engine.ts` 的 `kidsOf` 取子对话列表）在还有子对话没合回时点名提醒——计划一结束它们就挂不上了。
    - 回归：`shared/plan.test.ts`（计划结束后派子对话重开并补一步、**重开后总用时从重开时刻算**、多个子对话进同一份计划、对不上才补、能对上就不补、补的步骤在收尾前、`set_plan` 不抹掉自动步骤、同标题不重复、**给已做完的子对话再发消息复用原步骤**、`finish_plan` 提醒）和 `server/orchestrator.test.ts`（结束计划后派子对话自动补一步）。
  - 面板（`web/src/components/tasks/PlanPanel.tsx`）不加分支：`ensureChildStep` 保证有子对话就一定有进行中的计划，`shownPlan` 取最后一份计划本来就会渲染它，再加一条「没有计划但有子对话」的分支永远走不到。折叠头自动跟着变：`planHeadline` 只看 `doneAt`，重开时清空它，三态就从「已结束」回到「计划 n/m」。
    - **重开要重置总用时的起点**（`TaskPlan.reopenedAt` + `planSpan`）：只清 `doneAt` 会把上一轮的历史时长并进这一轮（计划 10:00 建、10:10 结束、11:00 重开，面板立刻显示 1 小时）。`planSpan` 的起点取 `max(原起点, reopenedAt)`。
    - **`send_to_conversation` 补步骤时必须带子对话标题**（`kidTitleOf` 从 `listConversations` 取）：没标题时会退化成 `子对话：<id>`，用户看不出是哪个子对话。它对应的子对话原来那一步已经 `done` 时**重新打开那一步**（`setStatus(revisit, 'pending')`）而不另开一格——`childStepId` 的 `own` 判定要求 `status !== 'done'`，否则同一件事会在计划里出现两格。
  - 回归：`shared/plan.test.ts`（父对话 push 收尾加在最后、删掉 / 挪到中间都放回最后、做完后又有新步骤就重新打开、一轮改完的第二份计划照样到推送这一步、`wrapUpKind` 的授权边界含 P4 和没有远端、明确不推送后收尾连同抄写的那条一起去掉、算不出来时不删）和 `server/engine-steps.test.ts`（授权段让模型照着计划最后一步做不另写一条、父对话在独立分支里时先合回再推）。
- 内置内容：内置角色和工作流模板在 `shared/builtin/`，界面文案的英文在 `shared/locales/en/`。
  本机副本：内置角色每次启动、每次保存都按当前定义同步（`shared/builtin/install.ts` 的 `upgradeBuiltinAgents`、`core.ts` 的 `builtinKey` / `syncCore`，[ADR 0015](../../adr/0015-builtin-roles-follow-definition.md)），用户改过的设定会被覆盖，覆盖前由 `server/index.ts` 备份。`legacy.ts` 的 `LEGACY_AGENT_FIELDS*` 现在只用来判断要不要备份和已合并角色能不能删；**指纹里不要引用会继续变的常量**（`SCENE_TEXT` 等），历史正文用 `LEGACY_SCENE_TEXT` 固定。内置工作流副本记 `builtinHash`（`workflowFingerprint`，坐标不算），内容还是那个指纹就升级，没记过的退回按 `LEGACY_WORKFLOWS` 比。
- 本机生图（`shared/local-image.ts`）：`LOCAL_FILES` 是 ComfyUI 的下载清单（`dir` / `file` / `url` / `gb`），`LOCAL_MODELS` 是按用途分组的模型条目（决定设置页「本机生图」列出什么、要多少显存，也是工作流可选的内置模型），`LOCAL_MODEL_GROUPS` 是分组顺序；同一文件还负责生成内置工作流的节点图、`{{prompt}}` / `{{negative}}` / `{{width}}` / `{{height}}` / `{{count}}` / `{{seed}}` / `{{layout}}` 的替换、工作流校验和自动挑选。
  2026-10-25 新增 `{{image}}`（`IMAGE_PLACEHOLDER`）和三个处理类内置工作流（`kind: 'both'`，游戏和网页都列）：`game-remove-bg`（`removeBgGraph`：`LoadBackgroundRemovalModel` + `RemoveBackground` + `InvertMask` + `JoinImageWithAlpha`，权重是 `LOCAL_FILES` 的 `birefnet` / `LOCAL_MODELS` 的 `birefnet`，分组「图片处理」`process`）、`game-img2img`（`imageToImage` 把任意带采样器和 VAE 的工作流改成图生图，`IMG2IMG_DENOISE` 0.6）、`game-upscale`（`upscaleGraph` 的 `ImageScaleBy`，`UPSCALE_FACTOR` 2）。`needsInputImage` 判定需要外部输入图的工作流，`pickWorkflow` 的 auto 模式跳过它们；`checkWorkflow` 允许只有 `{{image}}`、没有 `{{prompt}}` 的图；`fillWorkflow` 的 `image` 参数不传时保留占位符。`localWorkflow` 遇到 `family: 'birefnet'` 直接报错（处理类模型不能文生图），`builtinTemplates` 也不给处理类模型生成文生图模板。
- 工作流链（`shared/comfy-chain.ts`）：`ComfyChain`（`steps` 1~6 段，每段 `workflowId` / `prompt` / `denoise?`）和纯函数 `chainNeedsImage` / `checkChain` / `chainNotes` / `chainGraph`。`chainGraph` 把各段合成一张图：节点 id 加 `s{i}_` 前缀（`chainPrefix`）、非最后一段去掉 `SaveImage`、下游的 `{{image}}` 锚点节点删掉后把它的消费者直接接上游出口、第一段锚点填外部文件名；纯文生图的段接在后面时用 `imageToImage` 现加锚点。执行在 `server/comfy.ts` 的 `localGenerateChain`，复用 `uploadImage` / `submitGraph`。回归：`shared/comfy-chain.test.ts`。
  2026-10-24 新增 MOSS-Image（`family: 'moss'`，Apache-2.0，`base` 1024，`natural`）：`moss-image` 用 int8 权重（`diffusion_models` 5.4GB、`text_encoders` 7.3GB、`vae` 0.25GB，`vram` 16），`moss-image-bf16` 用 bf16 权重（10.2GB、19.3GB 加同一个 `vae`，`vram` 32）。`localWorkflow` 的 `moss` 分支：`UNETLoader` + `CLIPLoader`（`type: moss_image`）+ `VAELoader` + `SkipLayerGuidanceDiTSimple`（`single_layers: '22'`，0–0.5）+ `KSampler`（25 步、CFG 2.5、`er_sde`、`simple`）；int8 和 bf16 共用同一节点图，文件按模型实际带的取。内置工作流 `game-moss-layout` 的正向提示词写 `{{layout}}`，没有布局时回退成描述。
- MOSS 布局（`shared/moss.ts`）：`designLayoutItems` 从设计稿控件树取布局项（有实际文字的文字块、用到了有描述图片的控件，只沿 `CanvasPanel` 累加绝对坐标，最多 24 项）；`mossBbox` 把设计稿像素按实际出图尺寸换算成以画布中心为原点、`yxyx` 的 bbox；`mossLayoutJson` 输出单行官方 JSON（`summary.caption`、`items` 的 `text` / `object`、`bbox_coord_space: abs_centralized`、`bbox_format: yxyx`），没有有效项时返回 `undefined`。宽高必须等于实际出图尺寸，换算依赖 `shared/umg.ts` 的 `canvasSlotRect`。
- 项目 AI 初始化的推荐结构和保存校验（`shared/project-init.ts` 的 `ProjectProposal`、`ProjectProposalSchema`）：推荐随项目以 `initResult` 保存（`shared/schema.ts` 里可选），重开项目设置时拿来和当前设置比对；旧项目没有该字段按「没有推荐」处理，不要求重新初始化。
- Skills / 命令库的结构（`shared/library.ts`）：`LibraryItem` / `LibraryCli` 是列表项和 CLI 目录，`LibraryFile` 是一个 Skill 或命令的内容。
  2026-10-26 起 `LibraryFile` 有三个字段：`content`（主文件内容）、`files`（旧字段，主文件以外的文件路径扁平列表）、`tree?`（`LibraryTree`＝`{ entries, truncated? }`，**目录和文件混在一张表里**，`LibraryEntry` 是 `{ path, type: 'file' | 'dir', size? }`，路径统一 `/`，同层目录在前、父目录一定排在子项前面）。`files` 必须等于 `tree.entries` 里 `type === 'file'` 的 path（同一个数据源，两个字段不能打架）；命令没有附带目录，`tree` 为 `undefined`。回归：`server/library.test.ts`、`server/project-skills.test.ts`。
  同一文件也是**附件路径安全规则的唯一出处**：`libraryEntryPath` 逐段校验相对路径（挡 `..`、`.`、空段、绝对路径、盘符、`\0` 和 Windows 非法字符，反斜杠统一当 `/`），服务端在 `server/library.ts` 的 `entryOf` 里再补一道 `realpath` 落在 Skill 目录内的校验（字符串层拦不住软链接）。上限常量 `LIBRARY_FILE_MAX_BYTES`（1 MB）、`LIBRARY_TREE_MAX_ENTRIES`（1000，目录也算）、`LIBRARY_DIR_MAX_DELETE_ENTRIES`（目录递归删除前的条目上限）也在这里，服务端和前端都从这里引用，不在别处写数值。文件树排除分两张表：`LIBRARY_TREE_EXCLUDE_DIRS`（只对目录生效）、`LIBRARY_TREE_EXCLUDE_FILES`（只对文件生效）——不拿搜索用的 `DEFAULT_SEARCH_EXCLUDE`，那份清单会把技能里真叫 `logs` / `build` 的内容目录一起抹掉。
- 项目级测试步骤、搜索排除目录、子对话交接摘要等前后端共用的规则（`shared/test-steps.ts`、`shared/search-exclude.ts`、`shared/handoff.ts`）。
  搜索排除除了写进提示词，还由 `server/exec/runner.ts` 写成 ripgrep 配置、用 `RIPGREP_CONFIG_PATH` 交给 CLI，rg 和 CLI 内置搜索不靠提示词也会跳过（显式把排除目录当起点时照样能搜）。
- 清终端控制序列（`shared/ansi.ts` 的 `stripAnsi`）：清 CSI（SGR 颜色、加粗、清屏、光标移动，7 位 ESC 引导和 8 位 0x9B 引导两种）、OSC、两字符转义和进度条用的 `\r`；**普通方括号文本原样保留**（`[32m]`、Markdown 链接 `[文字](...)` 前面没有 ESC 就不是转义）。CLI 发现 stdout 接终端就上色，而面板把同一份输出用于界面 `<pre>`、报错文案和「AI 处理」上下文，所以在服务端写进 `job.output` 之前清一次（`server/accounts.ts` 的 `take`）。
- 项目教训（`shared/lessons.ts`）：交给 Agent 的预算和按文件取全文；界面的页签也在这里：`DEFAULT_TAB`「默认」放一个标签都没有的教训，`inTab` / `lessonTabs` 决定每个页签有哪些、各几条，界面上总有一个页签选中（选中的标签没了回到「默认」）。
- 项目教训的 AI 评审（`shared/lesson-review.ts`）：按 `shared/analysis-home.ts` 的归属规则在项目里开分析对话（`web/src/lib/task-transfer.ts` 的 `startLessonReview` → `createAnalysisTask`，必备角色「分析」，在统一的 AI 分析窗口里看），教训全文作附件；回复末尾的 `lesson-review` 块由 `parseLessonReview` 读出，对话里的卡片（`web/src/components/projects/LessonReview.tsx`）逐条点「应用」才写进教训（`POST /projects/:id/lessons/review` → `applyReviewItem`，和 `record_lesson` 同一个队列），改写、合并把旧版本留进改写记录；「已应用」按当前教训现算（`reviewItemState`），不另存。
- 子对话收尾的评审门禁（`shared/review-gate.ts`）：评审通过，或执行角色对每条高级、中级意见写了处置（`review_triage`）才放行，评审只出意见（[ADR 0009](../../adr/0009-review-findings-triaged.md)、[ADR 0010](../../adr/0010-review-code-only.md)）；派评审代码时要带交接单 `review`（需求、改动、跑过的检查），评审只评差异里改动的行，边界数字在 `shared/review-limits.ts`（[ADR 0013](../../adr/0013-review-diff-only-with-brief.md)）；验收结论的读法在 `shared/verdict.ts`（`parseVerdict` 取最后一条、`leadVerdict` 首行优先），引擎、门禁、执行报告共用。
- 工作总结（`shared/summary.ts`）：今天的时间窗口、从任务记录里提炼今天的活动、交给 CLI 的提示词和从回答里取报告，都是纯函数（单测在 `shared/summary.test.ts`）；跑 CLI 和存报告在 `server/summary.ts`。
- 任务导出与 AI 分析报告（`shared/task-export.ts`）：`taskReport` / `analysisReport` / `analysisPrompt` 是整体分析（导出、导入、执行记录分析共用）；可选的 `HelperScope = { stepId }` 把三者收窄到一个子任务（子任务窗口的「AI 分析」），报告走 `helperReport`、提示词走 `helperPrompt`（四类问题：耗时、角色符合度、优化空间、面板框架，不要求工作流修改建议块）。`helperReport` 的角色设定用 `composeRole` 拼好的实际生效内容（含引入的 Agent），派给子任务的要求原文取自 `TaskStep.brief`（`shared/engine.ts` 的 `spawn` 落盘；为空时同时说明「旧记录没保存」和「派它时只写了标题」两种可能）。`taskSummary` 会把 `brief` 一起清掉（列表和侧栏读不到、可能上千字）；演示版的 `load()` 对 `db.tasks` 也跑一遍 `Task.parse`，旧 localStorage 里缺新字段的任务才不会在读的时候报 undefined。传了 scope 才走收窄逻辑，不传时行为不变；报告的时间口径不变式见 `docs/lessons/task-export.md`。回归：`server/task-export.test.ts`（整体）和 `server/task-export-helper.test.ts`（子任务范围）。

## 入口

- `shared/schema.ts`：所有跨前后端的数据结构。
- `shared/clis.ts`：CLI 列表和能力的统一出口。
- `shared/engine.ts`：执行引擎，被 `server/` 和在线演示的模拟实现调用。
- `shared/ansi.ts`：`stripAnsi` 清 CLI 输出里的 ANSI 转义，目前由账号登录（`server/accounts.ts`）在存 CLI 输出前调用。
- `shared/local-image.ts`：本机生图的模型清单、内置工作流和占位符替换；`shared/comfy-chain.ts`：多个工作流串成一条链（合并成一张节点图）；`shared/moss.ts`：控件树到 MOSS 布局 JSON 的换算；`shared/proxy.ts`：本机代理默认值和自动探测的端口顺序；`shared/library.ts`：Skills / 命令库的结构、附件路径校验和上限常量。

## 依赖

只依赖 `zod`，不引用 `server/` 和 `web/`。前端通过 Vite 别名 `@shared` 引用（见 `vite.config.ts`）。

## 回归验证

- `npm run typecheck`（包含漏翻检查，改了文案必须同时补英文）
- `npm run test:unit`（覆盖 `shared/**/*.test.ts`：流程图、执行引擎、CLI 定义、内置模板等；`shared/moss.test.ts` 覆盖 bbox 换算、布局 JSON 格式和控件树提取）
- `shared/ansi.test.ts`：SGR 颜色、`[1m`/`[22m` 加粗、`[2m`/`[22m` 暗色、8 位 CSI、OSC、`\r`，以及含普通方括号的非 ANSI 文本不被改。

## 待确认

- `shared/engine.ts` 与 `shared/flow.ts` 的职责边界在文件头注释里写了，但两者都涉及「节点怎么排、怎么跑」，新增逻辑前先确认应该落在哪一边（待确认）。
