import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractJson } from '../../shared/assist.ts'
import { getCli } from '../../shared/clis.ts'
import {
  EXPERIENCE_KINDS,
  EXPERIENCE_SCOPE,
  type ExperienceKind,
  type ExperienceSettings,
  type ProjectExperience,
} from '../../shared/experience.ts'
import { t } from '../../shared/i18n.ts'
import type { Agent, Settings, Task } from '../../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import { withTaskModel } from '../../shared/tasks/run.ts'
import { invokeCli } from '../exec/invoke.ts'
import { childEnv } from '../exec/process.ts'

/**
 * 经验的两次模型调用：对话完成后的提炼、项目设置里的 AI 评审。都是一次性的调用：不开对话、不读项目，
 * 只把面板整理好的事实交给模型，拿回一个 JSON 代码块。用哪个 CLI / 模型：设置 →「经验」里指定的，
 * 没指定时跟随这个对话的 Agent（评审时跟随默认 Agent）。
 */

const TIMEOUT = 3 * 60_000

/** 这次用哪个 CLI、哪个模型：设置里写了用设置的，否则跟随对话的 Agent，再不行用默认 CLI */
export function experienceRun(
  exp: ExperienceSettings,
  settings: Settings,
  agent?: Pick<Agent, 'id' | 'cli' | 'model' | 'effort'>,
  task?: Pick<Task, 'mode' | 'agentId' | 'cli' | 'model' | 'effort' | 'sessionCli'>,
) {
  if (exp.cli || exp.model) {
    const cli = exp.cli || (agent ? agentRun(agent, settings).cli : defaultCli(settings))
    return agentRun({ cli, model: exp.model, effort: '' }, settings)
  }
  if (agent) return agentRun(task ? withTaskModel(agent, task) : agent, settings)
  return agentRun({ cli: defaultCli(settings), model: '', effort: '' }, settings)
}

/** 调一次模型拿回文字：出错时返回 error（调用方显示给用户，不悄悄重试） */
export async function askOnce(
  run: { cli: string; model: string; effort: string },
  settings: Settings,
  input: string,
  signal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
  const def = getCli(run.cli)
  if (!def) return { text: '', error: t('找不到 Agent：{cli}', { cli: run.cli }) }
  const cs = cliSettings(settings, run.cli)
  // 在空的临时目录里跑、用只读权限：提炼和评审只看交给它的文字，碰不到项目文件
  const cwd = path.join(tmpdir(), 'agent-panel-experience')
  await mkdir(cwd, { recursive: true })
  let text = ''
  const errors: string[] = []
  let result: { ok: boolean; error?: string } | undefined
  const r = await invokeCli({
    cliId: run.cli,
    command: cs.command,
    build: {
      model: run.model,
      effort: run.effort,
      permission: def.readOnly || cs.permission,
      extraArgs: cs.extraArgs,
    },
    cwd,
    env: childEnv(cs.env),
    input,
    signal,
    timeoutMs: TIMEOUT,
    noAskTool: true,
    onEvent: (ev) => {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
      else if (ev.type === 'error') errors.push(ev.message)
      else if (ev.type === 'result') result = ev
    },
  })
  if (r.killed === 'timeout') return { text, error: t('超过 3 分钟没有完成，已停止') }
  if (r.killed === 'stopped') return { text, error: t('已停止') }
  if (r.spawnError) return { text, error: r.spawnError }
  if (result ? !result.ok : r.code !== 0)
    return { text, error: result?.error || errors.join('\n') || t('{cli} 执行失败', { cli: def.name }) }
  return { text }
}

export interface LearnedItem {
  op: 'add' | 'update'
  id: string
  kind: ExperienceKind
  title: string
  body: string
  keywords: string[]
  paths: string[]
}

const strList = (v: unknown) =>
  Array.isArray(v)
    ? v
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .slice(0, 10)
    : []

/** 模型回的 JSON 换成条目：字段不对的丢掉，交给调用方再按规矩校验 */
export function parseLearned(text: string): { items: LearnedItem[]; error?: string } {
  const j = extractJson(text)
  if (j.error) return { items: [], error: j.error }
  const raw = (j.json as { items?: unknown })?.items
  if (!Array.isArray(raw)) return { items: [], error: t('JSON 里没有 items 数组') }
  const items: LearnedItem[] = []
  for (const x of raw as Record<string, unknown>[]) {
    const kind = String(x?.kind ?? '') as ExperienceKind
    const title = String(x?.title ?? '').trim()
    if (!title || !EXPERIENCE_KINDS.includes(kind)) continue
    items.push({
      op: x?.op === 'update' ? 'update' : 'add',
      id: String(x?.id ?? '').trim(),
      kind,
      title,
      body: String(x?.body ?? '').trim(),
      keywords: strList(x?.keywords),
      paths: strList(x?.paths),
    })
  }
  return { items: items.slice(0, 2) }
}

