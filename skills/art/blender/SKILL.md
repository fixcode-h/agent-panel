---
name: blender
description: 用 Blender 命令行（无头）完成建模、动画、多视角自检、FBX（UE 标准）导出与视口展示的全流程。任务需要 Blender 建模/动画/渲染检查、把资产导出给 UE、或需要多视角截图评估效果时使用；包含精细度指标、易错点知识库与现场经验回流约定。
user-invocable: true
---

# Blender 工作流技能

本技能负责用 Blender 完成「规格 → 分件建模/动画 → 场景体检 → 多视角自评 → 迭代 → 视口展示 →（可选）UE 导出」的全流程，并沉淀精细度指标、模块装配契约与易错点知识。涉及创建模型和模型动画的需求，可配合 `blender-model-animation-workflow` 技能做阶段编排。

## 执行底座

- 一律经启动器运行（自动定位 Blender：`BLENDER_PATH` → PATH → 注册表 InstallLocation → 常见目录；自动附加 `--python-exit-code 1`）：
  `python blender_cli.py <脚本> <参数...>`；相对脚本按当前工作目录、再按启动器所在 `scripts/` 目录解析。
- 定位失败或想确认版本：`python blender_cli.py --where`
- 无头优先；只有「视口展示」才以 `--gui` 打开窗口（关闭窗口后命令才返回）。
- 退出码约定：0 = 通过；1 = 检查未通过；2 = 环境或参数错误。

## 工作流（六段）

0. **规格先行**：用 `references/templates/spec-template.md` 固化用途、尺寸、组成、拓扑目标、禁止项与验收；额外写清每个模块的局部原点、旋转轴、父级和可拆装边界。有视频/图片参考时先用 `reference_frames.py` 出元数据、接触表、关键帧与放大裁切，再转写部件清单；单张图只能证明可见面，背面和遮挡结构必须标为补全或待确认（见 `references/reference-rebuild.md` 与 `references/model-animation-contract.md`）。
1. **场景搭建**：公制 + 缩放 1.0 + 命名前缀；及时应用变换；圆盖用 TRIFAN 等避免 n-gon；动画独立 action、30fps。**复杂模型走分件工坊**：拆件 → 单件脚本 + 单件预览精修 → 装配表组装（见 `references/part-workshop.md`），不要一把梭写整模脚本。每个功能模块使用独立 Collection 和 `GRP_*` 根 Empty，装配脚本只负责实例化、位置、旋转和父级关系，不重新生成几何。有参考图片时，以其实际内容决定几何、纹理、材质、颜色与风格，不划分高模/低模档位；曲面分段、平滑和倒角按每件可见特征调整。预算只来自明确交付限制或记录过的检查参数，不能替代参考对照（见 `references/metrics.md`）。
2. **减面与场景体检**：最终验收前保存原始模型和渲染基线，在候选副本中逐件减面；同条件对照剪影、细节、纹理、材质、颜色及动画，质量无可见退化才保留，无法安全减面的部件恢复并记录原因。详细步骤见 `references/workflow.md`。对减面后的最终模型运行 `inspect_scene.py` 输出五组指标 JSON；FAIL 先修再继续。相交报告必须把“预期接触”（例如轮毂-轴、轮缘-轴承、落水-水斗）与“结构性穿透”（例如支撑穿过轮体、椽子穿出屋面）分开记录；BVH 只提供定位证据，不自动替代人工判定。
3. **多视角自评**：`capture_views.py` 生成 ≥6 视角截图（默认双引擎 Workbench+EEVEE，环境大时 `--focus` 聚焦主体）；**禁止单视角定论**，按 `references/evaluation.md` 逐视角审查并迭代；循环动画交付前用 `--frames` 做多帧对比。重新打开 `.blend` 后，对每个模块根 Empty 做一次平移/恢复，确认模块可独立操作且父子关系不会漂移。
4. **视口展示**：`setup_viewport.py --gui` 打开 GUI 单视口（相机视角）+ 材质预览 + 循环播放；运动场景须有位移（Δx = 2πr × 圈数），相机跟随主体或用固定机位覆盖其活动范围（主体始终在画面内）。
5. **导出（可选）**：**默认不导出**；只在用户明确需要 UE 交付且**确认后**运行 `export_ue.py`（体检门槛 + FBX + 重导入自检）。

