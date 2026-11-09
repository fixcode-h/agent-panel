#!/usr/bin/env python3
"""场景体检：输出五组指标 JSON 与阈值判定（网格 / UV·材质 / 动画 / 场景 / 导出前）。

用法（经启动器，无头）：
  python blender_cli.py inspect_scene.py -- <scene.blend> --out <report.json> [--max-tris N]
      [--intersect-report [--intersect-focus "SM_RearTire,SM_FrontTire"] [--intersect-limit N]]
退出码：0=通过，1=存在 FAIL，2=环境错误（参数或文件问题）。

其他脚本可复用 `build_report(scene, max_tris)`；将本脚本所在目录加入 sys.path 后
`import inspect_scene` 即可（export_ue.py 即以此实现导出前门槛）。
"""
import argparse
import json
import math
import os
import re
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

DEFAULT_NAME_RE = re.compile(r'^(Cube|Sphere|Cylinder|Cone|Torus|Plane|Icosphere|Suzanne|Text|Empty|Circle|Grid)(\.\d+)?$')
NAME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9]*([_][A-Za-z0-9]+)*$')


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Inspect a .blend and report quality metrics.')
    parser.add_argument('blend', help='input .blend path')
    parser.add_argument('--out', default='inspect.json', help='report json path')
    parser.add_argument('--max-tris', type=int, default=50000, help='triangle budget for the whole scene')
    parser.add_argument('--evaluated', action='store_true', help='体检修改器/约束应用后的 evaluated mesh')
    parser.add_argument('--intersect-report', action='store_true', help='report intersecting mesh pairs (informational, assembly-aware)')
    parser.add_argument('--intersect-focus', default='', help='comma-separated name prefixes; only report pairs that touch them (e.g. "SM_RearTire,SM_FrontTire")')
    parser.add_argument('--intersect-limit', type=int, default=200, help='max reported intersect pairs (default 200)')
    frames = parser.add_mutually_exclusive_group()
    frames.add_argument('--intersect-frames', default='', help='comma-separated frames to sample')
    frames.add_argument('--intersect-every', type=int, default=0, help='sample every N frames in scene range')
    return parser.parse_args(argv)


def mesh_stats(obj, evaluated=False, depsgraph=None):
    evaluated_obj = obj.evaluated_get(depsgraph) if evaluated else None
    data = evaluated_obj.to_mesh() if evaluated else obj.data
    bm = bmesh.new()
    try:
        bm.from_mesh(data)
        stats = {
            'verts': len(bm.verts), 'edges': len(bm.edges), 'faces': len(bm.faces),
            'ngons': sum(1 for f in bm.faces if len(f.verts) > 4),
            'non_manifold_edges': sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary),
            'loose_verts': sum(1 for v in bm.verts if not v.link_edges),
        }
        data.calc_loop_triangles()
        stats['tris'] = len(data.loop_triangles)
        stats['uv_layers'] = [uv.name for uv in data.uv_layers]
        stats['materials'] = [slot.material.name if slot.material else None for slot in obj.material_slots]
        return stats
    finally:
        bm.free()
        if evaluated_obj is not None:
            evaluated_obj.to_mesh_clear()


def uv_bounds(obj):
    if not obj.data.uv_layers:
        return None
    layer = obj.data.uv_layers[0]
    us = [loop.uv[0] for loop in layer.data]
    vs = [loop.uv[1] for loop in layer.data]
    return [min(us), min(vs), max(us), max(vs)]


