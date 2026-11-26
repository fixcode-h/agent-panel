/**
 * 提醒卡片上的「安装」：照定义里的做法逐个试（找得到包管理器的才试），每步跑完刷新 PATH 再找一次程序，找到就算装好。
 * 跑在后台作业里（server/jobs/registry.ts）：侧栏底部能看日志、取消；装好或失败都推回提醒卡片。
 * 和「授权」里装 CLI（server/integrations.ts）是一个思路，那边的作业有自己的状态和界面，这里只装面板自己要用的小程序
 */
import { homedir } from 'node:os'
import { localProgram } from '../../shared/local-programs/defs.ts'
import { t } from '../../shared/i18n.ts'
import { resolveCommand } from '../cli/source.ts'
import { runProcess } from '../exec/process.ts'
import { startJob } from '../jobs/registry.ts'
import { refreshWinPath } from '../win-path.ts'
import { hasCommand, offerFailed, offerInstalled, offerInstalling, offerOf, platformOf, setupSteps } from './offers.ts'

const TIMEOUT_MS = 15 * 60_000

const has = hasCommand

/** 开始装：返回出错原因（没有这个程序、没有可用做法），开始了返回 undefined */
export function installProgram(id: string): string | undefined {
  const def = localProgram(id)
  if (!def) return t('没有这个程序')
  if (offerOf(id)?.jobId) return undefined
  const steps = setupSteps(id, has)
  const hint = def.install[platformOf()]
  if (!steps.length) return [t('这台电脑上没有可用的一键安装方式，请手动安装。'), hint].filter(Boolean).join('\n')
  const stop = new AbortController()
  const job = startJob({
    source: 'panel',
    kind: 'install',
    title: t('安装 {name}', { name: def.name }),
    cancel: () => stop.abort(),
  })
  offerInstalling(id, job.id)
  void (async () => {
    const errors: string[] = []
    for (const step of steps) {
      if (job.canceled) break
      const cmd = step.join(' ')
      job.log(`> ${cmd}`)
      job.progress({ phase: cmd })
      const r = await runProcess({
        command: resolveCommand(step[0]) ?? step[0],
        args: step.slice(1),
        cwd: homedir(),
        env: process.env,
        signal: stop.signal,
        timeoutMs: TIMEOUT_MS,
        onLine: (l) => job.log(l),
        onStderr: (l) => job.log(l),
      })
      // 退出码不为 0 也可能已经装上了（winget 报「已经安装」），以找不找得到程序为准
      if (r.code !== 0) errors.push(r.spawnError || t('{method} 退出码 {code}', { method: cmd, code: String(r.code) }))
      await refreshWinPath(true).catch(() => 0)
      if (has(def.command)) {
        job.end(true)
        offerInstalled(id)
        return
      }
    }
    const error = job.canceled ? t('安装已取消') : [t('{name} 没有装上', { name: def.name }), ...errors].join('\n')
    job.end(false, error)
    offerFailed(id, error)
  })().catch((e: unknown) => {
    const error = e instanceof Error ? e.message : String(e)
    job.end(false, error)
    offerFailed(id, error)
  })
  return undefined
}
