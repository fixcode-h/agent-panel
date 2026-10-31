# 分件工坊：复杂模型「拆分 → 精修 → 组装」

> 一句话：**不要一上来就写整模脚本**。把大模型拆成小件，每件对照参考图片单独构建、预览和精修，最后用装配表组装。

## 为什么有效

- 单件预览把问题放大：辐板太窄、齿与轮缘脱节、链板垫片过高穿地——整模一次渲染里根本看不清，单件 900px 预览上一眼就抓到。
- 改件不动整机：调整负重轮只跑 `p_wheel.py`＋预览，不必重跑整模。
- 装配表把「形状」与「摆放」解耦：件在自身局部坐标系里做好，位置/父级只在装配时给。
- 实例化天然成立：同一件（轮/链板/主动轮）只建一次，`obj.copy()` 共享网格，112 块链板不增面数。

## 目录与文件形态

```
项目/
  scripts/
    tank_anchors.py          # 锚点尺寸表 + 共享几何助手 + 装配表
    lib_common.py            # Part（多材质槽）/ make_tube / make_prism / make_loft / 材质缓存
    parts/
      p_wheel.py             # 一个部件一个文件，只暴露 NAME / OBJECTS / build()
      p_sprocket.py
      p_link.py
      p_hull.py
      ...
    build_parts.py           # 逐件构建 → parts/<件名>.blend（单件场景，便于预览）
    preview_parts.py         # 逐件渲染 3/4 + 正侧视（workbench，可 --engine eevee）
    assemble_tank.py         # 装配：建组 → 挂件 → 实例化 → 写回主场景
  parts/
    wheel.blend  sprocket.blend  ...   # 单件场景
    renders/wheel/q.png  renders/wheel/side.png  ...  # 单件预览
```

### 部件模块约定

```python
NAME = 'wheel'
OBJECTS = ('SM_Tank_Wheel',)

def build(name='SM_Tank_Wheel'):
    """在自身局部坐标系构建（原点居中/贴地），返回对象；不关心摆放。"""
```

- 局部坐标系：轮件轴线沿 Y、轮心在原点；炮塔组件以炮塔中心为原点；「装饰件」（车体侧面工具等）允许直接写在整车坐标系。
- 一切助手（`make_tube` / `petal_spokes` / 锚点尺寸 `A`）放 `tank_anchors.py`，件之间不互相 import 几何。

### 装配表

装配脚本只做三件事：建组（GRP_Tank/Sprung/Running/Track/Turret）、按表挂件、实例化多件。

```python
LOCAL = [('p_turret', grp_turret, (A['turret_x'], 0, A['z_deck'])),
         ('p_gun',    grp_turret, (A['turret_x'], 0, A['z_deck'])),
         ('p_wheel',  grp_running, wheel_placements()),
         ('p_link',   grp_track,   link_placements())]
```

- 挂父级统一用 `keep_parent()`（内部先 `view_layer.update()`，见 `pitfalls/scripting.md`）。
- 实例：`dup = obj.copy()`（共享网格）→ 设 `location/rotation_euler` → `keep_parent`；模板对象最后删除。

## 按参考特征决定部件做法

不设置高模/低模开关。每件把参考裁切、可见特征、几何/贴图做法和验收视角一起写入装配表，再调整实际参数。

| 参考特征                         | 制作依据                                                 | 验收                          |
| -------------------------------- | -------------------------------------------------------- | ----------------------------- |
| 轮廓转折、棱面、连续曲面         | 分段与平滑边界按参考调整，保留图中的转折或连续性         | 同机位剪影与近景对照          |
| 边缘高光、圆角、薄板厚度         | 按参考和部件尺寸确定倒角宽度/分段，锐利边不统一倒圆      | 边缘特写与厚度对照            |
| 孔洞、凹槽、接缝与遮挡           | 影响剪影或遮挡的细节用几何表达                           | 正侧视与局部裁切对照          |
| 木纹、涂装、标识、污渍与微小起伏 | 按图选择图片贴图或程序化材质，匹配图案、尺度、方向与分区 | 材质渲染与纹理特写对照        |
| 颜色与表面反射                   | 分别调整底色、粗糙度、金属感等，不把阴影当底色           | 匹配光照/色彩管理后的参考对照 |

三条实现约束：

1. **倒角宽度必须自适应**：不能给辐板、垫片和螺栓套统一宽度；参考边缘外观是目标，边长和厚度只用于限制偏移，避免细薄件变形。
2. **倒角会造 n-gon**：顶点处多边交汇生成 >4 边面，倒角后切分或三角化这些面，再核对参考轮廓。
3. **平滑不能抹掉参考特征**：平滑边界与光照都需对照参考调整；不套统一锐边角度，不为突出几何自行改变参考的光影风格。

## 单件预览与迭代纪律

```powershell
python blender_cli.py <项目>/scripts/build_parts.py wheel sprocket idler link
python blender_cli.py <项目>/scripts/preview_parts.py --res 900 wheel sprocket
```

- 或直接用技能脚本对单件场景出图：`capture_views.py parts/wheel.blend --focus SM_Tank --out ...`。
- 单件先过「结构对不对」（几段轮廓、几片辐板、有没有孔），再过「比例对不对」（对照参考放大裁切图）。
- 迭代到单件满意再装配；装配后再跑整机多视角，问题定位回单件改。
- 工坊件同样适用体检：单件场景也应 ngon=0 / 法线一致 / 有 UV。

## 与体检/评估的关系

- 装配完成后照常跑 `inspect_scene.py`（ngon / 相交 / 命名 / scale / 三角预算）。
- 相交报告的「跨对象」噪声很大一部分来自嵌套旋转件，工坊阶段就该用环形管消灭（见 `pitfalls/scripting.md`）。

## 实测证据（低多边形坦克项目）

| 指标       | 整模一把梭                        | 分件工坊                                 |
| ---------- | --------------------------------- | ---------------------------------------- |
| 部件对象   | 1 个 `build_tank.py` 内嵌全部     | 16 个 `p_*.py`，各自构建/预览            |
| 履带       | 静态整体网（5 万面一次写死）      | 单块链板 66 面 → 实例 112 块，可循环动画 |
| 负重轮     | 实心圆柱 + 嵌轮毂（相交报告噪声） | 双胎环管 + 梯形辐板 + 螺栓环（报告干净） |
| 迭代代价   | 改一个轮要重跑整模                | 改轮只跑 `p_wheel` + 预览                |
| 单件可核验 | 否                                | 每件 2 视角预览 + 单件体检               |

## 相关

- `references/reference-rebuild.md`（参考素材 → 复刻的完整流程）
- `references/pitfalls/scripting.md`（keep-parent 过期矩阵 / 环形管 / 多材质槽）
- `references/evaluation.md`（多视角评估）
