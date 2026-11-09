# 导出规则：FBX → UE

> **导出是可选步骤**：默认不导出；执行前先询问用户是否需要 UE 交付，未获确认不得自动导出。
> 默认交付**二进制 FBX**（`export_ue.py` 固化预设），导出后自动做重导入自检。
> 本机无 UE，UE 侧实机导入属**延期验证**：按下方清单在有 UE 的机器核对。

## 导出命令

```powershell
python blender_cli.py export_ue.py <scene.blend> --out <dir> [--name <base>] [--exempt]
```

- 导出前执行体检门槛：存在 FAIL 时拒绝导出（唯一例外：`--exempt`，须在评估记录说明理由）。
- 产物：`<dir>/<base>.fbx` + `<dir>/export_check.json`。

## 预设参数（在 Blender 5.2.1 实测）

| 参数                                        | 值               | 说明                                                  |
| ------------------------------------------- | ---------------- | ----------------------------------------------------- |
| `apply_unit_scale`                          | `True`           | 按场景单位换算，避免双倍缩放                          |
| `global_scale`                              | `1.0`            | 不叠加额外缩放                                        |
| `apply_scale_options`                       | `FBX_SCALE_NONE` | 不做批量缩放转换                                      |
| `axis_forward` / `axis_up`                  | `-Z` / `Y`       | Blender Z-up → FBX Y-up 标准转换，UE 导入保持默认即可 |
| `add_leaf_bones`                            | `False`          | 不生成叶骨（UE 重定向更干净）                         |
| `primary_bone_axis` / `secondary_bone_axis` | `Y` / `X`        | 骨骼轴向对齐 UE                                       |
| `bake_anim`                                 | `True`           | 烘焙动画，消除依赖                                    |
| `bake_anim_use_nla_strips`                  | `False`          | 见下方「动画模式」                                    |
| `bake_anim_use_all_actions`                 | `True`           | 每个 action 一个 take（推荐默认）                     |
| `bake_anim_simplify_factor`                 | `0.0`            | 不做关键帧简化，保证保真                              |
| `mesh_smooth_type`                          | `FACE`           | 按面平滑，配合切线导出                                |
| `use_mesh_modifiers`                        | `True`           | 应用修改器后导出                                      |
| `use_tspace`                                | `True`           | 导出切线，UE 法线贴图需要                             |
| `path_mode`                                 | `AUTO`           | 贴图路径处理；FBX 默认不内嵌贴图                      |
| `embed_textures`                            | `False`          | 贴图独立交付，便于 UE 管线                            |

## 动画模式（实测结论）

- **All Actions 模式（默认）**：每个 action 导出为一个 take，静态对象不产生动作；重导入自检 1:1。
- **NLA 条带模式（`bake_anim_use_nla_strips=True`）**：适合 NLA 组织的场景，但会把静态对象也烘焙出动作（实测 1 个动作为 8 个对象各生成 1 个），自检会误报数量不一致。
- 结论：默认用 All Actions；场景确实用 NLA 组织时再切换，并相应调整自检预期。

## 重导入自检（`export_check.json`）

- 导出后自动在无头 Blender 中重导入 FBX，比对：包围盒尺寸（相对容差 0.1% 或 1mm）、网格数、材质数、动作数。
- 任一项 FAIL → `EXPORT_OK=False`（退出码 1），先修再交付。
- 自检通过只代表「导出往返保真」；UE 侧的观感仍需实机核对。

## UE 侧导入检查清单（延期验证项）

1. **单位与缩放**：以 m 建模 → 导入 UE 应为 cm 口径（1m = 100uu），尺寸与设计值一致。
2. **朝向**：Z-up → Y-up 转换正确（角色面朝 -Y 或按项目约定）。
3. **材质槽**：数量、命名与 FBX 一致；贴图按需手动接入。
4. **骨骼层级**：无多余叶骨；骨骼命名可读、层级正确。
5. **动画时长**：take 数与帧范围符合预期（30fps 对齐）。
6. **法线/切线**：法线贴图方向正常（需 `use_tspace`，已开启）。

## 常见问题排查

- **动画丢失（动作数 0）**：确认动画是独立 action 且导出为 All Actions 模式；游离 action 在 NLA 模式下不会导出。
- **尺寸不对**：检查体检 `transform_applied`（scale=1）与 `units`；不要在物体或场景上叠加缩放。
- **多出一堆空动作**：NLA 模式副作用，切回 All Actions。
