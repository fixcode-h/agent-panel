import { Hono } from 'hono'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { t } from '../shared/i18n.ts'
import {
  BUILTIN_WORKFLOWS,
  ComfyWorkflow,
  LOCAL_FILES,
  LOCAL_MODELS,
  checkWorkflow,
  fillWorkflow,
  localFile,
  localModel,
  localSize,
  mirrorUrl,
  pickWorkflow,
  type WorkflowUse,
  type LocalGpu,
  type LocalJob,
  type LocalStatus,
} from '../shared/local-image.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { getCli } from '../shared/clis.ts'
import { localPrompts } from '../shared/design.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { invokeCli } from './exec/invoke.ts'
import { capture, childEnv, killTree, runProcess } from './exec/process.ts'
import { log } from './log.ts'
import { netFetch } from './net.ts'
import { getSettings } from './settings.ts'
import { registerFixTopic } from './fix.ts'
import { appDir } from './update.ts'

/**
 * 本机生图：在软件目录的 comfyui/ 下装 ComfyUI（源码 + 独立的 Python 虚拟环境），按需启动，
 * 用它的 HTTP 接口提交工作流、取回图片。安装、下载模型同一时间只跑一个，进度给设置页轮询。
 */

const isWin = platform() === 'win32'
const REPO = 'https://github.com/comfyanonymous/ComfyUI'
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'
/** 装依赖时用的 PyTorch：按显卡选对应的版本 */
const TORCH_INDEX: Record<LocalGpu, string> = {
  cuda: 'https://download.pytorch.org/whl/cu128',
  rocm: 'https://download.pytorch.org/whl/rocm6.4',
  cpu: 'https://download.pytorch.org/whl/cpu',
  mps: '',
}

export const comfyDir = () => process.env.AGENT_PANEL_COMFY_DIR ?? path.join(appDir(), 'comfyui')
const codeDir = () => path.join(comfyDir(), 'ComfyUI')
const venvPython = () =>
  isWin ? path.join(comfyDir(), 'venv', 'Scripts', 'python.exe') : path.join(comfyDir(), 'venv', 'bin', 'python')
const marker = () => path.join(comfyDir(), '.installed')
const filePath = (id: string) => {
  const f = localFile(id)!
  return path.join(codeDir(), 'models', f.dir, f.file)
}

type Job = LocalJob & { abort: AbortController }
let job: Job | undefined
let server: { child: ChildProcess; port: number; log: string } | undefined
let starting: Promise<string> | undefined
let gpuInfo: { gpu: LocalGpu; name?: string; vram?: number } | undefined
let python: { cmd: string; args: string[]; version: string } | null | undefined

const tail = (s: string, n = 20000) => (s.length > n ? s.slice(-n) : s)
const say = (line: string) => job && (job.log = tail(job.log + line + '\n'))

