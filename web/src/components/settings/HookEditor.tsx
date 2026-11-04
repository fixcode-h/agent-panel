import { useEffect, useState } from 'react'
import { CircleAlert, FlaskConical, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import type { HookDef, HookDefInput, HookEventName, ToolKind } from '@shared/hook-defs'
import { t } from '@shared/i18n'
import { hooksApi, type HookTestView } from '@/lib/api-hooks'
import { useData } from '@/lib/data'
import { toastError } from '@/lib/toast'
import { Modal } from '@/components/ui/modal'
import { Field, Input, Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { HOOK_EVENTS, eventHint, eventLabel } from './hook-labels'

/** 新建命令钩子时的脚本骨架：读 stdin 的统一格式 JSON，按事件写出 JSON；什么都不写就是不表态 */
const SCRIPT_TEMPLATE = `// 面板把这次触发的信息以 JSON 交给 stdin（字段见设置页的说明），往 stdout 写一个 JSON；什么都不写就是放行
let raw = ''
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const input = JSON.parse(raw)
  // 例：工具前拒绝改某类文件
  // if (input.tool?.kind === 'edit' && String(input.tool.input.file_path).endsWith('.lock'))
  //   process.stdout.write(JSON.stringify({ deny: true, reason: '锁文件不要手改' }))
})
`

const blank = (): HookDefInput => ({
  id: '',
  name: '',
  description: '',
  event: 'tool.before',
  scope: { projects: [], agents: [], clis: [] },
  match: { tool: 'any', path: '', command: '' },
  action: { type: 'command', script: SCRIPT_TEMPLATE },
  timeoutSec: 5,
  onError: 'allow',
  enabled: false,
  createdBy: 'user',
})

/**
 * 编辑一个用户钩子（ADR 0049 第二期）：名称、事件、范围、匹配、动作、超时、出错时怎么办；保存前服务端会校验
 * （语法、密钥、字段搭配），「试跑」用示例输入跑一次，看原始输出和面板读出来的决定
 */
export function HookEditor({
  open,
  initial,
  support,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  initial?: HookDef
  support: { id: string; name: string; events: HookEventName[] }[]
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const { projects, agents } = useData()
  const [d, setD] = useState<HookDefInput>(blank())
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<HookTestView | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    if (!open) return
    setD(initial ? structuredClone(initial) : blank())
    setErrors([])
    setWarnings([])
    setTest(null)
  }, [open, initial])
  const set = (patch: Partial<HookDefInput>) => setD((x) => ({ ...x, ...patch }))
  const scope = { projects: [], agents: [], clis: [], ...d.scope }
  const match = { tool: 'any' as ToolKind, path: '', command: '', ...d.match }
  const tool = d.event.startsWith('tool.')
  const toggle = (key: 'projects' | 'agents' | 'clis', id: string, on: boolean) =>
    set({ scope: { ...scope, [key]: on ? [...scope[key], id] : scope[key].filter((x) => x !== id) } })

  const save = async () => {
    setSaving(true)
    try {
      const r = await hooksApi.save(d)
      setWarnings(r.warnings)
      onSaved()
      onOpenChange(false)
    } catch (e) {
      const body = (e as { body?: { errors?: string[]; warnings?: string[] } }).body
      if (body?.errors?.length) {
        setErrors(body.errors)
        setWarnings(body.warnings ?? [])
      } else toastError(e)
    } finally {
      setSaving(false)
    }
  }
  const runTest = async () => {
    setTesting(true)
    try {
      const r = await hooksApi.test(d)
      setTest(r)
      setErrors(r.errors)
      setWarnings(r.warnings)
    } catch (e) {
      const body = (e as { body?: { errors?: string[] } }).body
      if (body?.errors) setErrors(body.errors)
      else toastError(e)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={initial ? t('编辑钩子') : t('新建钩子')}
      footer={
        <>
          <Button variant="secondary" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {t('试跑')}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={saving || !d.name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('名称')}>
            <Input
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t('例如：锁文件不要手改')}
            />
          </Field>
          <Field label={t('事件')} hint={eventHint(d.event)}>
            <Select
              value={d.event}
              onChange={(e) => set({ event: e.target.value as HookEventName })}
              options={HOOK_EVENTS.map((e) => ({ value: e, label: eventLabel(e) }))}
            />
          </Field>
        </div>
        <Field label={t('说明')}>
          <Input
            value={d.description ?? ''}
            onChange={(e) => set({ description: e.target.value })}
            placeholder={t('一句话说明它做什么')}
          />
        </Field>
        <Block
          label={t('哪些 CLI')}
          hint={t('都不选表示全部；不支持这个事件的 CLI 不会触发：{list}', {
            list:
              support
                .filter((s) => !s.events.includes(d.event))
                .map((s) => s.name)
                .join('、') || t('无'),
          })}
        >
          <div className="flex flex-wrap gap-3">
            {support.map((s) => (
              <Checkbox
                key={s.id}
                label={s.name}
                checked={scope.clis.includes(s.id)}
                onChange={(on) => toggle('clis', s.id, on)}
              />
            ))}
          </div>
        </Block>
        <div className="grid gap-4 sm:grid-cols-2">
          <Block label={t('哪些项目')} hint={t('都不选表示全部')}>
            <div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto">
              {projects.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.name}
                  checked={scope.projects.includes(p.id)}
                  onChange={(on) => toggle('projects', p.id, on)}
                />
              ))}
            </div>
          </Block>
          <Block label={t('哪些角色')} hint={t('都不选表示全部')}>
            <div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto">
              {agents.map((a) => (
                <Checkbox
                  key={a.id}
                  label={a.name}
                  checked={scope.agents.includes(a.id)}
                  onChange={(on) => toggle('agents', a.id, on)}
                />
              ))}
            </div>
          </Block>
        </div>
        {tool && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('工具')}>
              <Select
                value={match.tool}
                onChange={(e) => set({ match: { ...match, tool: e.target.value as ToolKind } })}
                options={[
                  { value: 'any', label: t('全部') },
                  { value: 'edit', label: t('改文件') },
                  { value: 'shell', label: t('跑命令') },
                  { value: 'read', label: t('读文件、搜索') },
                  { value: 'panel', label: t('面板工具') },
                ]}
              />
            </Field>
            <Field label={t('文件路径')} hint={t('相对项目根的通配，例如 src/**/*.ts')}>
              <Input value={match.path} onChange={(e) => set({ match: { ...match, path: e.target.value } })} />
            </Field>
            <Field
              label={match.tool === 'panel' ? t('工具名') : t('命令开头')}
              hint={match.tool === 'panel' ? t('面板工具的名字，例如 submit_merge') : t('例如 git push')}
            >
              <Input value={match.command} onChange={(e) => set({ match: { ...match, command: e.target.value } })} />
            </Field>
          </div>
        )}
        <Block label={t('动作')}>
          <Segmented
            label={t('动作')}
            value={d.action.type}
            onChange={(v) =>
              set({
                action:
                  v === 'command'
                    ? { type: 'command', script: SCRIPT_TEMPLATE }
                    : { type: 'http', url: 'https://', headers: [] },
              })
            }
            options={[
              { id: 'command', label: t('运行脚本') },
              { id: 'http', label: t('发 HTTP 请求') },
            ]}
          />
        </Block>
        {d.action.type === 'command' ? (
          <Field
            label={t('Node 脚本')}
            hint={t('stdin 进一段 JSON，stdout 写一个 JSON 或什么都不写；要用密钥就从 process.env 读，不要写进脚本')}
          >
            <Textarea
              className="min-h-56 font-mono text-xs"
              spellCheck={false}
              value={d.action.script}
              onChange={(e) => set({ action: { type: 'command', script: e.target.value } })}
            />
          </Field>
        ) : (
          <HttpFields action={d.action} onChange={(action) => set({ action })} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('超时（秒）')}>
            <Input
              type="number"
              min={1}
              max={60}
              value={d.timeoutSec ?? 5}
              onChange={(e) => set({ timeoutSec: Math.max(1, Math.min(60, Number(e.target.value) || 5)) })}
            />
          </Field>
          <Field label={t('出错时')} hint={t('超时、退出码不是 0、输出不是 JSON 都算出错')}>
            <Select
              value={d.onError ?? 'allow'}
              onChange={(e) => set({ onError: e.target.value as 'allow' | 'deny' })}
              options={[
                { value: 'allow', label: t('放行') },
                { value: 'deny', label: t('拒绝这次工具调用（只对工具前）') },
              ]}
            />
          </Field>
        </div>
        <Messages errors={errors} warnings={warnings} />
        {test && (
          <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-body">
            <span className="text-xs text-subtle">{t('试跑结果（{ms} 毫秒）', { ms: test.ms })}</span>
            {test.error ? (
              <span className="text-danger">{test.error}</span>
            ) : (
              <pre className="font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(test.out ?? {}, null, 2) === '{}'
                  ? t('不表态（放行）')
                  : JSON.stringify(test.out, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function HttpFields({
  action,
  onChange,
}: {
  action: Extract<HookDefInput['action'], { type: 'http' }>
  onChange: (a: Extract<HookDefInput['action'], { type: 'http' }>) => void
}) {
  const headers = action.headers ?? []
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('地址')} hint={t('面板把同样的 JSON POST 过去，响应体按同样的格式读')}>
        <Input value={action.url} onChange={(e) => onChange({ ...action, url: e.target.value })} />
      </Field>
      <Block label={t('请求头')} hint={t('值只能引用环境变量：密钥不进钩子定义，也就不会跟着导出出去')}>
        <div className="flex flex-col gap-2">
          {headers.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={h.key}
                placeholder={t('名称')}
                onChange={(e) =>
                  onChange({ ...action, headers: headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })
                }
              />
              <Input
                value={h.env}
                placeholder={t('环境变量名')}
                onChange={(e) =>
                  onChange({ ...action, headers: headers.map((x, j) => (j === i ? { ...x, env: e.target.value } : x)) })
                }
              />
              <IconButton
                icon={Trash2}
                label={t('删除')}
                onClick={() => onChange({ ...action, headers: headers.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => onChange({ ...action, headers: [...headers, { key: '', env: '' }] })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('加一个请求头')}
          </Button>
        </div>
      </Block>
    </div>
  )
}

/** 里面有好几个控件的一项：不能用 Field（它是 label，点到哪儿都会去点第一个控件） */
function Block({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </div>
  )
}

function Messages({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      {errors.map((e) => (
        <p key={e} className="flex items-start gap-1.5 text-body text-danger">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {e}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-body text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {w}
        </p>
      ))}
    </div>
  )
}
