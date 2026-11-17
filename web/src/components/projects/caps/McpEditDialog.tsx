import { useState } from 'react'
import { toast } from '@/lib/toast'
import { CircleAlert, CircleCheck, Loader2, Wand2, Zap } from 'lucide-react'
import type { McpServer, McpEntry, McpTestResult } from '@shared/library'
import type { ProjectMcpOverview } from '@shared/projects/mcp'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
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

export const mcpSummary = (s: McpServer) => (s.transport === 'http' ? s.url : `${s.command} ${joinArgs(s.args)}`.trim())

/** 增删改一条面板管理的工具：和「MCP 工具」页的编辑弹窗同一个形状，保存走项目接口 */
export function McpEditDialog({
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
      <McpJsonFill onFill={fillFrom} />
      <label className="flex flex-col gap-1.5">
        <span className="text-body font-medium">{t('名字')}</span>
        <Input
          value={name}
          disabled={!!entry}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="github"
          className="font-mono"
        />
        <span className="text-footnote text-subtle">
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
            <span className="text-body font-medium">{t('启动命令')}</span>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium">{t('参数')}</span>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem ~/projects"
              className="font-mono"
            />
            <span className="text-footnote text-subtle">{t('用空格分开，含空格的参数加引号')}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium">{t('环境变量')}</span>
            <Textarea
              rows={3}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="API_KEY=..."
              spellCheck={false}
              className="font-mono text-footnote"
            />
            <span className="text-footnote text-subtle">{t('一行一个，写成 名字=值')}</span>
          </label>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium">{t('地址')}</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium">{t('请求头')}</span>
            <Textarea
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder="Authorization: Bearer ..."
              spellCheck={false}
              className="font-mono text-footnote"
            />
            <span className="text-footnote text-subtle">{t('一行一个，写成 名字: 值')}</span>
          </label>
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-body font-medium">{t('装进哪些 Agent')}</span>
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
          className={`rounded-lg border px-3 py-2.5 text-footnote ${test.ok ? 'border-success/40 bg-success/8' : 'border-warning/40 bg-warning/8'}`}
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
              <Wand2 className="h-3.5 w-3.5 text-accent-text" />
              {t('用 AI 排查修复')}
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}
