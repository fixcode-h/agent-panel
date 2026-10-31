# 命令速查：什么时候用什么指令

> 所有脚本都经启动器执行：先定位 Blender（`BLENDER_PATH` → PATH → 注册表 → 常见目录），再以无头模式运行。
> 调用格式：`python blender_cli.py <脚本> <参数...>`（启动器自动插入 Blender 的 `--` 分隔符；不要手动再加 `--`）。
> GUI 展示：`python blender_cli.py setup_viewport.py --gui <scene.blend>`（去掉 `--background`，窗口关闭后命令才返回）。

## 场景与用途对照

| 要做什么                                     | 用什么                  | 命令                                                                                                                                                                                                                             |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 查看 Blender 定位结果                        | 启动器                  | `python blender_cli.py --where`                                                                                                                                                                                                  |
| 生成演示/自测场景                            | `build_sample_scene.py` | `python blender_cli.py build_sample_scene.py <out.blend>`                                                                                                                                                                        |
| 场景体检（指标 JSON）                        | `inspect_scene.py`      | `python blender_cli.py inspect_scene.py <scene.blend> --out <report.json> [--max-tris N] [--evaluated]`（按 `metrics.md` 的预算设置依据显式传参，不按高模/低模分档）                                                             |
| 相交检查（信息性）                           | `inspect_scene.py`      | 加 `--intersect-report`：列出相交对象对；`--intersect-focus "前缀,..."` 只看指定件相关配对，`--intersect-limit N` 设上限；`--intersect-frames "1,16,31"` 或 `--intersect-every N` 采样动画帧；装配接触需人工判断                 |
| 相交定位（信息性）                           | `diagnose_overlap.py`   | `python blender_cli.py diagnose_overlap.py <scene.blend> <对象A> <对象B> [--limit N]`：输出相交三角的中心坐标，用于定位 `--intersect-report` 报告的抽象对象对（如整条履带 vs 整个轮）                                            |
| 多视角截图（双引擎）                         | `capture_views.py`      | `python blender_cli.py capture_views.py <scene.blend> --out <dir> [--res 1024] [--engine both\|workbench\|eevee] [--focus "名称前缀1,名称前缀2"]`                                                                                |
| 动画多帧对比                                 | `capture_views.py`      | 加 `--frames "1,16,31,46"`：跳过固定视角集，逐帧渲染并逐帧跟住主体（`anim_f<帧>_<view>[_eevee].png`）；`--frame-view`（默认 right）可切 front/right/back/left/quarter/top——密集场景用 quarter 越过遮挡，特写转动件可配 `--focus` |
| 导出 UE 标准 FBX（**可选步骤，先询问用户**） | `export_ue.py`          | `python blender_cli.py export_ue.py <scene.blend> --out <dir> [--name base] [--max-tris N] [--exempt]`（门槛使用 evaluated mesh）                                                                                                |
| 视口展示（GUI 单视口）                       | `setup_viewport.py`     | `python blender_cli.py setup_viewport.py --gui <scene.blend>`（相机视角 + 播放；场景需有相机）                                                                                                                                   |
| 视口配置校验（无 GUI）                       | `setup_viewport.py`     | `python blender_cli.py setup_viewport.py <scene.blend> --check`                                                                                                                                                                  |

## 启动器行为

- 默认附加 `--factory-startup`（保证可复现；`--no-factory` 可关闭）。
- 默认附加 `--python-exit-code 1`：脚本抛异常时 Blender 以非零退出（不要省略）。
- 脚本参数直接跟在脚本名后；参数里出现 `--gui` 时会以 GUI 模式启动（不加 `--background`）。

## 常见 bpy 片段（写脚本时直接抄）

