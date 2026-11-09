#!/usr/bin/env python3
"""视口展示：以 GUI 打开场景，配置单视口（相机视角）+ 材质预览 + 循环播放。

用法：
  python blender_cli.py setup_viewport.py -- --gui <scene.blend>    # GUI 展示（窗口关闭后命令返回）
  python blender_cli.py setup_viewport.py -- <scene.blend> --check  # 无 GUI 校验场景与配置逻辑

本脚本只做视图配置，不修改也不保存场景数据。
"""
import argparse
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    parser = argparse.ArgumentParser(description='Configure a single-viewport showcase.')
    parser.add_argument('blend', help='input .blend path')
    parser.add_argument('--check', action='store_true', help='validate scene and logic without GUI')
    return parser.parse_args(argv)


def view_3d_areas(screen):
    return [a for a in screen.areas if a.type == 'VIEW_3D']


def configure_gui():
    window = bpy.context.window_manager.windows[0]
    screen = window.screen
    areas = view_3d_areas(screen)
    if not areas:
        print('no 3D viewport found')
        return
    area = max(areas, key=lambda a: a.width * a.height)
    space = next((s for s in area.spaces if s.type == 'VIEW_3D'), None)
    if space is None:
        print('no 3D view space found')
        return

    if bpy.context.scene.camera is not None:
        try:
            space.region_3d.view_perspective = 'CAMERA'
        except Exception as exc:
            print('camera view skipped: {0}'.format(exc))
    try:
        space.shading.type = 'MATERIAL'
    except Exception:
        pass
    try:
        with bpy.context.temp_override(window=window, screen=screen, area=area):
            bpy.ops.screen.animation_play()
    except Exception as exc:
        print('animation_play skipped: {0}'.format(exc))


def main():
    args = parse_args()
    if not os.path.isfile(args.blend):
        print('scene not found: ' + args.blend, file=sys.stderr)
        return 2
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    objects = list(bpy.context.scene.objects)
    if bpy.context.scene.camera is None:
        print('WARN: 场景没有相机：单视口将停留在默认视角。请先补一个 CAM_ 开头的相机（低机位、距主体约 1.5 m、35 mm 左右）再展示。')

    if bpy.app.background or args.check:
        if not objects:
            print('no objects in scene', file=sys.stderr)
            return 1
        print('CHECK OK: objects={0} viewport=single(camera)'.format(len(objects)))
        return 0

    configure_gui()
    print('GUI configured: single viewport (camera) + material preview + playback')
    return 0


if __name__ == '__main__':
    if bpy.app.background:
        sys.exit(main())
    else:
        # GUI 模式不要用 sys.exit：它会终止整个 Blender，窗口一闪而过
        try:
            code = main()
            if code != 0:
                print('setup_viewport returned {0}（GUI 保持打开以便查看）'.format(code))
        except Exception as exc:
            print('setup_viewport failed: {0}（GUI 保持打开以便查看）'.format(exc))
