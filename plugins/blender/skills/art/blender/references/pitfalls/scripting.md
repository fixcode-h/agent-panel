# 易错点：bpy / 无头脚本（scripting）

## 症状：脚本报错但命令像成功了（退出码 0）

### 症状

- 关键词：退出码 0 / exit code / 异常被吞 / silent failure
- 无头运行时脚本抛异常，但外层命令报告成功，后续步骤拿着旧产物继续跑。

### 错误做法

- 直接 `blender --background --python script.py`，不设置退出码语义。
- 脚本内部用 `print('error')` 代替 `raise` / `sys.exit`。

### 正确做法

```powershell
python blender_cli.py <script.py> <args...>   # 启动器已附加 --python-exit-code 1
```

脚本内用明确退出码约定：`0` 通过、`1` 检查未通过、`2` 环境错误（`sys.exit(main())`）。

### 为什么

Blender 默认在脚本异常后仍以 0 退出；`--python-exit-code 1` 让异常映射为非零，启动器与 CI 才能拦截。

### 验证方式

故意在脚本里 `raise RuntimeError('boom')`，运行后确认退出码为 1。

### 相关

`commands.md`（启动器行为）；`pitfalls/export.md`

## 症状：`bpy.ops` 在无头模式报 context 错误

### 症状

- 关键词：context is incorrect / poll / temp_override / 无头模式
- `bpy.ops.object.transform_apply` 等调用抛出 "context is incorrect"。

### 错误做法

- 直接调用依赖「当前区域/选区」的算子，不设置 active 对象或上下文。

### 正确做法

```python
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# 区域相关（如视图配置）用 temp_override
with bpy.context.temp_override(window=window, screen=screen, area=area):
    bpy.ops.screen.area_split(direction='HORIZONTAL', factor=0.5)
```

### 为什么

算子（ops）依赖运行上下文（active 对象、选区、区域）；数据 API（`obj.data.*`、`obj.scale`）不依赖上下文，能不用 ops 就不用。

### 验证方式

无头运行脚本，确认无 context 异常且目标数据已改变。

### 相关

`commands.md`（常见 bpy 片段）

## 症状：`--python-expr` 报 NameError / 引号被吞

### 症状

- 关键词：--python-expr / NameError / quoting / PowerShell 引号
- 在 PowerShell 里给 `--python-expr` 传带引号的 Python 代码，引号被 shell 吃掉，报奇怪的 NameError。

### 错误做法

- 在命令行把整段 Python（含引号）拼进 `--python-expr`。

### 正确做法

- 把代码写成临时 `.py` 文件，用 `--python` 运行（启动器默认方式）。

### 为什么

PowerShell 5.1 向原生程序传参时不会正确转义内嵌引号；两层引号（shell + Python）极易互相吞。

### 验证方式

任意探测脚本（如打印 FBX 导出参数）改成 `.py` 文件运行后可正常输出。

### 相关

`commands.md`

## 症状：相对路径找不到文件

### 症状

- 关键词：No such file / 相对路径 / cwd
- 脚本在其他目录执行时找不到输入/输出文件。

### 错误做法

- 依赖「命令在哪里敲」的相对路径。

### 正确做法

```python
path = os.path.abspath(args.blend)
os.makedirs(os.path.dirname(out), exist_ok=True)
```

### 为什么

无头运行的工作目录由调用方决定，脚本不应假设 cwd。

### 验证方式

在仓库根与临时目录各跑一次，输出路径一致。

## 症状：无头模式 `shade_auto_smooth` 打印 `geometry_nodes_essentials.blend` 库路径警告

### 症状

- 关键词：geometry_nodes_essentials / cannot be made relative / Smooth by Angle / 无头模式
- 应用自动平滑后保存或渲染时出现资产库路径警告，担心污染交付文件。

### 错误做法

- 让 Smooth by Angle 修改器长期挂在物体上（导出需额外处理，文件携带资产库引用）。
- 因此完全放弃自动平滑，圆柱端盖出现硬边断层。

### 正确做法

```python
bpy.ops.object.shade_smooth()
try:
    bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
except Exception:
    pass   # 旧版本不支持时退回普通平滑
```

立即应用修改器；警告仅为库路径不可相对化，不影响已应用的网格与导出。