/** 显卡：有 nvidia-smi 用 CUDA，苹果芯片用 MPS，Linux 上有 rocminfo 用 ROCm，都没有用 CPU（能跑但很慢） */
async function detectGpu() {
  if (gpuInfo) return gpuInfo
  const smi = await capture('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], tmpdir())
  if (smi.code === 0 && smi.stdout.trim()) {
    const [name, mem] = smi.stdout.trim().split('\n')[0].split(',')
    return (gpuInfo = { gpu: 'cuda', name: name.trim(), vram: Math.round(Number(mem) / 1024) || undefined })
  }
  if (platform() === 'darwin' && arch() === 'arm64') return (gpuInfo = { gpu: 'mps', name: 'Apple Silicon' })
  if (platform() === 'linux' && (await capture('rocminfo', [], tmpdir())).code === 0)
    return (gpuInfo = { gpu: 'rocm', name: 'AMD ROCm' })
  return (gpuInfo = { gpu: 'cpu' })
}

/** 找 Python 3.10 ~ 3.13（ComfyUI 和 PyTorch 支持的范围） */
async function findPython() {
  if (python !== undefined) return python
  const list: [string, string[]][] = isWin
    ? [
        ['py', ['-3.12']],
        ['py', ['-3.11']],
        ['py', ['-3.13']],
        ['py', ['-3.10']],
        ['python', []],
      ]
    : [
        ['python3.12', []],
        ['python3.11', []],
        ['python3.13', []],
        ['python3.10', []],
        ['python3', []],
        ['python', []],
      ]
  for (const [cmd, args] of list) {
    const r = await capture(cmd, [...args, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], tmpdir())
    const v = r.code === 0 ? r.stdout.trim() : ''
    const minor = Number(v.split('.')[1])
    if (v.startsWith('3.') && minor >= 10 && minor <= 13) return (python = { cmd, args, version: v })
  }
  return (python = null)
}

async function downloadedFiles() {
  const out: string[] = []
  for (const f of LOCAL_FILES) if (existsSync(filePath(f.id))) out.push(f.id)
  return out
}

async function baseUrl() {
  const s = (await getSettings()).imageGen.local
  return s.url ? s.url.replace(/\/+$/, '') : `http://127.0.0.1:${s.port}`
}

async function alive(url: string) {
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

export async function localStatus(): Promise<LocalStatus> {
  const s = (await getSettings()).imageGen.local
  const g = await detectGpu()
  const url = await baseUrl()
  const py = existsSync(marker()) ? null : await findPython()
  return {
    dir: comfyDir(),
    installed: existsSync(marker()),
    running: !!s.url || !!server ? await alive(url) : false,
    external: !!s.url,
    url,
    python: py?.version,
    gpu: g.gpu,
    gpuName: g.name,
    vram: g.vram,
    files: await downloadedFiles(),
    job: job && (({ abort: _, ...rest }) => rest)(job),
  }
}

/** 开一个后台操作；已经有在跑的就拒绝 */
function begin(kind: LocalJob['kind'], step: string, run: (j: Job) => Promise<void>) {
  if (job?.status === 'running') throw new Error(t('还有操作在进行：{step}', { step: job.step }))
  const j: Job = { id: randomUUID(), kind, status: 'running', step, log: '', abort: new AbortController() }
  job = j
  void run(j)
    .then(() => {
      j.status = 'done'
      j.progress = undefined
    })
    .catch((e) => {
      j.status = 'failed'
      j.error = j.abort.signal.aborted ? t('已取消') : (e as Error).message
      say(`\n${j.error}`)
      log.warn('comfy', `${kind} 失败`, { error: j.error })
    })
  return j
}

/** 跑一条命令，输出写进日志；失败时抛出带最后几行输出的错误 */
async function exec(cmd: string, args: string[], cwd: string) {
  say(`$ ${[cmd, ...args].join(' ')}`)
  const r = await runProcess({
    command: cmd,
    args,
    cwd,
    env: { ...childEnv([]), PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    signal: job?.abort.signal,
    timeoutMs: 0,
    onLine: (l) => say(l),
    onStderr: (s) => job && (job.log = tail(job.log + s)),
  })
  if (r.killed === 'stopped') throw new Error(t('已取消'))
  if (r.spawnError) throw new Error(r.spawnError)
  if (r.code !== 0)
    throw new Error(t('命令失败（退出码 {code}）：{cmd}', { code: String(r.code), cmd: [cmd, ...args].join(' ') }))
}

/** 下载一个文件：先写 .part，断了再点下载接着下（Range），完成后改名 */
async function download(url: string, to: string, onBytes: (n: number) => void, signal: AbortSignal) {
  await mkdir(path.dirname(to), { recursive: true })
  const part = `${to}.part`
  const have = existsSync(part) ? (await stat(part)).size : 0
  const res = await netFetch(url, { signal, headers: have ? { Range: `bytes=${have}-` } : {} })
  if (!res.ok || !res.body) throw new Error(t('下载失败（{status}）：{url}', { status: String(res.status), url }))
  const resumed = res.status === 206
  if (resumed) onBytes(have)
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => onBytes(c.length))
  await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal })
  await rename(part, to)
}

