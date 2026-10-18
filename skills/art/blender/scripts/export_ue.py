#!/usr/bin/env python3
"""导出 UE 标准 FBX：导出前体检门槛 + 导出后重导入自检。

用法（经启动器，无头）：
  python blender_cli.py export_ue.py -- <scene.blend> --out <dir> [--name <base>] [--max-tris N] [--exempt]
退出码：0=成功且自检通过，1=体检/自检未通过，2=环境错误。
"""
import argparse
import json
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inspect_scene  # noqa: E402


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Export UE-ready FBX with gate and self check.')
    parser.add_argument('blend', help='input .blend path')
    parser.add_argument('--out', required=True, help='output directory')
    parser.add_argument('--name', default=None, help='FBX base name (default: blend file stem)')
    parser.add_argument('--exempt', action='store_true',
                        help='override inspection FAIL gate (record the reason in the evaluation log)')
    parser.add_argument('--max-tris', type=int, default=50000, help='evaluated triangle budget')
    return parser.parse_args(argv)


def scene_metrics(scene, evaluated=False):
    meshes = [o for o in scene.objects if o.type == 'MESH']
    points = []
    for obj in meshes:
        target = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()) if evaluated else obj
        for corner in target.bound_box:
            points.append(target.matrix_world @ Vector(corner))
    if points:
        min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
        max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
        size = [round(v, 5) for v in (max_v - min_v)]
    else:
        size = [0.0, 0.0, 0.0]
    return {
        'objects': len(scene.objects),
        'meshes': len(meshes),
        'armatures': sum(1 for o in scene.objects if o.type == 'ARMATURE'),
        'materials': len([m for m in bpy.data.materials if m.users > 0]),
        'size': size,
        'action_count': len(bpy.data.actions),
        'actions': sorted(a.name for a in bpy.data.actions),
    }


def export_fbx(path):
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=False,
        apply_unit_scale=True,
        global_scale=1.0,
        apply_scale_options='FBX_SCALE_NONE',
        axis_forward='-Z',
        axis_up='Y',
        add_leaf_bones=False,
        primary_bone_axis='Y',
        secondary_bone_axis='X',
        bake_anim=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=True,
        bake_anim_simplify_factor=0.0,
        mesh_smooth_type='FACE',
        use_mesh_modifiers=True,
        use_tspace=True,
        path_mode='AUTO',
        embed_textures=False,
    )


def import_metrics(fbx_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    return scene_metrics(bpy.context.scene)


def main():
    args = parse_args()
    if not os.path.isfile(args.blend):
        print('scene not found: ' + args.blend, file=sys.stderr)
        return 2

    bpy.ops.wm.open_mainfile(filepath=args.blend)
    scene = bpy.context.scene

    if args.max_tris <= 0:
        print('--max-tris must be positive', file=sys.stderr)
        return 2
    gate = inspect_scene.build_report(scene, max_tris=args.max_tris, evaluated=True)
    if gate['summary']['fail'] > 0 and not args.exempt:
        for check in gate['checks']:
            if check['status'] == 'FAIL':
                print('[FAIL] {0}: {1}'.format(check['id'], check['message']))
        print('inspection gate failed; run inspect_scene.py for details, '
              'or pass --exempt after recording the reason')
        return 1
    if args.exempt and gate['summary']['fail'] > 0:
        print('WARNING: exporting with {0} inspection FAIL(s) (--exempt)'.format(gate['summary']['fail']))

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    base = args.name or os.path.splitext(os.path.basename(args.blend))[0]
    fbx_path = os.path.join(out_dir, base + '.fbx')

    original = scene_metrics(scene, evaluated=True)
    export_fbx(fbx_path)
    if not (os.path.isfile(fbx_path) and os.path.getsize(fbx_path) > 0):
        print('export failed: FBX not written: ' + fbx_path, file=sys.stderr)
        return 1

    imported = import_metrics(fbx_path)

    checks = []

    def add(cid, ok, message, details=None):
        checks.append({'id': cid, 'status': 'PASS' if ok else 'FAIL', 'message': message, 'details': details or {}})

    size_ok = all(abs(i - o) <= max(0.001, abs(o) * 0.001)
                  for i, o in zip(imported['size'], original['size']))
    add('size_match', size_ok, '包围盒尺寸 {0} -> {1}'.format(original['size'], imported['size']))
    add('mesh_count', imported['meshes'] == original['meshes'],
        '网格数 {0} -> {1}'.format(original['meshes'], imported['meshes']))
    add('material_count', imported['materials'] == original['materials'],
        '材质数 {0} -> {1}'.format(original['materials'], imported['materials']))
    add('action_count', imported['action_count'] == original['action_count'],
        '动作数 {0} -> {1}'.format(original['action_count'], imported['action_count']))

    ok = all(c['status'] == 'PASS' for c in checks)
    report = {
        'fbx': fbx_path,
        'original': original,
        'imported': imported,
        'checks': checks,
        'ok': ok,
        'gate': {'evaluated': True, 'max_tris': args.max_tris,
                 'summary': gate['summary']},
    }
    with open(os.path.join(out_dir, 'export_check.json'), 'w', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    for check in checks:
        print('[{0}] {1}: {2}'.format(check['status'], check['id'], check['message']))
    print('EXPORT_OK={0}'.format(ok))
    print('CHECK: ' + os.path.join(out_dir, 'export_check.json'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
