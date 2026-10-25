# shared：前后端共享的数据模型、流程图和执行引擎

- status: inferred
- source_paths: `shared/`
- entry: `shared/schema.ts`、`shared/clis.ts`
- analyzed_at: 2026-10-24

## 职责

- 数据结构：Agent、工作流、流程、项目、任务、设置等的 zod schema 和类型（`shared/schema.ts`）。
- 设置 schema 和默认值：后台命令并发 `backgroundLimit` 默认 64（范围 1–64，`shared/schema.ts`）；子对话并发上限已去掉，`Settings` 没有 `childConcurrency`、`Task` 没有 `childLimit`，旧 settings.json / task JSON 里的这两个字段由 zod 读时剥离、不报错。
- 本机代理的默认值（`shared/proxy.ts`）：`DEFAULT_PROXY_PORT` / `DEFAULT_PROXY_URL` 是设置页「网络代理」的占位符和说明、CLI 环境变量示例（`PROXY_ENV_EXAMPLE`）、自动探测端口顺序（`LOCAL_PROXY_PORTS`）的唯一出处；`shared/schema.ts` 的 `proxy` 字段注释也指向它。要换默认代理端口只改这一处，别处一律 import（`npm run lint` 的 `rules-check` 会拦住 ts / tsx / mjs / json 里再写的字面量）。默认端口在 v2rayN 里默认跑 socks，mixed 在 10814，纯 socks 时 `ProxyAgent` 用不了、探测会失败。`LOCAL_PROXY_PORTS` 里除了默认端口还有 Clash 的混合端口、老版 v2rayN 的 http 入站、Clash 的 socks 口、Clash Verge Rev 的混合端口和通用的 1080；`MAX_LOCAL_PROXIES`（3）决定真正尝试几个，所以默认端口必须排在前几位。具体顺序和取值只看 `shared/proxy.ts`。
- CLI 注册表：内置 CLI 定义在 `shared/clis/*.json`，由 `shared/clis.ts` 加载；参数拼装、输出解析方式、支持的能力、Skill 和说明文件位置都写在定义里，面板其他地方按字段走。Agent 的回复语言跟随面板设置，完整规则（正文和思考过程）、提示词末尾的提醒句、Command Code 通过 mod 追加系统提示词时的插件源码都在 `shared/prompt-lang.ts`。
- 流程图逻辑：节点、连线、子流程、引用解析、布局和任务规划（`shared/flow.ts`）。
- 工作流执行引擎：按流程图调度节点，处理开始 / 验收 / 结束流程、步骤串行、续跑和主 Agent 调度（`shared/engine.ts`）；真实执行和在线演示的模拟执行共用。
- 内置内容：内置角色和工作流模板在 `shared/builtin/`，界面文案的英文在 `shared/locales/en/`。
- 本机生图（`shared/local-image.ts`）：`LOCAL_FILES` 是 ComfyUI 的下载清单（`dir` / `file` / `url` / `gb`），`LOCAL_MODELS` 是按用途分组的模型条目（决定设置页「本机生图」列出什么、要多少显存，也是工作流可选的内置模型），`LOCAL_MODEL_GROUPS` 是分组顺序；同一文件还负责生成内置工作流的节点图、`{{prompt}}` / `{{negative}}` / `{{width}}` / `{{height}}` / `{{count}}` / `{{seed}}` / `{{layout}}` 的替换、工作流校验和自动挑选。
  2026-10-24 新增 MOSS-Image（`family: 'moss'`，Apache-2.0，`base` 1024，`natural`）：`moss-image` 用 int8 权重（`diffusion_models` 5.4GB、`text_encoders` 7.3GB、`vae` 0.25GB，`vram` 16），`moss-image-bf16` 用 bf16 权重（10.2GB、19.3GB 加同一个 `vae`，`vram` 32）。`localWorkflow` 的 `moss` 分支：`UNETLoader` + `CLIPLoader`（`type: moss_image`）+ `VAELoader` + `SkipLayerGuidanceDiTSimple`（`single_layers: '22'`，0–0.5）+ `KSampler`（25 步、CFG 2.5、`er_sde`、`simple`）；int8 和 bf16 共用同一节点图，文件按模型实际带的取。内置工作流 `game-moss-layout` 的正向提示词写 `{{layout}}`，没有布局时回退成描述。
