# 易错点：变换 / 单位 / 原点（transforms）

## 症状：导出到 UE 后大小不对（缩放）

### 症状

- 关键词：scale / 尺寸不对 / 双倍缩放 / unit scale
- FBX 导入 UE 后模型过大或过小。

### 错误做法

- 用物体 scale 当尺寸来源（如 scale=0.01 表示「厘米」）。
- 场景单位设置为空或非公制。

### 正确做法

```python
# 建模后统一应用缩放
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
```

场景单位保持：`scene.unit_settings.system = 'METRIC'`、`scale_length = 1.0`。

### 为什么

FBX 会携带物体变换；未应用的缩放会以「节点缩放」进入 UE，与其他资产叠加后尺寸失控。

### 验证方式

体检 `transform_applied` 与 `units` 均为 PASS；导出自检 `size_match` 在容差内。

### 相关

`metrics.md`；`export-ue.md`

## 症状：法线反了 / 材质显示异常（负缩放）

### 症状

- 关键词：翻转法线 / negative scale / 黑面 / 镜像
- 镜像复制或负缩放后，模型出现黑面、背面剔除异常。

### 错误做法

- 直接对物体设负的 scale 后应用，未检查法线方向。

### 正确做法

- 应用缩放前检查行列式：`obj.matrix_world.determinant() > 0`。
- 出现负行列式：修正缩放方向；必要时 `bpy.ops.mesh.flip_normals()`。

### 为什么

行列式为负 = 坐标系手性翻转，法线方向随之反转，渲染与光照都受影响。

### 验证方式

体检 `negative_scale` 为 PASS；渲染无黑面。

### 相关

`metrics.md`

## 症状：枢轴/原点不对，旋转与导出错位

### 症状

- 关键词：origin / pivot / 枢轴 / 旋转错位
- 对象旋转时绕错误的位置转；导出后层级位置偏移。

### 错误做法

- 保持创建时的默认原点（多在几何中心），不按用途调整。

### 正确做法

- 门：原点放铰链处并在编辑模式移动几何到原点；或用 `bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY')` 校正。
- 设定后应用旋转，避免残留旋转。

### 为什么

旋转、层级与导出都以对象原点为基准；原点错了，后续所有运动都不对。

### 验证方式

旋转对象观察是否绕预期轴/点转动；导出自检尺寸与位置正常。

### 相关

`workflow.md`（阶段 1）