## 读取索引（何时读哪篇）

| 场景 | 读 |
|---|---|
| 完整流程与阶段职责 | `references/workflow.md` |
| 参考视频/图片 → 一比一复刻流程 | `references/reference-rebuild.md` |
| 复杂模型：分件工坊（拆件/精修/装配） | `references/part-workshop.md` |
| 模型与动画的模块、装配、控制器和证据契约 | `references/model-animation-contract.md` |
| 指令/代码速查（什么时候用什么） | `references/commands.md` |
| 指标定义与阈值 | `references/metrics.md` |
| 多视角评估与审查清单 | `references/evaluation.md` |
| FBX→UE 导出规则与导入清单 | `references/export-ue.md` |
| 遇到具体问题（按症状查） | `references/pitfalls/README.md` → 对应主题篇 |
| 规格 / 评估记录模板 | `references/templates/` |

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `blender_cli.py` | 定位 Blender 并无头/GUI 启动脚本（公共入口） |
| `inspect_scene.py` | 场景体检 → 五组指标 JSON（退出码 1 表示有 FAIL）；默认 raw 网格，`--evaluated` 检查修改器/约束后的网格；相交报告支持 `--intersect-frames` / `--intersect-every` |
| `diagnose_overlap.py` | 相交定位：输出两个对象相交三角的中心坐标（配合 `inspect_scene.py --intersect-report` 使用） |
| `capture_views.py` | 多视角截图（双引擎 ≥6 视角 + `views.json`；大场景用 `--focus` 聚焦主体）；`--frames "1,16,31,46"` 逐帧对比动画（默认右侧视，`--frame-view` 可切 front/right/back/left/quarter/top，大场景务必配 `--focus`）；`--cam-frames "45,211"` 用场景自带相机核对交付镜头 |
| `setup_viewport.py` | 视口展示（`--gui` 单视口 + 相机视角）/ 无 GUI 校验 |
| `export_ue.py` | FBX（UE 标准）导出 + 重导入自检（可选步骤） |
| `build_sample_scene.py` | 生成演示/自测场景（含建模与动画的最佳实践示例） |
| `reference_frames.py` | 参考视频/图片预处理（系统 python 运行）：元数据、时间轴接触表、单帧、放大裁切、并排对照、多图拼表 |
| `smoke_blender_tooling.py` | 脚本编译检查和 Blender 运行时 smoke；未安装 Blender 时以退出码 2 标记 N/A |

## 现场经验回流

- 具体项目中发现的问题与经验：先记在项目自身的 `docs/blender/`（如有），现场优先、快速落笔。
- 成熟可复用的结论：整理进本技能 `references/pitfalls/`（统一模板 + 症状索引），让后续项目直接受益。
- 两边独立演进：现场文档不链接技能文档，技能文档不复述项目细节。

## 关键纪律

- 体检有 FAIL 不得进入导出（除非用户显式豁免并记录理由）。
- 多视角评估全通过（或显式豁免）才算完成；不允许只看一个视角下结论。
- 动画必须绑定到模块根 Empty、轮心 Empty 或明确的控制器；不要把同一模块的关键帧散落到多个网格对象。
- 交付动画要验证帧率、动作帧范围、循环首尾、局部旋转轴、控制器跟随、穿模和运动一致性；静态帧通过不等于动画通过。
- 重新打开文件并完成模块平移/恢复测试后，才可声称“可拆分、可装配”；只看到 Collection 分组不能证明模块真的可操作。
- 导出前必须先询问用户；参数不要凭记忆，以 `references/export-ue.md` 的实测表为准。
- 遇到问题先查 `references/pitfalls/` 的症状索引，避免重复踩坑。
- ffmpeg 失败、输出为空或参数非法必须返回非零；不要把旧输出文件当作本次成功。
- 相交 BVH 只报告 evaluated 世界坐标三角面的表面重叠；多帧采样是信息性抽样，不能证明所有帧无穿模。
