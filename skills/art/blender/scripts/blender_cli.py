#!/usr/bin/env python3
"""Blender CLI 启动器：定位 Blender 执行文件并以无头模式运行脚本。

用法：
  python blender_cli.py --where
  python blender_cli.py inspect_scene.py -- <scene.blend> --out inspect.json
  python blender_cli.py setup_viewport.py -- --gui <scene.blend>

定位顺序：BLENDER_PATH 环境变量 → PATH → Windows 注册表 InstallLocation → 常见安装目录。
脚本参数放在 `--` 之后，会原样传给 Blender 内的 Python 脚本（sys.argv）。
默认附加 --factory-startup 保证可复现；需要保留用户偏好时加 --no-factory。
带 --gui 时不加 --background（用于视口展示）。
"""
import glob
import os
import shutil
import subprocess
import sys

WINDOWS = os.name == 'nt'
EXE_NAME = 'blender.exe' if WINDOWS else 'blender'


def _file_from(path):
    if not path:
        return None
    path = os.path.expanduser(os.path.expandvars(str(path).strip('"')))
    if os.path.isdir(path):
        direct = os.path.join(path, EXE_NAME)
        if os.path.isfile(direct):
            return direct
        if WINDOWS:
            hits = glob.glob(os.path.join(path, 'Blender *', EXE_NAME))
            if hits:
                return sorted(hits, key=os.path.getmtime, reverse=True)[0]
        return None
    return path if os.path.isfile(path) else None


def _registry_dirs():
    if not WINDOWS:
        return
    import winreg
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'),
        (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
    ]
    for hive, sub in roots:
        try:
            with winreg.OpenKey(hive, sub) as key:
                index = 0
                while True:
                    try:
                        child = winreg.EnumKey(key, index)
                        index += 1
                    except OSError:
                        break
                    try:
                        with winreg.OpenKey(key, child) as item:
                            try:
                                display = str(winreg.QueryValueEx(item, 'DisplayName')[0])
                            except OSError:
                                continue
                            if 'Blender' not in display:
                                continue
                            try:
                                install = winreg.QueryValueEx(item, 'InstallLocation')[0]
                            except OSError:
                                continue
                            hit = _file_from(install)
                            if hit:
                                yield hit
                    except OSError:
                        continue
        except OSError:
            continue


def _common_dir_hit():
    patterns = []
    if WINDOWS:
        for drive in ('C:', 'D:', 'E:'):
            patterns.append('{0}\\Program Files\\Blender Foundation\\Blender *\\{1}'.format(drive, EXE_NAME))
            patterns.append('{0}\\Program Files (x86)\\Blender Foundation\\Blender *\\{1}'.format(drive, EXE_NAME))
        patterns.append(os.path.join(os.path.expanduser('~'), 'Tools', 'Blender*', '**', EXE_NAME))
    else:
        patterns += [
            '/usr/bin/blender',
            '/usr/local/bin/blender',
            '/opt/blender*/blender',
            '/Applications/Blender.app/Contents/MacOS/Blender',
        ]
    for pattern in patterns:
        hits = glob.glob(pattern, recursive=True)
        if hits:
            return sorted(hits, key=os.path.getmtime, reverse=True)[0]
    return None


def locate(explain=False):
    checks = [
        ('BLENDER_PATH', lambda: _file_from(os.environ.get('BLENDER_PATH'))),
        ('PATH', lambda: shutil.which('blender')),
        ('registry', lambda: next(iter(_registry_dirs()), None)),
        ('common-dirs', _common_dir_hit),
    ]
    for name, func in checks:
        try:
            hit = func()
        except Exception:
            hit = None
        if hit:
            if explain:
                print('found via {0}: {1}'.format(name, hit))
            return hit
    return None


def resolve_script(value):
    """Resolve a script from the caller cwd, then beside this launcher."""
    raw = os.path.expanduser(os.path.expandvars(str(value).strip('"')))
    candidates = [raw] if os.path.isabs(raw) else [
        os.path.abspath(raw),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), raw),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    if argv[0] == '--where':
        exe = locate(explain=True)
        if not exe:
            print('Blender not found. 请安装 Blender 或设置 BLENDER_PATH 后重试。')
            return 2
        try:
            result = subprocess.run([exe, '--version'], capture_output=True, text=True)
        except OSError as exc:
            print('Blender version check failed: {0}'.format(exc), file=sys.stderr)
            return 2
        first = (result.stdout or '').splitlines()
        print(first[0] if first else '(version unavailable)')
        return 0 if result.returncode == 0 else 1

    exe = locate()
    if not exe:
        print('Blender not found（已尝试 BLENDER_PATH / PATH / 注册表 / 常见目录）。'
              '请安装 Blender 或设置 BLENDER_PATH。', file=sys.stderr)
        return 2

    script = resolve_script(argv[0])
    if not script:
        print('script not found: ' + argv[0], file=sys.stderr)
        return 2
    rest = argv[1:]
    if rest and rest[0] == '--':
        rest = rest[1:]
    gui = '--gui' in rest
    if gui:
        rest = [a for a in rest if a != '--gui']
    factory = '--no-factory' not in rest
    if not factory:
        rest = [a for a in rest if a != '--no-factory']

    cmd = [exe]
    if not gui:
        cmd.append('--background')
        cmd += ['--python-exit-code', '1']
    if factory:
        cmd.append('--factory-startup')
    cmd += ['--python', script]
    if rest:
        cmd += ['--'] + rest
    print('running: ' + ' '.join(cmd), flush=True)
    try:
        return subprocess.call(cmd)
    except OSError as exc:
        print('Blender launch failed: {0}'.format(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
