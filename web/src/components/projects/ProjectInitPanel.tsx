import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, FilePlus2, FilePen, File, Loader2, RotateCw, Sparkles } from 'lucide-react'
import type { FileFormat, ParamValue, ProjectInput, Workflow } from '@shared/schema'
import type { InitSetting, ProjectProposal } from '@shared/project-init'
import { ENV_LABEL } from '@shared/test-steps'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 一条推荐：当前值 → 推荐值，apply 只改草稿（保存项目设置后才生效） */
interface Rec {
  id: string
  label: string
  reason: string
  current: string
  next: string
  same: boolean
  apply: (d: ProjectInput) => ProjectInput
  /** 推荐值较长时点开看的明细（测试步骤） */
  detail?: React.ReactNode
}
interface Group {
  id: string
  title: string
  recs: Rec[]
}

const settingLabel = (key: InitSetting['key']) =>
  ({
    childIsolation: t('子对话隔离'),
    gitPolicy: t('推送到远端'),
    encoding: t('编码'),
    eol: t('换行符'),
    searchExclude: t('搜索时跳过的目录'),
    wslDistro: t('WSL 发行版'),
    scaledVerify: t('按改动大小决定验证范围'),
  })[key]

function settingText(key: InitSetting['key'], v: unknown) {
  switch (key) {
    case 'childIsolation':
      return v === 'claim' ? t('共用目录 + 认领文件') : t('独立 worktree')
    case 'gitPolicy':
      return v === 'allow' ? t('允许直接推送') : v === 'deny' ? t('不推送，只做本地提交') : t('第一次需要推送时问一次')
    case 'encoding':
      return v === 'utf8-bom' ? 'UTF-8（带 BOM）' : t('UTF-8（不带 BOM）')
    case 'eol':
      return v === 'crlf' ? 'CRLF' : 'LF'
    case 'searchExclude':
      return Array.isArray(v) && v.length ? v.join('、') : t('只用内置清单')
    case 'wslDistro':
      return typeof v === 'string' && v ? v : t('Ubuntu-24.04（默认）')
    case 'scaledVerify':
      return v ? t('打开') : t('关闭')
  }
}

const paramText = (v: ParamValue | undefined) =>
  v === undefined || v === ''
    ? t('（默认）')
    : typeof v === 'boolean'
      ? v
        ? t('打开')
        : t('关闭')
      : Array.isArray(v)
        ? v.join('、') || t('（空）')
        : String(v)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 把初始化结果和当前草稿对照，整理成按设置页分组的推荐项 */