### 为什么

`shade_auto_smooth` 以资产库中的几何节点组实现；应用修改器后尖锐边写回网格属性，文件不再依赖该修改器。

### 验证方式

体检 `pending_modifiers` 为 PASS；无头运行除该警告外无报错，FBX 导出正常。

### 相关

`pitfalls/materials-uv.md`

## 症状：GUI 模式下一跑完就退出，窗口无法停留

### 症状

- 关键词：GUI 一闪而过 / 窗口立刻关闭 / sys.exit / 视口展示看不到
- 用 `--gui` 展示场景时 Blender 启动不到几秒就自行退出，桌面看不到窗口。

### 错误做法

- 脚本以 `sys.exit(main())` 结尾：在 Blender 的 `--python` 脚本里，`sys.exit` 会终止整个 Blender 进程（无头与 GUI 模式都一样）。

### 正确做法

```python
if __name__ == '__main__':
    if bpy.app.background:
        sys.exit(main())        # 无头：退出码语义交给调用方
    else:
        try:
            code = main()
            if code != 0:
                print('script returned {0}'.format(code))
        except Exception as exc:
            print('script failed: {0}'.format(exc))
```

- 启动器在 `--gui` 时不会附加 `--python-exit-code`，异常同样不会把窗口带走。

### 为什么

`sys.exit()` 抛出 SystemExit；Blender 把命令行脚本的 SystemExit 当作「退出应用」处理（配合 `--python-exit-code` 还会设置进程退出码）。

### 验证方式

`setup_viewport.py --gui <scene>` 后窗口保持打开；关闭窗口时命令才返回（退出码 0）。

### 相关

`commands.md`（GUI 展示）；`pitfalls/evaluation.md`

## 症状：视口布局摆错（四分屏成 4 列）/ 相机取景太远

### 症状

- 关键词：四分屏 / 布局 / 2x2 / 4 列 / 相机太远 / 取景
- 展示场景时四个 3D 视图排成一列而不是四方格；相机象限离主体很远、看不清。

### 错误做法

- 反复「切分最大区域 + 按长边方向切」凑数：形状变化后会连续纵向切分得到多条竖列；相机按固定远景摆放而不对焦主体。

### 正确做法

```python
# 默认：单视口（相机视角），不切分；需要多视图时——
# 先水平对半（上下），再把两半各自垂直对半 → 2×2
split_area(screen, window, main, 'HORIZONTAL', 0.5)
for area in halves:
    split_area(screen, window, area, 'VERTICAL', 0.5)
# 非相机视图对焦主体：设置 view_location / view_distance
space.region_3d.view_location = center
space.region_3d.view_distance = radius * 2.4
```

- 相机取景：低机位跟拍，距主体约 1.5 m（35 mm 镜头）；`setup_viewport.py` 已内置主体对焦。

### 为什么

切分方向若只看「最大区域」，同一方向会被重复选择；取景距离必须相对主体包围盒计算，不能写死。

### 验证方式

GUI 打开后四视图为 2×2 四方格，前/右/顶视图与相机象限都能看清主体。

### 相关

`commands.md`（GUI 展示）；`workflow.md` 阶段 4

## 症状：GUI 相机视角报 `enum "CAMERA" not found`

### 症状

- 关键词：view_axis / enum CAMERA / 相机视角 / enum "CAMERA" not found
- `setup_viewport.py --gui` 报 `Converting py args to operator properties: enum "CAMERA" not found in ('LEFT', 'RIGHT', 'BOTTOM', 'TOP', 'FRONT', 'BACK')`，后续配置（着色/播放）全部被跳过。

### 错误做法

- 用 `bpy.ops.view3d.view_axis(type='CAMERA')` 切相机视角（该运算符只接受六个正交方向）。

### 正确做法

```python
space.region_3d.view_perspective = 'CAMERA'   # 数据 API：枚举 PERSP / ORTHO / CAMERA
# 或用 bpy.ops.view3d.view_camera()（注意它是「切换」语义，重复调用会切回用户视角）
```

### 为什么

相机视角不是「正交轴视图」，由 `RegionView3D.view_perspective` 表达；`view_axis` 的 type 枚举里没有 CAMERA。

