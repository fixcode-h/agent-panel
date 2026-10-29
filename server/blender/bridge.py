"""
Agent 面板的 Blender 桥接（见 docs/adr/0025-model-design-blender.md）。

在 Blender 里起一个只听本机的 HTTP 服务，面板通过它在当前场景里执行 bpy 代码、读场景、导出 glb、存 .blend。
两种跑法用同一份脚本：
  blender -b --factory-startup --python bridge.py -- --token T [--blend scene.blend]
  python bridge.py --token T [--blend scene.blend]        # pip 装的 bpy 模块，测试用
启动成功后往标准输出打一行「READY <端口>」，面板读到它才开始发请求。

bpy 只能在主线程里调用：服务用单线程的 HTTPServer 在主线程里 serve_forever，一次处理一个请求，
面板那边也按对话串行发请求。
"""

import argparse
import contextlib
import io
import json
import math
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

import bpy

# 返回给 Agent 的输出上限：再长的打印也只回前面这一段，免得一次工具结果撑爆上下文
MAX_OUTPUT = 8000


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--token", required=True)
    p.add_argument("--blend", default="")
    p.add_argument("--port", type=int, default=0)
    return p.parse_args(argv)


ARGS = parse_args()


def open_scene():
    """接着上次的 .blend；没有就从空场景开始（不要默认的立方体、灯和相机），单位用米"""
    if ARGS.blend and os.path.exists(ARGS.blend):
        bpy.ops.wm.open_mainfile(filepath=ARGS.blend)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    unit = bpy.context.scene.unit_settings
    unit.system = "METRIC"
    unit.scale_length = 1.0


open_scene()

# Agent 每次执行共用一个命名空间：上一段定义的函数、变量下一段还能用
NAMESPACE = {"bpy": bpy, "math": math, "__name__": "__agent__"}
try:
    import bmesh
    import mathutils

    NAMESPACE.update({"bmesh": bmesh, "mathutils": mathutils, "Vector": mathutils.Vector})
except ImportError:
    pass


def clip(text):
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n…（输出太长，只保留前 %d 个字）" % MAX_OUTPUT


def run_code(code):
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(code, "<agent>", "exec"), NAMESPACE)
        return {"ok": True, "output": clip(out.getvalue())}
    except SystemExit:
        return {"ok": False, "output": clip(out.getvalue()), "error": "代码里调用了 exit，没有执行完"}
    except BaseException:
        # 只回 Agent 代码那一段的报错，桥接脚本自己的栈帧没用
        tb = traceback.format_exc()
        cut = tb.find('File "<agent>"')
        return {
            "ok": False,
            "output": clip(out.getvalue()),
            "error": clip("Traceback:\n  " + tb[cut:] if cut >= 0 else tb),
        }


def r3(v):
    return [round(float(x), 4) for x in v]


def scene_info():
    objects = []
    for ob in bpy.context.scene.objects:
        item = {
            "name": ob.name,
            "type": ob.type,
            "location": r3(ob.location),
            "rotation": r3(ob.rotation_euler),
            "scale": r3(ob.scale),
            "dimensions": r3(ob.dimensions),
            "parent": ob.parent.name if ob.parent else "",
            "collection": ob.users_collection[0].name if ob.users_collection else "",
            "materials": [s.material.name for s in getattr(ob, "material_slots", []) if s.material],
            "hidden": ob.hide_get() if hasattr(ob, "hide_get") else False,
        }
        if ob.type == "MESH" and ob.data:
            item["vertices"] = len(ob.data.vertices)
            item["faces"] = len(ob.data.polygons)
            item["modifiers"] = [m.type for m in ob.modifiers]
        objects.append(item)
    return {"objects": objects, "frame": bpy.context.scene.frame_current, "version": bpy.app.version_string}


def export_glb(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp.glb"
    # 先写临时文件再改名：网页这时来取不会拿到写了一半的文件
    bpy.ops.export_scene.gltf(
        filepath=tmp,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=True,
    )
    os.replace(tmp, path)


def save_blend(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        if self.headers.get("X-Bridge-Token") == ARGS.token:
            return True
        self.reply(403, {"ok": False, "error": "token"})
        return False

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if not self.allowed():
            return
        if self.path == "/health":
            return self.reply(200, {"ok": True, "version": bpy.app.version_string})
        if self.path == "/scene":
            return self.reply(200, {"ok": True, **scene_info()})
        self.reply(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            data = self.body()
            if self.path == "/exec":
                return self.reply(200, run_code(str(data.get("code", ""))))
            if self.path == "/export":
                export_glb(str(data["path"]))
                return self.reply(200, {"ok": True})
            if self.path == "/save":
                save_blend(str(data["path"]))
                return self.reply(200, {"ok": True})
            if self.path == "/shutdown":
                self.reply(200, {"ok": True})
                SERVER.shutting_down = True
                return
            self.reply(404, {"ok": False, "error": "not found"})
        except Exception as e:
            self.reply(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


class Server(HTTPServer):
    shutting_down = False

    def service_actions(self):
        if self.shutting_down:
            # serve_forever 的循环里不能直接 shutdown（会死锁），打标记让外面退出
            raise KeyboardInterrupt


SERVER = Server(("127.0.0.1", ARGS.port), Handler)
print("READY %d" % SERVER.server_address[1], flush=True)
try:
    SERVER.serve_forever(poll_interval=0.2)
except KeyboardInterrupt:
    pass
finally:
    SERVER.server_close()
