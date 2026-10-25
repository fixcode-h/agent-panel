import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  CircleAlert,
  CircleCheck,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react'
import type { Project } from '@shared/schema'
import { McpServer, type McpEntry, type McpTestResult } from '@shared/library'
import type { ProjectMcpDetected, ProjectMcpOverview } from '@shared/project-mcp'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { joinArgs, splitArgs } from '@/lib/utils'
import { openAiFix } from '@/lib/ai-fix'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { CliTag } from '@/components/library/parts'

/**
 * 项目设置里的 MCP：面板管理的工具（写进各 Agent 的全局配置，和「MCP 工具」页同一份数据）+
 * 项目目录里识别到的配置（只读，导入前一直留在用户自己的文件里）。
 * 后端见 server/project-mcp.ts，写入复用 mcp-store 那套（只动 mcpServers 里自己那几段）。
 */

/** 「键=值」一行一个 */
const toLines = (r: Record<string, string>, sep: string) =>
  Object.entries(r)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
const fromLines = (s: string, sep: string) =>
  Object.fromEntries(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(sep)
        return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]
      }),
  )

const summary = (s: McpServer) => (s.transport === 'http' ? s.url : `${s.command} ${joinArgs(s.args)}`.trim())

const key = (d: ProjectMcpDetected) => `${d.file}#${d.name}`