function buildGroups(
  p: ProjectProposal,
  draft: ProjectInput,
  ctx: { workflows: Workflow[]; activeId: string; fallbackId: string; globalFormat: FileFormat },
): Group[] {
  const wfName = (id: string) => ctx.workflows.find((w) => w.id === id)?.name ?? t('（未选择）')
  const basics: Rec[] = [
    {
      id: 'name',
      label: t('名称'),
      reason: p.reasons.name ?? '',
      current: draft.name.trim() || t('（空）'),
      next: p.name,
      same: draft.name.trim() === p.name,
      apply: (d) => ({ ...d, name: p.name }),
    },
  ]
  if (p.description)
    basics.push({
      id: 'description',
      label: t('简介'),
      reason: p.reasons.description ?? '',
      current: draft.description || t('（空）'),
      next: p.description,
      same: draft.description === p.description,
      apply: (d) => ({ ...d, description: p.description }),
    })

  // 默认工作流：AI 评估出的那个；没评估出时按项目类型落到内置的「通用项目」/「UE 项目」
  const def = p.workflows.find((w) => w.verdict === 'default')
  const defId = def?.id || ctx.fallbackId
  const wf: Rec[] = []
  if (defId)
    wf.push({
      id: 'workflow',
      label: t('默认工作流'),
      reason: def?.reason ?? (p.type === 'ue' ? t('Unreal Engine 项目') : ''),
      current: wfName(ctx.activeId),
      next: wfName(defId),
      same: draft.workflowId === defId || (!draft.workflowId && ctx.activeId === defId),
      apply: (d) => ({ ...d, workflowId: defId, workflowIds: d.workflowIds.filter((x) => x !== defId) }),
    })
  for (const o of p.workflows.filter((w) => w.verdict === 'optional'))
    wf.push({
      id: `optional:${o.id}`,
      label: t('可选工作流「{name}」', { name: o.name }),
      reason: o.reason,
      current: t('未加入'),
      next: t('加入'),
      same: draft.workflowIds.includes(o.id) || draft.workflowId === o.id,
      apply: (d) =>
        d.workflowIds.includes(o.id) || d.workflowId === o.id ? d : { ...d, workflowIds: [...d.workflowIds, o.id] },
    })
  const target = ctx.workflows.find((w) => w.id === defId)
  for (const [key, v] of Object.entries(p.params)) {
    const e = target?.expose.find((x) => x.key === key)
    if (!target || !e) continue
    const cur = draft.workflowParams[target.id]?.[key] as ParamValue | undefined
    wf.push({
      id: `param:${key}`,
      label: t('「{wf}」的{name}', { wf: target.name, name: e.label || key }),
      reason: p.reasons.params ?? e.description,
      current: paramText(cur ?? e.default),
      next: paramText(v),
      same: same(cur ?? e.default, v),
      apply: (d) => ({
        ...d,
        workflowParams: { ...d.workflowParams, [target.id]: { ...(d.workflowParams[target.id] ?? {}), [key]: v } },
      }),
    })
  }

  const tests: Rec[] = p.steps.length
    ? [
        {
          id: 'steps',
          label: t('测试步骤'),
          reason: p.reasons.steps ?? '',
          current: draft.testSteps.length ? t('{n} 步', { n: draft.testSteps.length }) : t('（没有）'),
          next: t('{n} 步：{names}', { n: p.steps.length, names: p.steps.map((s) => s.name).join('、') }),
          same: same(
            draft.testSteps.map((s) => [s.name, s.command]),
            p.steps.map((s) => [s.name, s.command]),
          ),
          apply: (d) => ({ ...d, testSteps: p.steps }),
          detail: (
            <ol className="flex flex-col gap-1.5">
              {p.steps.map((s) => (
                <li key={s.id} className="rounded-lg border bg-field/40 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.78125rem] font-medium">{s.name}</span>
                    <Badge>{ENV_LABEL[s.env]}</Badge>
                    {s.quick && <span className="text-[0.6875rem] text-subtle">{t('小改动也跑')}</span>}
                  </div>
                  <code className="mt-0.5 block font-mono text-[0.71875rem] break-all whitespace-pre-wrap text-muted">
                    {s.command}
                  </code>
                </li>
              ))}
            </ol>
          ),
        },
      ]
    : []

  const format = draft.fileFormat ?? ctx.globalFormat
  const settingRec = (s: InitSetting): Rec => {
    const base = { id: `setting:${s.key}`, label: settingLabel(s.key), reason: s.reason }
    switch (s.key) {
      case 'encoding':
      case 'eol': {
        const cur = format[s.key]
        return {
          ...base,
          current: settingText(s.key, cur),
          next: settingText(s.key, s.value),
          same: cur === s.value,
          apply: (d) => ({ ...d, fileFormat: { ...(d.fileFormat ?? ctx.globalFormat), [s.key]: s.value } }),
        }
      }
      case 'searchExclude': {
        // 只往项目清单里加，不删用户自己写的
        const cur = draft.searchExclude ?? []
        const merged = [...new Set([...cur, ...s.value])]
        return {
          ...base,
          current: settingText(s.key, cur),
          next: settingText(s.key, merged),
          same: s.value.every((x) => cur.includes(x)),
          apply: (d) => ({ ...d, searchExclude: [...new Set([...(d.searchExclude ?? []), ...s.value])] }),
        }
      }
      default: {
        const cur = draft[s.key]
        return {
          ...base,
          current: settingText(s.key, cur),
          next: settingText(s.key, s.value),
          same: cur === s.value,
          apply: (d) => ({ ...d, [s.key]: s.value }),
        }
      }
    }
  }
  const order = (keys: InitSetting['key'][]) => p.settings.filter((s) => keys.includes(s.key)).map(settingRec)

  return [
    { id: 'basics', title: t('基本信息'), recs: basics },
    { id: 'workflows', title: t('工作流'), recs: wf },
    { id: 'tests', title: t('测试步骤'), recs: tests },
    { id: 'children', title: t('子对话与推送'), recs: order(['childIsolation', 'gitPolicy', 'scaledVerify']) },
    { id: 'files', title: t('文件与搜索'), recs: order(['encoding', 'eol', 'searchExclude', 'wslDistro']) },
  ].filter((g) => g.recs.length)
}

const FILE_ICON = { created: FilePlus2, updated: FilePen, kept: File }
const fileLabel = (a: keyof typeof FILE_ICON) => ({ created: t('新建'), updated: t('修改'), kept: t('未改') })[a]

/**
 * 项目设置的「AI 初始化」页：没初始化时说明会做什么并开始；初始化完成后列出写过的文件，
 * 推荐的设置按设置页分组，每项能单独应用，也能整组或全部应用。应用只改草稿，点「确认」才保存
 */