const brief = (e: ProjectExperience) =>
  `- id: ${e.id}｜${e.kind}｜${e.title}｜关键词：${e.keywords.join('、')}｜位置：${e.paths.join('、') || '无'}`

/** 提炼的提示词：事实摘要 + 落点附近的目录 + 和这次有重合的已有经验 */
export function learnPrompt(o: { request: string; digest: string; tree: string; related: ProjectExperience[] }) {
  return `你在帮一个代码项目积累「经验」：下次同类请求能少走弯路的捷径。下面是一次已经完成的对话里，Agent 实际的工具调用摘要（面板统计的事实）。
判断这次有没有值得记的经验，有就最多写 2 条；没有就输出空数组。不要用任何工具，不要读文件，只根据下面的内容回答。

${EXPERIENCE_SCOPE}

## 用户这次的需求（开头部分）
${o.request || '（没有）'}

## 工具调用摘要
${o.digest}

## 落点目录附近的结构
${o.tree || '（没有）'}

## 已有的、可能相关的经验
${o.related.length ? o.related.map(brief).join('\n') : '（没有）'}
已有经验说的是同一件事时用 op: "update" 并填它的 id（补充关键词、修正位置）；不要重复新加。

## 输出
只输出一个 JSON 代码块：
\`\`\`json
{"items": [{"op": "add", "id": "", "kind": "locate", "title": "表格相关的代码和配置在哪", "body": "每张表一个 FXxxRow，注册在 TableRegistry.cpp；数据在 Content/DataTables/。", "keywords": ["表格", "配表", "DataTable"], "paths": ["Source/Game/Table/", "Content/DataTables/"]}]}
\`\`\`
kind 只能是 ${EXPERIENCE_KINDS.join(' / ')}。paths 写相对项目根的目录或 glob（命令类写命令本身），必须是摘要里出现过的。`
}

export interface ReviewVerdict {
  id: string
  /** keep 符合；delete 不该记；trim 该记但写得太细，给出精简后的写法 */
  verdict: 'keep' | 'delete' | 'trim'
  why: string
  title?: string
  body?: string
}

export function reviewPrompt(items: ProjectExperience[], missing: Map<string, string[]>) {
  return `下面是一个代码项目里积累的「经验」条目，按规矩逐条判断：符合的 keep；不该记的 delete；该记但写得太细、太长的 trim（给出精简后的标题和说明）。
不要用任何工具，只根据下面的内容判断。路径不存在（面板已经核对过，标在条目后面）的一般该 delete。

${EXPERIENCE_SCOPE}

## 条目
${items
  .map((e) => {
    const gone = missing.get(e.id) ?? []
    return `### id: ${e.id}（${e.kind}）\n标题：${e.title}\n说明：${e.body || '（无）'}\n关键词：${e.keywords.join('、')}\n位置：${e.paths.join('、') || '无'}${gone.length ? `\n面板核对：这些路径已经不存在 ${gone.join('、')}` : ''}`
  })
  .join('\n\n')}

## 输出
只输出一个 JSON 代码块，每条一项，why 一句话写依据：
\`\`\`json
{"verdicts": [{"id": "e1", "verdict": "keep", "why": "目录级的位置，下次找表格能直接用"}, {"id": "e2", "verdict": "trim", "why": "列了具体行号", "title": "…", "body": "…"}]}
\`\`\``
}

export function parseReview(text: string, ids: Set<string>): { verdicts: ReviewVerdict[]; error?: string } {
  const j = extractJson(text)
  if (j.error) return { verdicts: [], error: j.error }
  const raw = (j.json as { verdicts?: unknown })?.verdicts
  if (!Array.isArray(raw)) return { verdicts: [], error: t('JSON 里没有 verdicts 数组') }
  const out: ReviewVerdict[] = []
  for (const x of raw as Record<string, unknown>[]) {
    const id = String(x?.id ?? '').trim()
    const v = String(x?.verdict ?? '')
    if (!ids.has(id) || !['keep', 'delete', 'trim'].includes(v)) continue
    out.push({
      id,
      verdict: v as ReviewVerdict['verdict'],
      why: String(x?.why ?? '')
        .trim()
        .slice(0, 300),
      ...(v === 'trim' && { title: String(x?.title ?? '').trim(), body: String(x?.body ?? '').trim() }),
    })
  }
  return { verdicts: out }
}
