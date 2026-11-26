/**
 * Agent 的 custom_tool（ADR 0082）在服务端的那一半：list / show / run / test / save。
 * - run / test：校验参数、展开命令 → 守卫（和 CLI 跑命令同一套）→ 按影响弹授权卡（ctool:<范围>:<id>，带「本对话不再询问」）
 *   → P4 签出 → 跑。限时不超过两分钟的在工具里等结果，更长的交给后台命令、跑完推回（ADR 0067 第 5 节）。
 * - save：弹保存弹窗（purpose 'custom-tool'），等用户选存到项目还是全局、撞了已有的更新还是另存。
 * 交给 Agent 的文字是提示词，不翻译；对话里留给人看的记录用 t()
 */
import { CustomTool, INLINE_MAX_SEC, type ToolEntry, type ToolScope } from '../../shared/custom-tools/schema.ts'
import { draftProblems, showValue } from '../../shared/custom-tools/expand.ts'
import { findDups } from '../../shared/custom-tools/dup.ts'
import { hintText, listText, runText, showText } from '../../shared/custom-tools/text.ts'
import type { CustomToolCall, CustomToolCallCtx, CustomToolsApi } from '../../shared/host/custom-tools.ts'
import { ruleAllowed } from '../../shared/allow-rules.ts'
import { presetFor } from '../../shared/grants/preset.ts'
import { t } from '../../shared/i18n.ts'
import { panelRequest, type RequestCtx } from '../exec/panel-requests.ts'
import { systemNote } from '../exec/recovery.ts'
import { execute, prepare, type Prepared } from './run.ts'
import { findTool, listTools, noteRun, saveTool } from './store.ts'

/** 自建工具授权的规则键：同一个工具（分范围）算一类 */
export const toolRule = (scope: ToolScope, id: string) => `ctool:${scope}:${id}`

/** 这个对话最近一次试跑（保存弹窗里显示）：按草稿 id 记 */
const lastTests = new Map<string, { ok: boolean; text: string; dryRun: boolean }>() // 模块状态：运行时，对话结束后没用，丢了弹窗上只是少一行试跑结果

export interface CustomToolsWhere {
  projectId?: string
  projectRoot?: string
  workDir?: string
  docRoot?: string
}

const fail = (text: string) => ({ text, error: true })

/** 这一轮的 custom_tool：清单在开始时算好（提示词要用），调用时再现读（同事刚提交的新工具也认） */
export async function customToolsFor(
  ctx: RequestCtx,
  where: CustomToolsWhere,
  own: Set<string>,
): Promise<CustomToolsApi> {
  const { entries } = await listTools(where.projectId).catch(() => ({ entries: [] as ToolEntry[] }))
  return {
    hint: hintText(entries),
    call: (req, c) => dispatch(ctx, where, own, req, c),
  }
}

async function dispatch(
  ctx: RequestCtx,
  where: CustomToolsWhere,
  own: Set<string>,
  req: CustomToolCall,
  c: CustomToolCallCtx,
): Promise<{ text: string; error?: boolean }> {
  // 卡片（保存弹窗、授权卡）跟着这次调用：CLI 断开或取消了这次调用就收掉，不留一张没人等的卡。
  // 以前只跟着这一轮，CLI 等久了断开重试时页面上叠出两张一样的保存弹窗，用户要点两次（2026-11-26）
  if (c.signal) ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, c.signal]) }
  if (req.action === 'list') return { text: listText((await listTools(where.projectId)).entries, req.query) }
  if (req.action === 'show' || req.action === 'run') {
    if (!req.id) return fail('要写 id：先用 action=list 看有哪些工具')
    const e = await findTool(where.projectId, req.id)
    if (!e?.tool) return fail(`没有 id 为 ${req.id} 的自建工具。用 action=list 看有哪些`)
    if (req.action === 'show') return { text: showText(e) }
    return runOne(ctx, where, own, e.tool, e.scope, req.args, c, false)
  }
  if (req.action === 'test') {
    const d = parseDraft(req.draft)
    if ('error' in d) return fail(d.error)
    return runOne(ctx, where, own, d.tool, 'draft', req.args, c, !!req.dryRun)
  }
  if (req.action === 'save') return save(ctx, where, own, req)
  return fail(`没有 action=${String(req.action)}：可用 list / show / run / test / save`)
}

