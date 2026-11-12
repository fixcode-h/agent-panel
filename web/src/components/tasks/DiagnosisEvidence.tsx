import { useCallback, useEffect, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import type { PatchKind, PatchStatus } from '@shared/bug/patch'
import { logPathIn, type LogFetch } from '@shared/bug/log-watch'
import { TEMP_LOG } from '@shared/bug/cleanup'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

/**
 * 诊断报告「等你复现 / 等你验证」那一步的取证（分析稿 B1、B3）：
 * - WorkspacePatch：它在独立分支里加的临时日志（或修复）一键放到你的工作区，复现完一键还原；
 * - LogWatch：报告里写了日志文件在哪时，面板自己取复现期间新增的日志，填进贴日志的输入框。
 * 两样都只是帮用户少动手：放不放、交不交仍由用户点，面板不替用户交日志
 */

type PatchAct = 'apply' | 'restore' | 'forget'

/** 补丁的状态和三个动作；弹窗打开时查一次（取消确认框也靠它提醒先还原） */
export function usePatch(taskId: string, enabled: boolean) {
  const [status, setStatus] = useState<PatchStatus | null>(null)
  const [busy, setBusy] = useState<'' | PatchAct>('')
  // 没成功的那一次：服务端什么都没动，把说明和有冲突的文件摆出来（不悄悄重试）
  const [fail, setFail] = useState<{ action: PatchAct; reason: string; files: string[] } | null>(null)
  const [restored, setRestored] = useState(0)
  const refresh = useCallback(() => {
    api
      .patchStatus(taskId)
      .then(setStatus)
      // 查不了（导入的对话、旧版服务端）就当没有：不出按钮
      .catch(() => setStatus({ eligible: false }))
  }, [taskId])
  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, refresh])
  const act = async (action: PatchAct) => {
    setBusy(action)
    setFail(null)
    setRestored(0)
    try {
      const r = await api.patchAction(taskId, action)
      setStatus(r.status)
      if (!r.ok) setFail({ action, reason: r.reason, files: r.files })
      else if (action === 'restore') setRestored(r.files.length)
    } catch (e) {
      setFail({ action, reason: (e as Error).message, files: [] })
    } finally {
      setBusy('')
    }
  }
  return { status, busy, fail, restored, act, refresh }
}

/**
 * 决策卡上面的一条：把独立分支里的临时日志 / 修复放到我的工作区、还原。
 * 只在 Git 项目、对话开了独立分支时出现（服务端的 eligible）；补丁还在工作区里时不管走到哪一步都留着「还原」
 */
