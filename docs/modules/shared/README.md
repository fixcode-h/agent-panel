# shared：前后端共享的数据模型、流程图和执行引擎

- status: inferred
- source_paths: `shared/`
- entry: `shared/schema.ts`、`shared/clis.ts`
- analyzed_at: 2026-10-24

## 职责

- 数据结构：Agent、工作流、流程、项目、任务、设置等的 zod schema 和类型（`shared/schema.ts`）。
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
- 子对话收尾的评审门禁（`shared/review-gate.ts`）：评审通过，或执行角色对每条 🛑 写了处置（`review_triage`）才放行，评审只出意见（[ADR 0009](../../adr/0009-review-findings-triaged.md)）；验收结论的读法在 `shared/verdict.ts`（`parseVerdict` 取最后一条、`leadVerdict` 首行优先），引擎、门禁、执行报告共用。

## 入口

- `shared/schema.ts`：所有跨前后端的数据结构。
- `shared/clis.ts`：CLI 列表和能力的统一出口。
- `shared/engine.ts`：执行引擎，被 `server/` 和在线演示的模拟实现调用。
- `shared/local-image.ts`：本机生图的模型清单、内置工作流和占位符替换；`shared/moss.ts`：控件树到 MOSS 布局 JSON 的换算。

## 依赖

只依赖 `zod`，不引用 `server/` 和 `web/`。前端通过 Vite 别名 `@shared` 引用（见 `vite.config.ts`）。

## 回归验证

- `npm run typecheck`（包含漏翻检查，改了文案必须同时补英文）
- `npm run test:unit`（覆盖 `shared/**/*.test.ts`：流程图、执行引擎、CLI 定义、内置模板等；`shared/moss.test.ts` 覆盖 bbox 换算、布局 JSON 格式和控件树提取）

## 待确认

- `shared/engine.ts` 与 `shared/flow.ts` 的职责边界在文件头注释里写了，但两者都涉及「节点怎么排、怎么跑」，新增逻辑前先确认应该落在哪一边（待确认）。
