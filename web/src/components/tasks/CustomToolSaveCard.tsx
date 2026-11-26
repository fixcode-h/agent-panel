import { useState } from 'react'
import { Globe, Hammer, FolderGit2, TriangleAlert } from 'lucide-react'
import type { TaskRequest } from '@shared/schema'
import { CustomTool, type ToolScope } from '@shared/custom-tools/schema'
import { draftProblems } from '@shared/custom-tools/expand'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { ScopePicker } from '@/components/ui/scope-picker'
import { Switch } from '@/components/ui/switch'
import { CommandEffectBadge, ToolRunResult } from '@/components/ui/tool-run-result'

type Answer = (allow: boolean, text?: string) => Promise<void>

/**
 * 自建工具的保存弹窗（ADR 0082，效果图 2）：Agent 调 custom_tool action=save 时弹出，用户点完工具调用才返回。
 * 输入框上方留一条入口，弹窗默认打开；关掉弹窗不算回答，入口还在。
 * 回答格式和服务端约好：保存 = allow + JSON {scope, replace, confirm, patch}；让 Agent 再改 = 拒绝 + 意见；取消 = 拒绝不带话
 */
export function CustomToolSaveEntry({
  req,
  more,
  answer,
  className,
}: {
  req: TaskRequest
  more: number
  answer: Answer
  className?: string
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <div
        role="alertdialog"
        aria-label={t('Agent 请求确认')}
        className={cn(
          'mx-auto mb-2 flex max-w-(--content-w) items-center gap-2.5 rounded-2xl border border-warning/50 bg-card px-4 py-2.5 shadow-card animate-[pop-in_160ms_ease-out]',
          className,
        )}
      >
        <Hammer className="h-4 w-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium">{req.title}</span>
          <span className="text-xs text-warning">
            {t('选存到项目还是全局')}
            {more > 0 && <span className="text-subtle"> · {t('还有 {n} 个', { n: more })}</span>}
          </span>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          {t('查看并保存')}
        </Button>
      </div>
      {open && <SaveDialog req={req} onClose={() => setOpen(false)} answer={answer} />}
    </>
  )
}