export function installComfy() {
  return begin('install', t('准备安装'), async (j) => {
    const settings = (await getSettings()).imageGen.local
    const dir = comfyDir()
    await mkdir(dir, { recursive: true })
    j.step = t('检查 Python')
    python = undefined
    const py = await findPython()
    if (!py)
      throw new Error(
        t(
          '没有找到 Python 3.10 ~ 3.13。请先安装 Python 3.12（https://www.python.org/downloads/ ，Windows 安装时勾选 Add to PATH），装好后重试；也可以点「AI 处理」让 AI 帮你装。',
        ),
      )
    say(t('使用 Python {v}（{cmd}）', { v: py.version, cmd: [py.cmd, ...py.args].join(' ') }))
    const g = await detectGpu()
    say(t('显卡：{gpu}', { gpu: g.name ? `${g.name}${g.vram ? ` ${g.vram}GB` : ''}` : g.gpu }))

    if (!existsSync(path.join(codeDir(), 'main.py'))) {
      j.step = t('下载 ComfyUI')
      const git = await capture('git', ['--version'], dir)
      if (git.code === 0) await exec('git', ['clone', '--depth', '1', `${REPO}.git`, codeDir()], dir)
      else {
        // 没有 git：下载源码压缩包，用 Python 自带的 zipfile 解开
        const zip = path.join(dir, 'ComfyUI.zip')
        say(`${REPO}/archive/refs/heads/master.zip`)
        await download(`${REPO}/archive/refs/heads/master.zip`, zip, () => {}, j.abort.signal)
        await exec(py.cmd, [...py.args, '-m', 'zipfile', '-e', zip, dir], dir)
        const unpacked = (await readdir(dir)).find((n) => /^ComfyUI-/i.test(n))
        if (!unpacked) throw new Error(t('解压 ComfyUI 失败'))
        await rename(path.join(dir, unpacked), codeDir())
        await rm(zip, { force: true })
      }
    }
    if (!existsSync(venvPython())) {
      j.step = t('创建 Python 虚拟环境')
      await exec(py.cmd, [...py.args, '-m', 'venv', path.join(dir, 'venv')], dir)
    }
    const pip = (...args: string[]) => exec(venvPython(), ['-m', 'pip', 'install', ...args], dir)
    const mirror = settings.mirror ? ['-i', PYPI_MIRROR] : []
    j.step = t('安装 PyTorch（{gpu}，文件较大）', { gpu: g.gpu.toUpperCase() })
    await pip('--upgrade', 'pip', ...mirror)
    const index = TORCH_INDEX[g.gpu]
    await pip('torch', 'torchvision', 'torchaudio', ...(index ? ['--index-url', index] : mirror))
    j.step = t('安装 ComfyUI 的依赖')
    await pip('-r', path.join(codeDir(), 'requirements.txt'), ...mirror)
    await verify()
    await writeFile(marker(), new Date().toISOString())
    j.step = t('安装完成')
  })
}

/** 装好了没有：虚拟环境里能导入 torch 和 ComfyUI 的主要依赖 */
async function verify() {
  await exec(
    venvPython(),
    [
      '-c',
      'import torch, safetensors, aiohttp, yaml; print("torch", torch.__version__, "gpu", torch.cuda.is_available())',
    ],
    codeDir(),
  )
}

export function downloadModel(id: string) {
  const m = localModel(id)
  if (!m) throw new Error(t('没有这个模型'))
  return begin('download', t('下载 {name}', { name: m.name }), async (j) => {
    j.model = id
    const mirror = (await getSettings()).imageGen.local.mirror
    const todo = m.files.filter((f) => !existsSync(filePath(f)))
    const total = todo.reduce((n, f) => n + localFile(f)!.gb * 1024 ** 3, 0)
    j.progress = { done: 0, total }
    for (const id of todo) {
      const f = localFile(id)!
      j.step = t('下载 {file}', { file: f.file })
      const url = mirrorUrl(f.url, mirror)
      say(url)
      await download(url, filePath(id), (n) => (j.progress!.done += n), j.abort.signal)
    }
    j.step = t('{name} 下载完成', { name: m.name })
  })
}

