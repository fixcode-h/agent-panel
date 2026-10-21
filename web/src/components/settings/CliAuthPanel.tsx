import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ExternalLink, Loader2, LogIn, LogOut, Pencil, Save, Trash2, User, X } from 'lucide-react'
import { getCli, type CliDefinition } from '@shared/clis'
import { API_PROTOCOL_LABEL, apiFits, type ApiConfig } from '@shared/accounts'
import type { CliAccounts, LoginJob } from '@shared/schema'
import { api } from '@/lib/api'
import { DetectedApis } from './DetectedApis'
import { AiFixButton } from '@/components/ui/ai-fix'
import { loadCliModels } from '@/lib/cli-models'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Group, Row } from './parts'
import { t } from '@shared/i18n'

/**
 * CLI 的「登录方式」：账号（浏览器登录，可以存好几个账号随时切换）或 API（全局设置里配的接口和密钥）。
 * 两种方式的模型下拉各列各的，改完保存后马上重新读
 */
export function CliAuthPanel({
  def,
  mode,
  apiId,
  apis,
  onMode,
  onApi,
  onGoApis,
  onAddApi,
}: {
  def: CliDefinition
  mode: 'account' | 'api'
  apiId: string
  apis: ApiConfig[]
  onMode: (m: 'account' | 'api') => void
  onApi: (id: string) => void
  onGoApis: () => void
  onAddApi: (a: ApiConfig) => void
}) {
  const fitting = apis.filter((a) => apiFits(def.auth, a))
  const cur = fitting.find((a) => a.id === apiId)
  return (
    <Group title={t('登录方式')}>
      <Row
        title={t('使用')}
        desc={
          mode === 'account'
            ? t('用浏览器登录的账号，可以保存几个账号随时切换')
            : t(
                '用全局设置里配的 API（接口地址和密钥）；支持写配置的 Agent 会立即保存到它自己的配置，模型下拉优先从 Agent 读取',
              )
        }
        stack
      >
        <Segmented
          label={t('{cli} 登录方式', { cli: def.name })}
          value={mode}
          onChange={(v) => onMode(v as 'account' | 'api')}
          options={[{ id: 'account', label: t('账号') }, ...(def.auth?.api ? [{ id: 'api', label: 'API' }] : [])]}
        />
      </Row>
      {mode === 'api' ? (
        <Row
          title={t('API')}
          desc={t('{cli} 能用 {protocols} 协议的 API', {
            cli: def.name,
            protocols: (def.auth?.api?.protocols ?? []).map((p) => API_PROTOCOL_LABEL[p]).join(' / '),
          })}
          stack
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={t('{cli} 用的 API', { cli: def.name })}
                value={cur?.id ?? ''}
                onChange={(e) => onApi(e.target.value)}
                options={[
                  { value: '', label: fitting.length ? t('选择一个 API') : t('还没有适用的 API') },
                  ...fitting.map((a) => ({ value: a.id, label: a.name })),
                ]}
                className="w-64"
              />
              <Button variant="secondary" size="sm" onClick={onGoApis}>
                {t('管理 API')}
              </Button>
            </div>
            {cur ? (
              <p className="text-[0.78125rem] leading-relaxed text-subtle">
                <span className="font-mono">{cur.baseUrl || t('默认地址')}</span>
                {' · '}
                {cur.models.length ? t('{n} 个模型', { n: cur.models.length }) : t('还没有填模型，去 API 配置里添加')}
              </p>
            ) : (
              <p className="text-[0.78125rem] leading-relaxed text-warning">
                {fitting.length
                  ? t('还没选 API，现在会按 Agent 自己的登录运行')
                  : t('还没有适用的 API：到 API 配置里添加一个 {protocols} 协议的', {
                      protocols: (def.auth?.api?.protocols ?? []).map((p) => API_PROTOCOL_LABEL[p]).join(' / '),
                    })}
              </p>
            )}
            {/* 这个 CLI 自己配置里的 API：存进全局列表后直接选用 */}
            <DetectedApis
              apis={apis}
              cli={def.id}
              filter={(d) => apiFits(def.auth, d.api)}
              onAdd={onAddApi}
              onSaved={(a) => onApi(a.id)}
              selected={cur?.id}
            />
          </div>
        </Row>
      ) : (
        <AccountList def={def} />
      )}
    </Group>
  )
}

