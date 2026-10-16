import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { getCli } from '../shared/clis.ts'
import type { CliInstallJob, CliUpdate } from '../shared/schema.ts'
import { detectClis, invalidateClis } from './detect.ts'
import { invalidateModels } from './models.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'

const TIMEOUT = 10 * 60_000
const isWin = process.platform === 'win32'
// 测试时换成假的 npm
const NPM = process.env.AGENT_PANEL_NPM || 'npm'

/**
 * 设置里的「安装 / 更新 / 卸载」：用 npm 全局安装或卸载 CLI 的官方包。
 * 命令和包名都是固定的，不拼接用户输入。npm 的输出实时记下来给页面显示。
 */
/** 版本号里取出 x.y.z，例如「2.1.301 (Claude Code)」「codex-cli 0.163.0」 */
export const semver = (s?: string) =>
  /(\d+)\.(\d+)\.(\d+)/
    .exec(s ?? '')
    ?.slice(1)
    .map(Number)
export const newer = (a?: string, b?: string) => {
  const x = semver(a)
  const y = semver(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

export function installApi() {
  const jobs = new Map<string, CliInstallJob>()
  // npm 上的最新版本，缓存 30 分钟；装完、点「重新检测」时重新查
  const latest = new Map<string, { at: number; version?: string; error?: string }>()
  const routes = new Hono()

  const hint = (job: CliInstallJob, log: string) => {
    if (/EACCES|permission denied|EPERM/i.test(log))
      return isWin
        ? '没有权限写入 npm 的全局目录。请用管理员身份打开终端运行下面的命令。'
        : '没有权限写入 npm 的全局目录。可以在终端里用 sudo 运行下面的命令，或者把 npm 的全局目录改到自己的用户目录下。'
    if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(log))
      return '连不上 npm 仓库，请检查网络或代理（可以在终端里设置 npm 镜像）后重试。'
    return job.action === 'install' ? '安装失败，详细信息见下面的输出。' : '卸载失败，详细信息见下面的输出。'
  }

  async function run(job: CliInstallJob, pkg: string) {
    const append = (t: string) => {
      job.log = (job.log + t).slice(-12000)
    }
    const args = job.action === 'install' ? ['install', '-g', `${pkg}@latest`] : ['uninstall', '-g', pkg]
    const r = await runProcess({
      command: NPM,
      // npm 默认在下载完之前什么都不输出，http 级别的日志能让页面看到它在下载
      args: [...args, '--no-fund', '--no-audit', '--loglevel=http'],
      cwd: homedir(),
      env: childEnv([]),
      timeoutMs: TIMEOUT,
      onLine: (l) => append(l + '\n'),
      onStderr: append,
    })
    invalidateClis()
    invalidateModels(job.cli)
    latest.delete(job.cli)
    const status = (await detectClis(true)).find((c) => c.id === job.cli)
    job.cliStatus = status
    if (r.spawnError) {
      job.status = 'failed'
      job.error = '没有找到 npm。请先安装 Node.js（https://nodejs.org），它自带 npm。'
    } else if (r.killed === 'timeout') {
      job.status = 'failed'
      job.error = '超过 10 分钟还没有完成，已停止。可以复制下面的命令到终端里运行。'
    } else if (r.code !== 0) {
      job.status = 'failed'
      job.error = hint(job, job.log)
    } else if (job.action === 'uninstall' && status?.installed) {
      // npm 卸载成功但命令还在：多半是用官方安装脚本、Homebrew 等其他方式装的
      job.status = 'failed'
      job.error = `npm 里的包已经移除，但还能找到「${status.command}」，它可能是用其他方式安装的（官方安装脚本、Homebrew 等），请用对应的方式卸载。`
    } else if (job.action === 'install' && !status?.installed) {
      job.status = 'failed'
      job.error = `安装完成，但还找不到「${status?.command ?? pkg}」。可能需要重新打开终端或重启本服务让 PATH 生效，或者在下面填写可执行文件的完整路径。`
    } else job.status = 'done'
  }

  routes.post('/:id/:action{install|uninstall}', (c) => {
    const def = getCli(c.req.param('id'))
    if (!def) return c.json({ error: '未知的 CLI' }, 404)
    const action = c.req.param('action') as CliInstallJob['action']
    if ([...jobs.values()].some((j) => j.status === 'running'))
      return c.json({ error: '有一个安装 / 卸载还在进行，请等它完成' }, 409)
    const job: CliInstallJob = {
      id: randomUUID(),
      cli: def.id,
      action,
      status: 'running',
      command: action === 'install' ? `npm install -g ${def.npmPackage}@latest` : `npm uninstall -g ${def.npmPackage}`,
      log: '',
    }
    jobs.set(job.id, job)
    void run(job, def.npmPackage).catch((e) => {
      job.status = 'failed'
      job.error = (e as Error).message
    })
    return c.json(job, 202)
  })

  routes.get('/:id/update', async (c) => {
    const def = getCli(c.req.param('id'))
    if (!def) return c.json({ error: '未知的 CLI' }, 404)
    const status = (await detectClis()).find((x) => x.id === def.id)
    let hit = latest.get(def.id)
    if (!hit || c.req.query('refresh') === '1' || Date.now() - hit.at > 30 * 60_000) {
      const r = await capture(NPM, ['view', def.npmPackage, 'version'], homedir(), childEnv([]), 20_000)
      const v = r.stdout.trim().split('\n').at(-1)?.trim()
      hit = semver(v)
        ? { at: Date.now(), version: v }
        : { at: Date.now(), error: r.spawnError ?? (r.stderr.trim().split('\n').at(-1) || '查不到最新版本') }
      latest.set(def.id, hit)
    }
    const current = semver(status?.version)?.join('.')
    const res: CliUpdate = {
      current,
      latest: hit.version,
      available: !!status?.installed && newer(hit.version, current),
      error: hit.error,
    }
    return c.json(res)
  })

  // 每个 CLI 最近一次操作：页面切走再回来、或刷新后，用它接着显示进度
  routes.get('/jobs', (c) => {
    const latest = new Map<string, CliInstallJob>()
    for (const j of jobs.values()) latest.set(j.cli, j)
    return c.json([...latest.values()])
  })

  routes.get('/jobs/:jobId', (c) => {
    const job = jobs.get(c.req.param('jobId'))
    return job ? c.json(job) : c.json({ error: '没有这个操作' }, 404)
  })

  return routes
}