/** 删掉模型的文件；别的已下载模型还在用的文件留着 */
export async function removeModel(id: string) {
  const m = localModel(id)
  if (!m) throw new Error(t('没有这个模型'))
  const files = await downloadedFiles()
  const keep = new Set(
    LOCAL_MODELS.filter((o) => o.id !== id && o.files.every((f) => files.includes(f))).flatMap((o) => o.files),
  )
  for (const f of m.files)
    if (!keep.has(f)) {
      await rm(filePath(f), { force: true })
      await rm(`${filePath(f)}.part`, { force: true })
    }
}

/** 启动 ComfyUI（只监听本机），等它的接口能访问；已经在跑就直接返回地址 */
export async function startComfy(): Promise<string> {
  const s = (await getSettings()).imageGen.local
  const url = await baseUrl()
  if (s.url) {
    if (await alive(url)) return url
    throw new Error(t('连不上设置里填的 ComfyUI 地址 {url}，请确认它已经启动', { url }))
  }
  if (server && (await alive(url))) return url
  if (starting) return starting
  if (!existsSync(marker())) throw new Error(t('还没有安装本机生图（ComfyUI），请到设置 → 本机生图里一键安装'))
  starting = (async () => {
    // 端口被别的程序（比如自己开的 ComfyUI）占着、而且就是 ComfyUI：直接用
    if (await alive(url)) return url
    const g = await detectGpu()
    const args = ['main.py', '--listen', '127.0.0.1', '--port', String(s.port), '--disable-auto-launch']
    if (g.gpu === 'cpu') args.push('--cpu')
    const child = spawn(venvPython(), args, {
      cwd: codeDir(),
      env: { ...childEnv([]), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
    })
    const cur = (server = { child, port: s.port, log: '' })
    const add = (d: Buffer) => (cur.log = tail(cur.log + d.toString('utf8')))
    child.stdout!.on('data', add)
    child.stderr!.on('data', add)
    let exited = false
    child.on('exit', () => {
      exited = true
      if (server === cur) server = undefined
    })
    child.on('error', (e) => add(Buffer.from(String(e))))
    // 第一次启动要加载节点，慢的机器要一两分钟
    for (let i = 0; i < 240 && !exited; i++) {
      if (await alive(url)) return url
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!exited) stopComfy()
    throw new Error(
      t('ComfyUI 没有启动起来：{log}', { log: cur.log.trim().split('\n').slice(-8).join('\n') || t('没有输出') }),
    )
  })().finally(() => (starting = undefined))
  return starting
}

export function stopComfy() {
  const pid = server?.child.pid
  server = undefined
  if (pid) killTree(pid)
}
process.on('exit', stopComfy)

export const comfyLog = () => server?.log ?? ''

/**
 * 「AI 处理」本机生图的报错：页面把失败的步骤和输出交过来（见 server/fix.ts），这里补上环境、目录和修好后要满足的条件。
 * 页面在处理完后点「重新检测」，会重新找 Python
 */
registerFixTopic('local-image', {
  cwd: () => comfyDir(),
  context: async () => {
    const g = await detectGpu()
    const py = await findPython()
    await mkdir(comfyDir(), { recursive: true })
    const serverLog = comfyLog()
    return `这是本机图片生成工具 ComfyUI 的安装或启动问题。
- 显卡：${g.name ?? g.gpu}${g.vram ? `（${g.vram}GB 显存）` : ''}，PyTorch 应该用 ${g.gpu.toUpperCase()} 版本${TORCH_INDEX[g.gpu] ? `（${TORCH_INDEX[g.gpu]}）` : ''}
- 找到的 Python：${py ? `${[py.cmd, ...py.args].join(' ')}（${py.version}）` : '没有找到 3.10~3.13 的版本'}
- 安装目录：${comfyDir()}（ComfyUI 源码在 ${codeDir()}，Python 虚拟环境在 ${path.join(comfyDir(), 'venv')}）
- 虚拟环境的 Python：${venvPython()}
${serverLog ? `\nComfyUI 启动时的输出：\n${serverLog.slice(-4000)}\n` : ''}
处理这类问题的约定：
- 只在安装目录里改动；可以用虚拟环境的 pip 装或重装依赖，缺 Python 时可以用系统的包管理器装 Python 3.12。
- 不要删除 ${path.join(codeDir(), 'models')} 里的模型文件。
- 修好后运行 ${venvPython()} -c "import torch, safetensors, aiohttp, yaml" 确认能导入；全部正常时在 ${marker()} 写入当前时间（这个文件表示安装完成）。`
  },
})

export function cancelJob() {
  job?.abort.abort()
}

/**
 * 用本机模型生成：一次提交一个工作流，count 张放在同一批里；轮询结果，取回图片交给 onImage
 */
/** 用户的工作流（内置的在代码里），存在数据目录 */
const WORKFLOWS_FILE = () => path.join(DATA_DIR, 'comfy-workflows.json')
export async function userWorkflows(): Promise<ComfyWorkflow[]> {
  const raw = await readJson(WORKFLOWS_FILE())
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    const p = ComfyWorkflow.safeParse(x)
    return p.success ? [{ ...p.data, builtin: undefined }] : []
  })
}
export const allWorkflows = async () => [...BUILTIN_WORKFLOWS, ...(await userWorkflows())]
let writing = Promise.resolve()
async function saveWorkflows(fn: (list: ComfyWorkflow[]) => ComfyWorkflow[]) {
  const next = writing.then(async () => writeJsonAtomic(WORKFLOWS_FILE(), fn(await userWorkflows())))
  writing = next.catch(() => {})
  await next
}