/** 账号：现在登录的、保存的几个账号、登录和登出 */
function AccountList({ def }: { def: CliDefinition }) {
  const [data, setData] = useState<CliAccounts>()
  const [busy, setBusy] = useState('')
  const [login, setLogin] = useState<LoginJob | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string }>()
  const load = useCallback(
    () =>
      api
        .accounts()
        .then((l) => setData(l.find((x) => x.cli === def.id)))
        .catch(() => {}),
    [def.id],
  )
  useEffect(() => {
    setData(undefined)
    setLogin(null)
    void load()
    // 页面里可能已经有进行中的登录（切走再回来）
    void api.loginStatus(def.id).then((j) => j?.status === 'running' && setLogin(j))
  }, [def.id, load])
  const refreshModels = () => loadCliModels(def.id, true).catch(() => {})

  // 登录中：每秒问一次进度
  const running = login?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(async () => {
      const j = await api.loginStatus(def.id).catch(() => null)
      if (!j) return
      setLogin(j)
      if (j.status !== 'running') {
        void load()
        if (j.status === 'done') {
          toast.success(t('已登录'))
          void refreshModels()
        }
      }
    }, 1000)
    return () => clearInterval(timer)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [running, def.id, load])

  const run = async (key: string, fn: () => Promise<CliAccounts | void>, done?: string) => {
    setBusy(key)
    try {
      const r = await fn()
      if (r) setData(r)
      if (done) toast.success(done)
      void refreshModels()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const start = async () => {
    setBusy('login')
    try {
      setLogin(await api.loginStart(def.id))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  if (!data) return <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-subtle" />
  const label = data.live.loggedIn ? data.live.label || t('已登录') : t('没有登录')
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-field/40 p-3">
        <User className="h-4 w-4 shrink-0 text-subtle" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.84375rem] font-medium">{label}</p>
          <p className="text-[0.75rem] text-subtle">
            {data.live.loggedIn
              ? data.unsaved
                ? t('这个账号还没保存，保存后才能切换回来')
                : t('现在 {cli} 用的账号', { cli: def.name })
              : t('登录后 {cli} 才能用账号模式运行', { cli: def.name })}
          </p>
        </div>
        {data.unsaved && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() => run('save', () => api.saveAccount(def.id))}
          >
            {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('保存')}
          </Button>
        )}
        {data.canLogin && (
          <Button size="sm" disabled={!!busy || running} onClick={start}>
            {busy === 'login' || running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogIn className="h-3.5 w-3.5" />
            )}
            {data.live.loggedIn ? t('登录其他账号') : t('登录')}
          </Button>
        )}
        {data.live.loggedIn && (
          <Button
            size="sm"
            variant="danger-outline"
            disabled={!!busy || running}
            title={t('从 {cli} 里退出登录；账号会保存着，之后可以切换回来', { cli: def.name })}
            onClick={() => run('logout', () => api.logoutAccount(def.id), t('已登出'))}
          >
            {busy === 'logout' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
            {t('登出')}
          </Button>
        )}
      </div>
      {def.auth?.accountNote && (
        <p className="rounded-xl border border-warning/40 bg-warning/8 px-3 py-2.5 text-[0.78125rem] leading-relaxed">
          {def.auth.accountNote}
        </p>
      )}
      {login && <LoginProgress cli={def.id} job={login} onClose={() => setLogin(null)} />}
      {data.accounts.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t('保存的账号')}>
          {data.accounts.map((a) => (
            <li
              key={a.id}
              className={cn(
                'group flex items-center gap-2 rounded-lg border px-3 py-2',
                a.active ? 'border-accent/50 bg-accent-soft/40' : 'border-transparent hover:bg-sel/60',
              )}
            >
              <span
                className={cn(
                  'grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                  a.active ? 'border-accent bg-accent text-white' : 'border-line-strong',
                )}
              >
                {a.active && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              {renaming?.id === a.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const name = renaming.name
                    setRenaming(undefined)
                    void run('rename', () => api.renameAccount(def.id, a.id, name))
                  }}
                >
                  <Input
                    autoFocus
                    value={renaming.name}
                    maxLength={60}
                    onChange={(e) => setRenaming({ id: a.id, name: e.target.value })}
                    aria-label={t('账号名称')}
                    className="h-8 min-w-0 flex-1 text-[0.8125rem]"
                  />
                  <Button size="icon-sm" type="submit" aria-label={t('保存名称')}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label={t('取消')}
                    onClick={() => setRenaming(undefined)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.84375rem] font-medium">{a.name}</span>
                    {a.email && a.email !== a.name && (
                      <span className="block truncate text-[0.75rem] text-subtle">{a.email}</span>
                    )}
                  </span>
                  {!a.active && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!!busy || running}
                      onClick={() =>
                        run(
                          `s:${a.id}`,
                          () => api.switchAccount(def.id, a.id),
                          t('已切换到「{name}」', { name: a.name }),
                        )
                      }
                    >
                      {busy === `s:${a.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t('切换')}
                    </Button>
                  )}
                  <button
                    type="button"
                    aria-label={t('重命名 {name}', { name: a.name })}
                    title={t('重命名')}
                    onClick={() => setRenaming({ id: a.id, name: a.name })}
                    className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-fg focus-visible:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('删除 {name}', { name: a.name })}
                    title={t('删除（只删除保存的，不影响 Agent 现在的登录）')}
                    onClick={() => run(`d:${a.id}`, () => api.deleteAccount(def.id, a.id))}
                    className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-danger focus-visible:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.75rem] leading-relaxed text-subtle">
        {t('账号的登录凭据只保存在本机的数据目录里。切换账号只替换凭据，{cli} 的其他配置、Skill 和会话都不变。', {
          cli: def.name,
        })}
      </p>
    </div>
  )
}

/** 登录进行中：浏览器会自动打开；没打开就点链接，要粘贴授权码时在这里输入 */
function LoginProgress({ cli, job, onClose }: { cli: string; job: LoginJob; onClose: () => void }) {
  const [code, setCode] = useState('')
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [job.output])
  const running = job.status === 'running'
  const askCode = running && /paste|code|粘贴|授权码/i.test(job.output)
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-3 text-[0.8125rem]',
        job.status === 'failed' && 'border-danger/40 bg-danger/5',
        job.status === 'done' && 'border-success/40 bg-success/5',
      )}
    >
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
        ) : job.status === 'done' ? (
          <Check className="h-4 w-4 shrink-0 text-success" />
        ) : (
          <X className="h-4 w-4 shrink-0 text-danger" />
        )}
        <span className="min-w-0 flex-1 font-medium">
          {running
            ? t('正在登录：在打开的浏览器里完成登录')
            : job.status === 'done'
              ? t('登录成功')
              : t('登录没有完成')}
        </span>
        {job.status === 'failed' && (
          <AiFixButton
            variant="ghost"
            className="h-7 px-2 text-xs"
            issue={() => ({
              title: t('{cli} 登录没有完成', { cli: getCli(cli)?.name ?? cli }),
              error: job.error ?? '',
              output: job.output.slice(-12_000),
              topic: `cli:${cli}`,
            })}
          />
        )}
        {running ? (
          <Button size="sm" variant="ghost" onClick={() => void api.loginCancel(cli)}>
            {t('取消')}
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label={t('关闭')} onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {running && job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit max-w-full items-center gap-1.5 text-accent hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('浏览器没有自动打开？点这里登录')}</span>
        </a>
      )}
      {askCode && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!code.trim()) return
            void api.loginInput(cli, code).catch((err) => toast.error((err as Error).message))
            setCode('')
          }}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('粘贴浏览器里显示的授权码')}
            aria-label={t('授权码')}
            className="h-8 min-w-0 flex-1 font-mono text-[0.78125rem]"
          />
          <Button size="sm" type="submit" disabled={!code.trim()}>
            {t('提交')}
          </Button>
        </form>
      )}
      {job.error && <p className="text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-danger">{job.error}</p>}
      {job.output.trim() && (
        <pre
          ref={box}
          className="max-h-28 overflow-auto rounded-lg bg-field px-2.5 py-2 font-mono text-[0.71875rem] leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]"
        >
          {job.output.trim()}
        </pre>
      )}
    </div>
  )
}