function parseDraft(raw: Record<string, unknown> | undefined): { tool: CustomTool } | { error: string } {
  if (!raw || typeof raw !== 'object')
    return { error: 'draft 要写工具定义（id、name、run.command、params……），格式见 custom_tool 的说明' }
  const r = CustomTool.safeParse({ ...raw, version: 1, history: [] })
  if (!r.success)
    return {
      error: `草稿不对：${r.error.issues.map((i) => `${i.path.join('.') || '（整体）'} ${i.message}`).join('；')}`,
    }
  const problems = draftProblems(r.data)
  return problems.length ? { error: `草稿有问题：${problems.join('；')}` } : { tool: r.data }
}

/** 跑一次：守卫、授权、签出、执行（或交给后台） */
async function runOne(
  ctx: RequestCtx,
  where: CustomToolsWhere,
  own: Set<string>,
  tool: CustomTool,
  scope: ToolScope | 'draft',
  args: Record<string, unknown> | undefined,
  c: CustomToolCallCtx,
  dryRun: boolean,
): Promise<{ text: string; error?: boolean }> {
  const p = await prepare(tool, args, { ...where, scope })
  if (p.error) return fail(`参数不对，没有执行：${p.error}`)
  if (dryRun) {
    const text = `展开后会跑（${p.shell}，在 ${p.cwd}）：\n${p.line}`
    lastTests.set(testKey(ctx, tool.id), { ok: true, text, dryRun: true })
    return { text }
  }
  const why = c.guard ? await c.guard(p.line) : ''
  if (why) return fail(`面板的守卫拦下了这条命令，没有执行：${why}`)
  if (tool.effect !== 'read') {
    const ok = await grant(ctx, own, tool, scope, p)
    if (!ok.allow) return fail(ok.info)
  }
  const long =
    tool.run.background === 'always' || (tool.run.background === 'auto' && tool.run.timeoutSec > INLINE_MAX_SEC)
  if (long && c.background) {
    const r = await c.background({
      command: p.line,
      name: `${tool.name}（自建工具）`,
      cwd: p.cwd,
      timeoutMinutes: Math.max(1, Math.ceil(tool.run.timeoutSec / 60)),
    })
    return r.ok ? { text: `${tool.name} 跑得久，已交给后台命令：${r.info}` } : fail(r.info)
  }
  const { result } = await execute(tool, p, { projectRoot: where.workDir || where.projectRoot, signal: c.signal })
  const text = runText(tool, result)
  if (scope === 'draft') lastTests.set(testKey(ctx, tool.id), { ok: result.ok, text, dryRun: false })
  else
    noteRun(scope, tool.id, where.projectId, {
      at: new Date().toISOString(),
      ok: result.ok,
      ms: result.ms,
      summary: result.errors[0]?.msg ?? result.tail.at(-1) ?? '',
    })
  return result.ok ? { text } : fail(text)
}

/** 保存弹窗里用户能直接改的几项文字（id、名字、说明、什么时候用 / 别用）；别的字段不认 */
function textPatch(p: Record<string, unknown> | undefined) {
  const out: Record<string, string> = {}
  for (const k of ['id', 'name', 'summary', 'useWhen', 'avoidWhen'])
    if (typeof p?.[k] === 'string' && (p[k] as string).trim()) out[k] = (p[k] as string).trim()
  return out
}

const testKey = (ctx: RequestCtx, id: string) => `${ctx.task.id}:${id}`