export function ProjectMcpSection({ project }: { project?: Project }) {
  const [data, setData] = useState<ProjectMcpOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState<McpEntry | 'new' | null>(null)
  const [del, setDel] = useState<McpEntry | null>(null)
  // 导入确认：一次一条或全部
  const [confirm, setConfirm] = useState<{ file: string; name: string }[] | null>(null)
  const [importing, setImporting] = useState(false)

  const load = () => {
    if (!project) return
    setLoading(true)
    api
      .projectMcp(project.id)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    setData(null)
    load()
    // load 每次渲染都是新的函数，只在换了项目时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  /**
   * 让 AI 排查：把项目路径、这一条的配置原文、连接测试的报错一起交过去；修完刷新列表。
   * 走的是页面通用的「AI 处理」（web/src/lib/ai-fix.ts），不另做弹窗。
   */
  const diagnose = async (
    target?: { name: string; server: McpServer; origin: string; raw: string },
    known?: string,
  ) => {
    if (!project) return
    let test: McpTestResult | undefined
    if (target) {
      test =
        known === undefined
          ? await api
              .testProjectMcp(target.server)
              .catch((e) => ({ ok: false, error: (e as Error).message, tools: [] }))
          : { ok: false, error: known, tools: [] }
    }
    const context = [
      t('项目：{name}（{path}）', { name: project.name, path: project.path }),
      target && t('这一条的来源：{origin}', { origin: target.origin }),
      target && t('当前配置：\n{raw}', { raw: target.raw }),
      data?.detected.length
        ? t('项目里识别到的配置：\n{list}', {
            list: data.detected.map((d) => `${d.file} → ${d.name}\n${d.raw}`).join('\n\n'),
          })
        : '',
      data?.servers.length
        ? t('面板管理的配置（各 Agent 的全局配置）：\n{list}', {
            list: data.servers
              .map((s) => `${s.name}（${s.transport}），装在：${s.clis.join('、') || t('没有')}`)
              .join('\n'),
          })
        : '',
      data?.errors.length
        ? t('读不懂的配置文件：\n{list}', {
            list: data.errors.map((e) => `${e.file}：${e.error}`).join('\n'),
          })
        : '',
    ].filter(Boolean)
    openAiFix({
      title: target ? t('项目的 MCP「{name}」', { name: target.name }) : t('项目的 MCP 配置'),
      error: test && !test.ok ? (test.error ?? '') : '',
      output: test?.ok ? t('连接成功，{n} 个工具', { n: test.tools.length }) : '',
      context: context.join('\n\n'),
      cwd: project.path,
      topic: 'project-mcp',
      home: { kind: 'project', projectId: project.id },
      // 修完可能是改了文件，也可能是装了包：重新读一遍列表
      onDone: load,
    })
  }

  const doImport = async () => {
    if (!project || !confirm?.length) return
    setImporting(true)
    try {
      const r = await api.importProjectMcp(project.id, confirm)
      setData(r.overview)
      if (r.done.length) toast.success(t('已导入 {n} 条配置', { n: r.done.length }))
      if (r.skipped.length)
        toast.error(t('{n} 条没有导入：{reason}', { n: r.skipped.length, reason: r.skipped[0].reason }))
      setConfirm(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  if (!project)
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Intro />
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[0.8125rem] text-subtle">
          {t('先创建项目，再管这个项目的 MCP 配置。')}
        </p>
      </div>
    )

  const todo = (data?.detected ?? []).filter((d) => d.nameOk && d.status !== 'same')

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <Intro
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {t('重新识别')}
            </Button>
            <Button size="sm" onClick={() => setEdit('new')} disabled={!data}>
              <Plus className="h-3.5 w-3.5" />
              {t('添加')}
            </Button>
          </div>
        }
      />
      {error ? (
        <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !data ? (
        <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
      ) : (
        <>
          {!project.path ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[0.8125rem] text-subtle">
              {t('这个项目还没设本地目录，所以识别不到项目里的配置。在「常规」里填好目录并保存后再回来。')}
            </p>
          ) : (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[0.8125rem] font-medium">{t('项目里识别到的配置')}</h3>
                <span className="text-[0.75rem] text-subtle">
                  {data.detected.length ? t('共 {n} 条', { n: data.detected.length }) : t('没有找到')}
                </span>
                {todo.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    onClick={() => setConfirm(todo.map((d) => ({ file: d.file, name: d.name })))}
                  >
                    {t('全部导入（{n}）', { n: todo.length })}
                  </Button>
                )}
              </div>
              {!data.detected.length ? (
                <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[0.75rem] leading-relaxed text-subtle">
                  {t(
                    '没找到项目里的 MCP 配置。支持 .mcp.json、.claude/settings*.json、.cursor/mcp.json、.vscode/mcp.json、.gemini/settings.json、.codex/config.toml。',
                  )}
                </p>
              ) : (
                <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
                  {data.detected.map((d) => (
                    <li key={key(d)} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      {d.server.transport === 'http' ? (
                        <Globe className="h-4 w-4 shrink-0 text-accent" />
                      ) : (
                        <Terminal className="h-4 w-4 shrink-0 text-accent" />
                      )}
                      <div className="min-w-0 flex-[1_1_240px]">
                        <p className="flex items-center gap-2 font-mono text-[0.84375rem]">
                          <span className="truncate">{d.name}</span>
                          <StatusBadge status={d.status} />
                        </p>
                        <p className="truncate font-mono text-[0.75rem] text-muted" title={summary(d.server)}>
                          {summary(d.server) || t('（没有填命令或地址）')}
                        </p>
                        <p className="truncate text-[0.71875rem] text-subtle" title={d.file}>
                          {d.file} · {d.source}
                        </p>
                      </div>
                      <span className="flex items-center gap-0.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirm([{ file: d.file, name: d.name }])}
                          disabled={!d.nameOk || d.status === 'same'}
                          title={!d.nameOk ? t('名字里有空格或特殊字符，导入前要在项目文件里改名') : undefined}
                        >
                          {d.status === 'same' ? t('已导入') : d.status === 'different' ? t('覆盖全局配置') : t('导入')}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('用 AI 排查这条')}
                          title={t('用 AI 排查这条')}
                          onClick={() =>
                            void diagnose({
                              name: d.name,
                              server: d.server,
                              origin: `${d.file}（${d.source}）`,
                              raw: d.raw,
                            })
                          }
                        >
                          <Wand2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!!data.errors.length && (
                <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[0.75rem]">
                  {data.errors.map((e) => (
                    <li key={e.file} className="flex gap-2">
                      <span className="shrink-0 font-mono">{e.file}</span>
                      <span className="min-w-0 flex-1 text-muted">{e.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[0.8125rem] font-medium">{t('面板管理的工具')}</h3>
              <span className="text-[0.75rem] text-subtle">
                {data.servers.length ? t('共 {n} 条', { n: data.servers.length }) : ''}
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void diagnose()}>
                <Wand2 className="h-3.5 w-3.5 text-accent" />
                {t('用 AI 排查整页')}
              </Button>
            </div>
            {!data.servers.length ? (
              <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[0.8125rem] text-subtle">
                {t('还没有面板管理的 MCP 工具：点右上角「添加」，或导入上面识别到的配置。')}
              </p>
            ) : (
              <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
                {data.servers.map((s) => (
                  <li key={s.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    {s.transport === 'http' ? (
                      <Globe className="h-4 w-4 shrink-0 text-accent" />
                    ) : (
                      <Terminal className="h-4 w-4 shrink-0 text-accent" />
                    )}
                    <div className="min-w-0 flex-[1_1_240px]">
                      <p className="truncate font-mono text-[0.84375rem]">{s.name}</p>
                      <p className="truncate font-mono text-[0.75rem] text-muted" title={summary(s)}>
                        {summary(s)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      {data.clis.map((c) => (
                        <label
                          key={c.id}
                          className="flex cursor-pointer items-center gap-2 text-[0.78125rem] text-muted"
                        >
                          <Switch
                            checked={s.clis.includes(c.id)}
                            onCheckedChange={(on) => void toggle(s, c.id, on)}
                            aria-label={t('在 {cli} 里启用', { cli: c.name })}
                          />
                          <CliTag id={c.id} name={c.name} className="border-0 bg-transparent px-0" />
                        </label>
                      ))}
                    </div>
                    <span className="flex items-center gap-0.5">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('编辑')}
                        title={t('编辑')}
                        onClick={() => setEdit(s)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('删除')}
                        title={t('删除')}
                        onClick={() => setDel(s)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[0.75rem] leading-relaxed text-subtle">
              {t('配置文件：')}
              {data.clis.map((c) => `${c.name} ${c.file}`).join(t('；'))}
            </p>
          </section>
        </>
      )}

      {data && edit && (
        <EditDialog
          entry={edit === 'new' ? undefined : edit}
          clis={data.clis}
          projectId={project.id}
          onClose={() => setEdit(null)}
          onSaved={(d) => {
            setData(d)
            setEdit(null)
          }}
          onDiagnose={(server, err) =>
            void diagnose(
              { name: server.name, server, origin: t('编辑中的配置'), raw: JSON.stringify(server, null, 2) },
              err,
            )
          }
        />
      )}
      <ConfirmDialog
        open={!!confirm?.length}
        onOpenChange={(o) => !o && !importing && setConfirm(null)}
        title={
          confirm?.length === 1
            ? t('导入「{name}」？', { name: confirm[0].name })
            : t('导入这 {n} 条配置？', { n: confirm?.length ?? 0 })
        }
        description={t(
          '写进各 Agent 的全局配置文件，之后由面板管理；项目里的配置文件不会改动。同名且配置不同的会覆盖全局那一份。',
        )}
        confirmText={t('导入')}
        onConfirm={doImport}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={t('删除「{name}」？', { name: del?.name ?? '' })}
        description={t('会从所有 Agent 的配置文件里移除这个工具。')}
        onConfirm={async () => {
          try {
            setData(await api.deleteProjectMcp(project.id, del!.name))
            setDel(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </div>
  )

  async function toggle(s: McpEntry, cli: string, on: boolean) {
    try {
      setData(await api.saveProjectMcp(project!.id, s, on ? [...s.clis, cli] : s.clis.filter((c) => c !== cli)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
}

function Intro({ action }: { action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-3 pb-1">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="text-[0.9375rem] font-semibold">{t('MCP 工具')}</h3>
        <p className="text-[0.78125rem] leading-relaxed text-subtle">
          {t(
            'MCP 工具让 Agent 连上外部的服务和数据。这里管当前项目用的 MCP：面板写进各 Agent 的全局配置文件（和「MCP 工具」页是同一份），项目目录里已有的配置只读识别出来、可以一键导入。这里的改动立即生效，不用下面的按钮保存。',
          )}
        </p>
      </div>
      {action}
    </div>
  )
}

const STATUS = {
  new: { label: t('只在项目里'), cls: 'bg-accent/10 text-accent' },
  same: { label: t('和各 Agent 的配置一致'), cls: 'bg-success/10 text-success' },
  different: { label: t('和各 Agent 的配置不同'), cls: 'bg-warning/10 text-warning' },
} as const

function StatusBadge({ status }: { status: ProjectMcpDetected['status'] }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[0.65625rem] ${STATUS[status].cls}`}>
      {STATUS[status].label}
    </span>
  )
}

/** 增删改一条面板管理的工具：和「MCP 工具」页的编辑弹窗同一个形状，保存走项目接口 */
function EditDialog({
  entry,
  clis,
  projectId,
  onClose,
  onSaved,
  onDiagnose,
}: {
  entry?: McpEntry
  clis: ProjectMcpOverview['clis']
  projectId: string
  onClose: () => void
  onSaved: (d: ProjectMcpOverview) => void
  onDiagnose: (server: McpServer, error: string) => void
}) {
  const [name, setName] = useState(entry?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(entry?.transport ?? 'stdio')
  const [command, setCommand] = useState(entry?.command ?? '')
  const [args, setArgs] = useState(joinArgs(entry?.args ?? []))
  const [env, setEnv] = useState(toLines(entry?.env ?? {}, '='))
  const [url, setUrl] = useState(entry?.url ?? '')
  const [headers, setHeaders] = useState(toLines(entry?.headers ?? {}, ': '))
  const [picked, setPicked] = useState<string[]>(entry?.clis ?? clis.map((c) => c.id))
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<McpTestResult | 'running' | null>(null)

  const server = (): McpServer => ({
    name,
    transport,
    command: command.trim(),
    args: splitArgs(args),
    env: fromLines(env, '='),
    url: url.trim(),
    headers: fromLines(headers, ':'),
  })
  const valid =
    /^[A-Za-z0-9][\w-]*$/.test(name) && (transport === 'stdio' ? !!command.trim() : /^https?:\/\//.test(url.trim()))

  const runTest = async () => {
    setTest('running')
    try {
      setTest(await api.testProjectMcp(server()))
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, tools: [] })
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.saveProjectMcp(projectId, server(), picked))
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={entry ? t('编辑 MCP 工具') : t('添加 MCP 工具')}
      footer={
        <>
          <Button variant="secondary" onClick={runTest} disabled={!valid || test === 'running'}>
            {test === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {t('测试连接')}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={!valid || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('名字')}</span>
        <Input
          value={name}
          disabled={!!entry}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="github"
          className="font-mono"
        />
        <span className="text-[0.75rem] text-subtle">
          {name && !/^[A-Za-z0-9][\w-]*$/.test(name) ? t('工具名只能用字母、数字、- 和 _') : t('创建后不能改名')}
        </span>
      </label>
      <Segmented
        label={t('连接方式')}
        value={transport}
        onChange={(v) => {
          setTransport(v)
          setTest(null)
        }}
        options={[
          { id: 'stdio', label: t('本地命令') },
          { id: 'http', label: t('远程地址') },
        ]}
      />
      {transport === 'stdio' ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('启动命令')}</span>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('参数')}</span>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem ~/projects"
              className="font-mono"
            />
            <span className="text-[0.75rem] text-subtle">{t('用空格分开，含空格的参数加引号')}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('环境变量')}</span>
            <Textarea
              rows={3}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="API_KEY=..."
              spellCheck={false}
              className="font-mono text-[0.78125rem]"
            />
            <span className="text-[0.75rem] text-subtle">{t('一行一个，写成 名字=值')}</span>
          </label>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('地址')}</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('请求头')}</span>
            <Textarea
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder="Authorization: Bearer ..."
              spellCheck={false}
              className="font-mono text-[0.78125rem]"
            />
            <span className="text-[0.75rem] text-subtle">{t('一行一个，写成 名字: 值')}</span>
          </label>
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-[0.8125rem] font-medium">{t('装进哪些 Agent')}</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {clis.map((c) => (
            <Checkbox
              key={c.id}
              checked={picked.includes(c.id)}
              onChange={(v) => setPicked((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
              label={c.name}
            />
          ))}
        </div>
      </div>
      {test && test !== 'running' && (
        <div
          className={`rounded-lg border px-3 py-2.5 text-[0.78125rem] ${test.ok ? 'border-success/40 bg-success/8' : 'border-warning/40 bg-warning/8'}`}
        >
          <p className="flex items-center gap-1.5 font-medium">
            {test.ok ? (
              <CircleCheck className="h-4 w-4 text-success" />
            ) : (
              <CircleAlert className="h-4 w-4 text-warning" />
            )}
            {test.ok
              ? t('连接成功，{n} 个工具', { n: test.tools.length })
              : t('连接失败：{error}', { error: test.error ?? '' })}
          </p>
          {!test.ok && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onDiagnose(server(), test.error ?? '')}
            >
              <Wand2 className="h-3.5 w-3.5 text-accent" />
              {t('用 AI 排查修复')}
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}
