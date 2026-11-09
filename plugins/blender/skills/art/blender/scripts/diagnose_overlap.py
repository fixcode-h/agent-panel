#!/usr/bin/env python3
"""相交定位：输出两个对象相交三角的中心坐标（配合 inspect_scene --intersect-report 使用）。

背景：`--intersect-report` 只给对象对（如 SM_X_TrackL <-> SM_X_WheelL_01），
当对象由几十个件组成时无法直接看出「在哪里相交」。本脚本对两个对象各建
世界坐标 BVH（三角化后），输出相交三角对的中心坐标，按坐标即可锁定嫌疑件。

用法（经启动器）：
  python blender_cli.py diagnose_overlap.py -- <scene.blend> <对象A> <对象B> [--limit 12]
退出码：0=运行成功（即使 0 对）；2=参数或文件错误。
"""
import argparse
import os
import sys

import bpy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inspect_scene


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Locate overlapping triangle centers between two objects.')
    parser.add_argument('blend', help='input .blend path')
    parser.add_argument('object_a', help='first object name')
    parser.add_argument('object_b', help='second object name')
    parser.add_argument('--limit', type=int, default=12, help='max printed pair locations (default 12)')
    parser.add_argument('--frame', type=int, help='evaluate the scene at this frame')
    return parser.parse_args(argv)


def main():
    args = parse_args()
    if not os.path.isfile(args.blend):
        print('scene not found: ' + args.blend, file=sys.stderr)
        return 2
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    obj_a = bpy.data.objects.get(args.object_a)
    obj_b = bpy.data.objects.get(args.object_b)
    if obj_a is None or obj_b is None:
        print('object not found: {0} / {1}'.format(args.object_a, args.object_b), file=sys.stderr)
        return 2

    if obj_a.type != 'MESH' or obj_b.type != 'MESH' or args.limit <= 0:
        print('objects must be MESH and --limit must be positive', file=sys.stderr)
        return 2
    scene = bpy.context.scene
    if args.frame is not None:
        if args.frame < scene.frame_start or args.frame > scene.frame_end:
            print('frame outside scene range', file=sys.stderr); return 2
        scene.frame_set(args.frame)
        bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts_a, faces_a = inspect_scene.world_triangles(obj_a, depsgraph)
    verts_b, faces_b = inspect_scene.world_triangles(obj_b, depsgraph)
    tree_a = inspect_scene.world_bvh(obj_a, depsgraph)
    tree_b = inspect_scene.world_bvh(obj_b, depsgraph)
    pairs = tree_a.overlap(tree_b)
    print('overlap triangle pairs: {0}'.format(len(pairs)))
    for index_a, index_b in pairs[:args.limit]:
        tri_a = [verts_a[i] for i in faces_a[index_a]]
        tri_b = [verts_b[i] for i in faces_b[index_b]]
        center_a = (tri_a[0] + tri_a[1] + tri_a[2]) / 3.0
        center_b = (tri_b[0] + tri_b[1] + tri_b[2]) / 3.0
        print('A(%.3f, %.3f, %.3f)  B(%.3f, %.3f, %.3f)' %
              (center_a.x, center_a.y, center_a.z, center_b.x, center_b.y, center_b.z))
    return 0


if __name__ == '__main__':
    sys.exit(main())