/** 工作流能不能跑：用到的内置模型下载好了（用已有的 ComfyUI 时不检查，模型由用户自己放） */
export async function workflowReady(wf: ComfyWorkflow) {
  if ((await getSettings()).imageGen.local.url || !wf.model) return true
  const m = localModel(wf.model)
  return !m || m.files.every((f) => existsSync(filePath(f)))
}

/**
 * 用本机的 ComfyUI 生成：按指定的工作流（或按图片用途自动选的），count 张放在同一批里；
 * 轮询结果，取回图片交给 onImage
 */
export async function localGenerate(
  o: {
    /** 工作流 id，auto 自动选 */
    workflow: string
    kind: 'game' | 'web'
    use: WorkflowUse
    /** 完整的描述（新模型用）和压缩成关键词用的材料（SDXL 用） */
    full: string
    short: Parameters<typeof localPrompts>[2]
    width: number
    height: number
    count: number
    onImage: (b: Buffer) => void
    onProgress?: (text: string) => void
  },
  signal: AbortSignal,
) {
  const list = await allWorkflows()
  const ready = new Set<string>()
  for (const w of list) if (await workflowReady(w)) ready.add(w.id)
  const wf = pickWorkflow(list, o.workflow, o.kind, o.use, (w) => ready.has(w.id))
  if (!wf)
    throw new Error(
      o.workflow === 'auto'
        ? t('还没有能用的本机模型，请到设置 → 本机生图里下载一个')
        : t('找不到工作流 {id}', { id: o.workflow }),
    )
  const m = localModel(wf.model)
  if (!ready.has(wf.id))
    throw new Error(t('{name} 还没下载完，请到设置 → 本机生图里下载', { name: m?.name ?? wf.model }))
  const p = localPrompts(o.full, m?.natural ?? true, o.short)
  const prompt = wf.extra ? `${p.prompt}${m?.natural === false ? ', ' : '\n'}${wf.extra}` : p.prompt
  o.onProgress?.(t('正在启动本机生图…'))
  const url = await startComfy()
  const size = localSize(o.width, o.height, m?.base ?? 1024)
  const workflow = fillWorkflow(wf.graph, {
    prompt,
    negative: p.negative,
    ...size,
    count: Math.min(4, Math.max(1, o.count)),
    seed: Math.floor(Math.random() * 2 ** 48),
  })
  const res = await fetch(`${url}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'agent-panel' }),
    signal,
  })
  const body = (await res.json().catch(() => ({}))) as { prompt_id?: string; error?: unknown; node_errors?: unknown }
  if (!res.ok || !body.prompt_id)
    throw new Error(t('ComfyUI 拒绝了这次生成：{error}', { error: JSON.stringify(body.error ?? body).slice(0, 600) }))
  const id = body.prompt_id
  const cancel = () => {
    void fetch(`${url}/queue`, { method: 'POST', body: JSON.stringify({ delete: [id] }) }).catch(() => {})
    void fetch(`${url}/interrupt`, { method: 'POST' }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    o.onProgress?.(t('本机生成中（{name}，{w}×{h}）…', { name: wf.name, w: size.width, h: size.height }))
    for (;;) {
      if (signal.aborted) throw new Error(t('已停止'))
      await new Promise((r) => setTimeout(r, 1000))
      const h = (await fetch(`${url}/history/${id}`, { signal })
        .then((r) => r.json())
        .catch(() => ({}))) as Record<string, ComfyHistory>
      const entry = h[id]
      if (!entry) {
        if (!(await alive(url))) throw new Error(t('ComfyUI 意外退出了：{log}', { log: comfyLog().slice(-800) }))
        continue
      }
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find((x) => x[0] === 'execution_error')?.[1] as
          | { exception_message?: string; node_type?: string }
          | undefined
        throw new Error(
          t('本机生成失败：{error}', { error: `${err?.node_type ?? ''} ${err?.exception_message ?? ''}`.trim() }),
        )
      }
      if (!entry.status?.completed) continue
      const images = Object.values(entry.outputs ?? {}).flatMap((x) => x.images ?? [])
      for (const img of images) {
        const q = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder ?? '',
          type: img.type ?? 'output',
        })
        const r = await fetch(`${url}/view?${q}`, { signal })
        if (r.ok) o.onImage(Buffer.from(await r.arrayBuffer()))
      }
      if (!images.length) throw new Error(t('本机生成没有输出图片'))
      return
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

interface ComfyHistory {
  status?: { status_str?: string; completed?: boolean; messages?: [string, unknown][] }
  outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>
}

/** ComfyUI 里装了哪些节点（在跑时才拿得到），AI 写工作流和检查时用 */
async function nodeTypes(): Promise<Map<string, unknown> | undefined> {
  const url = await baseUrl()
  if (!(await alive(url))) return undefined
  try {
    const r = await fetch(`${url}/object_info`, { signal: AbortSignal.timeout(15000) })
    return new Map(Object.entries((await r.json()) as Record<string, unknown>))
  } catch {
    return undefined
  }
}

/** 节点的输入定义压成一行，给 AI 看（只给可能用到的节点，全部太长） */
function nodeBrief(info: Map<string, unknown>, used: Set<string>) {
  const pick = [...info.keys()].filter(
    (k) =>
      used.has(k) ||
      /Loader|Latent|KSampler|Sampler|Scheduler|Guider|Noise|CLIPTextEncode|VAE|SaveImage|ModelSampling|Lora|Upscale|ImageScale|Conditioning|ControlNet|Flux|Image(Blend|Sharpen|Invert|Composite)/.test(
        k,
      ),
  )
  return pick
    .slice(0, 160)
    .map((k) => {
      const req = (info.get(k) as { input?: { required?: Record<string, unknown[]> } })?.input?.required ?? {}
      const args = Object.entries(req).map(([n, d]) => {
        const type = Array.isArray(d?.[0]) ? `[${(d[0] as unknown[]).slice(0, 12).join('|')}]` : String(d?.[0])
        return `${n}:${type}`
      })
      return `- ${k}(${args.join(', ')})`
    })
    .join('\n')
}

/**
 * AI 生成或优化工作流：交给「AI 创建」用的 CLI，按格式输出接口格式的 JSON，检查通过才返回；
 * 不通过时把问题告诉它再改一次
 */
export async function assistWorkflow(
  input: { kind: 'game' | 'web'; instruction: string; base?: ComfyWorkflow },
  signal: AbortSignal,
): Promise<{ workflow: ComfyWorkflow; note: string }> {
  const settings = await getSettings()
  const cli = settings.assist.cli && getCli(settings.assist.cli) ? settings.assist.cli : defaultCli(settings)
  const def = getCli(cli)!
  const cs = cliSettings(settings, cli)
  const run = agentRun({ cli, model: settings.assist.model || '@high' }, settings)
  const info = await nodeTypes()
  const files = await downloadedFiles()
  const models = LOCAL_FILES.filter((f) => files.includes(f.id)).map((f) => `${f.dir}/${f.file}`)
  const example = input.base ?? BUILTIN_WORKFLOWS.find((w) => w.kind === input.kind)!
  const cwd = path.join(tmpdir(), 'agent-panel-comfy')
  await mkdir(cwd, { recursive: true })
  let feedback = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = `你是 ComfyUI 工作流专家。${input.base ? '请按要求优化下面这个工作流' : '请写一个新的 ComfyUI 工作流'}，用于给${input.kind === 'web' ? '网页' : '游戏 UI'}生成图片资源。

用户的要求：
${input.instruction}

格式要求：
- 输出 ComfyUI 的接口格式（API format）JSON：{ "节点id": { "class_type": "...", "inputs": { ... } } }，连线写成 ["节点id", 输出序号]。
- 参数用占位符：正向描述写 "{{prompt}}"，反向描述写 "{{negative}}"（可以在前后加固定的英文要求），宽、高、张数、随机种子分别写成 "{{width}}"、"{{height}}"、"{{count}}"、"{{seed}}"（整个值就是占位符）。
- 必须有 SaveImage 节点输出图片。
- 只用下面列出的节点和已经下载的模型文件${info ? '' : '（ComfyUI 没在运行，拿不到完整的节点列表；只用 ComfyUI 自带的核心节点）'}。
- 先用一两句话说明你的思路和改动，再给一个 \`\`\`json 代码块，里面是：{ "name": "工作流名称", "use": "icon|button|panel|background|concept|illustration|any 之一", "model": "用到的内置模型 id（${LOCAL_MODELS.map((m) => m.id).join('、')}，用别的模型留空）", "description": "一句话说明用在哪里", "extra": "加在描述后面的英文要求，可以为空", "graph": { ... } }

已下载的模型文件：
${models.join('\n') || '（还没有下载模型）'}

${info ? `可用的节点（输入名:类型）：\n${nodeBrief(info, new Set(Object.values(example.graph).map((n) => n.class_type)))}` : ''}

${input.base ? '要优化的工作流' : '参考（内置的工作流）'}：
\`\`\`json
${JSON.stringify({ name: example.name, use: example.use, model: example.model, description: example.description, extra: example.extra, graph: example.graph }, null, 1)}
\`\`\`
${feedback ? `\n上一次的结果有问题，请修正：\n${feedback}` : ''}`
    let text = ''
    const errors: string[] = []
    const r = await invokeCli({
      cliId: cli,
      command: cs.command,
      build: { model: run.model, effort: run.effort, permission: cs.permission, extraArgs: cs.extraArgs },
      cwd,
      env: childEnv(cs.env),
      input: prompt,
      signal,
      timeoutMs: 0,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') text += ev.text
        else if (ev.type === 'text') text += `\n${ev.text}`
        else if (ev.type === 'error') errors.push(ev.message)
      },
    })
    if (r.killed === 'stopped') throw new Error(t('已停止'))
    if (r.spawnError) throw new Error(t('{error}。请确认已安装 {cli}', { error: r.spawnError, cli: def.name }))
    const block = /```json\s*([\s\S]*?)```/.exec(text)?.[1]
    if (!block) {
      feedback = t('没有找到 json 代码块')
      if (errors.length) feedback += `：${errors.join('；')}`
      continue
    }
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(block)
    } catch (e) {
      feedback = `JSON 解析失败：${(e as Error).message}`
      continue
    }
    const parsed = ComfyWorkflow.safeParse({
      ...raw,
      id: input.base && !input.base.builtin ? input.base.id : `wf_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      updatedAt: new Date().toISOString(),
    })
    if (!parsed.success) {
      feedback = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
      continue
    }
    const problems = checkWorkflow(parsed.data.graph, info ? new Set(info.keys()) : undefined)
    if (problems.length) {
      feedback = problems.join('\n')
      continue
    }
    return { workflow: { ...parsed.data, builtin: undefined }, note: text.split('```')[0].trim() }
  }
  throw new Error(t('AI 没有给出能用的工作流：{error}', { error: feedback }))
}