| 需求                        | 代码                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 重置为空场景                | `bpy.ops.wm.read_factory_settings(use_empty=True)`                                                                      |
| 打开 .blend                 | `bpy.ops.wm.open_mainfile(filepath=path)`                                                                               |
| 应用变换                    | `bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)`（先设 active + 选中）                       |
| UV 展开                     | 进入编辑模式 → `bpy.ops.uv.smart_project()`（失败时退回 `angle_limit=math.radians(66)`）                                |
| 圆柱/圆锥端盖避免 n-gon     | `primitive_cylinder_add(..., end_fill_type='TRIFAN')`                                                                   |
| 关键帧插入                  | `obj.keyframe_insert(data_path='rotation_euler', frame=f)`                                                              |
| 读取动作曲线（5.x 兼容）    | `action.fcurves` 在 5.x 不存在；改走 `action.layers[*].strips[*].channelbags[*].fcurves`（见 `pitfalls/animation.md`）  |
| 探测导出参数                | 写临时 .py 用 `--python` 运行（不要用 `--python-expr` 拼引号，见 `pitfalls/scripting.md`）                              |
| 异形台体（多边形炮塔/锥台） | 两个同点数闭合截面（俯视轮廓）在 z0..z1 桥接：四边形连接 + 顶底三角扇封盖（`bridge_profiles` 模式）                     |
| bmesh 生成件定尺寸/定位     | 缩放与平移写进同一 matrix（`Translation @ Diagonal`）；勿对已平移顶点再 `bmesh.ops.scale`（见 `pitfalls/scripting.md`） |

## 退出码约定（全部脚本一致）

- `0` = 通过；`1` = 检查未通过（体检有 FAIL / 导出门槛拒绝 / 自检失败）；`2` = 环境或参数错误（找不到 Blender / 找不到场景文件）。

## 参考素材预处理（reference_frames.py，系统 python 运行，不进 Blender）

拿到的参考视频/图片先过一遍这里，再谈建模。ffmpeg 查找顺序：`FFMPEG_BIN` → PATH → 常见目录 → `imageio-ffmpeg`（`python -m pip install imageio-ffmpeg` 自带静态 ffmpeg，推荐）。

| 命令                                                                                     | 用途                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `python reference_frames.py --info 视频.mp4`                                             | 时长/分辨率/帧率/总帧数（决定采样步长）         |
| `python reference_frames.py --sheet 视频.mp4 输出目录 --step 3 --tile 5x3 --width 640`   | 时间轴接触表（每 3 s 一帧，超一屏自动分多张）   |
| `python reference_frames.py --frames 视频.mp4 输出目录 --times "0,5,65"`                 | 指定秒点单帧（看关键瞬间）                      |
| `python reference_frames.py --frames 视频.mp4 输出目录 --every 25`                       | 每 25 秒等间隔抽帧（实际使用 ffmpeg `fps=1/N`） |
| `python reference_frames.py --crop 帧.jpg 细节.jpg --box x,y,w,h --scale 3`              | 局部放大（查辐板/垫片/制退器这类结构）          |
| `python reference_frames.py --pair 参考帧.jpg 渲染.png 对照.jpg --width 420`             | 并排对照（参考 vs 渲染，统一高度）              |
| `python reference_frames.py --montage 图1 图2 图3 --out 拼图.jpg --tile 3x1 --width 420` | 多图拼表（单件预览合集/多视角合集）             |

读数纪律：接触表扫全局 → 单帧放大查结构 → 逐张读图（多张同读会被当二进制跳过）。

## 分件工坊（复杂模型）

| 动作                               | 命令                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| 逐件构建（每件一个 .blend）        | `python blender_cli.py <项目>/scripts/build_parts.py [件名 ...]`                     |
| 单件预览（3/4 + 正侧，双引擎可选） | `python blender_cli.py <项目>/scripts/preview_parts.py --res 900 [件名 ...]`         |
| 单件场景出图（用技能脚本）         | `python blender_cli.py capture_views.py parts/wheel.blend --focus SM_Tank --out ...` |
| 装配整机                           | `python blender_cli.py <项目>/scripts/assemble_tank.py`                              |

完整方法论见 `references/part-workshop.md`；参考复刻全流程见 `references/reference-rebuild.md`。
