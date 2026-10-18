#!/usr/bin/env python3
"""参考素材预处理（视频/图片 -> 可读的接触表、单帧、放大裁切、对照拼图）。

为什么需要：拿到一段参考视频/一堆参考图时，Blender 脚本读不了视频，
而「时间轴接触表 + 关键帧放大 + 与渲染结果并排对照」是复刻任务的第一步。
本脚本用 ffmpeg 完成这些动作；找不到 ffmpeg 时给出可执行的获取路径。

ffmpeg 查找顺序：
  1) 环境变量 FFMPEG_BIN
  2) PATH（shutil.which）
  3) 常见安装目录（winget/scoop/choco/Program Files）
  4) 已安装的 imageio-ffmpeg 包（pip install imageio-ffmpeg，纯 Python wheel，自带静态 ffmpeg）

用法（用系统 python 运行，不需要 Blender）：
  python reference_frames.py --info VIDEO
  python reference_frames.py --sheet VIDEO OUT_DIR [--step 3] [--tile 5x3] [--width 640]
  python reference_frames.py --frames VIDEO OUT_DIR --times "0,5,10" | --every 25
  python reference_frames.py --crop IMG OUT.jpg --box x,y,w,h [--scale 3]
  python reference_frames.py --pair REF.jpg RENDER.png OUT.jpg [--width 800]
  python reference_frames.py --montage IMG1 IMG2 IMG3 --out OUT.jpg [--tile 3x1] [--width 480]

退出码：0 成功；1 检查未通过（文件不存在/解析失败）；2 环境错误（缺 ffmpeg）。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import glob
import math

KNOWN_DIRS = (
    r'C:\ffmpeg\bin',
    r'C:\Program Files\ffmpeg\bin',
    os.path.expanduser(r'~\scoop\shims'),
    r'C:\ProgramData\chocolatey\bin',
)


def find_ffmpeg():
    env = os.environ.get('FFMPEG_BIN')
    if env and os.path.isfile(env):
        return env
    found = shutil.which('ffmpeg')
    if found:
        return found
    for base in KNOWN_DIRS:
        candidate = os.path.join(base, 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
        if os.path.isfile(candidate):
            return candidate
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    print('ERROR: 未找到 ffmpeg。任选其一：\n'
          '  - winget install ffmpeg\n'
          '  - scoop install ffmpeg\n'
          '  - python -m pip install imageio-ffmpeg（自带静态 ffmpeg，推荐）\n'
          '  - 设置环境变量 FFMPEG_BIN 指向 ffmpeg 可执行文件', file=sys.stderr)
    return None


def run(ffmpeg, args, quiet=True):
    cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error' if quiet else 'info'] + args
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print('FFMPEG_FAIL: %s' % ' '.join(cmd), file=sys.stderr)
        print(proc.stderr.strip()[-800:], file=sys.stderr)
    return proc


def _positive(value, label, allow_zero=False):
    if not math.isfinite(value) or (value < 0 if allow_zero else value <= 0):
        raise ValueError('{0} 必须为{1}'.format(label, '非负数' if allow_zero else '正数'))


def _run_ok(ffmpeg, args):
    return run(ffmpeg, args).returncode == 0


def probe(ffmpeg, path):
    """解析 duration / 分辨率 / fps / 总帧数（ffmpeg -i 的 stderr）。"""
    proc = subprocess.run([ffmpeg, '-hide_banner', '-i', path],
                          capture_output=True, text=True)
    text = proc.stderr
    info = {'path': path}
    m = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', text)
    if m:
        h, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
        info['duration'] = round(h * 3600 + mm * 60 + ss, 3)
    m = re.search(r'Video: .*?(\d{2,5})x(\d{2,5})', text)
    if m:
        info['width'], info['height'] = int(m.group(1)), int(m.group(2))
    m = re.search(r'(\d+(?:\.\d+)?) fps', text)
    if m:
        info['fps'] = float(m.group(1))
    if 'duration' in info and 'fps' in info:
        info['frames'] = int(round(info['duration'] * info['fps']))
    return info


def cmd_info(args, ffmpeg):
    info = probe(ffmpeg, args.info)
    if 'duration' not in info:
        print('INFO_FAIL: 无法解析视频信息', file=sys.stderr)
        return 1
    print('INFO ' + ' '.join('%s=%s' % kv for kv in info.items()))
    return 0


def cmd_sheet(args, ffmpeg):
    info = probe(ffmpeg, args.sheet)
    if 'duration' not in info:
        print('SHEET_FAIL: 无法解析视频信息', file=sys.stderr)
        return 1
    try:
        _positive(args.step, '--step')
        _positive(args.width, '--width')
        cols, rows = (int(v) for v in args.tile.lower().split('x'))
        _positive(cols, 'tile columns'); _positive(rows, 'tile rows')
    except (ValueError, TypeError) as exc:
        print('SHEET_FAIL: ' + str(exc), file=sys.stderr)
        return 2
    per_sheet = cols * rows
    span = args.step * per_sheet
    total = info['duration']
    os.makedirs(args.out, exist_ok=True)
    sheet = 0
    t = args.start
    while t < total and (args.duration <= 0 or t < args.start + args.duration):
        length = min(span, total - t)
        out = os.path.join(args.out, 'sheet_%02d.jpg' % sheet)
        vf = 'fps=1/%s,scale=%d:-2,tile=%dx%d' % (args.step, args.width, cols, rows)
        if os.path.exists(out):
            os.remove(out)
        if not _run_ok(ffmpeg, ['-y', '-ss', str(t), '-t', str(length), '-i', args.sheet,
                                '-vf', vf, '-frames:v', '1', '-qscale:v', '3', out]):
            return 1
        if not os.path.isfile(out) or os.path.getsize(out) == 0:
            print('SHEET_FAIL: 输出为空：' + out, file=sys.stderr)
            return 1
        print('SHEET %s (t=%s..%ss)' % (out, t, round(t + length, 2)))
        sheet += 1
        t += span
    print('SHEETS_DONE %d' % sheet)
    return 0


def cmd_frames(args, ffmpeg):
    try:
        _positive(args.width, '--width')
        if not args.times:
            _positive(args.every, '--every')
    except (ValueError, TypeError) as exc:
        print('FRAMES_FAIL: ' + str(exc), file=sys.stderr)
        return 2
    os.makedirs(args.out, exist_ok=True)
    ok = True
    if args.times:
        times = [float(v) for v in args.times.split(',') if v.strip()]
        for t in times:
            out = os.path.join(args.out, 'f%08.2f.jpg' % t)
            if os.path.exists(out):
                os.remove(out)
            produced = _run_ok(ffmpeg, ['-y', '-ss', str(t), '-i', args.frames, '-frames:v', '1',
                                        '-qscale:v', '3', out]) and os.path.isfile(out) and os.path.getsize(out) > 0
            ok = produced and ok
            if produced:
                print('FRAME %s' % out)
    else:
        vf = 'fps=1/%s,scale=%d:-2' % (args.every, args.width)
        pattern = os.path.join(args.out, 'f%05d.jpg')
        if not _run_ok(ffmpeg, ['-y', '-i', args.frames, '-vf', vf, '-qscale:v', '3', pattern]):
            return 1
        ok = bool(glob.glob(os.path.join(args.out, 'f*.jpg')))
        print('FRAMES_DONE every=%d' % args.every)
    return 0 if ok else 1


def cmd_crop(args, ffmpeg):
    try:
        x, y, w, h = (int(v) for v in args.box.split(','))
        _positive(w, 'crop width'); _positive(h, 'crop height'); _positive(args.scale, '--scale')
    except (ValueError, TypeError) as exc:
        print('CROP_FAIL: ' + str(exc), file=sys.stderr)
        return 2
    if os.path.exists(args.crop[1]): os.remove(args.crop[1])
    vf = 'crop=%d:%d:%d:%d,scale=%d:-2' % (w, h, x, y, w * args.scale)
    if not _run_ok(ffmpeg, ['-y', '-i', args.crop[0], '-vf', vf, '-qscale:v', '2', args.crop[1]]): return 1
    print('CROP %s' % args.crop[1])
    return 0 if os.path.isfile(args.crop[1]) and os.path.getsize(args.crop[1]) > 0 else 1


def cmd_pair(args, ffmpeg):
    """并排对照：两张图统一高度后横向拼接（--width 在此模式表示统一高度）。"""
    h = args.width
    if h <= 0: return 2
    if os.path.exists(args.pair[2]): os.remove(args.pair[2])
    if not _run_ok(ffmpeg, ['-y', '-i', args.pair[0], '-i', args.pair[1], '-filter_complex',
                            '[0:v]scale=-2:%d[a];[1:v]scale=-2:%d[b];[a][b]hstack=inputs=2' % (h, h),
                            '-qscale:v', '3', args.pair[2]]): return 1
    print('PAIR %s' % args.pair[2])
    return 0 if os.path.isfile(args.pair[2]) and os.path.getsize(args.pair[2]) > 0 else 1


def cmd_montage(args, ffmpeg):
    try:
        cols, rows = (int(v) for v in args.tile.lower().split('x'))
        _positive(cols, 'tile columns'); _positive(rows, 'tile rows'); _positive(args.width, '--width')
    except (ValueError, TypeError) as exc:
        print('MONTAGE_FAIL: ' + str(exc), file=sys.stderr); return 2
    w = args.width
    h = int(round(w * 9.0 / 16.0))
    inputs = []
    for path in args.montage_inputs:
        inputs += ['-i', path]
    pad = ('scale=%d:%d:force_original_aspect_ratio=decrease,'
           'pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=0x202024,setsar=1' % (w, h, w, h))
    chains = ''.join('[%d:v]%s[v%d];' % (i, pad, i)
                     for i in range(len(args.montage_inputs)))
    concat = ''.join('[v%d]' % i for i in range(len(args.montage_inputs)))
    filter_complex = ('%s%sconcat=n=%d:v=1:a=0,tile=%dx%d'
                      % (chains, concat, len(args.montage_inputs), cols, rows))
    if os.path.exists(args.out): os.remove(args.out)
    if not _run_ok(ffmpeg, ['-y'] + inputs + ['-filter_complex', filter_complex,
                                              '-frames:v', '1', '-qscale:v', '3', args.out]): return 1
    print('MONTAGE %s' % args.out)
    return 0 if os.path.isfile(args.out) and os.path.getsize(args.out) > 0 else 1


def main():
    parser = argparse.ArgumentParser(description='参考素材预处理（ffmpeg）')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--info', metavar='VIDEO')
    group.add_argument('--sheet', metavar='VIDEO')
    group.add_argument('--frames', metavar='VIDEO')
    group.add_argument('--crop', nargs=2, metavar=('IMG', 'OUT'))
    group.add_argument('--pair', nargs=3, metavar=('REF', 'RENDER', 'OUT'))
    group.add_argument('--montage', dest='montage_inputs', nargs='+', metavar='IMG')
    parser.add_argument('--out', help='输出文件或目录')
    parser.add_argument('--step', type=float, default=3.0, help='接触表采样间隔秒（默认 3）')
    parser.add_argument('--tile', default='5x3', help='网格 列x行（默认 5x3）')
    parser.add_argument('--width', type=int, default=640, help='每格/每图宽度（默认 640）')
    parser.add_argument('--start', type=float, default=0.0)
    parser.add_argument('--duration', type=float, default=0.0, help='0=到片尾')
    parser.add_argument('--times', help='逗号分隔的秒点（--frames 用）')
    parser.add_argument('--every', type=float, default=25, help='每 N 秒取一张（--frames 用）')
    parser.add_argument('--box', default='0,0,640,360', help='裁切 x,y,w,h（--crop 用）')
    parser.add_argument('--scale', type=int, default=3, help='裁切放大倍数（--crop 用）')
    args = parser.parse_args()

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return 2
    if args.info:
        return cmd_info(args, ffmpeg)
    if args.sheet:
        if not args.out:
            print('ERROR: --sheet 需要 --out 目录', file=sys.stderr)
            return 2
        return cmd_sheet(args, ffmpeg)
    if args.frames:
        if not args.out:
            print('ERROR: --frames 需要 --out 目录', file=sys.stderr)
            return 2
        return cmd_frames(args, ffmpeg)
    if args.crop:
        return cmd_crop(args, ffmpeg)
    if args.pair:
        return cmd_pair(args, ffmpeg)
    if args.montage_inputs:
        if not args.out:
            print('ERROR: --montage 需要 --out 文件', file=sys.stderr)
            return 2
        return cmd_montage(args, ffmpeg)
    return 2


if __name__ == '__main__':
    sys.exit(main())
