import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { t } from '../shared/i18n.ts'
import { ModelMeta, type ModelObject } from '../shared/blender.ts'
import { DATA_DIR } from './store.ts'
import { getSettings } from './settings.ts'
import { log } from './log.ts'

/**
 * 模型设计用的 Blender（见 docs/adr/0025-model-design-blender.md）。
 *
 * 每个模型对话一个后台 Blender 进程，里面跑 server/blender/bridge.py 起的本机 HTTP 服务；
 * Agent 经 MCP 工具（blender-mcp.ts）交来的 bpy 代码在这里串行发给它。每执行一次就存 .blend、导出 glb、版本加一，
 * 网页右栏的「模型」页签看到版本变了就重新加载，做到「边建边看」。
 * 场景存在数据目录 models/<对话 id>/ 下，进程关了下次接着用。
 */

/** 出包时由 esbuild 写进 server.mjs（scripts/package.mjs）；开发时读源码旁边的文件 */
declare const __BLENDER_BRIDGE__: string | undefined
const EMBEDDED = typeof __BLENDER_BRIDGE__ === 'string' ? __BLENDER_BRIDGE__ : undefined
const BRIDGE_SOURCE = path.resolve(import.meta.dirname, 'blender', 'bridge.py')

export const MODELS_DIR = path.join(DATA_DIR, 'models')
export const modelDir = (taskId: string) => path.join(MODELS_DIR, taskId.replace(/[^\w-]/g, '_'))
const blendFile = (taskId: string) => path.join(modelDir(taskId), 'scene.blend')
export const glbFile = (taskId: string) => path.join(modelDir(taskId), 'scene.glb')
const metaFile = (taskId: string) => path.join(modelDir(taskId), 'model.json')

/** 空闲多久关掉 Blender 进程：一个进程占几百 MB 内存，没在建模时不留着 */
const IDLE_MS = 10 * 60_000
/** 一段代码最长跑多久：超时当作卡住，杀掉进程，下次重开（场景停在上次存的 .blend） */
const EXEC_TIMEOUT_MS = 5 * 60_000
const START_TIMEOUT_MS = 90_000

/**
 * 测试和没装 Blender 本体的开发环境：设了这个环境变量就用 pip 装的 bpy 模块跑桥接（python bridge.py），
 * 不找 Blender 可执行文件
 */
const BPY_PYTHON = () => process.env.AGENT_PANEL_BLENDER_PYTHON ?? ''

/** 常见的安装位置：用户没填路径、PATH 里也没有时按这些找 */
function candidates(): string[] {
  const out: string[] = []
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      const dir = path.join(root, 'Blender Foundation')
      if (!existsSync(dir)) continue
      // 多个版本时用版本号最大的那个
      for (const v of readdirSync(dir).sort().reverse()) out.push(path.join(dir, v, 'blender.exe'))
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Blender.app/Contents/MacOS/Blender')
  } else {
    out.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender')
  }
  return out
}

function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const f = path.join(dir, name + ext)
      if (dir && existsSync(f)) return f
    }
  }
  return ''
}

/** 要用哪个 Blender：设置里填的优先，再看 PATH，再看常见安装位置；都没有返回空串 */
export async function blenderPath(): Promise<string> {
  if (BPY_PYTHON()) return BPY_PYTHON()
  const set = (await getSettings()).blender.path
  if (set) return set
  return onPath('blender') || candidates().find((f) => existsSync(f)) || ''
}

const run = (cmd: string, args: string[], timeout = 60_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  )

/** 检测结果给设置页和新建模型对话用：找没找到、在哪、什么版本、为什么不能用 */
export async function blenderStatus(): Promise<{ path: string; version: string; error: string }> {
  const exe = await blenderPath()
  if (!exe)
    return {
      path: '',
      version: '',
      error: t('没有找到 Blender。请先安装 Blender 4.2 或更新的版本，或在设置里填它的位置。'),
    }
  try {
    const out = BPY_PYTHON()
      ? await run(exe, ['-I', '-c', 'import bpy; print("Blender " + bpy.app.version_string)'])
      : await run(exe, ['--version'])
    const m = /Blender\s+([\d.]+[^\n]*)/.exec(out)
    return { path: exe, version: m?.[1]?.trim() ?? '', error: m ? '' : t('这个程序不像是 Blender') }
  } catch (e) {
    return { path: exe, version: '', error: t('启动 Blender 失败：{error}', { error: (e as Error).message }) }
  }
}

