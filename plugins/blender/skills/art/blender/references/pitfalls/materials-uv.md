# 易错点：材质 / UV / 贴图（materials-uv）

## 症状：`use_nodes` 弃用告警 / 材质没有节点

### 症状

- 关键词：use_nodes / deprecated / Blender 5.x / 没有节点
- 运行时出现 `DeprecationWarning: Material.use_nodes is expected to be removed in Blender 6.0`，或材质节点树为空导致体检 `material_nodes` FAIL。

### 错误做法

- 沿用旧写法先设 `mat.use_nodes = True` 再取节点。

### 正确做法

```python
mat = bpy.data.materials.new(name)
bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Base Color'].default_value = base_color
```

直接用 `mat.node_tree`；不要读写 `use_nodes`（5.x 已弃用）。

### 为什么

Blender 5.x 材质默认就是节点材质；旧布尔开关进入弃用期，读写会触发告警甚至在未来版本移除。

### 验证方式

运行脚本无 DeprecationWarning；体检 `material_nodes` 为 PASS。

### 相关

`metrics.md`

## 症状：缺 UV，导出后材质/贴图异常

### 症状

- 关键词：uv / 缺 UV / 贴图错位 / uv_present
- 体检 `[FAIL] uv_present`，或 UE 中材质表现异常。

### 错误做法

- 只建几何不展开 UV；以为「纯色材质不需要 UV」。

### 正确做法

```python
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode='OBJECT')
```

### 为什么

UV 是贴图与多数材质管线的输入；缺失会导致导入失败或默认 UV 拉伸。

### 验证方式

体检 `uv_present`、`uv_bounds` 通过；多视角渲染中材质项正常。

### 相关

`evaluation.md`

## 症状：贴图丢失 / 路径失效

### 症状

- 关键词：贴图丢失 / missing texture / 相对路径 / embed
- 换机器或移动目录后贴图变成粉紫/缺失。

### 错误做法

- 用绝对路径引用贴图；指望 FBX 内嵌贴图。

### 正确做法

- 贴图与任务目录一起交付，用相对路径（`path_mode='AUTO'`，不内嵌）。
- 体检 `texture_files` 确认文件存在。

### 为什么

FBX 默认不内嵌贴图；绝对路径换机即断。

### 验证方式

`inspect_scene.py` 的 `texture_files` 为 PASS；拷贝任务目录到新路径后仍可渲染。

### 相关

`export-ue.md`

## 症状：材质数超预算 / 非 Principled 节点

### 症状

- 关键词：material_nodes / 材质数量 / Principled / PBR
- 体检报缺失 Principled 或材质数量超过项目约定。

### 错误做法

- 用旧式或自定义节点树（Emission/Blend 混杂）；每个小件一个材质。

### 正确做法

- 统一 Principled BSDF；按「物理材质」合并（一个材质跨多件）。
- 预算参考见 `metrics.md`。

### 为什么

UE 侧按材质槽切分绘制批次；材质越多开销越大，非 PBR 节点无法直接映射。

### 验证方式

体检 `material_nodes` PASS；材质数与预算表对照。

## 症状：Workbench 预览全灰，看不到材质配色

### 症状

- 关键词：Workbench 全灰 / 没有材质色 / diffuse_color / color_type MATERIAL
- 所有物体在 Workbench 截图里是同一灰色，无法用颜色评估材质分区。

### 错误做法

- 只设置 Principled 节点的 Base Color，不设置材质的视口显示色（`Material.diffuse_color`）。

### 正确做法

```python
mat = bpy.data.materials.new(name)
bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Base Color'].default_value = rgba
mat.diffuse_color = rgba      # Workbench 的 MATERIAL 模式取这里
```

（`capture_views.py` 渲染前也会自动把 Base Color 同步到 `diffuse_color`，双保险。）

### 为什么

Workbench 的 `color_type='MATERIAL'` 使用材质的视口显示色，而不是节点里的 Base Color。

### 验证方式

Workbench 截图中出现与规格一致的配色（如红车架、蓝海、橙喙）。

### 相关

`evaluation.md`（双引擎基线）

## 症状：金属材质在评估渲染里死黑 / 黑白刺眼

### 症状

- 关键词：metallic / 死黑 / 镜面 / EEVEE 无环境 / 金属发黑
- EEVEE 渲染中金属件（炮管、履带、轮毂）要么整块黑、要么高光白得刺眼，看起来像建模或材质出错。

### 错误做法

- 给评估场景设高 metallic（0.9+）和小 roughness，且场景没有环境贴图/环境光——金属只反射世界，世界暗时金属近乎全黑。

### 正确做法

- 评估用途的金属：`metallic` 降到 0.25–0.5、`roughness` 0.35–0.6（保留金属感同时可见中间调）。
- 或给 world 补环境色（`Background` 颜色 0.05–0.1 即可显著改善）。
- 高 metallic 留给有环境贴图的最终渲染 / UE 端。

### 为什么

金属度越高，Base Color 越接近反射率而非漫反射色——没有可反射的环境时，只剩直接光高光与黑底。

### 验证方式

EEVEE 中金属件有可辨认的中间调与倒角明暗层次；不再出现大块死黑。

### 相关

`pitfalls/evaluation.md`（双引擎）；`evaluation.md`

## 症状：平滑着色后形体「发糊」，高模看着像塑料

### 症状

- 关键词：高模发糊 / 没形体 / smooth shading 太软 / 背光面一片白 / flat look
- 打开平滑着色 + 倒角后，渲染里主体反而比低模版更平：大平面没有明暗分界，边缘读不出来，像一块塑料。

### 错误做法

- 只做 `polygon.use_smooth = True` 而不标锐边（所有过渡都被抹平）；
- 或 `smooth_angle` 设得比倒角面角还大（例如倒角两段各 30°、阈值 32°），倒角面也被算作平滑，边缘彻底消失；
- 环境光（World Strength）给到 1.0：补光把背光面填平，形体失去明暗对比。

### 正确做法

- 平滑面 + **按角度标锐边**：`smooth_angle` 取 20° 左右，让「大面之间的硬边」和「倒角面的分段过渡」都留出明暗层次：

```python
limit = math.radians(20.0)
for e in bm.edges:
    if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > limit:
        me.edges[e.index].use_edge_sharp = True     # 面 use_smooth=True + 锐边
```

- 环境光强度压到 0.3–0.5，主光能量 2–2.5（日间沙漠/棚拍量级）；
- **主光放在展示面一侧**：机位看哪面，光就从哪面来（背光面再高模也会读成一片平）。

### 为什么

高模的「形体」靠明暗渐变与边缘高光读出来：锐边决定边缘是否可读，光比决定面与面是否分得开；两者缺一，几何再密也白搭。

### 验证方式

多视角渲染逐张看：主体是否每块面都有可辨的明暗/边缘；对比低模版的可读性不应下降；单件预览（EEVEE + 补光）先确认件本身成立。

### 相关

`references/part-workshop.md`（按参考特征决定部件做法）；`pitfalls/evaluation.md`
