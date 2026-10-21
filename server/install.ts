import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { getCli } from '../shared/clis.ts'
import type { CliInstallJob, CliStatus, CliUpdate } from '../shared/schema.ts'
import { detectClis, invalidateClis } from './detect.ts'
import { invalidateModels } from './models.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'
import { brewName, claudeNative, NPM, npmCommandPath } from './cli-source.ts'
import { getSettings, saveSettings } from './settings.ts'
import { cliSettings } from '../shared/settings.ts'
import { rm } from 'node:fs/promises'
import { t } from '../shared/i18n.ts'

const TIMEOUT = 10 * 60_000
const isWin = process.platform === 'win32'

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
        ? t('没有权限写入安装目录。请用管理员身份打开终端运行下面的命令。')
        : t(
            '没有权限写入 npm 的全局目录。可以在终端里用 sudo 运行下面的命令，或者把 npm 的全局目录改到自己的用户目录下。',
          )
    if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(log))
      return t('连不上 npm 仓库，请检查网络或代理（可以在终端里设置 npm 镜像）后重试。')
    return job.action === 'install' ? t('安装失败，详细信息见下面的输出。') : t('卸载失败，详细信息见下面的输出。')
  }

  /** 按安装方式决定执行什么：没装时用 npm 安装；已经装了就用它原来的方式更新或卸载 */
  function plan(
    job: CliInstallJob,
    pkg: string,
    before?: CliStatus,
  ):
    | { command: string; args: string[]; text: string; pre?: { command: string; args: string[]; text: string }[] }
    | 'native-remove' {
    const npm = (args: string[]) => ({
      command: NPM,
      // npm 默认在下载完之前什么都不输出，http 级别的日志能让页面看到它在下载
      args: [...args, '--no-fund', '--no-audit', '--loglevel=http'],
      text: `npm ${args.join(' ')}`,
    })
    const install = job.action === 'install'
    // 包改过名（例如 Pi 从 @mariozechner 搬到 @earendil-works）：两个包提供同一个命令，
    // 装新包前先卸掉旧的，否则 npm 会报 EEXIST
    const pre = install
      ? (getCli(job.cli)?.npmRenameFrom ?? []).filter((n) => n && n !== pkg).map((n) => npm(['uninstall', '-g', n]))
      : []
    const withPre = <T extends { command: string; args: string[]; text: string }>(step: T) =>
      pre.length ? { ...step, pre } : step
    if (!before?.installed) return withPre(npm(install ? ['install', '-g', `${pkg}@latest`] : ['uninstall', '-g', pkg]))
    if (before.source === 'native' && before.path)
      return install ? { command: before.path, args: ['update'], text: 'claude update' } : 'native-remove'
    if (before.source === 'brew') {
      const name = brewName(job.cli)
      const args = [install ? 'upgrade' : 'uninstall', ...name]
      return { command: 'brew', args, text: `brew ${args.join(' ')}` }
    }
    return withPre(npm(install ? ['install', '-g', `${pkg}@latest`] : ['uninstall', '-g', pkg]))
  }

  async function run(job: CliInstallJob, pkg: string) {
    const append = (t: string) => {
      job.log = (job.log + t).slice(-12000)
    }
    const before = (await detectClis(true)).find((c) => c.id === job.cli)
    job.update = job.action === 'install' && !!before?.installed
    const how = plan(job, pkg, before)
    let r: { spawnError?: string; killed?: string | null; code: number | null }
    if (how === 'native-remove') {
      // 官方安装脚本装的 Claude Code：删掉命令和版本文件（登录信息和 ~/.claude 里的配置不动）
      const n = claudeNative()
      job.command = isWin
        ? t('del "{bin}" 并删除 "{data}"', { bin: n.bin, data: n.data })
        : `rm -f ${n.bin} && rm -rf ${n.data}`
      try {
        await rm(n.bin, { force: true })
        await rm(n.data, { recursive: true, force: true })
        append(t('已删除') + '\n')
        r = { code: 0 }
      } catch (e) {
        append(`${(e as Error).message}\n`)
        r = { code: 1 }
      }
    } else {
      job.command = how.text
      // 先卸掉改名前的旧包；卸不掉也不拦着，npm 装新包时会再报具体原因
      for (const step of how.pre ?? []) {
        append(`$ ${step.text}\n`)
        await runProcess({
          command: step.command,
          args: step.args,
          cwd: homedir(),
          env: childEnv([]),
          timeoutMs: TIMEOUT,
          onLine: (l) => append(l + '\n'),
          onStderr: append,
        })
      }
      r = await runProcess({
        command: how.command,
        args: how.args,
        cwd: homedir(),
        env: childEnv([]),
        timeoutMs: TIMEOUT,
        onLine: (l) => append(l + '\n'),
        onStderr: append,
      })
    }
    invalidateClis()
    invalidateModels(job.cli)
    latest.delete(job.cli)
    let status = (await detectClis(true)).find((c) => c.id === job.cli)
    // npm 装好了新版本，但 PATH 里先找到的是别处装的旧版本：改用 npm 里的这个，否则更新了等于没更新
    if (
      job.action === 'install' &&
      how !== 'native-remove' &&
      how.command === NPM &&
      r.code === 0 &&
      status?.installed &&
      status.source !== 'npm'
    ) {
      const npmPath = await npmCommandPath(status.command)
      const v = npmPath ? await capture(npmPath, ['--version'], homedir(), childEnv([]), 10_000) : undefined
      if (npmPath && v?.code === 0 && newer(v.stdout, status.version)) {
        const settings = await getSettings()
        const cs = cliSettings(settings, job.cli)
        await saveSettings({ ...settings, clis: { ...settings.clis, [job.cli]: { ...cs, command: npmPath } } })
        job.note = t('PATH 里先找到的是 {path}（{version}），已改用 npm 安装的 {npm}。', {
          path: status.path ?? status.command,
          version: semver(status.version)?.join('.') ?? t('旧版本'),
          npm: npmPath,
        })
        invalidateClis()
        status = (await detectClis(true)).find((c) => c.id === job.cli)
      }
    }
    job.cliStatus = status
    if (r.spawnError) {
      job.status = 'failed'
      job.error =
        how !== 'native-remove' && how.command === 'brew'
          ? t('没有找到 brew。')
          : t('没有找到 npm。请先安装 Node.js（https://nodejs.org），它自带 npm。')
    } else if (r.killed === 'timeout') {
      job.status = 'failed'
      job.error = t('超过 10 分钟还没有完成，已停止。可以复制下面的命令到终端里运行。')
    } else if (r.code !== 0) {
      job.status = 'failed'
      job.error = hint(job, job.log)
    } else if (job.action === 'uninstall' && status?.installed) {
      job.status = 'failed'
      job.error = t(
        '已经执行了卸载，但还能找到 {path}。它不是 npm 、Homebrew 或官方安装脚本装的，请手动删除这个文件，或用安装它的方式卸载。',
        { path: status.path ?? status.command },
      )
    } else if (job.action === 'install' && !status?.installed) {
      job.status = 'failed'
      job.error = t(
        '安装完成，但还找不到「{command}」。可能需要重新打开终端或重启本服务让 PATH 生效，或者在下面填写可执行文件的完整路径。',
        { command: status?.command ?? pkg },
      )
    } else if (
      job.action === 'install' &&
      before?.installed &&
      semver(status?.version)?.join('.') === semver(before.version)?.join('.') &&
      !job.note
    ) {
      // 更新命令成功了，版本却没变：多半是 PATH 里还有另一个旧的
      const now = await capture(NPM, ['view', pkg, 'version'], homedir(), childEnv([]), 20_000)
      const v = now.stdout.trim().split('\n').at(-1)?.trim()
      if (v && newer(v, status?.version)) {
        job.status = 'failed'
        job.error = t(
          '更新命令执行完了，但运行的 {path} 还是 {version}。可能还有另一份旧的装在别处，请在下面的「可执行文件」里填新版本的完整路径。',
          { path: status?.path ?? status?.command ?? '', version: semver(status?.version)?.join('.') ?? '' },
        )
      } else job.status = 'done'
    } else job.status = 'done'
  }

  routes.post('/:id/:action{install|uninstall}', (c) => {
    const def = getCli(c.req.param('id'))
    if (!def) return c.json({ error: t('未知的 Agent') }, 404)
    const action = c.req.param('action') as CliInstallJob['action']
    if ([...jobs.values()].some((j) => j.status === 'running'))
      return c.json({ error: t('有一个安装 / 卸载还在进行，请等它完成') }, 409)
    const job: CliInstallJob = {
      id: randomUUID(),
      cli: def.id,
      action,
      status: 'running',
      // 实际的命令在开始执行时按安装方式确定
      command: action === 'install' ? `npm install -g ${def.npmPackage}@latest` : `npm uninstall -g ${def.npmPackage}`,
      log: '',
    }
    // 页面只用每个 CLI 最近一次的记录，这个 CLI 以前结束的记录可以丢掉，免得一直攒在内存里
    for (const [id, j] of jobs) if (j.cli === def.id && j.status !== 'running') jobs.delete(id)
    jobs.set(job.id, job)
    void run(job, def.npmPackage).catch((e) => {
      job.status = 'failed'
      job.error = (e as Error).message
    })
    return c.json(job, 202)
  })

  routes.get('/:id/update', async (c) => {
    const def = getCli(c.req.param('id'))
    if (!def) return c.json({ error: t('未知的 Agent') }, 404)
    const status = (await detectClis()).find((x) => x.id === def.id)
    let hit = latest.get(def.id)
    if (!hit || c.req.query('refresh') === '1' || Date.now() - hit.at > 30 * 60_000) {
      const r = await capture(NPM, ['view', def.npmPackage, 'version'], homedir(), childEnv([]), 20_000)
      const v = r.stdout.trim().split('\n').at(-1)?.trim()
      hit = semver(v)
        ? { at: Date.now(), version: v }
        : { at: Date.now(), error: r.spawnError ?? (r.stderr.trim().split('\n').at(-1) || t('查不到最新版本')) }
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
    return job ? c.json(job) : c.json({ error: t('没有这个操作') }, 404)
  })

  return routes
}