### 验证方式

`--gui` 启动后输出 `GUI configured: single viewport (camera) + material preview + playback` 且窗口保持打开；不再出现 `setup_viewport failed`。

### 相关

`commands.md`（GUI 展示）；`pitfalls/evaluation.md`

## 症状：相交检测漏检（BVH 返回 0）

### 症状

- 关键词：BVH / overlap / 漏检 / 局部空间 / 四边形
- 相交检查对肉眼可见的相交件报告 0 对；合成对照（两个相交立方体）也返回 0。

### 错误做法

- `BVHTree.FromObject` 直接跨对象比较（它是对象局部空间，位置不同会误报/漏报）。
- `BVHTree.FromPolygons(..., all_triangles=False)` 用四边形建树——实测 `overlap()` 会漏检（相交立方体也返回 0）。

### 正确做法

```python
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
mesh.transform(obj.matrix_world)          # 世界坐标
mesh.calc_loop_triangles()                # 先三角化
tree = BVHTree.FromPolygons([v.co.copy() for v in mesh.vertices],
                            [tuple(t.vertices) for t in mesh.loop_triangles],
                            all_triangles=True, epsilon=0.0)
```

（`inspect_scene.py` 的 `world_bvh` 已固化；大场景用 `--intersect-focus "前缀,..."` 聚焦特定件。）

### 为什么

`FromObject` 用未变换的局部网格；四边形面在 BVH 内未三角化时 `overlap()` 的相交判定不可靠。

### 验证方式

合成对照：相交立方体返回 >0、相距 10 m 返回 0；场景内已知穿透（如轮胎陷地）可被检出。

### 相关

`commands.md`；`pitfalls/topology.md`（结构性穿透）

## 症状：bmesh 生成的几何整体跑偏（缩放把位置也乘了）

### 症状

- 关键词：bmesh.ops.scale / 位置偏移 / 几何跑到原点附近 / scale shifted geometry
- 用 `bmesh.ops.create_uvsphere/cone(..., matrix=Matrix.Translation(目标点))` 建好几何后，再用 `bmesh.ops.scale` 调整尺寸：部件出现在远离目标点的位置（平移量被缩放系数乘过）。

### 错误做法

```python
head = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0,
                                 matrix=Matrix.Translation((0.0, 6.0, 0.35)))
bmesh.ops.scale(bm, vec=(0.05, 0.05, 0.06), verts=head['verts'])   # 位置也被乘了
# → 球心跑到 (0, 6.0*0.05, 0.35*0.06) = (0, 0.30, 0.021)
```

### 正确做法

把缩放与平移写进同一个 matrix（右乘先作用：先缩放、后平移）：

```python
matrix = Matrix.Translation((0.0, 6.0, 0.35)) @ Matrix.Diagonal((0.05, 0.05, 0.06, 1.0))
bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0, matrix=matrix)
```

### 为什么

`bmesh.ops.scale` 的 space 默认是单位矩阵，语义是「顶点坐标 × vec」，不是「以某点为中心缩放」；已平移过的顶点会把平移量一起乘进结果。

### 验证方式

生成后打印对象/连通分量的包围盒，确认中心与尺寸都在预期区间（可用按连通分量拆分检查的小脚本）。

### 相关

`pitfalls/transforms.md`（变换纪律）；`commands.md`

## 症状：手写网格出现黑面 / 法线反（面顶点顺序不可靠）

### 症状

- 关键词：法线反 / 黑面 / 面顺序 / 手写面 / recalc
- 用 bmesh 手工 `bm.faces.new([...])` 构造盒体、挤出轮廓、扇形封盖时，部分面法线朝内，渲染出现黑面或非流形判定异常。

### 错误做法

- 逐个面手推顶点顺序（逆时针朝外），并假设多件、多结构下仍能全对。

### 正确做法

对每个闭合流形对象，写入 mesh 前统一重算朝外法线：

```python
def bm_to_object(bm, name, material):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ...
```

### 为什么

`recalc_face_normals` 基于流形拓扑统一朝外；闭合体（哪怕由很多互不相连的封闭件组成）都能被正确处理，比人工推顺序可靠。

### 验证方式

渲染无黑面；`inspect_scene.py` 无非流形告警。