export function ProjectInitPanel({
  draft,
  setDraft,
  result,
  workflows,
  activeId,
  fallbackId,
  fromDir,
  globalFormat,
  canStart,
  starting,
  signals,
  onStart,
}: {
  draft: ProjectInput
  setDraft: (f: (d: ProjectInput) => ProjectInput) => void
  result: ProjectProposal | null
  workflows: Workflow[]
  /** 当前实际生效的默认工作流 */
  activeId: string
  /** AI 没评估出默认工作流时按项目类型选的内置工作流 */
  fallbackId: string
  /** 没在这里初始化过，但目录里已有初始化写好的 AGENTS.md 和文档 */
  fromDir: boolean
  globalFormat: FileFormat
  /** 选好本地目录才能开始 */
  canStart: boolean
  starting: boolean
  /** 面板快速扫描出的线索 */
  signals: string[]
  onStart: () => void
}) {
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const groups = result ? buildGroups(result, draft, { workflows, activeId, fallbackId, globalFormat }) : []
  const all = groups.flatMap((g) => g.recs)
  const pending = all.filter((r) => !r.same)
  const apply = (recs: Rec[]) => {
    const todo = recs.filter((r) => !r.same)
    if (!todo.length) return
    setDraft((d) => todo.reduce((acc, r) => r.apply(acc), d))
    setApplied((s) => new Set([...s, ...todo.map((r) => r.id)]))
  }
  const skipped = result?.workflows.filter((w) => w.verdict === 'skip') ?? []
  const startButton = (
    <Button
      size="sm"
      variant={draft.initializedAt ? 'secondary' : 'primary'}
      disabled={!canStart || starting}
      onClick={onStart}
    >
      {starting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : draft.initializedAt ? (
        <RotateCw className="h-3.5 w-3.5" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      {draft.initializedAt ? t('重新初始化') : t('AI 初始化项目')}
    </Button>
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 [&>*]:shrink-0">
      <div className="flex flex-col gap-1 pb-1">
        <h3 className="text-[0.9375rem] font-semibold">{t('AI 初始化项目')}</h3>
        <p className="text-[0.78125rem] leading-relaxed text-subtle">
          {t(
            '本机 Agent 读一遍项目，写好 AGENTS.md 和项目文档框架，再评估哪些工作流可用、项目设置该怎么配。推荐项可以逐项应用，也可以整组或全部应用；每个项目初始化一次，完成后才能保存项目设置。',
          )}
        </p>
      </div>

      {!result && (
        <section
          className={cn(
            'flex flex-col gap-4 rounded-xl border p-4',
            draft.initializedAt ? 'bg-card' : 'border-accent/40 bg-accent-soft/40',
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                draft.initializedAt ? 'bg-success/12 text-success' : 'bg-accent-soft text-accent',
              )}
            >
              {draft.initializedAt ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[0.875rem] font-medium">
                {fromDir
                  ? t('目录已经初始化过')
                  : draft.initializedAt
                    ? t('已于 {date} 初始化', { date: new Date(draft.initializedAt).toLocaleString() })
                    : t('这个项目还没有初始化')}
              </span>
              <span className="text-[0.78125rem] text-subtle">
                {fromDir
                  ? t('目录里已有初始化写好的 AGENTS.md 和文档，可以直接保存；想要推荐的设置可以重新初始化。')
                  : draft.initializedAt
                    ? t('项目结构有大变化时可以重新初始化：已有的文档只补不覆盖。')
                    : canStart
                      ? t('初始化完成并应用后，才能点「确认」保存项目设置。')
                      : t('先在「常规」里选好本地目录。')}
              </span>
            </div>
            {startButton}
          </div>
          {!draft.initializedAt && (
            <ol className="grid gap-2 sm:grid-cols-2">
              {[
                ['AGENTS.md', t('没有就新建，已有就保留原内容补全：项目说明、硬规则、常用命令、文档地图')],
                [t('文档框架'), t('按 project-documentation 建文档入口、模块地图和各模块的说明；P4 项目放在项目外')],
                [t('评估工作流'), t('逐个判断已添加的工作流：哪个当默认、哪些放进可选、哪些用不上')],
                [t('推荐设置'), t('测试步骤、子对话隔离、推送、编码换行、搜索排除等，每项附依据')],
              ].map(([title, desc], i) => (
                <li key={title} className="flex gap-2.5 rounded-lg border bg-card px-3 py-2.5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-field text-[0.6875rem] text-muted">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[0.8125rem] font-medium">{title}</span>
                    <span className="text-[0.75rem] leading-relaxed text-subtle">{desc}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {signals.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {signals.map((s) => (
                <li key={s}>· {s}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {result && (
        <>
          <section className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-success/12 text-success">
                <Check className="h-3.5 w-3.5" />
              </span>
              <span className="text-[0.8125rem] font-medium">{t('初始化完成')}</span>
              {result.docRoot && (
                <span className="text-xs text-subtle">{t('文档根：{dir}', { dir: result.docRoot })}</span>
              )}
              <span className="ml-auto">{startButton}</span>
            </div>
            {result.files.length ? (
              <ul className="flex max-h-[18rem] flex-col divide-y overflow-y-auto rounded-lg border">
                {result.files.map((f) => {
                  const Icon = FILE_ICON[f.action]
                  return (
                    <li key={f.path} className="flex items-start gap-2.5 px-3 py-2">
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <code className="truncate font-mono text-[0.75rem]">{f.path}</code>
                        {f.summary && <span className="text-[0.71875rem] text-subtle">{f.summary}</span>}
                      </span>
                      <Badge tone={f.action === 'created' ? 'success' : f.action === 'updated' ? 'accent' : 'neutral'}>
                        {fileLabel(f.action)}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <span className="text-xs text-subtle">
                {t('Agent 没有报告写了哪些文件，可以在左边的「项目说明」里查看 AGENTS.md。')}
              </span>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[0.875rem] font-semibold">{t('推荐设置')}</span>
              <span className="text-xs text-subtle">
                {all.length
                  ? pending.length
                    ? t('{n} 项和当前设置不同，应用后点「确认」保存', { n: pending.length })
                    : t('全部推荐都已和当前设置一致，点「确认」保存')
                  : t('没有需要调整的设置')}
              </span>
            </div>
            <Button size="sm" disabled={!pending.length} onClick={() => apply(all)}>
              <Check className="h-3.5 w-3.5" />
              {t('全部应用')}
            </Button>
          </div>

          {groups.map((g) => {
            const left = g.recs.filter((r) => !r.same).length
            return (
              <section key={g.id} className="overflow-hidden rounded-xl border bg-card">
                <header className="flex items-center gap-2 border-b bg-panel/60 px-3.5 py-2">
                  <span className="text-[0.8125rem] font-medium">{g.title}</span>
                  <span className="text-xs text-subtle">{left ? t('{n} 项待应用', { n: left }) : t('已一致')}</span>
                  {left > 0 && g.recs.length > 1 && (
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => apply(g.recs)}>
                      {t('应用本组')}
                    </Button>
                  )}
                </header>
                <ul className="divide-y">
                  {g.recs.map((r) => (
                    <li key={r.id} className="flex flex-col gap-2 px-3.5 py-3">
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="flex min-w-[180px] flex-[1_1_200px] flex-col gap-0.5">
                          <span className="text-[0.8125rem] font-medium">{r.label}</span>
                          {r.reason && <span className="text-[0.75rem] leading-relaxed text-subtle">{r.reason}</span>}
                        </div>
                        <div className="flex min-w-0 flex-[2_1_260px] items-start gap-2 text-[0.78125rem]">
                          {!r.same && (
                            <>
                              <span className="min-w-0 flex-1 break-words text-subtle line-through decoration-subtle/50">
                                {r.current}
                              </span>
                              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                            </>
                          )}
                          <span className={cn('min-w-0 flex-1 break-words', r.same ? 'text-muted' : 'font-medium')}>
                            {r.next}
                          </span>
                        </div>
                        <div className="flex w-[92px] shrink-0 justify-end">
                          {!r.same ? (
                            <Button size="sm" variant="secondary" onClick={() => apply([r])}>
                              {t('应用')}
                            </Button>
                          ) : applied.has(r.id) ? (
                            <span className="inline-flex items-center gap-1 text-xs text-success">
                              <Check className="h-3.5 w-3.5" />
                              {t('已应用')}
                            </span>
                          ) : (
                            <span className="text-xs text-subtle">{t('已一致')}</span>
                          )}
                        </div>
                      </div>
                      {r.detail && (
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            className="flex w-fit cursor-pointer items-center gap-1 text-xs text-accent hover:underline"
                            aria-expanded={open.has(r.id)}
                            onClick={() =>
                              setOpen((s) => {
                                const n = new Set(s)
                                if (n.has(r.id)) n.delete(r.id)
                                else n.add(r.id)
                                return n
                              })
                            }
                          >
                            <ChevronRight
                              className={cn('h-3.5 w-3.5 transition-transform', open.has(r.id) && 'rotate-90')}
                            />
                            {t('查看推荐的步骤')}
                          </button>
                          {open.has(r.id) && r.detail}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}

          {skipped.length > 0 && (
            <section className="flex flex-col gap-1.5 rounded-xl border border-dashed px-3.5 py-3">
              <span className="text-xs font-medium text-muted">{t('评估后不适用的工作流')}</span>
              <ul className="flex flex-col gap-1">
                {skipped.map((w) => (
                  <li key={w.id} className="text-xs text-subtle">
                    <span className="text-muted">{w.name}</span>
                    {w.reason && `：${w.reason}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