export function comfyApi() {
  const routes = new Hono()
  const wrap = (fn: () => unknown) => async (c: import('hono').Context) => {
    try {
      return c.json((await fn()) ?? (await localStatus()))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  routes.get('/status', wrap(localStatus))
  routes.post(
    '/install',
    wrap(() => void installComfy()),
  )
  routes.post(
    '/cancel',
    wrap(() => void cancelJob()),
  )
  routes.post(
    '/start',
    wrap(async () => void (await startComfy())),
  )
  routes.post(
    '/stop',
    wrap(() => void stopComfy()),
  )
  routes.post('/models/:id/download', (c) => wrap(() => void downloadModel(c.req.param('id')))(c))
  routes.delete('/models/:id', (c) => wrap(() => removeModel(c.req.param('id')).then(() => undefined))(c))
  routes.get('/workflows', async (c) => {
    const list = await allWorkflows()
    const ready: string[] = []
    for (const w of list) if (await workflowReady(w)) ready.push(w.id)
    return c.json({ list, ready })
  })
  routes.put('/workflows/:id', async (c) => {
    const id = c.req.param('id')
    if (BUILTIN_WORKFLOWS.some((w) => w.id === id))
      return c.json({ error: t('内置的工作流不能修改，请先复制一份') }, 400)
    const p = ComfyWorkflow.safeParse({ ...(await c.req.json()), id, updatedAt: new Date().toISOString() })
    if (!p.success)
      return c.json({ error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') }, 400)
    const problems = checkWorkflow(p.data.graph)
    if (problems.length) return c.json({ error: problems.join('；') }, 400)
    const wf = { ...p.data, builtin: undefined }
    await saveWorkflows((l) => (l.some((w) => w.id === id) ? l.map((w) => (w.id === id ? wf : w)) : [...l, wf]))
    return c.json(wf)
  })
  routes.delete('/workflows/:id', async (c) => {
    const id = c.req.param('id')
    await saveWorkflows((l) => l.filter((w) => w.id !== id))
    return c.json({ ok: true })
  })
  routes.post('/workflows/assist', async (c) => {
    const body = (await c.req.json()) as { kind?: string; instruction?: string; base?: unknown }
    const base = body.base ? ComfyWorkflow.safeParse(body.base) : undefined
    if (!body.instruction?.trim()) return c.json({ error: t('请写下要求') }, 400)
    try {
      return c.json(
        await assistWorkflow(
          {
            kind: body.kind === 'web' ? 'web' : 'game',
            instruction: body.instruction.trim(),
            base: base?.success ? base.data : undefined,
          },
          c.req.raw.signal,
        ),
      )
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  // 重新检测 Python 和显卡（装好 Python、换了驱动之后）
  routes.post(
    '/detect',
    wrap(() => void ((python = undefined), (gpuInfo = undefined))),
  )
  return routes
}