### 相关

`pitfalls/topology.md`；`commands.md`（常见 bpy 片段）

## 症状：相交报告只有对象名，定位不到具体相交位置

### 症状

- 关键词：intersect-report / 定位相交 / 不知道哪相交 / overlap location
- `inspect_scene.py --intersect-report` 报告 `SM_X_TrackL <-> SM_X_WheelL_01` 这类对象对，但对象由几十个件组成（整条履带 vs 整个轮），肉眼找不到相交点。

### 错误做法

- 靠渲染图猜想，或在两个对象内逐件手工排查。

### 正确做法

- 用相交定位脚本（已收录）：对两个对象各建「世界坐标 + 三角化」BVH，`overlap()` 后输出相交三角的中心坐标：

```powershell
python blender_cli.py diagnose_overlap.py -- <scene.blend> SM_X_TrackL SM_X_WheelL_01
```

- 按坐标立即锁定嫌疑件（如 z≈0.02–0.04 落在「轮底 vs 板顶」之间）。
- 建树沿用 `world_bvh` 的既有纪律：世界坐标变换 + `all_triangles=True`（见「相交检测漏检」条目）。

### 为什么

BVH `overlap()` 返回三角索引、不携带坐标；把索引映射回顶点即得位置，比猜快且准。

### 验证方式

输出坐标与嫌疑部件的包围盒吻合；修复后该对象对从 `--intersect-report` 中消失。

### 相关

`commands.md`（diagnose_overlap）；`pitfalls/topology.md`（路径件方向 / 穿透）

## 症状：挂父级后子件被二次偏移（位置翻倍 / 整体漂移）

### 症状

- 关键词：keep parent / 子件偏移 / 位置翻倍 / matrix_parent_inverse / 装配后位置不对
- 批量给对象 `obj.parent = grp` 之后，子件世界位置多出父级那段偏移（例：轮心 y 由 1.13 变 2.26），或全部件整体漂移。

### 错误做法

- 在刚设置/刚创建对象后立刻读 `obj.matrix_world` 或 `grp.matrix_world` 去算 `matrix_parent_inverse`。依赖图未刷新，读到的是过期矩阵（常为单位阵），inverse 失效。

### 正确做法

- 统一用「保持世界变换」的挂父级函数：

```python
def keep_parent(obj, grp):
    bpy.context.view_layer.update()          # 关键：先刷新依赖图
    obj.parent = grp
    obj.matrix_parent_inverse = grp.matrix_world.inverted()
    return obj
```

- 语义区分：**要随组运动但保持原位**的件（车轮随车体）用 keep_parent；**要让父级变换整体生效**的件（烟团缩放的网格子件）直接 `obj.parent = grp`、不设 inverse。

### 为什么

`matrix_world` 是依赖图求值结果，脚本内改完变换没 `update()` 就读取会拿到旧值；成百实例装配时表现为「位置翻倍」这类整齐的偏移，最容易被误判为坐标算错。

### 验证方式

装配后抽查若干子件 `obj.matrix_world.translation` 与设计坐标一致；或渲染侧视核对轮系/挂件就位。

### 相关

`references/part-workshop.md`（装配表）；`commands.md`（blender_cli）

## 症状：嵌套旋转件互相穿插（轮胎里嵌实心圆柱）

### 症状

- 关键词：轮胎/轮毂穿插 / 相交报告噪声 / 环形管 / annulus / tube
- 轮类部件用实心圆柱拼（轮胎=实心圆柱、轮毂直接插进去），静态看着没问题，`--intersect-report` 把成对轮件全报相交；换视角/旋转时穿帮。

### 错误做法

- 用实心圆柱做轮胎/轮缘，再把轮毂、辐板插进实心体内部。

### 正确做法

- 旋转嵌套件一律用**环形管**：外壁 + 内壁 + 两端环形封盖（四环闭合 loft：外前→外后→内后→内前，首尾再桥接），并留 5 mm 级间隙：

```python
def make_tube(r_out, r_in, depth, segments=16):
    # rings: (r_out,-h/2) (r_out,+h/2) (r_in,+h/2) (r_in,-h/2)，闭合桥接、不封盖
    ...
```

