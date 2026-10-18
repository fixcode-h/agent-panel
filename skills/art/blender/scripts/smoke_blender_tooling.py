#!/usr/bin/env python3
"""Blender 技能回归入口。

先编译检查本技能的脚本；只有发现 Blender 时才执行运行时 smoke。没有 Blender
时返回 2（N/A），避免把缺少运行时误报成通过。
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile


# 脚本和本文件同在技能目录的 scripts/ 下，不依赖技能装在哪里
SCRIPTS = pathlib.Path(__file__).resolve().parent


def run(cmd):
    proc = subprocess.run(cmd, cwd=str(SCRIPTS), capture_output=True, text=True)
    return {'command': cmd, 'returncode': proc.returncode,
            'stdout': proc.stdout[-2000:], 'stderr': proc.stderr[-2000:]}


def main():
    results = [run([sys.executable, '-m', 'compileall', '-q', str(SCRIPTS)])]
    where = run([sys.executable, str(SCRIPTS / 'blender_cli.py'), '--where'])
    results.append(where)
    report = {'host': results, 'runtime': {'status': 'N/A', 'reason': 'Blender not found'}}
    if where['returncode'] == 0:
        with tempfile.TemporaryDirectory(prefix='blender-smoke-') as temp:
            blend = os.path.join(temp, 'sample.blend')
            build = run([sys.executable, str(SCRIPTS / 'blender_cli.py'),
                         'build_sample_scene.py', '--', blend])
            inspect = run([sys.executable, str(SCRIPTS / 'blender_cli.py'),
                           'inspect_scene.py', '--', blend, '--out', os.path.join(temp, 'inspect.json'),
                           '--intersect-report', '--intersect-every', '10'])
            report['runtime'] = {'status': 'PASS' if build['returncode'] == 0 and inspect['returncode'] in (0, 1) else 'FAIL',
                                 'build': build, 'inspect': inspect}
    out = os.environ.get('BLENDER_SMOKE_REPORT')
    if out:
        pathlib.Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if any(item['returncode'] != 0 for item in results[:1]):
        return 1
    return 0 if report['runtime']['status'] == 'PASS' else 2


if __name__ == '__main__':
    sys.exit(main())
