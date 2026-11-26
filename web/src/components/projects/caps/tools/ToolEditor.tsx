import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { CustomTool, ToolEntry, ToolParam } from '@shared/custom-tools/schema'
import { draftProblems } from '@shared/custom-tools/expand'
import type { ToolRunRes } from '@shared/api-contract/custom-tools'
import { t } from '@shared/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChipListInput } from '@/components/ui/chip-list-input'
import { IconButton } from '@/components/ui/icon-button'
import { Field, FormSection, Input, Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Sheet } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { paramArgs, paramDefaults, ToolParamForm, type ParamValues } from '@/components/ui/tool-param-form'
import { ToolRunResult } from '@/components/ui/tool-run-result'
import { toast, toastError } from '@/lib/toast'
import type { CustomTools } from './use-custom-tools'
import { RoleTab } from './RoleTab'

type Tab = 'basic' | 'run' | 'effect' | 'role' | 'history' | 'try'

/**
 * 自建工具的编辑抽屉（ADR 0082，效果图 5）：基本 / 运行和参数 / 影响和输出 / 用途（ADR 0086）/ 版本 / 试运行。
 * 保存直接写回原来的范围（版本 +1）；id 是 Agent 调用的名字，改了等于换了个工具，所以这里不让改
 */
export function ToolEditor({
  entry,
  tool,
  ct,
  startTab,
  onClose,
}: {
  entry: ToolEntry
  tool: CustomTool
  ct: CustomTools
  startTab?: 'try'
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>(startTab ?? 'basic')
  const [d, setD] = useState<CustomTool>(tool)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(d) !== JSON.stringify(tool)
  const problems = draftProblems(d)
  const set = <K extends keyof CustomTool>(k: K, v: CustomTool[K]) => setD((x) => ({ ...x, [k]: v }))
  const setRun = <K extends keyof CustomTool['run']>(k: K, v: CustomTool['run'][K]) =>
    setD((x) => ({ ...x, run: { ...x.run, [k]: v } }))
  const save = () => {
    setBusy(true)
    ct.save(entry.scope, d, true, note)
      .then((r) => {
        toast.success(t('已保存为 v{n}', { n: r.tool?.version ?? '' }))
        onClose()
      })
      .catch(toastError)
      .finally(() => setBusy(false))
  }
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('{name} · {where}', { name: tool.name, where: entry.scope === 'project' ? t('项目') : t('全局') })}
      width="min(680px, 100%)"
      footer={
        <div className="flex items-center gap-2">
          {problems.length > 0 && <span className="truncate text-footnote text-danger">{problems[0]}</span>}
          <Button variant="secondary" className="ml-auto" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={!dirty || busy || problems.length > 0}>
            {t('保存')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          label={t('编辑哪部分')}
          size="sm"
          options={[
            { id: 'basic', label: t('基本') },
            { id: 'run', label: t('运行和参数') },
            { id: 'effect', label: t('影响和输出') },
            { id: 'role', label: t('用途') },
            { id: 'history', label: t('版本') },
            { id: 'try', label: t('试运行') },
          ]}
        />
        {tab === 'basic' && <BasicTab d={d} set={set} note={note} setNote={setNote} />}
        {tab === 'run' && <RunTab d={d} setRun={setRun} set={set} />}
        {tab === 'effect' && <EffectTab d={d} set={set} />}
        {tab === 'role' && <RoleTab d={d} set={(v) => set('role', v)} />}
        {tab === 'history' && <HistoryTab tool={tool} />}
        {tab === 'try' && <TryTab entry={entry} d={d} dirty={dirty} ct={ct} />}
      </div>
    </Sheet>
  )
}

type SetFn = <K extends keyof CustomTool>(k: K, v: CustomTool[K]) => void

function BasicTab({
  d,
  set,
  note,
  setNote,
}: {
  d: CustomTool
  set: SetFn
  note: string
  setNote: (s: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('中文名')}>
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label={t('id')} hint={t('Agent 调用时用的名字，保存后不能改')}>
          <Input value={d.id} disabled className="font-mono" />
        </Field>
      </div>
      <Field label={t('说明')}>
        <Input value={d.summary} onChange={(e) => set('summary', e.target.value)} />
      </Field>
      <Field label={t('什么时候用')} hint={t('Agent 按这句判断要不要调它，写具体的场景')}>
        <Textarea rows={2} value={d.useWhen} onChange={(e) => set('useWhen', e.target.value)} />
      </Field>
      <Field label={t('什么时候别用')}>
        <Textarea rows={2} value={d.avoidWhen} onChange={(e) => set('avoidWhen', e.target.value)} />
      </Field>
      <Field label={t('标签')}>
        <ChipListInput value={d.tags} onChange={(v) => set('tags', v)} label={t('标签')} placeholder={t('回车添加')} />
      </Field>
      <Field label={t('这一版改了什么')} hint={t('写进版本记录，可以不填')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </div>
  )
}

function RunTab({
  d,
  set,
  setRun,
}: {
  d: CustomTool
  set: SetFn
  setRun: <K extends keyof CustomTool['run']>(k: K, v: CustomTool['run'][K]) => void
}) {
  const setParam = (i: number, p: Partial<ToolParam>) =>
    set(
      'params',
      d.params.map((x, j) => (j === i ? { ...x, ...p } : x)),
    )
  return (
    <div className="flex flex-col gap-4">
      <FormSection title={t('命令')}>
        <Field
          label={t('命令模板')}
          hint={t('参数写成 {{名字}}，面板自带 {{projectRoot}} {{workDir}} {{docRoot}} {{script}}；值会自动加引号')}
        >
          <Textarea
            rows={2}
            className="font-mono"
            value={d.run.command}
            onChange={(e) => setRun('command', e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Windows 上改用')}>
            <Input
              className="font-mono"
              value={d.run.win ?? ''}
              onChange={(e) => setRun('win', e.target.value || undefined)}
            />
          </Field>
          <Field label={t('其他系统上改用')}>
            <Input
              className="font-mono"
              value={d.run.posix ?? ''}
              onChange={(e) => setRun('posix', e.target.value || undefined)}
            />
          </Field>
          <Field label={t('工作目录')} hint={t('相对项目根')}>
            <Input className="font-mono" value={d.run.cwd} onChange={(e) => setRun('cwd', e.target.value)} />
          </Field>
          <Field label={t('限时（秒）')}>
            <Input
              inputMode="numeric"
              value={String(d.run.timeoutSec)}
              onChange={(e) => setRun('timeoutSec', Number(e.target.value) || 0)}
            />
          </Field>
          <Field label={t('放到后台')}>
            <Select
              value={d.run.background}
              onChange={(e) => setRun('background', e.target.value as CustomTool['run']['background'])}
              options={[
                { value: 'auto', label: t('自动（超过两分钟放后台）') },
                { value: 'always', label: t('总是后台') },
                { value: 'never', label: t('总是等结果') },
              ]}
            />
          </Field>
        </div>
        {d.run.script && (
          <Field label={t('脚本（.{ext}）', { ext: d.run.script.ext })}>
            <Textarea
              rows={6}
              className="font-mono"
              value={d.run.script.text}
              onChange={(e) => setRun('script', { ext: d.run.script!.ext, text: e.target.value })}
            />
          </Field>
        )}
      </FormSection>
      <FormSection
        title={t('参数')}
        aside={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              set('params', [
                ...d.params,
                {
                  name: `arg${d.params.length + 1}`,
                  label: '',
                  type: 'string',
                  desc: '',
                  required: false,
                  options: [],
                  inProject: true,
                },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" />
            {t('加参数')}
          </Button>
        }
      >
        {!d.params.length && <p className="text-footnote text-subtle">{t('这个工具没有参数。')}</p>}
        {d.params.map((p, i) => (
          <div
            key={i}
            className="grid grid-cols-2 gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[1fr_1fr_8rem_auto]"
          >
            <Input
              className="font-mono"
              value={p.name}
              aria-label={t('参数名')}
              onChange={(e) => setParam(i, { name: e.target.value })}
            />
            <Input value={p.label} placeholder={t('中文名')} onChange={(e) => setParam(i, { label: e.target.value })} />
            <Select
              aria-label={t('类型')}
              value={p.type}
              onChange={(e) => setParam(i, { type: e.target.value as ToolParam['type'] })}
              options={[
                { value: 'string', label: t('文本') },
                { value: 'number', label: t('数字') },
                { value: 'boolean', label: t('开关') },
                { value: 'enum', label: t('选项') },
                { value: 'path', label: t('路径') },
              ]}
            />
            <IconButton
              icon={Trash2}
              size="sm"
              tone="danger"
              label={t('删掉这个参数')}
              onClick={() =>
                set(
                  'params',
                  d.params.filter((_, j) => j !== i),
                )
              }
            />
            <Input
              className="col-span-2"
              value={p.desc}
              placeholder={t('说明')}
              onChange={(e) => setParam(i, { desc: e.target.value })}
            />
            <Input
              value={p.default === undefined ? '' : String(p.default)}
              placeholder={t('默认值')}
              onChange={(e) => setParam(i, { default: e.target.value === '' ? undefined : e.target.value })}
            />
            <label className="flex items-center gap-1.5 text-footnote text-muted">
              <Switch
                checked={p.required}
                onCheckedChange={(v) => setParam(i, { required: v })}
                aria-label={t('必填')}
              />
              {t('必填')}
            </label>
            {p.type === 'enum' && (
              <Input
                className="col-span-2 sm:col-span-4"
                value={p.options.join(', ')}
                placeholder={t('可选值，用逗号隔开')}
                onChange={(e) => setParam(i, { options: e.target.value.split(/[,，]\s*/).filter(Boolean) })}
              />
            )}
          </div>
        ))}
      </FormSection>
    </div>
  )
}

function EffectTab({ d, set }: { d: CustomTool; set: SetFn }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('影响')} hint={t('只读、会改项目文件、影响外部：Agent 和你都靠它判断这个工具会不会改东西')}>
        <Select
          value={d.effect}
          onChange={(e) => set('effect', e.target.value as CustomTool['effect'])}
          options={[
            { value: 'read', label: t('只读') },
            { value: 'write', label: t('会改项目里的文件') },
            { value: 'external', label: t('影响外部（提交、上传、发消息）') },
          ]}
        />
      </Field>
      <label className="flex items-center gap-2 text-body">
        <Switch checked={d.confirm} onCheckedChange={(v) => set('confirm', v)} aria-label={t('运行前先问我')} />
        <span className="shrink-0 whitespace-nowrap">{t('运行前先问我')}</span>
        <span className="text-footnote text-subtle">
          {t('默认关：Agent 调用时直接跑，和普通工具一样。打开后每次先弹授权卡（可选本对话不再询问）')}
        </span>
      </label>
      <Field label={t('会改的文件')} hint={t('相对项目根，** 表示任意层；P4 项目运行前会先签出')}>
        <ChipListInput
          value={d.writes}
          onChange={(v) => set('writes', v)}
          label={t('会改的文件')}
          placeholder="Content/Config/**"
        />
      </Field>
      <Field label={t('算成功的退出码')}>
        <Input
          value={d.output.okExit.join(', ')}
          onChange={(e) =>
            set('output', {
              ...d.output,
              okExit: e.target.value
                .split(/[,，\s]+/)
                .filter(Boolean)
                .map(Number)
                .filter(Number.isInteger),
            })
          }
        />
      </Field>
      <Field label={t('报错行的正则')} hint={t('命名分组 file、line、msg，匹配上的行会单独列给 Agent')}>
        <Input
          className="font-mono"
          value={d.output.errorPattern ?? ''}
          onChange={(e) => set('output', { ...d.output, errorPattern: e.target.value || undefined })}
        />
      </Field>
      {d.sources.length > 0 && (
        <Field label={t('依据的文件')}>
          <span className="font-mono text-footnote text-muted">{d.sources.join('、')}</span>
        </Field>
      )}
    </div>
  )
}

function HistoryTab({ tool }: { tool: CustomTool }) {
  const rows = [
    {
      version: tool.version,
      at: tool.updatedAt,
      by: tool.createdBy,
      command: tool.run.command,
      note: tool.note,
      now: true,
    },
    ...tool.history,
  ]
  return (
    <div className="flex flex-col gap-2">
      {rows.map((v) => (
        <div key={v.version} className="flex flex-col gap-0.5 rounded-lg border border-line px-3 py-2">
          <span className="flex items-center gap-2 text-body font-medium">
            v{v.version}
            {'now' in v && <Badge tone="accent">{t('当前')}</Badge>}
            <span className="text-footnote font-normal text-subtle">
              {v.at ? new Date(v.at).toLocaleString() : ''} {v.by}
            </span>
          </span>
          {v.note && <span className="text-footnote text-muted">{v.note}</span>}
          <code className="font-mono text-caption break-all text-subtle">{v.command}</code>
        </div>
      ))}
      <p className="text-footnote text-subtle">{t('最多留最近 5 个旧版本。')}</p>
    </div>
  )
}

function TryTab({ entry, d, dirty, ct }: { entry: ToolEntry; d: CustomTool; dirty: boolean; ct: CustomTools }) {
  const [values, setValues] = useState<ParamValues>(() => paramDefaults(d.params))
  const [res, setRes] = useState<ToolRunRes & { dryRun: boolean }>()
  const [busy, setBusy] = useState(false)
  const go = (dryRun: boolean) => {
    setBusy(true)
    // 改了没保存时按改过的草稿跑，方便边改边试
    const target = dirty ? { draft: d } : { scope: entry.scope, id: d.id }
    ct.run({ ...target, args: paramArgs(values), dryRun })
      .then((r) => setRes({ ...r, dryRun }))
      .catch(toastError)
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-3">
      <ToolParamForm params={d.params} values={values} onChange={setValues} />
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => go(true)} disabled={busy}>
          {t('只展开命令')}
        </Button>
        <Button onClick={() => go(false)} disabled={busy}>
          {busy ? t('运行中…') : t('运行')}
        </Button>
        <span className="text-footnote text-subtle">
          {dirty ? t('按没保存的改动跑') : t('在项目目录里真的执行，会改文件的会真的改')}
        </span>
      </div>
      {res && <ToolRunResult ok={res.ok} line={res.line} text={res.text} output={res.output} dryRun={res.dryRun} />}
    </div>
  )
}