- MOSS 布局（`shared/moss.ts`）：`designLayoutItems` 从设计稿控件树取布局项（有实际文字的文字块、用到了有描述图片的控件，只沿 `CanvasPanel` 累加绝对坐标，最多 24 项）；`mossBbox` 把设计稿像素按实际出图尺寸换算成以画布中心为原点、`yxyx` 的 bbox；`mossLayoutJson` 输出单行官方 JSON（`summary.caption`、`items` 的 `text` / `object`、`bbox_coord_space: abs_centralized`、`bbox_format: yxyx`），没有有效项时返回 `undefined`。宽高必须等于实际出图尺寸，换算依赖 `shared/umg.ts` 的 `canvasSlotRect`。
- 项目 AI 初始化的推荐结构和保存校验（`shared/project-init.ts` 的 `ProjectProposal`、`ProjectProposalSchema`）：推荐随项目以 `initResult` 保存（`shared/schema.ts` 里可选），重开项目设置时拿来和当前设置比对；旧项目没有该字段按「没有推荐」处理，不要求重新初始化。
- 项目级测试步骤、搜索排除目录、子对话交接摘要等前后端共用的规则（`shared/test-steps.ts`、`shared/search-exclude.ts`、`shared/handoff.ts`）。
  搜索排除除了写进提示词，还由 `server/exec/runner.ts` 写成 ripgrep 配置、用 `RIPGREP_CONFIG_PATH` 交给 CLI，rg 和 CLI 内置搜索不靠提示词也会跳过（显式把排除目录当起点时照样能搜）。
- 清终端控制序列（`shared/ansi.ts` 的 `stripAnsi`）：清 CSI（SGR 颜色、加粗、清屏、光标移动，7 位 ESC 引导和 8 位 0x9B 引导两种）、OSC、两字符转义和进度条用的 `\r`；**普通方括号文本原样保留**（`[32m]`、Markdown 链接 `[文字](...)` 前面没有 ESC 就不是转义）。CLI 发现 stdout 接终端就上色，而面板把同一份输出用于界面 `<pre>`、报错文案和「AI 处理」上下文，所以在服务端写进 `job.output` 之前清一次（`server/accounts.ts` 的 `take`）。
- 项目教训（`shared/lessons.ts`）：交给 Agent 的预算和按文件取全文；界面的页签也在这里：`DEFAULT_TAB`「默认」放一个标签都没有的教训，`inTab` / `lessonTabs` 决定每个页签有哪些、各几条，界面上总有一个页签选中（选中的标签没了回到「默认」）。
- 项目教训的 AI 评审（`shared/lesson-review.ts`）：在项目里开分析对话（`web/src/lib/task-transfer.ts` 的 `startLessonReview`，角色用 `analysisAgentId`：内置「分析」，没有就用项目默认角色），教训全文作附件；回复末尾的 `lesson-review` 块由 `parseLessonReview` 读出，对话里的卡片（`web/src/components/projects/LessonReview.tsx`）逐条点「应用」才写进教训（`POST /projects/:id/lessons/review` → `applyReviewItem`，和 `record_lesson` 同一个队列），改写、合并把旧版本留进改写记录；「已应用」按当前教训现算（`reviewItemState`），不另存。
- 子对话收尾的评审门禁（`shared/review-gate.ts`）：评审通过，或执行角色对每条高级、中级意见写了处置（`review_triage`）才放行，评审只出意见（[ADR 0009](../../adr/0009-review-findings-triaged.md)、[ADR 0010](../../adr/0010-review-code-only.md)）；验收结论的读法在 `shared/verdict.ts`（`parseVerdict` 取最后一条、`leadVerdict` 首行优先），引擎、门禁、执行报告共用。

## 入口

- `shared/schema.ts`：所有跨前后端的数据结构。
- `shared/clis.ts`：CLI 列表和能力的统一出口。
- `shared/engine.ts`：执行引擎，被 `server/` 和在线演示的模拟实现调用。
- `shared/ansi.ts`：`stripAnsi` 清 CLI 输出里的 ANSI 转义，目前由账号登录（`server/accounts.ts`）在存 CLI 输出前调用。
- `shared/local-image.ts`：本机生图的模型清单、内置工作流和占位符替换；`shared/moss.ts`：控件树到 MOSS 布局 JSON 的换算；`shared/proxy.ts`：本机代理默认值和自动探测的端口顺序。

## 依赖

只依赖 `zod`，不引用 `server/` 和 `web/`。前端通过 Vite 别名 `@shared` 引用（见 `vite.config.ts`）。

## 回归验证

- `npm run typecheck`（包含漏翻检查，改了文案必须同时补英文）
- `npm run test:unit`（覆盖 `shared/**/*.test.ts`：流程图、执行引擎、CLI 定义、内置模板等；`shared/moss.test.ts` 覆盖 bbox 换算、布局 JSON 格式和控件树提取）
- `shared/ansi.test.ts`：SGR 颜色、`[1m`/`[22m` 加粗、`[2m`/`[22m` 暗色、8 位 CSI、OSC、`\r`，以及含普通方括号的非 ANSI 文本不被改。

## 待确认

- `shared/engine.ts` 与 `shared/flow.ts` 的职责边界在文件头注释里写了，但两者都涉及「节点怎么排、怎么跑」，新增逻辑前先确认应该落在哪一边（待确认）。