def evaluated_uv_bounds(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        if not mesh.uv_layers or not mesh.uv_layers[0].data:
            return None
        layer = mesh.uv_layers[0]
        us = [loop.uv[0] for loop in layer.data]
        vs = [loop.uv[1] for loop in layer.data]
        return [min(us), min(vs), max(us), max(vs)]
    finally:
        evaluated.to_mesh_clear()


def world_triangles(obj, depsgraph):
    """在世界坐标空间构建 BVH。

    两个坑（实测）：BVHTree.FromObject 构建的是对象局部空间，跨对象比较会误报；
    FromPolygons 用四边形（all_triangles=False）时 overlap 会漏检（相交立方体也返回 0）。
    因此统一变换到世界坐标并三角化后再建树。
    """
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        matrix = evaluated.matrix_world
        vertices = [matrix @ vertex.co for vertex in mesh.vertices]
        faces = [tuple(tri.vertices) for tri in mesh.loop_triangles]
        return vertices, faces
    finally:
        evaluated.to_mesh_clear()


def world_bvh(obj, depsgraph):
    vertices, faces = world_triangles(obj, depsgraph)
    return BVHTree.FromPolygons(vertices, faces, all_triangles=True, epsilon=0.0)


def intersect_pairs(objects, limit=200, focus=(), depsgraph=None):
    """AABB 预筛 + BVH 精确相交检测；返回 (相交对象对, 是否截断)。

    信息性检查，不参与 PASS/FAIL 判定。focus 非空时只报告至少一端命中
    名称前缀的配对，用于在装配件较多的场景里聚焦（如只看轮胎/车架相关）。
    """
    if limit <= 0:
        raise ValueError('limit must be positive')
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    entries = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            corners = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
        finally:
            evaluated.to_mesh_clear()
        if not corners:
            continue
        lo = [min(c[i] for c in corners) for i in range(3)]
        hi = [max(c[i] for c in corners) for i in range(3)]
        entries.append([obj, lo, hi, None])

    def overlaps(a, b):
        return all(a[1][i] <= b[2][i] and b[1][i] <= a[2][i] for i in range(3))

    def focused(name_a, name_b):
        if not focus:
            return True
        return any(name_a.startswith(prefix) or name_b.startswith(prefix) for prefix in focus)

    pairs = []
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            if not focused(entries[i][0].name, entries[j][0].name):
                continue
            if not overlaps(entries[i], entries[j]):
                continue
            for index in (i, j):
                if entries[index][3] is None:
                    entries[index][3] = world_bvh(entries[index][0], depsgraph)
            if entries[i][3].overlap(entries[j][3]):
                pairs.append((entries[i][0].name, entries[j][0].name))
                if len(pairs) >= limit:
                    return pairs, True
    return pairs, False


def action_report(action):
    info = {'name': action.name, 'frame_range': list(action.frame_range)}
    if hasattr(action, 'fcurves'):
        fcurves = list(action.fcurves)
    else:
        fcurves = [fc for layer in getattr(action, 'layers', [])
                   for strip in layer.strips
                   for bag in getattr(strip, 'channelbags', [])
                   for fc in bag.fcurves]
    info['fcurves'] = len(fcurves)
    info['interpolations'] = sorted({kp.interpolation for fc in fcurves for kp in fc.keyframe_points})
    loop_ok = True
    for fc in fcurves:
        if len(fc.keyframe_points) >= 2:
            first = fc.keyframe_points[0].co[1]
            last = fc.keyframe_points[-1].co[1]
            if 'rotation' in fc.data_path:
                delta = abs((last - first) % math.tau)
                continuous = min(delta, abs(math.tau - delta)) <= 1e-4
            else:
                continuous = abs(first - last) <= 1e-4
            if not continuous:
                loop_ok = False
                break
    info['first_last_equal'] = loop_ok
    return info


def build_report(scene, max_tris=50000, evaluated=False):
    """对给定场景执行全部检查，返回报告字典（不写文件、不打印）。"""
    checks = []

    def add(group, cid, status, message, details=None):
        checks.append({'group': group, 'id': cid, 'status': status, 'message': message, 'details': details or {}})

    meshes = [o for o in scene.objects if o.type == 'MESH']
    armatures = [o for o in scene.objects if o.type == 'ARMATURE']

    totals = {'verts': 0, 'tris': 0, 'ngons': 0, 'non_manifold_edges': 0, 'loose_verts': 0}
    depsgraph = bpy.context.evaluated_depsgraph_get()
    no_uv, bad_scale, neg_scale, default_names, bad_names, uv_out_of_range = [], [], [], [], [], []
    for obj in meshes:
        st = mesh_stats(obj, evaluated=evaluated, depsgraph=depsgraph)
        for key in totals:
            totals[key] += st[key]
        if not st['uv_layers']:
            no_uv.append(obj.name)
        if any(abs(s - 1.0) > 1e-4 for s in obj.scale):
            bad_scale.append(obj.name)
        if obj.matrix_world.determinant() < 0:
            neg_scale.append(obj.name)
        if DEFAULT_NAME_RE.match(obj.name):
            default_names.append(obj.name)
        elif not NAME_RE.match(obj.name):
            bad_names.append(obj.name)
        bounds = evaluated_uv_bounds(obj, depsgraph) if evaluated else uv_bounds(obj)
        if bounds and (bounds[0] < -0.001 or bounds[1] < -0.001 or bounds[2] > 1.001 or bounds[3] > 1.001):
            uv_out_of_range.append(obj.name)

    add('mesh', 'tri_budget', 'PASS' if totals['tris'] <= max_tris else 'FAIL',
        '三角面 {0} / 预算 {1}'.format(totals['tris'], max_tris))
    add('mesh', 'ngons', 'PASS' if totals['ngons'] == 0 else 'FAIL',
        'n-gon（>4 边）面数：{0}'.format(totals['ngons']))
    add('mesh', 'non_manifold', 'PASS' if totals['non_manifold_edges'] == 0 else 'FAIL',
        '非流形边：{0}'.format(totals['non_manifold_edges']))
    add('mesh', 'loose_verts', 'PASS' if totals['loose_verts'] == 0 else 'WARN',
        '松散顶点：{0}'.format(totals['loose_verts']))
    add('mesh', 'transform_applied', 'PASS' if not bad_scale else 'FAIL',
        '缩放已应用' if not bad_scale else '未应用缩放的物体：' + ', '.join(bad_scale))
    add('mesh', 'negative_scale', 'PASS' if not neg_scale else 'FAIL',
        '法线朝向正常' if not neg_scale else '含负缩放（法线可能反转）：' + ', '.join(neg_scale))
    add('mesh', 'naming_default', 'PASS' if not default_names else 'WARN',
        '命名规范' if not default_names else '默认命名：' + ', '.join(default_names))
    add('mesh', 'naming_pattern', 'PASS' if not bad_names else 'WARN',
        '命名形状合规' if not bad_names else '命名形状待规范：' + ', '.join(bad_names))

    add('uv_material', 'uv_present', 'PASS' if not no_uv else 'FAIL',
        '全部网格含 UV' if not no_uv else '缺少 UV 的网格：' + ', '.join(no_uv))
    add('uv_material', 'uv_bounds', 'PASS' if not uv_out_of_range else 'WARN',
        'UV 位于 [0,1] 内' if not uv_out_of_range else 'UV 越界：' + ', '.join(uv_out_of_range))
    mats = [m for m in bpy.data.materials if m.users > 0]
    non_principled = [m.name for m in mats
                      if m.node_tree is None or not any(n.type == 'BSDF_PRINCIPLED' for n in m.node_tree.nodes)]
    add('uv_material', 'material_nodes', 'PASS' if not non_principled else 'FAIL',
        '材质均为 Principled 节点' if not non_principled else '缺少 Principled BSDF 的材质：' + ', '.join(non_principled))

    fps_ok = scene.render.fps in (24, 25, 30)
    add('animation', 'fps', 'PASS' if fps_ok else 'WARN', '帧率 {0}'.format(scene.render.fps))
    actions = [action_report(a) for a in bpy.data.actions]
    add('animation', 'actions', 'PASS' if actions else 'WARN',
        '动作数 {0}'.format(len(actions)), {'actions': actions})
    zero_bones, default_bones = [], []
    for arm in armatures:
        for bone in arm.data.bones:
            if bone.length < 1e-6:
                zero_bones.append(arm.name + '/' + bone.name)
            if re.match(r'^(Bone|Bone\.\d+)$', bone.name):
                default_bones.append(arm.name + '/' + bone.name)
    add('animation', 'zero_length_bones', 'PASS' if not zero_bones else 'FAIL',
        '无零长度骨骼' if not zero_bones else '零长度骨骼：' + ', '.join(zero_bones))
    add('animation', 'bone_naming', 'PASS' if not default_bones else 'WARN',
        '骨骼命名规范' if not default_bones else '默认骨骼名：' + ', '.join(default_bones))

    unit_ok = scene.unit_settings.system == 'METRIC' and abs(scene.unit_settings.scale_length - 1.0) < 1e-6
    add('scene', 'units', 'PASS' if unit_ok else 'FAIL',
        '公制单位 / 缩放 1.0' if unit_ok else
        '单位设置异常：system={0}, scale={1}'.format(scene.unit_settings.system, scene.unit_settings.scale_length))
    hidden = [o.name for o in scene.objects if o.hide_render]
    add('scene', 'hidden_objects', 'PASS' if not hidden else 'WARN',
        '无渲染隐藏对象' if not hidden else '渲染隐藏对象：' + ', '.join(hidden))
    add('scene', 'frame_range', 'PASS' if scene.frame_end > scene.frame_start else 'WARN',
        '帧范围 {0}-{1}'.format(scene.frame_start, scene.frame_end))

    modifiers = [o.name for o in meshes if len(o.modifiers) > 0]
    add('export_pre', 'pending_modifiers', 'PASS' if not modifiers else 'WARN',
        '无未应用的修改器' if not modifiers else '含修改器的物体（导出前确认）：' + ', '.join(modifiers))
    missing_tex = [img.name for img in bpy.data.images
                   if img.source == 'FILE' and img.filepath and not os.path.isfile(bpy.path.abspath(img.filepath))]
    add('export_pre', 'texture_files', 'PASS' if not missing_tex else 'WARN',
        '贴图文件可用' if not missing_tex else '缺失贴图文件：' + ', '.join(missing_tex))

    summary = {
        'pass': sum(1 for c in checks if c['status'] == 'PASS'),
        'warn': sum(1 for c in checks if c['status'] == 'WARN'),
        'fail': sum(1 for c in checks if c['status'] == 'FAIL'),
    }
    return {
        'scene': {
            'file': bpy.data.filepath,
            'objects': len(scene.objects),
            'meshes': len(meshes),
            'armatures': len(armatures),
            'totals': totals,
            'geometry_mode': 'evaluated' if evaluated else 'raw',
        },
        'summary': summary,
        'checks': checks,
    }


def main():
    args = parse_args()
    if not os.path.isfile(args.blend):
        print('scene not found: ' + args.blend, file=sys.stderr)
        return 2
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    scene = bpy.context.scene
    if args.max_tris <= 0 or args.intersect_limit <= 0 or args.intersect_every < 0:
        print('invalid positive budget/limit or non-negative interval', file=sys.stderr)
        return 2
    report = build_report(scene, args.max_tris, evaluated=args.evaluated)
    if args.intersect_report:
        focus = tuple(item.strip() for item in args.intersect_focus.split(',') if item.strip())
        if args.intersect_frames:
            try:
                frame_list = [int(item.strip()) for item in args.intersect_frames.split(',') if item.strip()]
            except ValueError:
                print('invalid --intersect-frames', file=sys.stderr); return 2
        elif args.intersect_every:
            frame_list = list(range(scene.frame_start, scene.frame_end + 1, args.intersect_every))
        else:
            frame_list = [scene.frame_current]
        if not frame_list or any(frame < scene.frame_start or frame > scene.frame_end for frame in frame_list):
            print('intersection frames must be inside scene frame range', file=sys.stderr); return 2
        original_frame = scene.frame_current
        sampled = []
        try:
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for frame in frame_list:
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                pairs, truncated = intersect_pairs(
                    [o for o in scene.objects if o.type == 'MESH'],
                    limit=args.intersect_limit, focus=focus, depsgraph=depsgraph)
                sampled.append({'frame': frame, 'pairs': [list(pair) for pair in pairs], 'truncated': truncated})
        finally:
            scene.frame_set(original_frame)
            bpy.context.view_layer.update()
        for item in sampled:
            for left, right in item['pairs']:
                print('INTERSECT frame={0}: {1} <-> {2}'.format(item['frame'], left, right))
        report['intersections'] = {
            'mode': 'evaluated_world_surface', 'frames': sampled,
            'focus': list(focus), 'limit': args.intersect_limit,
            'sampled_frames': frame_list,
            'informational': True,
        }
        if len(sampled) == 1:
            report['intersections']['pairs'] = sampled[0]['pairs']
            report['intersections']['truncated'] = sampled[0]['truncated']
    summary = report['summary']

    out = os.path.abspath(args.out)
    if os.path.dirname(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    for check in report['checks']:
        if check['status'] != 'PASS':
            print('[{0}] {1}: {2}'.format(check['status'], check['id'], check['message']))
    print('SUMMARY pass={0} warn={1} fail={2}'.format(summary['pass'], summary['warn'], summary['fail']))
    print('REPORT: ' + out)
    return 1 if summary['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