export function WorkspacePatch({
  patch,
  kind,
}: {
  patch: ReturnType<typeof usePatch>
  /** 这一版现在能放哪种：等你复现是临时日志，验证是修复；别的时候不能放（已经放了的仍能还原） */
  kind: PatchKind | undefined
}) {
  const { status, busy, fail, restored, act } = patch
  const applied = status?.applied
  if (!status || (!applied && !(status.eligible && kind))) return null
  const fix = (applied?.kind ?? kind) === 'fix'
  const text = applied
    ? fix
      ? t('修复已经临时放到你的工作区（{k} 个文件）。试完点还原，面板把这几个文件写回放之前的样子并核对。', {
          k: applied.files.length,
        })
      : t('临时日志已经放到你的工作区（{k} 个文件）。复现完点还原，面板把这几个文件写回放之前的样子并核对。', {
          k: applied.files.length,
        })
    : fix
      ? t('修复在它的独立分支里，你的工作区里还没有：可以先临时放过去试一下，试完还原。')
      : t('临时日志加在它的独立分支里，你的工作区里没有：放过去再复现，复现完还原。')
  return (
    <div data-workspace-patch className="mb-3 rounded-lg border border-line bg-card px-3 py-2 text-body select-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn('min-w-0 flex-1 basis-64', applied ? 'text-warning' : 'text-muted')}>{text}</span>
        {applied ? (
          <Button size="sm" disabled={!!busy} onClick={() => void act('restore')}>
            {busy === 'restore' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('从我的工作区还原')}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void act('apply')}>
            {busy === 'apply' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {fix ? t('把修复临时放到工作区试一下') : t('放到我的工作区')}
          </Button>
        )}
      </div>
      {applied && (
        <ul className="mt-2 max-h-24 overflow-y-auto rounded-md bg-panel px-2 py-1.5 font-mono text-caption text-muted">
          {applied.files.map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
        </ul>
      )}
      {restored > 0 && !applied && !fail && (
        <p className="mt-2 text-caption text-success">{t('已还原：{k} 个文件和放之前一样。', { k: restored })}</p>
      )}
      {fail && (
        <div className="mt-2 text-caption text-danger" role="alert">
          <p className="whitespace-pre-wrap">{fail.reason}</p>
          {fail.files.length > 0 && (
            <ul className="mt-1 font-mono">
              {fail.files.map((f) => (
                <li key={f} className="truncate" title={f}>
                  {f}
                </li>
              ))}
            </ul>
          )}
          {fail.action === 'restore' && applied && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act('forget')}>
                {busy === 'forget' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('我自己改回去，不用再提醒')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 取消修复的确认框里：补丁还在工作区时提醒先还原（取消后分支不会合回，留在工作区的日志没人管） */
export function PatchReminder({ patch }: { patch: ReturnType<typeof usePatch> }) {
  const applied = patch.status?.applied
  if (!applied) return null
  return (
    <p data-patch-reminder className="text-body text-warning">
      {applied.kind === 'fix'
        ? t('修复还临时放在你的工作区里（{k} 个文件）：先关掉这个确认框，点「从我的工作区还原」，再取消。', {
            k: applied.files.length,
          })
        : t('临时日志还放在你的工作区里（{k} 个文件）：先关掉这个确认框，点「从我的工作区还原」，再取消。', {
            k: applied.files.length,
          })}
    </p>
  )
}

const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

type View = 'related' | 'full'

/**
 * 贴日志的输入框上面的一条：报告里写了日志文件在哪时出现。
 * 「开始复现」服务端记下文件现在多大，「复现完了，取日志」取新增的部分填进输入框（默认只填带 [排查- 的行，可以切到完整内容）；
 * 用户看过再点原来的「交日志」。读哪个文件由服务端按报告认，页面只带「确认读项目外面的这个文件」
 */
export function LogWatch({
  taskId,
  where,
  onFill,
}: {
  taskId: string
  /** 报告的「日志在哪」（collect.where） */
  where: string | undefined
  /** 把取到的日志填进输入框（整个换掉） */
  onFill: (text: string) => void
}) {
  const path = logPathIn(where)
  const [started, setStarted] = useState<{ at: string; missing?: boolean } | null>(null)
  const [busy, setBusy] = useState<'' | 'start' | 'fetch'>('')
  const [got, setGot] = useState<LogFetch | null>(null)
  const [view, setView] = useState<View>('related')
  const [error, setError] = useState('')
  // 文件在项目目录外面：等用户点确认后带着 confirm 再发一次
  const [confirm, setConfirm] = useState<'' | 'start' | 'fetch'>('')
  const [ok, setOk] = useState(false)
  useEffect(() => {
    if (!path) return
    let off = false
    api
      .logWatchStatus(taskId)
      .then((s) => !off && s.started?.path === path && setStarted({ at: s.started.at }))
      // 查不到就当没开始过：按钮照常能点
      .catch(() => {})
    return () => {
      off = true
    }
  }, [taskId, path])
  if (!path) return null
  const run = async (action: 'start' | 'fetch', yes = ok) => {
    setBusy(action)
    setError('')
    setConfirm('')
    try {
      if (action === 'start') {
        const r = await api.logWatch(taskId, 'start', yes)
        if (r.ok) {
          setStarted({ at: new Date().toISOString(), missing: r.missing })
          setGot(null)
        } else if (r.needConfirm) setConfirm(action)
        if (!r.ok) setError(r.error)
      } else {
        const r = await api.logWatch(taskId, 'fetch', yes)
        if (r.ok) {
          setGot(r)
          const v: View = r.related ? 'related' : 'full'
          setView(v)
          if (r.text) onFill(v === 'related' ? r.related : r.text)
        } else if (r.needConfirm) setConfirm(action)
        if (!r.ok) setError(r.error)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const lines = (s: string) => (s ? s.split('\n').length : 0)
  return (
    <div data-log-watch className="mb-2 rounded-lg border border-line bg-card px-2.5 py-2 text-caption">
      <div className="flex items-center gap-1.5 text-muted">
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{t('日志文件')}</span>
        <span className="min-w-0 truncate font-mono text-fg" title={path}>
          {path}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('start')}>
          {busy === 'start' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {started ? t('重新开始复现') : t('开始复现')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!!busy || !started}
          title={started ? undefined : t('先点「开始复现」，面板记下日志文件现在到哪了')}
          onClick={() => void run('fetch')}
        >
          {busy === 'fetch' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('复现完了，取日志')}
        </Button>
      </div>
      {started && !got && !error && (
        <p className="mt-2 leading-relaxed text-subtle">
          {started.missing
            ? t('这个文件现在还不存在：复现时生成的整个文件都算新增。复现完回来点「复现完了，取日志」。')
            : t('已记下日志文件现在到哪了。按报告里的步骤复现，完了回来点「复现完了，取日志」。')}
        </p>
      )}
      {got && !error && (
        <div className="mt-2 flex flex-col gap-1.5 leading-relaxed">
          {got.text ? (
            <>
              <p className="text-subtle">
                {t('新增 {size}、{n} 行，其中 {k} 行带 {prefix}…]；已经填进下面的输入框，看过再交。', {
                  size: sizeText(got.bytes),
                  n: lines(got.text),
                  k: lines(got.related),
                  prefix: TEMP_LOG,
                })}
              </p>
              {got.related && got.related !== got.text && (
                <Segmented
                  size="sm"
                  value={view}
                  onChange={(v) => {
                    setView(v)
                    onFill(v === 'related' ? got.related : got.text)
                  }}
                  label={t('填进输入框的内容')}
                  options={[
                    { id: 'related', label: t('相关行') },
                    { id: 'full', label: t('完整新增内容') },
                  ]}
                  className="self-start"
                />
              )}
              {!got.related && (
                <p className="text-warning">
                  {t('新增内容里没有带 {prefix}…] 的行，填进去的是完整新增内容。', { prefix: TEMP_LOG })}
                </p>
              )}
            </>
          ) : (
            <p className="text-warning">{t('从开始复现到现在，这个文件没有新增内容。')}</p>
          )}
          {got.truncated && <p className="text-warning">{t('新增内容超过 2 MB，只取了前 2 MB，后面的截掉了。')}</p>}
          {got.rotated && (
            <p className="text-warning">{t('日志文件比开始复现时还小（被清空或换了新文件），取的是现在整个文件。')}</p>
          )}
        </div>
      )}
      {error && (
        <div className={cn('mt-2 leading-relaxed', confirm ? 'text-warning' : 'text-danger')} role="alert">
          <p className="[overflow-wrap:anywhere]">{error}</p>
          {confirm && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-1.5"
              disabled={!!busy}
              onClick={() => {
                setOk(true)
                void run(confirm, true)
              }}
            >
              {t('确认，读这个文件')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