/** 授权：工作流自带的、这个对话放行过的直接过（留一行记录），否则弹卡 */
async function grant(
  ctx: RequestCtx,
  own: Set<string>,
  tool: CustomTool,
  scope: ToolScope | 'draft',
  p: Prepared,
): Promise<{ allow: boolean; info: string }> {
  const { task } = ctx
  // 试跑草稿不记「本对话不再询问」：草稿每次可能都不一样
  const rule = scope === 'draft' ? '' : toolRule(scope, tool.id)
  const label = t('自建工具「{name}」', { name: tool.name })
  const auto = rule && (presetFor(task, rule) || ruleAllowed(task.allowRules ?? [], rule))
  if (auto) {
    task.messages.push(
      systemNote(
        ctx.newId(),
        '',
        '',
        t('按这个对话的放行规则自动允许（{rule}）：{line}', { rule: label, line: p.line }),
      ),
    )
    ctx.changed()
    return { allow: true, info: '' }
  }
  const params = Object.entries(p.values)
    .map(([k, v]) => `${tool.params.find((x) => x.name === k)?.label || k}：${showValue(v)}`)
    .join('，')
  const r = await panelRequest(
    ctx,
    {
      step: '',
      agentId: '',
      kind: 'tool',
      title:
        scope === 'draft'
          ? t('试跑还没保存的工具「{name}」？', { name: tool.name })
          : t('运行自建工具「{name}」？', { name: tool.name }),
      detail: [
        t('实际会跑的命令：\n{line}', { line: p.line }),
        params && t('参数：{params}', { params }),
        t('在 {cwd} 里跑，限时 {sec} 秒', { cwd: p.cwd, sec: tool.run.timeoutSec }),
        tool.writes.length ? t('会改（P4 项目先签出）：{files}', { files: tool.writes.join('、') }) : '',
        tool.effect === 'external' ? t('这个工具会影响外部（提交、上传、发消息这类）。') : '',
      ]
        .filter(Boolean)
        .join('\n'),
      ...(rule ? { rule, ruleLabel: label } : {}),
    },
    own,
  )
  if (!r) return { allow: false, info: '请求作废了（对话被停止，或这次调用断开了）：没有执行。' }
  if (!r.allow)
    return {
      allow: false,
      info: `用户没有允许运行${r.message ? `，说：${r.message}` : ''}。不要换成自己拼的命令去跑同样的事。`,
    }
  if (r.always && rule && !(task.allowRules ?? []).includes(rule)) task.allowRules = [...(task.allowRules ?? []), rule]
  return { allow: true, info: '' }
}

/** 保存：草稿先自查，再弹保存弹窗等用户定范围；结果原样告诉 Agent */
async function save(
  ctx: RequestCtx,
  where: CustomToolsWhere,
  own: Set<string>,
  req: CustomToolCall,
): Promise<{ text: string; error?: boolean }> {
  const d = parseDraft(req.draft)
  if ('error' in d) return fail(d.error)
  const { entries } = await listTools(where.projectId)
  const dups = findDups(d.tool, entries)
  const test = lastTests.get(testKey(ctx, d.tool.id))
  const r = await panelRequest(
    ctx,
    {
      step: '',
      agentId: '',
      kind: 'tool',
      purpose: 'custom-tool',
      title: t('保存工具「{name}」', { name: d.tool.name }),
      detail: req.note ?? '',
      customTool: {
        draft: req.draft ?? {},
        dups,
        ...(test ? { test } : {}),
        inProject: !!where.projectId,
        problems: [],
      },
    },
    own,
  )
  if (!r) return fail('保存弹窗作废了（对话被停止，或这次调用断开了）：没有保存。')
  if (!r.allow)
    return r.answer?.trim()
      ? fail(`用户要你再改一改：${r.answer.trim()}\n改好后再调一次 action=save。`)
      : fail('用户取消了保存。不用再问，告诉用户草稿内容就行。')
  let pick: { scope?: ToolScope; replace?: boolean; patch?: Record<string, unknown> } = {}
  try {
    pick = JSON.parse(r.answer ?? '{}')
  } catch {
    // 回答不是 JSON（旧页面）：按默认存项目
  }
  const scope: ToolScope = pick.scope === 'global' || !where.projectId ? 'global' : 'project'
  try {
    const saved = await saveTool({
      projectId: where.projectId,
      scope,
      draft: { ...d.tool, ...textPatch(pick.patch) },
      replace: !!pick.replace,
      by: 'Agent',
      note: req.note,
    })
    lastTests.delete(testKey(ctx, d.tool.id))
    ctx.task.messages.push(
      systemNote(
        ctx.newId(),
        '',
        '',
        t('已保存自建工具「{name}」（{scope} · v{version}）：{file}', {
          name: saved.tool!.name,
          scope: scope === 'project' ? t('项目') : t('全局'),
          version: saved.tool!.version,
          file: saved.file,
        }),
      ),
    )
    ctx.changed()
    return {
      text: `用户已保存：${saved.tool!.id}「${saved.tool!.name}」存成${scope === 'project' ? '项目工具（跟仓库走，大家共用）' : '全局工具（只在这台电脑）'}，v${saved.tool!.version}，文件 ${saved.file}。之后所有对话都能用 custom_tool action=run id=${saved.tool!.id} 调它。用一两句告诉用户就行。`,
    }
  } catch (e) {
    return fail(`保存失败：${(e as Error).message}`)
  }
}
