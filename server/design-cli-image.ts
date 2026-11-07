import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getCli } from '../shared/clis.ts'
import { t } from '../shared/i18n.ts'
import { agentRun, cliSettings } from '../shared/settings.ts'
import { askSession } from './asks.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { getSettings } from './settings.ts'

/**
 * 设计页用图片 CLI 出图（从 designs.ts 拆出来）：设计对话的切图、原画、拆件图都走这里。
 * 用设置里的图片 CLI（Codex 的 image_gen）生成：每生成一张就交给 onImage
 */
export async function cliGenerate(
  prompt: string,
  count: number,
  /** 只用到停止、审批归属和输出字数：照原画还原出拆件图时没有设计对话的 Job，传这三样就行 */
  job: { abort: AbortController; scope: string; outChars: number },
  onImage: (b: Buffer) => void,
  /** 一起交给模型的参考图（原画模板、要在它基础上改的原画） */
  refs: string[] = [],
): Promise<Buffer[]> {
  const settings = await getSettings()
  const cliId = settings.imageGen.cli || 'codex'
  const def = getCli(cliId)
  if (!def?.images)
    throw new Error(t('{cli} 不能生成图片，请在设置的「默认 Agent」里换成 Codex', { cli: def?.name ?? cliId }))
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) throw new Error(t('{cli} 在设置里被停用了', { cli: def.name }))
  const run = agentRun(
    { cli: cliId, model: settings.imageGen.model || '@high', effort: settings.imageGen.effort },
    settings,
  )
  const cwd = path.join(tmpdir(), 'agent-panel-images')
  await mkdir(cwd, { recursive: true })
  let got = 0
  // 模型有时会多画几张：最多收 count 张，多的不要，不然进度会出现「4/3」
  // 图片文件可能还没写完，读到了再交出去；最后等所有读取结束
  const reads: Promise<void>[] = []
  const errors: string[] = []
  let result: { ok: boolean; error?: string } | undefined
  const asks = askSession(job.scope, () => job.abort.abort())
  const r = await invokeCli({
    askUser: asks.askUser,
    onAsk: asks.onAsk,
    cliId,
    command: cs.command,
    build: {
      model: run.model,
      effort: run.effort,
      // 审批按设置里的权限：CLI 要确认时弹出卡片等用户
      permission: cs.permission,
      extraArgs: cs.extraArgs,
    },
    cwd,
    env: childEnv(cs.env),
    input: `请用内置的 image_gen 工具生成 ${count} 张图片（每张单独调用一次 image_gen，内容一样、细节可以不同；正好 ${count} 张，不要多画）。不要写代码、不要运行命令、不要另存文件，生成完直接结束，不用解释。${refs.length ? '\n附上的图片是参考图，按下面的要求参考它。' : ''}

图片要求：
${prompt}`,
    images: refs.length ? refs : undefined,
    signal: job.abort.signal,
    // 不限时长，用户随时可以停止
    timeoutMs: 0,
    onEvent: (ev) => {
      if (ev.type === 'image') {
        if (ev.failed) errors.push(ev.failed)
        else if (ev.path || ev.data) {
          const b64 = ev.data ? Buffer.from(ev.data, 'base64') : null
          const read = ev.path ? readFile(ev.path).catch(() => b64) : Promise.resolve(b64)
          reads.push(
            read.then((b) => {
              if (!b?.length || got >= count) return
              got++
              onImage(b)
            }),
          )
        }
      } else if (ev.type === 'error') errors.push(ev.message)
      else if (ev.type === 'result') result = ev
      else if (ev.type === 'text_delta' || ev.type === 'text') job.outChars += ev.text.length
    },
  }).finally(asks.done)
  await Promise.all(reads)
  if (r.killed === 'stopped') throw new Error(t('已停止'))
  if (r.spawnError) throw new Error(t('{error}。请确认已安装 {cli}', { error: r.spawnError, cli: def.name }))
  if (!got)
    throw new Error(
      [
        t('{cli} 没有生成图片', { cli: def.name }),
        result?.error,
        ...errors,
        r.stderr.trim().split('\n').slice(-3).join('\n'),
      ]
        .filter(Boolean)
        .join('：'),
    )
  return []
}