- 低多边形负重轮实测配方：双胎（各 0.16 宽，中缝 0.085 留给履带导齿）+ 轮缘环 + 5 片外宽内窄梯形辐板 + 7 颗螺栓 + 中心盖；轮毂外径比胎内径小 2–3 cm。
- 辐板用**梯形棱柱**（`make_prism` 的 XZ 剖面沿 Y 挤）而不是长方体：外缘宽度约为内缘 3 倍，才像参考的扇形辐板。

### 为什么

相交报告按三角形实际相交判定：**同对象内**嵌套不报、**跨对象**必然报。环形管让「轮毂装在胎孔里」几何上成立，报告干净且视觉正确。

### 验证方式

`inspect_scene.py --intersect-report` 中该件对消失；单件预览看中缝与胎孔。

### 相关

`references/part-workshop.md`；`pitfalls/topology.md`（路径件方向/穿透）

## 症状：一个部件需要多材质（深底板 + 浅垫片）被迫拆成多个对象

### 症状

- 关键词：多材质 / material_index / 一件两色 / 拆对象 / 履带链板
- 链板（深色底板 + 浅色哑铃垫 + 导齿）、轮（黑胎 + 浅辐板）要 2–3 种颜色，按「一个 Part 一个材质」只能拆对象，实例化后对象数翻倍。

### 错误做法

- 每个颜色拆一个对象再用父级绑在一起（对象数暴涨、装配表复杂、动画关键帧翻倍）。

### 正确做法

- 让 Part 支持材质槽分段：每次 `add()` 记录本段面数与材质索引；`finish(extra_mats=(...))` 时按段写 `polygon.material_index`：

```python
p.set_mat(1)                     # 之后的 add() 面归入材质槽 1
p.box(...)
p.finish('SM_Tank_Link', 'M_Metal_Dark', extra_mats=('M_Metal_Light',))
```

- 一个部件只出一个对象；实例化 `obj.copy()` 共享网格与材质槽。

### 为什么

低多边形资产的细节主要靠「同件多色」；把颜色拆成对象会让对象数、装配表、关键帧全部膨胀。

### 验证方式

单件预览两色分区清晰；对象数不随细节增加而暴涨；材质数不失控（见 `metrics.md` 预算表）。

### 相关

`references/part-workshop.md`

## 症状：高模倒角把细薄件压变形 / 体检 ngons FAIL

### 症状

- 关键词：倒角 / bevel / 细节被压坏 / 辐板碎裂 / n-gon / clamps
- 统一给所有硬边倒角 12 mm 后，辐板、链板垫片、螺栓这类细薄件出现黑色裂缝/自交/塌陷；或倒角后体检 `ngons` FAIL。

### 错误做法

- 用一个全局倒角宽度处理整件（小特征承受不了大偏移，clamp_overlap 只防完全自交，防不住「视觉上被压扁」）。
- 倒角后不做处理，忽略顶点处多边交汇新生成的 >4 边面。

### 正确做法

- 倒角宽度**自适应**：按该件所有边的中位长度 × 8%，再夹到 [1.5 mm, 期望上限]：

```python
lengths = sorted(e.calc_length() for e in bm.edges)
offset = min(width, max(lengths[len(lengths) // 2] * 0.08, 0.0015))
bmesh.ops.bevel(bm, geom=hard_edges, offset=offset, segments=2, affect='EDGES',
                clamp_overlap=True, loop_slide=True)
ngons = [f for f in bm.faces if len(f.verts) > 4]
if ngons:
    bmesh.ops.triangulate(bm, faces=ngons)          # 倒角顶点补面立即三角化
```

- 只倒「硬边」：双面边且面角 > 26°；大平面内的细分边不碰。

### 为什么

倒角偏移是绝对尺寸：细薄件（几十毫米）遇上十毫米倒角，几何直接被吞掉；而顶点处多边交汇必然生成五边以上的补面，不三角化就过不了 ngons 检查。

### 验证方式

单件预览（EEVEE）看细薄件是否完整；体检 `ngons = 0`；对比倒角前后的面数增长（正常为 +30%–80%，暴涨说明倒角打到不该打的边）。

### 相关

`references/part-workshop.md`（按参考特征决定部件做法）；`pitfalls/topology.md`
