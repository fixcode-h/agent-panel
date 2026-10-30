import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { CircleAlert, CircleCheck, Globe, Loader2, Pencil, Plus, Terminal, Trash2, Wand2, Zap } from 'lucide-react'
import { McpServer, type McpEntry, type McpOverview, type McpTestResult } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { CliTag, PageFrame } from '@/components/library/parts'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { McpJsonFill } from '@/components/library/McpJsonFill'
import type { McpDraft } from '@shared/mcp-json'

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

export function McpPage() {
  const [data, setData] = useState<McpOverview | null>(null)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<McpEntry | 'new' | null>(null)
  const [del, setDel] = useState<McpEntry | null>(null)

  useEffect(() => {
    api
      .mcpTools()
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [])

  const toggle = async (s: McpEntry, cli: string, on: boolean) => {
    try {
      setData(await api.saveMcpTool(s, on ? [...s.clis, cli] : s.clis.filter((c) => c !== cli)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <PageFrame
      title={t('MCP 工具')}
      intro={t(
        'MCP 工具让 Agent 能连上外部的服务和数据（文档、数据库、浏览器…）。这里直接读写各个 Agent 自己的配置文件，装在哪个 Agent 里由右边的开关决定；用 Agent 自己的命令装的也会列出来。',
      )}
      actions={
        <Button onClick={() => setEdit('new')} disabled={!data}>
          <Plus className="h-4 w-4" />
          {t('添加')}
        </Button>
      }
    >
      {error ? (
        <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !data ? (
        <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
      ) : !data.servers.length ? (
        <EmptyPanel size="xl">{t('还没有装 MCP 工具，点右上角「添加」。')}</EmptyPanel>
      ) : (
        <Card as="ul" className="flex flex-col divide-y overflow-hidden">
          {data.servers.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              {s.transport === 'http' ? (
                <Globe className="h-4 w-4 shrink-0 text-accent-text" />
              ) : (
                <Terminal className="h-4 w-4 shrink-0 text-accent-text" />
              )}
              <div className="min-w-0 flex-[1_1_240px]">
                <p className="truncate font-mono text-[0.8125rem]">{s.name}</p>
                <p className="truncate font-mono text-[0.75rem] text-muted" title={summary(s)}>
                  {summary(s)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {data.clis.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
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
        </Card>
      )}
      {data && (
        <p className="text-[0.75rem] leading-relaxed text-subtle">
          {t('配置文件：')}
          {data.clis.map((c) => `${c.name} ${c.file}`).join('；')}
          {t('。Command Code 的 MCP 配置面板暂不管理。')}
        </p>
      )}

      {data && edit && (
        <EditDialog
          entry={edit === 'new' ? undefined : edit}
          data={data}
          onClose={() => setEdit(null)}
          onSaved={(d) => {
            setData(d)
            setEdit(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={t('删除「{name}」？', { name: del?.name ?? '' })}
        description={t('会从所有 Agent 的配置文件里移除这个工具。')}
        onConfirm={async () => {
          try {
            setData(await api.deleteMcpTool(del!.name))
            setDel(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </PageFrame>
  )
}

const summary = (s: McpServer) => (s.transport === 'http' ? s.url : `${s.command} ${joinArgs(s.args)}`.trim())

function EditDialog({
  entry,
  data,
  onClose,
  onSaved,
}: {
  entry?: McpEntry
  data: McpOverview
  onClose: () => void
  onSaved: (d: McpOverview) => void
}) {
  const [name, setName] = useState(entry?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(entry?.transport ?? 'stdio')
  const [command, setCommand] = useState(entry?.command ?? '')
  const [args, setArgs] = useState(joinArgs(entry?.args ?? []))
  const [env, setEnv] = useState(toLines(entry?.env ?? {}, '='))
  const [url, setUrl] = useState(entry?.url ?? '')
  const [headers, setHeaders] = useState(toLines(entry?.headers ?? {}, ': '))
  const [clis, setClis] = useState<string[]>(entry?.clis ?? data.clis.map((c) => c.id))
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<McpTestResult | 'running' | null>(null)
  // 让 AI 排查时带去的当前配置和报错（打开那一刻的快照）
  const [ai, setAi] = useState<Record<string, string> | null>(null)

  const server = (): McpServer => ({
    name,
    transport,
    command: command.trim(),
    args: splitArgs(args),
    env: fromLines(env, '='),
    url: url.trim(),
    headers: fromLines(headers, ':'),
  })
  // 粘贴 JSON 分析出来的配置：编辑已有工具时名字不能改，只换其余各项
  const fillFrom = (d: McpDraft) => {
    if (!entry && d.name) setName(d.name)
    setTransport(d.transport)
    setCommand(d.command)
    setArgs(joinArgs(d.args))
    setEnv(toLines(d.env, '='))
    setUrl(d.url)
    setHeaders(toLines(d.headers, ': '))
    setTest(null)
  }
  const valid =
    /^[A-Za-z0-9][\w-]*$/.test(name) && (transport === 'stdio' ? !!command.trim() : /^https?:\/\//.test(url.trim()))
  const taken = !entry && data.servers.some((s) => s.name === name)

  const runTest = async () => {
    setTest('running')
    try {
      setTest(await api.testMcpTool(server()))
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, tools: [] })
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.saveMcpTool(server(), clis))
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
          <span className="flex-1 text-[0.75rem] text-warning">{taken ? t('已经有同名的工具了') : ''}</span>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={!valid || taken || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <McpJsonFill onFill={fillFrom} />
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
              className="font-mono text-[0.75rem]"
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
              className="font-mono text-[0.75rem]"
            />
            <span className="text-[0.75rem] text-subtle">{t('一行一个，写成 名字: 值')}</span>
          </label>
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-[0.8125rem] font-medium">{t('装进哪些 Agent')}</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {data.clis.map((c) => (
            <Checkbox
              key={c.id}
              checked={clis.includes(c.id)}
              onChange={(v) => setClis((p) => (v ? [...p, c.id] : p.filter((x) => x !== c.id)))}
              label={c.name}
            />
          ))}
        </div>
      </div>
      {ai && (
        <AssistDialog
          open
          onOpenChange={(o) => !o && setAi(null)}
          kind="mcp"
          title={name}
          subject={ai}
          autoStart={t('帮我排查这个工具为什么连不上，找到原因并修复配置。')}
          onApply={(p) => {
            if (p.kind !== 'mcp') return
            const v = p.server
            setTransport(v.transport)
            setCommand(v.command)
            setArgs(joinArgs(v.args))
            setEnv(toLines(v.env, '='))
            setUrl(v.url)
            setHeaders(toLines(v.headers, ': '))
            setTest(null)
            toast.success(t('已填入修复后的配置，可以再点「测试连接」确认'))
          }}
        />
      )}
      {test && test !== 'running' && (
        <div className={`rounded-lg px-3 py-2.5 text-[0.75rem] ${test.ok ? 'bg-success/8' : 'bg-warning/8'}`}>
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
              onClick={() =>
                setAi({
                  name,
                  server: JSON.stringify(server(), null, 2),
                  error: test.error ?? '',
                  clis: clis.map((id) => data.clis.find((c) => c.id === id)?.name ?? id).join('、'),
                })
              }
            >
              <Wand2 className="h-3.5 w-3.5 text-accent-text" />
              {t('用 AI 排查修复')}
            </Button>
          )}
          {!!test.tools.length && (
            <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {test.tools.map((x) => (
                <li key={x.name} className="flex gap-2">
                  <span className="shrink-0 font-mono">{x.name}</span>
                  <span className="line-clamp-1 text-muted">{x.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}
