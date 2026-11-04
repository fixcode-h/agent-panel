import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
import type { HookDef } from '@shared/hook-defs'
import type { Proposal } from '@shared/assist'
import { t } from '@shared/i18n'
import { hooksApi, type BuiltinHookView, type HooksView, type HookTriggerView } from '@/lib/api-hooks'
import { useData } from '@/lib/data'
import { toast, toastError } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { Group, Row } from './parts'
import { HookEditor } from './HookEditor'
import { BuiltinParams } from './BuiltinParams'
import { Select } from '@/components/ui/input'
import { eventLabel } from './hook-labels'

/**
 * 设置里的「钩子」（ADR 0049 第二期）：Agent 执行到固定时刻（结束前、工具前后、压缩之后）自动运行的检查。
 * 内置钩子只能开关；我的钩子可以新建、让 AI 创建、编辑、复制、排序、删除，新建的默认关着，看过再打开。
 * 每个钩子写明哪些 CLI 支持它的事件，不支持的照实写出来，不假装生效
 */
export function HooksSection() {
  const { projects } = useData()
  const [view, setView] = useState<HooksView | null>(null)
  const [error, setError] = useState('')
  const [triggers, setTriggers] = useState<HookTriggerView[]>([])
  const [editing, setEditing] = useState<{ hook?: HookDef } | null>(null)
  const [assist, setAssist] = useState<{ hook?: HookDef } | null>(null)
  const [removing, setRemoving] = useState<HookDef | null>(null)
  const [busy, setBusy] = useState('')
  // 内置钩子看哪一层的开关：空是全局，选了项目就是这个项目单独的（覆盖全局）
  const [scope, setScope] = useState('')
  const [params, setParams] = useState<BuiltinHookView | null>(null)

  const load = async (sc = scope) => {
    try {
      const [v, tr] = await Promise.all([hooksApi.list(sc), hooksApi.triggers().catch(() => [])])
      setView(v)
      setTriggers(tr)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load(scope)
    // 只在切换范围时重读：load 每次渲染都是新函数，放进依赖会一直重读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const supportText = (event: string) => {
    if (!view) return ''
    const yes = view.support.filter((s) => s.events.includes(event as never)).map((s) => s.name)
    const no = view.support.filter((s) => !s.events.includes(event as never)).map((s) => s.name)
    return [
      yes.length ? t('支持：{list}', { list: yes.join('、') }) : t('目前没有 CLI 支持这个事件'),
      no.length ? t('不支持：{list}（这些 CLI 的对话里不会触发）', { list: no.join('、') }) : '',
    ]
      .filter(Boolean)
      .join('；')
  }

  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await f()
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy('')
    }
  }
  const move = (i: number, by: number) => {
    if (!view) return
    const ids = view.hooks.map((h) => h.id)
    const [x] = ids.splice(i, 1)
    ids.splice(i + by, 0, x)
    void act('order', () => hooksApi.order(ids))
  }
  const copy = (h: HookDef) =>
    void act(`copy:${h.id}`, () =>
      hooksApi.save({ ...h, id: '', name: t('{name}（副本）', { name: h.name }).slice(0, 60), enabled: false }),
    )
  // AI 交的提案：一律关着保存（用户看过再打开），保存前服务端还会再校验一遍
  const applyAi = async (p: Proposal) => {
    if (p.kind !== 'hook') return
    const r = await hooksApi.save({ ...p.hook, enabled: false })
    toast.success(t('已保存「{name}」，看过后在列表里打开', { name: r.hook.name }))
    await load()
  }

  if (error) return <p className="py-6 text-body text-danger">{error}</p>
  if (!view)
    return (
      <p className="flex items-center gap-1.5 py-6 text-body text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('正在读取钩子…')}
      </p>
    )

  return (
    <>
      <p className="pt-2 pb-1 text-body leading-relaxed text-subtle">
        {t(
          '钩子在 Agent 执行到固定时刻自动运行：模型准备结束这一轮、调用工具前后、压缩上下文之后。只按工具、文件、计划这些事实判断，不读模型回复的文字。',
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <span className="text-body text-subtle">{t('内置钩子的开关')}</span>
        <Select
          className="w-56"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label={t('内置钩子的开关')}
          options={[
            { value: '', label: t('所有项目（全局）') },
            ...projects.map((x) => ({ value: x.id, label: t('只在「{name}」', { name: x.name }) })),
          ]}
        />
        {scope && <span className="text-xs text-subtle">{t('这个项目单独设的开关优先，没设的跟着全局')}</span>}
      </div>
      <Group title={t('内置钩子')}>
        {view.builtins.map((b) => (
          <Row key={b.id} title={b.name} desc={b.description} hint={`${eventLabel(b.event)} · ${supportText(b.event)}`}>
            <div className="flex shrink-0 items-center gap-1.5">
              {scope && b.projectOn !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === `b:${b.id}`}
                  onClick={() => void act(`b:${b.id}`, () => hooksApi.setBuiltin(b.id, null, scope))}
                >
                  {t('跟随全局（{state}）', { state: b.globalOn ? t('开') : t('关') })}
                </Button>
              )}
              {/* 没有参数的也留出按钮的位置：一列开关上下对齐 */}
              {b.params.length > 0 ? (
                <IconButton icon={SlidersHorizontal} label={t('参数')} size="xs" onClick={() => setParams(b)} />
              ) : (
                <span className="w-6" aria-hidden />
              )}
              <Switch
                checked={b.on}
                disabled={busy === `b:${b.id}`}
                onCheckedChange={(on) => void act(`b:${b.id}`, () => hooksApi.setBuiltin(b.id, on, scope))}
                aria-label={b.name}
              />
            </div>
          </Row>
        ))}
      </Group>
      <Group title={t('我的钩子')} plain>
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus className="h-3.5 w-3.5" />
            {t('新建钩子')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAssist({})}>
            <Sparkles className="h-3.5 w-3.5" />
            {t('AI 创建')}
          </Button>
        </div>
        {view.hooks.length ? (
          <div className="settings-card">
            {view.hooks.map((h, i) => (
              <div key={h.id} className="settings-row flex items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5 text-prose font-medium">
                    {h.name}
                    <Badge title={supportText(h.event)}>{eventLabel(h.event)}</Badge>
                    <Badge>{h.action.type === 'command' ? t('脚本') : 'HTTP'}</Badge>
                    {h.createdBy === 'ai' && <Badge tone="accent">AI</Badge>}
                  </span>
                  {h.description && <span className="truncate text-body text-subtle">{h.description}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton icon={ArrowUp} label={t('上移')} size="xs" disabled={!i} onClick={() => move(i, -1)} />
                  <IconButton
                    icon={ArrowDown}
                    label={t('下移')}
                    size="xs"
                    disabled={i === view.hooks.length - 1}
                    onClick={() => move(i, 1)}
                  />
                  <IconButton icon={Pencil} label={t('编辑')} size="xs" onClick={() => setEditing({ hook: h })} />
                  <IconButton icon={Wand2} label={t('让 AI 改写')} size="xs" onClick={() => setAssist({ hook: h })} />
                  <IconButton icon={Copy} label={t('复制')} size="xs" onClick={() => copy(h)} />
                  <IconButton icon={Trash2} label={t('删除')} size="xs" onClick={() => setRemoving(h)} />
                  <Switch
                    className="ml-2"
                    checked={h.enabled}
                    disabled={busy === `h:${h.id}`}
                    onCheckedChange={(on) => void act(`h:${h.id}`, () => hooksApi.save({ ...h, enabled: on }))}
                    aria-label={h.name}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-card py-4 text-center text-body text-subtle">
            {t('还没有自己的钩子。新建一个，或者让 AI 按你的描述写一个')}
          </p>
        )}
      </Group>
      <Group title={t('最近触发')} plain>
        <div className="flex items-center pb-2">
          <span className="text-body text-subtle">
            {t('面板这次启动以来最近 50 次钩子的运行（内置钩子只记拦下和补说明的）')}
          </span>
          <IconButton className="ml-auto" icon={RefreshCw} label={t('刷新')} size="xs" onClick={() => void load()} />
        </div>
        {triggers.length ? (
          <div className="settings-card">
            {triggers.map((x, i) => (
              <div key={`${x.at}-${i}`} className="settings-row flex items-center gap-3 py-2 text-body">
                <span className="w-16 shrink-0 text-xs text-subtle">{new Date(x.at).toLocaleTimeString()}</span>
                <span className="min-w-0 shrink-0 font-medium">{x.name}</span>
                <Badge>{eventLabel(x.event)}</Badge>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    x.result === 'error' ? 'text-danger' : x.result === 'none' ? 'text-subtle' : 'text-accent-text',
                  )}
                >
                  {resultLabel(x.result)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-subtle" title={x.detail}>
                  {x.detail}
                </span>
                <span className="shrink-0 text-xs text-subtle">{t('{ms} 毫秒', { ms: x.ms })}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-card py-4 text-center text-body text-subtle">{t('还没有触发过')}</p>
        )}
      </Group>
      <BuiltinParams hook={params} onOpenChange={(o) => !o && setParams(null)} onSaved={() => void load()} />
      <HookEditor
        open={!!editing}
        initial={editing?.hook}
        support={view.support}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => void load()}
      />
      {assist && (
        <AssistDialog
          open
          onOpenChange={(o) => !o && setAssist(null)}
          kind="hook"
          title={assist.hook?.name}
          subject={{
            ...(assist.hook ? { hook: JSON.stringify(assist.hook) } : {}),
            // 项目清单交给 AI：范围按项目名写，面板换成 id（见 shared/assist-hook.ts）
            projects: JSON.stringify(projects.map((x) => ({ id: x.id, name: x.name }))),
          }}
          onApply={applyAi}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        title={t('删除钩子「{name}」？', { name: removing?.name ?? '' })}
        description={t('删掉后它不会再触发，脚本也一起删掉')}
        onConfirm={() => removing && act(`d:${removing.id}`, () => hooksApi.remove(removing.id))}
        onOpenChange={(o) => !o && setRemoving(null)}
      />
    </>
  )
}

function resultLabel(r: HookTriggerView['result']) {
  return r === 'block'
    ? t('拦住')
    : r === 'deny'
      ? t('拒绝')
      : r === 'context'
        ? t('补了说明')
        : r === 'error'
          ? t('出错')
          : t('不表态')
}
