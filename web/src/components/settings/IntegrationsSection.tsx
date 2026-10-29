import { useEffect, useState } from 'react'
import { Download, KeyRound, Loader2, LogIn, LogOut, RefreshCw, ShieldCheck, SquareTerminal } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { IntegrationInstallJob, IntegrationLoginJob, IntegrationView } from '@shared/integrations'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { CopyText } from './parts'

/**
 * 设置里的「授权」：列出需要授权的外部 CLI，检测安装和登录状态，
 * 在面板里完成浏览器授权或 token 授权。登录状态由这些工具自己保存，面板不经手凭据。
 * 新增一个工具只需在 shared/integrations.ts 里加一份定义，这里不用改。
 */
export function IntegrationsSection() {
  const [list, setList] = useState<IntegrationView[] | null>(null)
  const [error, setError] = useState('')
  const [jobs, setJobs] = useState<Record<string, IntegrationLoginJob | null>>({})
  const [busy, setBusy] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // 正在输入 token 的那个工具
  const [tokenFor, setTokenFor] = useState('')
  const [token, setToken] = useState('')
  // 确认退出登录的那个工具
  const [removing, setRemoving] = useState('')
  const [installs, setInstalls] = useState<Record<string, IntegrationInstallJob | null>>({})

  const load = async (refresh = false) => {
    try {
      setList(await api.integrations(refresh))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // 打开页面时接上还在跑的授权（切走再回来不会丢）
  useEffect(() => {
    if (!list) return
    let alive = true
    void Promise.all(list.map((v) => api.integrationLoginStatus(v.id).catch(() => null))).then((found) => {
      if (!alive) return
      setJobs(Object.fromEntries(list.map((v, i) => [v.id, found[i]])))
    })
    void Promise.all(
      list
        .filter((v) => !v.installed)
        .map(async (v) => [v.id, await api.integrationInstallStatus(v.id).catch(() => null)] as const),
    ).then((found) => alive && setInstalls((prev) => ({ ...prev, ...Object.fromEntries(found) })))
    return () => {
      alive = false
    }
  }, [list])

  // 有授权任务在跑时轮询；结束后重新读一次状态
  const running = list?.filter((v) => jobs[v.id]?.status === 'running').map((v) => v.id) ?? []
  useEffect(() => {
    if (!running.length) return
    const timer = setInterval(async () => {
      const found = await Promise.all(
        running.map(async (id) => [id, await api.integrationLoginStatus(id).catch(() => null)] as const),
      )
      setJobs((prev) => ({ ...prev, ...Object.fromEntries(found) }))
      if (found.some(([, j]) => j && j.status !== 'running')) void load(true)
    }, 1200)
    return () => clearInterval(timer)
    // 只跟着「哪些任务在跑」变化；load 每次渲染都是新函数，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [running.join(',')])

  // 一键安装在跑时轮询；装完重新检测
  const installing = Object.entries(installs)
    .filter(([, j]) => j?.status === 'running')
    .map(([id]) => id)
  useEffect(() => {
    if (!installing.length) return
    const timer = setInterval(async () => {
      const found = await Promise.all(
        installing.map(async (id) => [id, await api.integrationInstallStatus(id).catch(() => null)] as const),
      )
      setInstalls((prev) => ({ ...prev, ...Object.fromEntries(found) }))
      if (found.some(([, j]) => j && j.status !== 'running')) void load(true)
    }, 1500)
    return () => clearInterval(timer)
    // 只跟着「哪些在装」变化；load 每次渲染都是新函数，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [installing.join(',')])

  const install = async (id: string) => {
    try {
      const job = await api.integrationInstall(id)
      setInstalls((prev) => ({ ...prev, [id]: job }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const check = async () => {
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      setRefreshing(false)
    }
  }

  const login = async (id: string) => {
    if (busy) return
    setBusy(id)
    try {
      const job = await api.integrationLogin(id)
      setJobs((prev) => ({ ...prev, [id]: job }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const cancel = async (id: string) => {
    try {
      await api.integrationCancel(id)
      setJobs((prev) => ({ ...prev, [id]: null }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const submitToken = async (id: string) => {
    if (!token.trim() || busy) return
    setBusy(id)
    try {
      const v = await api.integrationToken(id, token)
      setList((prev) => prev?.map((x) => (x.id === v.id ? v : x)) ?? prev)
      setToken('')
      setTokenFor('')
      toast.success(t('授权完成'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const logout = async (id: string) => {
    try {
      const v = await api.integrationLogout(id)
      setList((prev) => prev?.map((x) => (x.id === v.id ? v : x)) ?? prev)
      setJobs((prev) => ({ ...prev, [id]: null }))
      setRemoving('')
      toast.success(t('已退出登录'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const target = list?.find((v) => v.id === removing)

  if (error) return <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
  if (!list) return <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '给本机的命令行工具授权后，角色在任务里可以直接用它们操作远端，例如合并分支、查看和创建 PR、提交 issue。登录状态由这些工具自己保存，面板不保存凭据。',
        )}
      </p>
      {list.map((v) => {
        const job = jobs[v.id]
        // 正在授权时不再提供第二个入口，先取消或等它完成
        const inProgress = job?.status === 'running'
        const setup = installs[v.id]
        const settingUp = setup?.status === 'running'
        return (
          <section key={v.id} className="rounded-xl bg-card shadow-card p-4">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border bg-field text-muted">
                <SquareTerminal className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {v.name}
                  <span
                    className={cn(
                      'rounded-full px-2 py-px text-[0.6875rem] font-normal',
                      v.authed
                        ? 'bg-success/12 text-success'
                        : v.installed
                          ? 'bg-warning/12 text-warning'
                          : 'bg-sel text-subtle',
                    )}
                  >
                    {v.authed ? t('已授权') : v.installed ? t('未授权') : t('未安装')}
                  </span>
                  {v.version && <span className="font-mono text-[0.6875rem] font-normal text-subtle">{v.version}</span>}
                  {v.docsUrl && (
                    <a
                      href={v.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[0.6875rem] font-normal text-accent-text hover:underline"
                    >
                      {t('文档')}
                    </a>
                  )}
                </p>
                <p className="mt-0.5 text-[0.75rem] leading-relaxed text-subtle">{v.description}</p>
              </div>
            </div>

            {!v.installed ? (
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-[0.75rem] text-muted">
                  <span>{t('没有检测到 {command}，先安装再授权。', { command: v.command })}</span>
                  {v.canInstall && (
                    <Button size="sm" onClick={() => void install(v.id)} disabled={settingUp}>
                      {settingUp ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {settingUp ? t('安装中…') : t('一键安装')}
                    </Button>
                  )}
                  {v.installHint && <CopyText text={v.installHint} title={t('复制安装命令')} />}
                  <Button size="sm" variant="ghost" onClick={check} disabled={refreshing || settingUp}>
                    <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                    {t('重新检测')}
                  </Button>
                </div>
                {setup && <InstallBox job={setup} />}
              </div>
            ) : v.authed ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-[0.8125rem] text-success">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('已授权')}
                  {v.account && <span className="font-mono text-muted">· {v.account}</span>}
                </span>
                {!v.account && v.detail && (
                  <span className="w-full text-[0.75rem] whitespace-pre-wrap text-subtle">{v.detail}</span>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={check} disabled={refreshing}>
                  <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                  {t('重新检测')}
                </Button>
                {v.canLogout && (
                  <Button size="sm" variant="danger-outline" onClick={() => setRemoving(v.id)}>
                    <LogOut className="h-3.5 w-3.5" />
                    {t('退出登录')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {v.hint && <p className="text-[0.75rem] leading-relaxed text-muted">{v.hint}</p>}
                {v.detail && (
                  <p className="text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-subtle">{v.detail}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {v.browserAuth && (
                    <Button size="sm" onClick={() => void login(v.id)} disabled={!!busy || inProgress}>
                      {busy === v.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LogIn className="h-3.5 w-3.5" />
                      )}
                      {t('浏览器授权')}
                    </Button>
                  )}
                  {v.tokenAuth && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setTokenFor(tokenFor === v.id ? '' : v.id)
                        setToken('')
                      }}
                      disabled={!!busy || inProgress}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {t('用 Token 授权')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={check} disabled={refreshing || inProgress}>
                    <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                    {t('重新检测')}
                  </Button>
                </div>
                {tokenFor === v.id && (
                  <div className="flex flex-col gap-2 rounded-lg bg-sel/40 p-3">
                    <p className="text-[0.75rem] leading-relaxed text-muted">
                      {t('粘贴 Token，只传给本机的 {command}，面板不保存。', { command: v.command })}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="password"
                        autoFocus
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="ghp_…"
                        aria-label={t('Token')}
                        className="min-w-[180px] flex-1 font-mono text-[0.8125rem]"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void submitToken(v.id)
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        onClick={() => void submitToken(v.id)}
                        disabled={!token.trim() || busy === v.id}
                      >
                        {busy === v.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {t('授权')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setTokenFor('')}>
                        {t('取消')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {job && <LoginBox job={job} onCancel={() => void cancel(v.id)} />}
          </section>
        )
      })}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving('')}
        title={t('退出 {name} 的授权？', { name: target?.name ?? '' })}
        description={t('退出后 Agent 在任务里不能再用它操作远端，需要时可以重新授权。')}
        confirmText={t('退出登录')}
        onConfirm={() => removing && logout(removing)}
      />
    </div>
  )
}

/** 一键安装的进度：正在用的安装方式和输出，失败时给出原因 */
function InstallBox({ job }: { job: IntegrationInstallJob }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-sel/40 p-3">
      {job.status === 'running' ? (
        <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
          <span className="min-w-0">
            {t('正在安装：')}
            <span className="font-mono text-[0.75rem]">{job.method}</span>
          </span>
        </p>
      ) : (
        <p
          className={cn('text-[0.8125rem] whitespace-pre-wrap', job.status === 'done' ? 'text-success' : 'text-danger')}
        >
          {job.status === 'done' ? t('安装完成') : job.error || t('安装没有完成')}
        </p>
      )}
      {job.status === 'running' && (
        <p className="text-[0.6875rem] text-subtle">{t('Windows 上可能会弹出系统的权限确认，点「是」继续。')}</p>
      )}
      {job.output && job.status !== 'done' && (
        <pre className="max-h-32 overflow-auto text-[0.6875rem] whitespace-pre-wrap text-subtle">{job.output}</pre>
      )}
    </div>
  )
}

/** 浏览器授权的进度：一次性授权码、授权网址、CLI 的输出 */
function LoginBox({ job, onCancel }: { job: IntegrationLoginJob; onCancel: () => void }) {
  if (job.status !== 'running') {
    return (
      <div className="mt-3 rounded-lg bg-sel/40 p-3">
        <p className={cn('text-[0.8125rem]', job.status === 'done' ? 'text-success' : 'text-danger')}>
          {job.status === 'done' ? t('授权完成') : job.error || t('授权没有完成')}
        </p>
        {job.status === 'failed' && job.output && (
          <pre className="mt-2 max-h-32 overflow-auto text-[0.6875rem] whitespace-pre-wrap text-subtle">
            {job.output}
          </pre>
        )}
      </div>
    )
  }
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg bg-sel/40 p-3">
      <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
        {t('等待浏览器完成授权…')}
      </p>
      {job.code && (
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <span className="text-subtle">{t('一次性授权码')}</span>
          <CopyText text={job.code} title={t('复制授权码')} />
          <span className="text-subtle">{t('在浏览器里输入这个码')}</span>
        </div>
      )}
      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-[0.8125rem] text-accent-text hover:underline"
        >
          <LogIn className="h-3.5 w-3.5" />
          {t('打开授权页面')}
        </a>
      )}
      {job.output && (
        <pre className="max-h-32 overflow-auto text-[0.6875rem] whitespace-pre-wrap text-subtle">{job.output}</pre>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('取消授权')}
        </Button>
      </div>
    </div>
  )
}
