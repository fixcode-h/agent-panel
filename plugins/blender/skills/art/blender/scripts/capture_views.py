#!/usr/bin/env python3
"""多视角截图：按包围盒自动布置固定视角集并批量渲染 PNG。

视角集：前 / 后 / 左 / 右（固定仰角）+ 顶视 + 透视 3/4 + 特写，共 7 张。
渲染引擎：默认 both（Workbench 看几何轮廓 + EEVEE 看材质光照），可单引擎。
默认按全场景取景；环境很大的场景用 --focus 聚焦主体（名称或前缀，逗号分隔）。
输出命名：单引擎 view_<视角>.png；both 模式 Workbench 为 view_<视角>.png，EEVEE 为 view_<视角>_eevee.png。
动画模式（--frames "1,16,31,46"）：跳过固定视角集，逐帧渲染并逐帧跟住主体（输出 anim_f<帧>_<view>[_eevee].png），
默认右侧视（--frame-view 可切 front/right/back/left/quarter/top），用于「前后帧对比」检查循环动画（跟随/相位/首尾连续）。
大场景务必配 --focus：--frames 不带 focus 时按全场景包围盒取景，主体会只剩几个像素。
交付镜头模式（--cam-frames "45,211,330"）：不新建相机，直接用场景自带相机（scene.camera）渲染指定帧
（输出 cam_f<帧>[_eevee].png），用于核对交付/展示镜头本身；场景无相机时报错。

用法（经启动器，无头）：
  python blender_cli.py capture_views.py -- <scene.blend> --out <dir> [--res 1024] [--engine both|workbench|eevee] [--focus "SM_Pelican,SM_Rear,SM_Front"] [--frames "1,16,31,46"] [--frame-view right]
  python blender_cli.py capture_views.py -- <scene.blend> --out <dir> --cam-frames "45,211,330"
退出码：0=成功，1=无可渲染对象 / focus 无匹配 / 场景无相机，2=环境错误或 --frames/--cam-frames 非法。
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

VIEWS = [
    ('front', 0.0, 12.0, 1.0, 'scene'),
    ('right', 90.0, 12.0, 1.0, 'scene'),
    ('back', 180.0, 12.0, 1.0, 'scene'),
    ('left', 270.0, 12.0, 1.0, 'scene'),
    ('top', 0.0, 88.0, 1.05, 'scene'),
    ('three_quarter', 45.0, 30.0, 1.0, 'scene'),
    ('closeup', 315.0, 18.0, 1.6, 'closeup'),
]

# --frames 模式的相机方向（azimuth, elevation）；默认右侧视：能同时观察位移与轮转/履带
FRAME_VIEWS = {
    'front': (0.0, 8.0),
    'right': (90.0, 8.0),
    'back': (180.0, 8.0),
    'left': (270.0, 8.0),
    'quarter': (45.0, 30.0),
    'top': (0.0, 88.0),
}


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Capture multi-view screenshots of a .blend.')
    parser.add_argument('blend', help='input .blend path')
    parser.add_argument('--out', required=True, help='output directory for PNGs')
    parser.add_argument('--res', type=int, default=1024, help='square resolution in pixels')
    parser.add_argument('--engine', default='both', choices=['both', 'workbench', 'eevee'])
    parser.add_argument('--focus', default='', help='comma separated object names/prefixes to frame (default: whole scene)')
    frames = parser.add_mutually_exclusive_group()
    frames.add_argument('--frames', default='', help='comma separated frames; render per-frame views (animation compare)')
    parser.add_argument('--frame-view', default='right',
                        choices=sorted(FRAME_VIEWS.keys()),
                        help='camera direction for --frames mode (default: right side view)')
    frames.add_argument('--cam-frames', default='',
                        help='comma separated frames; render with the scene own camera (delivery shot check)')
    return parser.parse_args(argv)


def world_bbox(objects, depsgraph=None):
    points = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph) if depsgraph is not None else obj
        corners = evaluated.bound_box
        for corner in corners:
            points.append(evaluated.matrix_world @ Vector(corner))
    if not points:
        return None, None
    min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return min_v, max_v


def place_camera(cam, target, azimuth_deg, elev_deg, distance):
    az = math.radians(azimuth_deg)
    el = math.radians(elev_deg)
    offset = Vector((math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el))) * distance
    cam.location = target + offset
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def ensure_world(scene):
    if scene.world is not None:
        return
    world = bpy.data.worlds.new('CaptureWorld')
    scene.world = world
    if world.node_tree:
        background = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
        if background is not None:
            background.inputs['Color'].default_value = (0.05, 0.05, 0.07, 1.0)
            background.inputs['Strength'].default_value = 0.35


def setup_engine(scene, engine, res):
    if engine == 'eevee':
        selected = False
        for candidate in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
            try:
                scene.render.engine = candidate
                selected = True
                break
            except TypeError:
                continue
        if not selected:
            raise RuntimeError('当前 Blender 不支持 EEVEE')
        ensure_world(scene)
    else:
        scene.render.engine = 'BLENDER_WORKBENCH'
        shading = scene.display.shading
        shading.light = 'STUDIO'
        shading.color_type = 'MATERIAL'
        shading.show_cavity = True
        shading.background_type = 'VIEWPORT'
        shading.background_color = (0.05, 0.05, 0.07)
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'


def sync_viewport_colors():
    """Workbench 的 MATERIAL 取 Material.diffuse_color（视口显示色），
    此处把 Principled Base Color 同步过去，避免预览全灰。"""
    synced = 0
    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        base = bsdf.inputs['Base Color'].default_value
        mat.diffuse_color = (base[0], base[1], base[2], base[3])
        synced += 1
    print('viewport colors synced: {0}'.format(synced))


def main():
    args = parse_args()
    if args.res <= 0:
        print('--res must be positive', file=sys.stderr)
        return 2
    if not os.path.isfile(args.blend):
        print('scene not found: ' + args.blend, file=sys.stderr)
        return 2
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    meshes = [o for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    if not meshes:
        print('no renderable mesh objects in scene', file=sys.stderr)
        return 1

    tokens = [t.strip() for t in args.focus.split(',') if t.strip()]
    if tokens:
        focus = [o for o in meshes if any(o.name == t or o.name.startswith(t) for t in tokens)]
        if not focus:
            print('focus matched no objects: ' + args.focus, file=sys.stderr)
            return 1
    else:
        focus = meshes

    min_v, max_v = world_bbox(focus, depsgraph)
    center = (min_v + max_v) / 2.0
    size = max_v - min_v
    scene_radius = max(size.length / 2.0, 0.1)

    if tokens:
        closeup_center, closeup_radius = center, scene_radius
    else:
        largest = max(meshes, key=lambda o: (o.matrix_world @ Vector(o.bound_box[6]) - o.matrix_world @ Vector(o.bound_box[0])).length)
        lmin, lmax = world_bbox([largest], depsgraph)
        closeup_center = (lmin + lmax) / 2.0
        closeup_radius = max((lmax - lmin).length / 2.0, 0.1)
        largest_len = (lmax - lmin).length
        if size.length > 5.0 and size.length > 3.0 * largest_len:
            print('tip: 场景包围盒远大于内容主体；可用 --focus "名称前缀1,名称前缀2" 聚焦取景')

    orig_camera = scene.camera

    camera_data = None
    camera = None
    if not args.cam_frames.strip():
        camera_data = bpy.data.cameras.new('CaptureCamera')
        camera = bpy.data.objects.new('CaptureCamera', camera_data)
        scene.collection.objects.link(camera)
        scene.camera = camera

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    frames = []
    if args.frames.strip():
        try:
            frames = [int(item) for item in args.frames.split(',') if item.strip()]
        except ValueError:
            frames = []
        if not frames:
            print('bad --frames value: ' + args.frames, file=sys.stderr)
            return 2

    engines = ['workbench', 'eevee'] if args.engine == 'both' else [args.engine]
    results = []
    fov_rad = camera_data.angle if camera_data else 0.0

    cam_frames = []
    if args.cam_frames.strip():
        try:
            cam_frames = [int(item) for item in args.cam_frames.split(',') if item.strip()]
        except ValueError:
            cam_frames = []
        if not cam_frames:
            print('bad --cam-frames value: ' + args.cam_frames, file=sys.stderr)
            return 2

    all_requested_frames = cam_frames or frames
    if all_requested_frames and any(frame < scene.frame_start or frame > scene.frame_end for frame in all_requested_frames):
        print('requested frame outside scene range {0}-{1}'.format(scene.frame_start, scene.frame_end), file=sys.stderr)
        return 2
    if cam_frames:
        if orig_camera is None:
            print('scene has no camera for --cam-frames (add CAM_ camera first)', file=sys.stderr)
            return 1
        scene.camera = orig_camera
        for engine in engines:
            setup_engine(scene, engine, args.res)
            if engine == 'workbench':
                sync_viewport_colors()
            for frame in cam_frames:
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                suffix = '_eevee' if (len(engines) > 1 and engine == 'eevee') else ''
                filepath = os.path.join(out_dir, 'cam_f%03d' % frame + suffix)
                scene.render.filepath = filepath
                bpy.ops.render.render(write_still=True)
                png = filepath + '.png'
                ok = os.path.isfile(png) and os.path.getsize(png) > 0
                results.append({
                    'view': 'cam_f%03d' % frame,
                    'engine': engine,
                    'frame': frame,
                    'camera': scene.camera.name,
                    'file': png,
                    'ok': ok,
                })
                print('[{0}] {1}'.format('OK' if ok else 'EMPTY', png))
        meta = {
            'scene': os.path.abspath(args.blend),
            'engines': engines,
            'resolution': args.res,
            'camera': scene.camera.name,
            'cam_frames': cam_frames,
            'views': results,
            'all_ok': all(item['ok'] for item in results),
        }
        with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as handle:
            json.dump(meta, handle, ensure_ascii=False, indent=2)
        print('CAM_FRAMES={0} CAMERA={1} ENGINES={2} ALL_OK={3}'.format(
            len(results), scene.camera.name, ','.join(engines), meta['all_ok']))
        print('OUT: ' + out_dir)
        return 0 if meta['all_ok'] else 1

    if frames:
        if not tokens:
            print('tip: --frames 未带 --focus 时按全场景包围盒取景；大场景请加 --focus "主体前缀"')
        frame_az, frame_el = FRAME_VIEWS[args.frame_view]
        for engine in engines:
            setup_engine(scene, engine, args.res)
            if engine == 'workbench':
                sync_viewport_colors()
            for frame in frames:
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                depsgraph = bpy.context.evaluated_depsgraph_get()
                fmin, fmax = world_bbox(focus, depsgraph)
                fcenter = (fmin + fmax) / 2.0
                fradius = max((fmax - fmin).length / 2.0, 0.1)
                distance = (fradius * 1.15) / math.tan(fov_rad / 2.0)
                place_camera(camera, fcenter, frame_az, frame_el, distance)
                suffix = '_eevee' if (len(engines) > 1 and engine == 'eevee') else ''
                filepath = os.path.join(out_dir, 'anim_f%03d_%s' % (frame, args.frame_view) + suffix)
                scene.render.filepath = filepath
                bpy.ops.render.render(write_still=True)
                png = filepath + '.png'
                ok = os.path.isfile(png) and os.path.getsize(png) > 0
                results.append({
                    'view': 'anim_f%03d_%s' % (frame, args.frame_view),
                    'engine': engine,
                    'frame': frame,
                    'file': png,
                    'ok': ok,
                })
                print('[{0}] {1}'.format('OK' if ok else 'EMPTY', png))
        meta = {
            'scene': os.path.abspath(args.blend),
            'engines': engines,
            'resolution': args.res,
            'focus': tokens,
            'frames': frames,
            'frame_view': args.frame_view,
            'views': results,
            'all_ok': all(item['ok'] for item in results),
        }
        with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as handle:
            json.dump(meta, handle, ensure_ascii=False, indent=2)
        print('ANIM_FRAMES={0} ENGINES={1} ALL_OK={2}'.format(len(results), ','.join(engines), meta['all_ok']))
        print('OUT: ' + out_dir)
        return 0 if meta['all_ok'] else 1

    for engine in engines:
        setup_engine(scene, engine, args.res)
        if engine == 'workbench':
            sync_viewport_colors()
        for name, azimuth, elevation, factor, target_kind in VIEWS:
            if target_kind == 'closeup':
                target, radius = closeup_center, closeup_radius
            else:
                target, radius = center, scene_radius
            distance = (radius * factor) / math.tan(fov_rad / 2.0)
            place_camera(camera, target, azimuth, elevation, distance)
            suffix = '_eevee' if (len(engines) > 1 and engine == 'eevee') else ''
            filepath = os.path.join(out_dir, 'view_' + name + suffix)
            scene.render.filepath = filepath
            bpy.ops.render.render(write_still=True)
            png = filepath + '.png'
            ok = os.path.isfile(png) and os.path.getsize(png) > 0
            results.append({
                'view': name,
                'engine': engine,
                'file': png,
                'azimuth': azimuth,
                'elevation': elevation,
                'distance': round(distance, 4),
                'ok': ok,
            })
            print('[{0}] {1}'.format('OK' if ok else 'EMPTY', png))

    meta = {
        'scene': os.path.abspath(args.blend),
        'engines': engines,
        'resolution': args.res,
        'focus': tokens,
        'views': results,
        'all_ok': all(item['ok'] for item in results),
    }
    with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)

    print('VIEWS={0} ENGINES={1} ALL_OK={2}'.format(len(results), ','.join(engines), meta['all_ok']))
    print('OUT: ' + out_dir)
    return 0 if meta['all_ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
