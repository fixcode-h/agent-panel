# 易错点索引（症状 → 正确做法）

> 使用方式：先按「症状关键词」定位条目，再进对应文档看完整处理。每条目统一模板：症状 → 错误做法 → 正确做法（最小代码）→ 为什么 → 验证方式 → 相关。
> 收录规则：实测复现过 + 有最小正确做法 + 能给出验证方式，才收录进本目录。

| 症状（关键词）                          | 常见于             | 正确做法要点                                                              | 详情                              |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------- | --------------------------------- |
| 脚本报错但命令显示成功 / 退出码 0       | 无头批处理         | 启动器加 `--python-exit-code 1`；脚本用 `sys.exit` 约定退出码             | `scripting.md`                    |
| `bpy.ops` 报 context 错误（无头模式）   | 资源操作、区域操作 | `bpy.context.temp_override(...)` 提供上下文；或改用数据 API               | `scripting.md`                    |
| `--python-expr` 报 NameError / 引号被吞 | PowerShell 传参    | 写临时 `.py` 文件用 `--python` 运行，不要在命令行拼引号                   | `scripting.md`                    |
| 相对路径找不到文件                      | 脚本读取输入       | 统一用绝对路径或显式 `os.path.join` + `abspath`                           | `scripting.md`                    |
| 导出到 UE 后大小不对                    | 建模/导出          | 应用变换（scale=1）+ 场景单位公制 1.0                                     | `transforms.md`                   |
| 法线反了 / 材质显示异常                 | 镜像或负缩放       | 应用缩放后检查行列式，必要时翻转法线                                      | `transforms.md`                   |
| 旋转导出错乱 / 枢轴不对                 | 默认原点未调整     | 依据用途设原点后应用旋转                                                  | `transforms.md`                   |
| 体检报 `ngons` > 0                      | 圆柱/圆锥/倒角     | 端盖用 `end_fill_type='TRIFAN'`；倒角用单段；局部切分                     | `topology.md`                     |
| 体检报 `non_manifold` > 0               | 布尔/重复面        | 清理重复面与孤边；布尔后做一次体检                                        | `topology.md`                     |
| 体检报 `loose_verts` > 0                | 删除面后残留       | 清理松散顶点/边                                                           | `topology.md`                     |
| `use_nodes` 弃用告警 / 材质没有节点     | Blender 5.x        | 直接操作 `mat.node_tree`；不要读写 `use_nodes`（5.x 已弃用）              | `materials-uv.md`                 |
| 导入后材质/贴图异常                     | 缺 UV / 路径       | 每个网格保证 UV 层；贴图统一相对路径且随任务交付                          | `materials-uv.md`                 |
| FBX 导出后动画丢失                      | 动画组织           | 用 All Actions 模式（默认）；不要依赖游离 action 的 NLA 导出              | `animation.md`                    |
| 动画变短 / 丢关键帧                     | 帧率、简化         | `bake_anim_simplify_factor=0`；帧率与关键帧范围一致                       | `animation.md`                    |
| 循环动画有跳变                          | 首尾帧             | 首尾关键帧值一致（体检 `first_last_equal`）                               | `animation.md`                    |
| 导出后多出一堆空动作                    | NLA 条带模式       | 切回 All Actions 模式                                                     | `export.md`                       |
| 重导入自检尺寸不匹配                    | 单位/缩放          | 先看体检 `units` 与 `transform_applied`                                   | `export.md`                       |
| UE 里朝向不对                           | 轴向转换           | 保持导出预设 `axis_forward=-Z / axis_up=Y`，UE 侧用默认导入               | `export.md`                       |
| 截图里主体只有几个像素 / 看不清         | 大场景取景         | `--focus "名称前缀,..."` 聚焦主体；环境远大于主体时必用                   | `evaluation.md`                   |
| 只看一种引擎，漏检材质/光照             | 渲染引擎           | 双引擎 `--engine both`；两套图都要逐视角审查                              | `evaluation.md`                   |
| 批量读取多张截图看不到图                | 评估流程           | 逐张读取（单张才进入视觉通道），逐张给结论                                | `evaluation.md`                   |
| 动作曲线报 `fcurves` AttributeError     | Blender 5.x 动作   | 走 `layers → strips → channelbags` 取 fcurves；不要静默跳过               | `animation.md`                    |
| Workbench 预览全灰                      | 材质视口色         | 设 `mat.diffuse_color`（或由 capture_views 自动同步）                     | `materials-uv.md`                 |
| 库路径警告 geometry_nodes_essentials    | 自动平滑           | 应用 Smooth by Angle 修改器；警告不影响结果                               | `scripting.md`                    |
| GUI 一闪而过 / 窗口立刻关闭             | 视口展示           | GUI 脚本不要 `sys.exit`（会退出 Blender）；包 try/except                  | `scripting.md`                    |
| 四分屏成 4 列 / 相机取景太远            | 视口展示           | 默认单视口（相机视角）；需要多视图时先水平再各半垂直成 2×2                | `scripting.md`                    |
| 结构件插进轮胎 / 结构性穿透             | 结构布局           | 叉/撑走外侧（≥胎半宽+半径）；居中件按外半径+间隙校核                      | `topology.md`                     |
| 预览原地播放（轮转但不位移）            | 动画预览           | 根组位移 Δx = 2πr×圈数、LINEAR；相机跟随                                  | `animation.md`                    |
| GUI 相机视角报 enum "CAMERA" not found  | 视口展示           | 用 `region_3d.view_perspective='CAMERA'`；`view_axis` 不含该枚举          | `scripting.md`                    |
| 相交检测漏检（BVH 返回 0）              | 检测脚本           | 世界坐标 + 三角化后再建 BVH；`FromObject` 是局部空间                      | `scripting.md`                    |
| 滚动方向与前进方向不一致                | 动画预览           | 按 v = ω·r 定符号（+X 前进配 +Y 轴正转）；整圈数保相位                    | `animation.md`                    |
| bmesh 生成后缩放导致位置跑偏            | 程序化建模         | 缩放+平移写进同一 matrix；勿对已平移顶点再 scale                          | `scripting.md`                    |
| 手写面顺序导致黑面/法线反               | 程序化建模         | 闭合体写完统一 `recalc_face_normals`                                      | `scripting.md`                    |
| 履带/链条细节频闪（想滚却像噪声）       | 动画预览           | 低频特征承载运动；等距密集细节保持静态（30fps 采样上限）                  | `animation.md`                    |
| 轮子打滑（转速与位移不符）              | 动画预览           | 用有效接触半径 `r_eff = 轮半径 + 板半厚` 计算角位移                       | `animation.md`                    |
| 金属死黑 / 黑白镜面                     | EEVEE 评估         | metallic 降到 0.25–0.5 或补环境色                                         | `materials-uv.md`                 |
| 动画帧被前景遮挡                        | 多帧评估           | `--frame-view quarter` 越过遮挡；特写聚焦转动件                           | `evaluation.md`                   |
| 路径阵列件凸起朝内/戳穿邻件             | 程序化建模         | 切线角旋转的局部 +z 可能朝路径内侧；验算后取负或显式构造法向              | `topology.md`                     |
| 新增轮件与相邻轮相交（含无解）          | 结构布局           | 轴距 ≥ 半径和 + 5 mm；无解时缩小视觉损失最小件；改后重跑全量相交          | `topology.md`                     |
| 相交报告只有对象名无法定位              | 检测脚本           | `diagnose_overlap.py` 输出相交三角中心坐标定位                            | `scripting.md`                    |
| 挂父级后子件二次偏移（位置翻倍）        | 程序化建模         | `keep_parent`：先 `view_layer.update()` 再取父级逆矩阵                    | `scripting.md`                    |
| 嵌套旋转件互相穿插（轮胎/轮毂）         | 程序化建模         | 旋转嵌套件用环形管（内外壁+环盖）+5 mm 间隙；辐板用梯形棱柱               | `scripting.md`                    |
| 一件需要多材质被迫拆对象                | 程序化建模         | Part 材质槽分段：`set_mat()` + `finish(extra_mats=...)` 写 material_index | `scripting.md`                    |
| 履带链板不动 / 逐帧烘焙文件爆炸         | 动画预览           | 相位驱动 `u=(u_i+s/L)%1`；直线 10 帧、圆弧 1–2 帧自适应采样               | `animation.md`                    |
| 碎块/烟团穿地或提前可见                 | 动画预览           | 落地按半高夹紧；出生前补不可见关键帧（scale 0.001）                       | `animation.md`                    |
| 缩放动画导致 transform_applied FAIL     | 场景体检           | 空物体承载缩放动画，网格子件 scale=1                                      | `animation.md`                    |
| 复杂模型一把梭导致质量上不去            | 整体方法           | 分件工坊：拆件→单件预览精修→装配表组装                                    | `references/part-workshop.md`     |
| 参考视频/图片变不成可用素材             | 参考复刻           | `reference_frames.py` 出元数据/接触表/单帧/放大/对照图                    | `references/reference-rebuild.md` |
| 高模倒角压坏细薄件 / 倒角后 ngons FAIL  | 高模建模           | 倒角宽度按中位边长自适应；倒角顶点补面立即三角化                          | `scripting.md`                    |
| 平滑着色后形体发糊（高模像塑料）        | 高模建模           | 锐边阈值 20°；环境光压到 0.3–0.5；主光置于展示面一侧                      | `materials-uv.md`                 |

## 文档模板（每篇必须六节齐全）

1. **症状**：可观察现象 + 可搜索关键词（中英文都写）。
2. **错误做法**：常见但错的写法/习惯（说明它为什么看着像对的）。
3. **正确做法**：最小可复现的代码/命令（能直接抄）。
4. **为什么**：机制层面的原因（一句话说清）。
5. **验证方式**：怎么确认已修好（命令/观察点）。
6. **相关**：关联文档或条目。