function SaveDialog({ req, onClose, answer }: { req: TaskRequest; onClose: () => void; answer: Answer }) {
  const ct = req.customTool!
  const parsed = CustomTool.safeParse({ ...ct.draft, version: 1, history: [] })
  const tool = parsed.data
  const sameId = ct.dups.find((d) => d.sameId)
  const [scope, setScope] = useState<ToolScope>(
    !ct.inProject ? 'global' : sameId?.scope === 'global' ? 'global' : 'project',
  )
  const [replace, setReplace] = useState(!!sameId)
  const [name, setName] = useState(tool?.name ?? '')
  const [summary, setSummary] = useState(tool?.summary ?? '')
  const [useWhen, setUseWhen] = useState(tool?.useWhen ?? '')
  // 默认不问：Agent 调用时直接跑（用户 2026-11-26），想每次过目的在这里或之后的管理页打开
  const [confirm, setConfirm] = useState(tool?.confirm ?? false)
  const [revise, setRevise] = useState<string>()
  const [busy, setBusy] = useState(false)
  const problems = tool
    ? [...ct.problems, ...draftProblems(tool)]
    : parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`)
  // 同 id 的在另一个范围不算撞：项目的会盖住全局的，这是允许的
  const clash = ct.dups.find((d) => d.sameId && d.scope === scope)
  const go = async (allow: boolean, text?: string) => {
    setBusy(true)
    try {
      await answer(allow, text)
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    go(true, JSON.stringify({ scope, replace: !!clash && replace, confirm, patch: { name, summary, useWhen } }))
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={req.title}
      footer={
        revise === undefined ? (
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" onClick={() => go(false)} disabled={busy}>
              {t('取消')}
            </Button>
            <Button variant="secondary" className="ml-auto" onClick={() => setRevise('')} disabled={busy}>
              {t('让 Agent 再改')}
            </Button>
            <Button onClick={save} disabled={busy || problems.length > 0 || (!!clash && !replace)}>
              {t('保存')}
            </Button>
          </div>
        ) : (
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" className="ml-auto" onClick={() => setRevise(undefined)}>
              {t('返回')}
            </Button>
            <Button onClick={() => go(false, revise)} disabled={busy || !revise.trim()}>
              {t('发给 Agent')}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {revise !== undefined ? (
          <Field label={t('要 Agent 怎么改')}>
            <Textarea rows={4} autoFocus value={revise} onChange={(e) => setRevise(e.target.value)} />
          </Field>
        ) : (
          <>
            {!ct.test && (
              <p className="flex items-center gap-1.5 text-footnote text-warning">
                <TriangleAlert className="h-3.5 w-3.5" />
                {t('还没试跑过')}
              </p>
            )}
            {problems.map((p) => (
              <p key={p} className="text-footnote text-danger">
                {p}
              </p>
            ))}
            {tool && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('中文名')}>
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <Field label="id">
                    <span className="flex h-9 items-center gap-2 font-mono text-body">
                      {tool.id}
                      <CommandEffectBadge effect={tool.effect} />
                    </span>
                  </Field>
                </div>
                <Field label={t('说明')}>
                  <Input value={summary} onChange={(e) => setSummary(e.target.value)} />
                </Field>
                <Field label={t('什么时候用')}>
                  <Textarea rows={2} value={useWhen} onChange={(e) => setUseWhen(e.target.value)} />
                </Field>
                <Field label={t('命令')}>
                  <code className="block rounded-md bg-sel/50 px-2.5 py-1.5 font-mono text-footnote break-all">
                    {tool.run.command}
                  </code>
                </Field>
                {tool.params.length > 0 && (
                  <Field label={t('参数')}>
                    <ul className="flex flex-col gap-0.5 text-footnote text-muted">
                      {tool.params.map((p) => (
                        <li key={p.name}>
                          <span className="font-mono text-fg">{p.name}</span>
                          {p.required && ' *'} {p.label} · {p.type}
                          {p.default !== undefined && ` · ${t('默认 {v}', { v: String(p.default) })}`}
                          {p.desc && ` — ${p.desc}`}
                        </li>
                      ))}
                    </ul>
                  </Field>
                )}
                {tool.writes.length > 0 && (
                  <Field label={t('会改的文件')}>
                    <span className="font-mono text-footnote text-muted">{tool.writes.join('、')}</span>
                  </Field>
                )}
                <label className="flex items-center gap-2 text-body">
                  <Switch checked={confirm} onCheckedChange={setConfirm} aria-label={t('运行前先问我')} />
                  <span className="shrink-0 whitespace-nowrap">{t('运行前先问我')}</span>
                  <span className="text-footnote text-subtle">
                    {t('默认关：Agent 调用时直接跑，和普通工具一样。打开后每次先弹授权卡（可选本对话不再询问）')}
                  </span>
                </label>
                {ct.test && (
                  <ToolRunResult
                    ok={ct.test.ok}
                    line={ct.test.dryRun && ct.test.ok ? ct.test.text : ''}
                    text={ct.test.text}
                    dryRun={ct.test.dryRun}
                  />
                )}
              </>
            )}
            <Field label={t('保存到')}>
              <ScopePicker<ToolScope>
                value={scope}
                onChange={setScope}
                label={t('保存到')}
                options={[
                  {
                    id: 'project',
                    icon: FolderGit2,
                    title: t('加入项目'),
                    badge: t('推荐'),
                    desc: t('存进文档目录的 AgentPanel/Tools，跟仓库走，大家共用'),
                    note: t('P4 项目会先签出'),
                    disabled: !ct.inProject,
                  },
                  {
                    id: 'global',
                    icon: Globe,
                    title: t('全局'),
                    desc: t('只在这台电脑，所有项目都能用'),
                  },
                ]}
              />
            </Field>
            {ct.dups.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5">
                {ct.dups.map((d) => (
                  <span key={`${d.scope}:${d.id}`} className="text-footnote text-warning">
                    {t('和已有的「{name}」（{where} · v{v}）{why}', {
                      name: d.name,
                      where: d.scope === 'project' ? t('项目') : t('全局'),
                      v: d.version,
                      why: d.why,
                    })}
                  </span>
                ))}
                {clash && (
                  <label className="flex items-center gap-2 text-footnote">
                    <Switch checked={replace} onCheckedChange={setReplace} aria-label={t('更新它')} />
                    {t('更新它（v{a} → v{b}）；不更新就让 Agent 换个 id', { a: clash.version, b: clash.version + 1 })}
                  </label>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
