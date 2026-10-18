# 易错点：导出（export / FBX / 自检）

## 症状：导出后多出一堆空动作（1 → N）

### 症状
- 关键词：NLA 条带 / 多余 take / action_count 8 / 静态对象动作
- 自检 `[FAIL] action_count: 动作数 1 -> 8`，导入端多出每个对象一个动作。

### 错误做法
- 用 NLA 条带模式（`bake_anim_use_nla_strips=True`）导出含有静态对象的场景。

### 正确做法
- 切回 All Actions 模式（`bake_anim_use_all_actions=True`、`bake_anim_use_nla_strips=False`）——`export_ue.py` 的默认值。

### 为什么
NLA 模式按「所有可动对象 × 条带」烘焙，静态对象也会生成空/常值动作；All Actions 只导出文件里真实存在的 action。

### 验证方式
自检 `action_count` 与原始一致（实测 1 → 1）。

### 相关
`export-ue.md`（动画模式实测结论）

## 症状：重导入自检尺寸不匹配

### 症状
- 关键词：size_match / 包围盒 / 尺寸偏差 / 缩放
- 自检 `[FAIL] size_match: 包围盒尺寸 [...] -> [...]`。

### 错误做法
- 忽略体检里的 `units` / `transform_applied` 警告直接导出。

### 正确做法
- 先修体检 FAIL（应用缩放、统一单位），再导出；必要时在 `export_check.json` 里比对原始/导入两组数值定位哪一轴异常。

### 为什么
未应用的缩放会让 FBX 携带节点变换，重导入后包围盒换算不一致。

### 验证方式
重新导出，`size_match` 在容差内（相对 0.1% 或 1mm）。

### 相关
`pitfalls/transforms.md`

## 症状：UE 里朝向不对

### 症状
- 关键词：朝向 / axis / -Z / Y-up / 旋转 90°
- 导入 UE 后模型朝上或朝前方向不对。

### 错误做法
- 随意改 `axis_forward` / `axis_up` 组合；导出时额外施加旋转。

### 正确做法
- 保持预设：`axis_forward='-Z'`、`axis_up='Y'`（Blender Z-up → FBX Y-up）；UE 侧用默认导入设置。

### 为什么
两端的轴向约定要成对匹配；单边修改会引入 90° 偏差。

### 验证方式
UE 侧导入清单第 2 项（朝向）通过；或重导入 Blender 对比朝向一致。

### 相关
`export-ue.md`（UE 导入检查清单）

## 附：如何探测导出参数（不要用 --python-expr）

- 写一个临时 `.py`（例如打印 `bpy.ops.export_scene.fbx.get_rna_type().properties` 的 identifier），经启动器运行：
  `python blender_cli.py probe_fbx.py`
- 原因：PowerShell 传给 `--python-expr` 的引号会被吞（见 `pitfalls/scripting.md`）。

### 相关
`pitfalls/scripting.md`