/** 桥接脚本落到数据目录再交给 Blender：出包后没有源码目录，开发时也统一走这一份 */
async function bridgeScript(): Promise<string> {
  const to = path.join(MODELS_DIR, 'bridge.py')
  const src = EMBEDDED ?? (await readFile(BRIDGE_SOURCE, 'utf8'))
  const cur = await readFile(to, 'utf8').catch(() => '')
  if (cur !== src) {
    await mkdir(MODELS_DIR, { recursive: true })
    await writeFile(to, src)
  }
  return to
}

interface Bridge {
  proc: ChildProcess
  port: number
  token: string
  /** 串行队列：bpy 只能一次做一件事，同一个对话的请求排着发 */
  queue: Promise<unknown>
  lastUsed: number
  busy: number
}

const bridges = new Map<string, Promise<Bridge>>()

async function start(taskId: string): Promise<Bridge> {
  const exe = await blenderPath()
  if (!exe) throw new Error((await blenderStatus()).error)
  const script = await bridgeScript()
  await mkdir(modelDir(taskId), { recursive: true })
  const token = randomUUID()
  const extra = ['--token', token, '--blend', blendFile(taskId)]
  const args = BPY_PYTHON() ? ['-I', script, ...extra] : ['-b', '--factory-startup', '--python', script, '--', ...extra]
  const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const keep = (b: Buffer) => (tail = (tail + b.toString()).slice(-4000))
  proc.stderr?.on('data', keep)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(t('Blender 启动超时：{tail}', { tail: tail.slice(-600) })))
    }, START_TIMEOUT_MS)
    proc.stdout?.on('data', (b: Buffer) => {
      keep(b)
      const m = /READY (\d+)/.exec(tail)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(t('Blender 没能启动（退出码 {code}）：{tail}', { code: String(code), tail: tail.slice(-600) })))
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  const b: Bridge = { proc, port, token, queue: Promise.resolve(), lastUsed: Date.now(), busy: 0 }
  // 进程自己没了（被杀、崩溃）：从表里拿掉，下次用时重开
  proc.on('exit', () => {
    if (bridges.get(taskId)) bridges.delete(taskId)
  })
  log.info('blender', '模型对话的 Blender 已启动', { taskId, port })
  return b
}

function bridgeFor(taskId: string): Promise<Bridge> {
  let p = bridges.get(taskId)
  if (!p) {
    p = start(taskId)
    bridges.set(taskId, p)
    // 起不来不留在表里：下次重新试，不一直返回同一个失败
    p.catch(() => bridges.delete(taskId))
  }
  return p
}

