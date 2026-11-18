/**
 * 模型目录的两种联网查询（AI 补全单个模型、联网检查新模型）共用的一次 Agent 调用：
 * 按「AI 辅助」里设置的 CLI 和模型跑，只给只读权限，不执行用户的额外参数；
 * 输出边跑边写进 job.text 给界面显示，失败时返回给用户看的原因。
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getCli } from '../../shared/clis.ts'
import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import { childEnv } from '../exec/process.ts'
import { invokeCli } from '../exec/invoke.ts'
import { getSettings } from '../settings.ts'
import { AUTO_ANSWER } from '../asks.ts'
import { t } from '../../shared/i18n.ts'

export interface CatalogAgentJob {
  /** 指定用哪个 CLI；空的用「AI 辅助」里设置的 */
  cli: string
  text: string
  abort: AbortController
}

const lookupCli = (settings: Awaited<ReturnType<typeof getSettings>>, own?: string) => {
  if (own && getCli(own)) return own
  if (settings.assist.cli && getCli(settings.assist.cli)) return settings.assist.cli
  return defaultCli(settings)
}

/** 跑完返回 undefined（输出在 job.text 里），出错返回原因 */
export async function runCatalogAgent(job: CatalogAgentJob, prompt: string, minutes: number) {
  const settings = await getSettings()
  const cli = lookupCli(settings, job.cli)
  const def = getCli(cli)
  if (!def) return t('没有可用的 Agent，请先在设置里安装并启用')
  const cs = cliSettings(settings, cli)
  if (!cs.enabled) return t('{cli} 在设置里被停用了', { cli: def.name })
  const picked = agentRun({ cli, model: settings.assist.model, effort: '' }, settings)
  // 查询只需要读网页，用一个固定的临时工作目录，不留下每次查询的目录
  const cwd = path.join(tmpdir(), 'agent-panel-model-lookup')
  await mkdir(cwd, { recursive: true })
  let errors = ''
  let failed: string | undefined
  const r = await invokeCli({
    cliId: cli,
    command: cs.command,
    build: {
      model: picked.model,
      effort: picked.effort,
      // 只读：AI 只需要联网查资料，不在用户目录里改东西
      permission: def.readOnly || cs.permission,
      extraArgs: [],
      maxTurns: cs.maxTurns || 60,
    },
    cwd,
    env: childEnv(cs.env),
    input: prompt,
    signal: job.abort.signal,
    timeoutMs: minutes * 60_000,
    askUser: () => false,
    // 查询只读资料：审批请求一律不批准，别让进程停在等用户确认上
    onAsk: (ev) => ev.reply(AUTO_ANSWER),
    onEvent: (ev) => {
      if (ev.type === 'text_delta') job.text = (job.text + ev.text).slice(-8000)
      else if (ev.type === 'text') job.text = (job.text ? `${job.text.trimEnd()}\n\n${ev.text}` : ev.text).slice(-8000)
      else if (ev.type === 'error') errors = ev.message
    },
  }).catch((e) => {
    failed = (e as Error).message
    return undefined
  })
  if (!r) return failed ?? t('已停止')
  if (r.killed === 'stopped') return t('已停止')
  if (r.killed === 'timeout') return t('超过 {n} 分钟没有完成，已停止', { n: minutes })
  if (r.spawnError)
    return t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
      error: r.spawnError,
      cli: def.name,
      hint: def.installHint,
    })
  if (r.code !== 0)
    return (
      [errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') ||
      t('{cli} 退出码 {code}', { cli: def.name, code: String(r.code) })
    )
  return undefined
}
