#!/usr/bin/env python3
"""生成示例场景：桌子 + 台灯（含循环动画、材质与 UV）。

用于技能自测与演示（最佳实践参考：命名前缀、应用变换、材质、UV、循环动画）。

用法（经启动器，无头）：
  python blender_cli.py build_sample_scene.py -- <out.blend>
"""
import argparse
import math
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Build the sample Blender scene.')
    parser.add_argument('out', help='output .blend path')
    return parser.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, base_color, metallic, roughness):
    mat = bpy.data.materials.new(name)
    bsdf = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = base_color
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def _activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def apply_transforms(obj):
    _activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)


def bevel(obj, width=0.015, segments=1):
    _activate(obj)
    mod = obj.modifiers.new('Bevel', 'BEVEL')
    mod.width = width
    mod.segments = segments
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


def unwrap(obj):
    _activate(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    except TypeError:
        bpy.ops.uv.smart_project()
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)


def add_box(name, dimensions, location, material):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (dimensions[0], dimensions[1], dimensions[2])
    apply_transforms(obj)
    obj.data.materials.append(material)
    return obj


def add_cylinder(name, radius, depth, location, material, vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=vertices,
                                        end_fill_type='TRIFAN', location=location)
    obj = bpy.context.active_object
    obj.name = name
    apply_transforms(obj)
    obj.data.materials.append(material)
    return obj


def add_cone(name, radius1, radius2, depth, location, material, vertices=32):
    bpy.ops.mesh.primitive_cone_add(radius1=radius1, radius2=radius2, depth=depth, vertices=vertices,
                                    end_fill_type='TRIFAN', location=location)
    obj = bpy.context.active_object
    obj.name = name
    apply_transforms(obj)
    obj.data.materials.append(material)
    return obj


def animate_head(obj):
    """台灯灯头点头循环：第 1 帧与第 60 帧姿态一致。"""
    obj.rotation_mode = 'XYZ'
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.keyframe_insert('rotation_euler', frame=1)
    obj.rotation_euler = (-0.35, 0.0, 0.0)
    obj.keyframe_insert('rotation_euler', frame=30)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.keyframe_insert('rotation_euler', frame=60)


def main():
    args = parse_args()
    reset_scene()

    scene = bpy.context.scene
    scene.name = 'SampleLamp'
    scene.render.fps = 30
    scene.frame_start = 1
    scene.frame_end = 60
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0

    mat_wood = make_material('M_Wood', (0.42, 0.27, 0.15, 1.0), 0.0, 0.45)
    mat_metal = make_material('M_Metal', (0.55, 0.56, 0.58, 1.0), 1.0, 0.35)
    mat_shade = make_material('M_LampShade', (0.90, 0.78, 0.45, 1.0), 0.0, 0.60)

    table = add_box('SM_TableTop', (1.10, 0.70, 0.05), (0.0, 0.0, 0.75), mat_wood)
    bevel(table)
    unwrap(table)

    leg_dx, leg_dy = 0.48, 0.28
    legs = [
        ('SM_TableLeg_NW', (-leg_dx, leg_dy)),
        ('SM_TableLeg_NE', (leg_dx, leg_dy)),
        ('SM_TableLeg_SW', (-leg_dx, -leg_dy)),
        ('SM_TableLeg_SE', (leg_dx, -leg_dy)),
    ]
    for name, (x, y) in legs:
        leg = add_cylinder(name, 0.03, 0.72, (x, y, 0.36), mat_metal, vertices=16)
        unwrap(leg)

    base = add_cylinder('SM_LampBase', 0.11, 0.035, (0.25, 0.0, 0.795), mat_metal, vertices=32)
    bevel(base, width=0.008)
    unwrap(base)

    pole = add_cylinder('SM_LampPole', 0.012, 0.42, (0.25, 0.0, 1.0), mat_metal, vertices=16)
    unwrap(pole)

    head = add_cone('SM_LampHead', 0.03, 0.10, 0.14, (0.25, 0.0, 1.27), mat_shade, vertices=32)
    unwrap(head)
    animate_head(head)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print('SAVED:', out)
    print('objects:', len(bpy.data.objects), 'materials:', len(bpy.data.materials))


if __name__ == '__main__':
    main()