async function call<T>(b: Bridge, method: 'GET' | 'POST', route: string, body?: unknown, timeout = 60_000) {
  const res = await fetch(`http://127.0.0.1:${b.port}${route}`, {
    method,
    headers: { 'X-Bridge-Token': b.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  return (await res.json()) as T & { ok: boolean; error?: string }
}

/** 同一个对话的请求排队，一次一个；排队期间也算「在用」，不会被空闲回收 */
function queued<T>(taskId: string, fn: (b: Bridge) => Promise<T>): Promise<T> {
  return bridgeFor(taskId).then((b) => {
    b.busy++
    const next = b.queue.then(
      () => fn(b),
      () => fn(b),
    )
    b.queue = next.catch(() => {})
    return next.finally(() => {
      b.busy--
      b.lastUsed = Date.now()
    })
  })
}

export async function readModelMeta(taskId: string): Promise<ModelMeta> {
  const raw = await readFile(metaFile(taskId), 'utf8').catch(() => '')
  return ModelMeta.parse(raw ? JSON.parse(raw) : {})
}

/** 存 .blend、导出 glb、读场景，写进 model.json，版本加一 */
async function snapshot(taskId: string, b: Bridge): Promise<ModelMeta> {
  await call(b, 'POST', '/save', { path: blendFile(taskId) })
  const ex = await call(b, 'POST', '/export', { path: glbFile(taskId) }, 120_000)
  const scene = await call<{ objects: ModelObject[] }>(b, 'GET', '/scene')
  const prev = await readModelMeta(taskId)
  const meta = ModelMeta.parse({
    version: prev.version + 1,
    updatedAt: new Date().toISOString(),
    objects: scene.objects ?? [],
    exportError: ex.ok ? '' : (ex.error ?? ''),
  })
  await writeFile(metaFile(taskId), JSON.stringify(meta, null, 2))
  return meta
}

export interface RunResult {
  ok: boolean
  output: string
  error: string
  meta: ModelMeta
}

/**
 * 在这个对话的场景里执行一段 bpy 代码。报错时场景可能已经改了一半，照样存档导出，
 * 网页看到的永远是 Blender 里真实的样子
 */
export function runPython(taskId: string, code: string): Promise<RunResult> {
  return queued(taskId, async (b) => {
    let r: { ok: boolean; output?: string; error?: string }
    try {
      r = await call(b, 'POST', '/exec', { code }, EXEC_TIMEOUT_MS)
    } catch (e) {
      // 超时或进程没了：杀掉重开，场景回到上次存的 .blend
      b.proc.kill()
      bridges.delete(taskId)
      throw new Error(
        t('Blender 执行这段代码时卡住或退出了，已重启，场景回到上一次保存的样子：{error}', {
          error: (e as Error).message,
        }),
      )
    }
    const meta = await snapshot(taskId, b)
    return { ok: r.ok, output: r.output ?? '', error: r.error ?? '', meta }
  })
}

/** 当前场景的物体列表（不改场景、不导出） */
export function sceneObjects(taskId: string): Promise<ModelObject[]> {
  return queued(taskId, async (b) => (await call<{ objects: ModelObject[] }>(b, 'GET', '/scene')).objects ?? [])
}

/** 关掉某个对话的 Blender（对话删除、用户手动停） */
export async function closeBlender(taskId: string) {
  const p = bridges.get(taskId)
  if (!p) return
  bridges.delete(taskId)
  const b = await p.catch(() => undefined)
  if (!b) return
  await call(b, 'POST', '/shutdown').catch(() => {})
  setTimeout(() => b.proc.kill(), 3000).unref()
}

// 空闲回收：每分钟看一次，没在排队、超过 IDLE_MS 没用过的关掉
setInterval(() => {
  for (const [taskId, p] of bridges)
    void p.then(
      (b) => {
        if (!b.busy && Date.now() - b.lastUsed > IDLE_MS) void closeBlender(taskId)
      },
      () => {},
    )
}, 60_000).unref()

// 面板退出时带走所有 Blender 进程，不留孤儿
process.on('exit', () => {
  for (const p of bridges.values())
    void p.then(
      (b) => b.proc.kill(),
      () => {},
    )
})

/** /api/blender：检测状态；/api/blender/models/:taskId：预览要的版本号、物体列表和 glb */
export function blenderApi() {
  return new Hono()
    .get('/status', async (c) => c.json(await blenderStatus()))
    .get('/models/:taskId', async (c) => c.json(await readModelMeta(c.req.param('taskId'))))
    .get('/models/:taskId/scene.glb', async (c) => {
      const buf = await readFile(glbFile(c.req.param('taskId'))).catch(() => null)
      if (!buf) return c.json({ error: t('还没有模型') }, 404)
      return c.body(new Uint8Array(buf), 200, {
        'Content-Type': 'model/gltf-binary',
        // 版本号在地址里（?v=），同一版可以缓存
        'Cache-Control': 'no-cache',
      })
    })
}
