import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  Cpu,
  FlaskConical,
  Settings2,
  Palette,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
  Layers,
  HardDrive,
  GripVertical,
} from 'lucide-react'
import { CLIS, type CliDefinition } from '@shared/clis'
import { type Settings, CONTENT_MAX, CONTENT_WIDTH } from '@shared/schema'
import { applyContentWidth, switchLang } from '@/lib/data'
import { LANGS, t } from '@shared/i18n'
import { defaultCli, orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { loadCliModels, useCliDef } from '@/lib/cli-models'
import { resumeInstallJobs, setInstallFinish } from '@/lib/cli-install'
import { notifyEnabled, notifySupported, setNotify } from '@/lib/notify'
import { useAutosave } from '@/lib/useAutosave'
import { cn, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SaveIndicator } from '@/components/layout/Detail'
import { UpdateSection } from '@/components/settings/UpdateSection'
import { StylesSettings } from '@/components/settings/StylesSettings'
import { DataSection } from '@/components/settings/DataSection'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/projects/ProjectSettingsDialog'
import { useAppUpdate } from '@/lib/app-update'
import { Group, ReadValue, Row } from '@/components/settings/parts'
import { CustomClis } from '@/components/settings/CustomClis'
import {
  AssistModel,
  CliSection,
  TierTable,
  defaultEffortText,
  defaultModelText,
  textToEnv,
  toDraft,
} from '@/components/settings/CliSection'

interface Section {
  id: string
  label: string
  icon?: LucideIcon
  cli?: CliDefinition
}

const sectionsFor = (clis: CliDefinition[]): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2 },
  { id: 'categories', label: t('项目分类'), icon: Layers },
  { id: 'models', label: t('默认 CLI'), icon: Cpu },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: t('AI 创建'), icon: Sparkles },
  { id: 'styles', label: t('风格库'), icon: Palette },
  { id: 'data', label: t('数据'), icon: HardDrive },
  { id: 'update', label: t('版本更新'), icon: ArrowUpCircle },
]

function SettingsBody({
  initial,
  section,
  onSection,
}: {
  initial: Settings
  section: string
  onSection: (s: string) => void
}) {
  const { setSettings, clis, refreshClis } = useData()
  const [timeout, setTimeoutMin] = useState(String(initial.stepTimeoutMinutes))
  const [idle, setIdle] = useState(String(initial.idleTimeoutMinutes))
  const [notify, setNotifyOn] = useState(notifyEnabled)
  const [openBrowser, setOpenBrowser] = useState(initial.openBrowser)
  const [requireToken, setRequireToken] = useState(initial.requireToken)
  const [proxy, setProxy] = useState(initial.proxy)
  const [contentWidth, setContentWidth] = useState(initial.contentWidth)
  const [language, setLanguage] = useState(initial.language)
  const [cliOrder, setCliOrder] = useState(() => orderClis(CLIS, initial.cliOrder).map((c) => c.id))
  const ordered = orderClis(CLIS, cliOrder)
  const SECTIONS = sectionsFor(ordered)
  // 侧栏里拖动 CLI 调整顺序：拖到哪一项上就插到那里
  const [dragging, setDragging] = useState('')
  const moveCli = (id: string, to: number) =>
    setCliOrder((o) => {
      const from = o.indexOf(id)
      if (from < 0 || to < 0 || to >= o.length || from === to) return o
      const next = o.filter((x) => x !== id)
      next.splice(to, 0, id)
      return next
    })
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const [detecting, setDetecting] = useState(false)
  const [assist, setAssist] = useState(initial.assist)
  const [imageGen, setImageGen] = useState(initial.imageGen)
  const [defCli, setDefCli] = useState(() => defaultCli(initial))
  const demo = !!import.meta.env.VITE_DEMO
  const update = useAppUpdate().data?.update
  // 安装 / 卸载结束后重新检测，并提示结果；进度在 cli-install 里，切换页面不会丢
  useEffect(() => {
    setInstallFinish((j) => {
      const name = CLIS.find((c) => c.id === j.cli)?.name ?? j.cli
      void Promise.all([refreshClis().catch(() => {}), loadCliModels(j.cli, true).catch(() => {})])
      // 服务端改用了 npm 装的那个可执行文件：同步到这里，免得自动保存又改回去
      if (j.note)
        void api.settings().then((fresh) => {
          setSettings(fresh)
          setDrafts((d) => ({ ...d, [j.cli]: { ...d[j.cli], command: fresh.clis[j.cli]?.command ?? '' } }))
        })
      const kind = j.action === 'uninstall' ? 'uninstall' : j.update ? 'update' : 'install'
      if (j.status === 'done')
        toast.success(
          {
            install: t('{name} 已安装', { name }),
            update: t('{name} 已更新', { name }),
            uninstall: t('{name} 已卸载', { name }),
          }[kind],
        )
      else
        toast.error(
          {
            install: t('{name} 安装失败', { name }),
            update: t('{name} 更新失败', { name }),
            uninstall: t('{name} 卸载失败', { name }),
          }[kind],
        )
    })
    void resumeInstallJobs()
    // 只在安装结束时执行一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshClis])
  // 打开设置就开始读各个 CLI 的模型列表，切到 CLI 页时多半已经读好（Command Code 第一次要几秒）
  useEffect(() => {
    for (const c of CLIS) loadCliModels(c.id).catch(() => {})
  }, [])

  const minutes = Number(timeout)
  const valid = timeout !== '' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440
  const idleMin = Number(idle)
  const idleValid = idle !== '' && Number.isInteger(idleMin) && idleMin >= 0 && idleMin <= 1440
  const tier = (x: { model: string; effort: string }) => ({ model: x.model.trim(), effort: x.effort })
  const value: Settings = {
    openBrowser,
    requireToken,
    proxy: proxy.trim(),
    contentWidth,
    language,
    cliOrder,
    stepTimeoutMinutes: valid ? minutes : initial.stepTimeoutMinutes,
    idleTimeoutMinutes: idleValid ? idleMin : initial.idleTimeoutMinutes,
    defaultCli: defCli,
    clis: Object.fromEntries(
      Object.entries(drafts).map(([id, d]) => [
        id,
        {
          enabled: d.enabled,
          command: d.command.trim(),
          defaultModel: d.defaultModel.trim(),
          defaultEffort: d.defaultEffort,
          tiers: { high: tier(d.tiers.high), medium: tier(d.tiers.medium), low: tier(d.tiers.low) },
          permission: d.permission,
          extraArgs: splitArgs(d.args),
          env: textToEnv(d.envText),
          showLimits: d.showLimits,
          autoCompact: d.autoCompact,
        },
      ]),
    ),
    assist: { ...assist, model: assist.model.trim() },
    imageGen: { ...imageGen, model: imageGen.model.trim() },
  }
  const save = useAutosave(
    value,
    async (v) => {
      setSettings(await api.saveSettings(v))
      // 不强制重新检测：每次自动保存都把 CLI 跑一遍会让保存变得很慢
      await refreshClis(false)
    },
    // 超时填错时这一项沿用原值，其他设置照常保存
    true,
  )

  const detect = async () => {
    setDetecting(true)
    try {
      // 模型列表跟着重新读：装了新版本、换了账号或改了环境变量后能用的模型可能变了
      await Promise.all([refreshClis(), ...CLIS.map((c) => loadCliModels(c.id, true).catch(() => {}))])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const statusOf = (id: string) => clis.find((c) => c.id === id)
  const inCli = cur.id === 'models' || !!cur.cli
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label={t('设置分类')}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
      >
        <span className="hidden px-2.5 pt-1 pb-3 font-serif text-[20px] font-semibold md:block">{t('设置')}</span>
        {SECTIONS.filter((s) => !s.cli).map((s) => {
          // CLI 相关的几页（默认 CLI 和各个 CLI）在左栏里合成一项「CLI」
          const on = s.id === 'models' ? inCli : s.id === cur.id
          return (
            <button
              key={s.id}
              onClick={() => onSection(s.id)}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
              )}
            >
              {s.id === 'models' ? (
                <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              ) : (
                s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              )}
              <span className="truncate">{s.id === 'models' ? 'CLI' : s.label}</span>
              {s.id === 'update' && update && (
                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有新版本')} />
              )}
            </button>
          )
        })}
      </nav>

      {inCli && (
        // CLI 的二级列表：默认 CLI 和各个 CLI，CLI 可以拖动调整顺序（新建 Agent、下拉框里也按这个顺序）
        <nav
          aria-label="CLI"
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3 md:pt-6"
        >
          {SECTIONS.filter((s) => s.id === 'models' || s.cli).map((s, i, list) => {
            const on = s.id === cur.id
            const st = s.cli && statusOf(s.cli.id)
            return (
              <div key={s.id} className="contents">
                {s.cli && !list[i - 1]?.cli && (
                  <span className="hidden items-center justify-between px-2.5 pt-3 pb-1 text-[11px] text-subtle md:flex">
                    {t('已接入')}
                    <span className="text-[10.5px] text-subtle/80">{t('拖动调整顺序')}</span>
                  </span>
                )}
                <button
                  onClick={() => onSection(s.id)}
                  aria-current={on ? 'page' : undefined}
                  title={s.cli ? t('拖动调整顺序，或按 Alt + ↑ / ↓') : undefined}
                  draggable={!!s.cli}
                  onDragStart={(e) => {
                    if (!s.cli) return
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', s.cli.id)
                    setDragging(s.cli.id)
                  }}
                  onDragOver={(e) => {
                    if (!dragging || !s.cli) return
                    e.preventDefault()
                    if (s.cli.id !== dragging) moveCli(dragging, cliOrder.indexOf(s.cli.id))
                  }}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={() => setDragging('')}
                  onKeyDown={(e) => {
                    if (!s.cli || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                    e.preventDefault()
                    moveCli(s.cli.id, cliOrder.indexOf(s.cli.id) + (e.key === 'ArrowUp' ? -1 : 1))
                  }}
                  className={cn(
                    'group flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                    on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                    s.cli && dragging === s.cli.id && 'opacity-50',
                  )}
                >
                  {s.cli ? (
                    <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(s.cli.id) }} />
                  ) : (
                    s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                  )}
                  <span className="truncate">{s.label}</span>
                  {s.cli && defCli === s.cli.id && (
                    <span className="text-[11px] font-normal text-subtle">{t('默认')}</span>
                  )}
                  {s.cli && (
                    <GripVertical className="ml-auto hidden h-3.5 w-3.5 shrink-0 text-subtle opacity-0 group-hover:opacity-100 md:block" />
                  )}
                  {st && (
                    <span
                      className={cn(
                        'hidden h-1.5 w-1.5 shrink-0 rounded-full md:block',
                        st.installed && st.enabled ? 'bg-success' : 'bg-line-strong',
                      )}
                    />
                  )}
                </button>
              </div>
            )
          })}
        </nav>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3 md:px-8 md:pt-7">
          <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] font-semibold">{cur.label}</h2>
          <SaveIndicator {...save} invalid={valid ? undefined : t('超时时间需要是 0 到 1440 的整数')} />
          <DialogCloseButton label={t('关闭设置')} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">
          {cur.id === 'styles' && <StylesSettings />}
          {cur.id === 'general' && (
            <Group>
              {demo && (
                <p className="mb-2 flex gap-2.5 rounded-xl border p-3.5 text-[13px] leading-relaxed text-subtle">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 CLI。')}
                </p>
              )}
              <Row
                title={t('单个步骤最长运行时间')}
                desc={t('分钟，填 0 不限制。超时后会停止这一步，任务标记为失败。')}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={timeout}
                    onChange={(e) => setTimeoutMin(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!valid}
                    className={cn('h-9', !valid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('单个步骤最长运行时间（分钟）')}
                  />
                  {!valid && <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不限制')}</span>}
                </div>
              </Row>
              <Row
                title={t('没有输出时提醒')}
                desc={t(
                  '分钟，填 0 不检测。CLI 这么久没有任何输出时在任务里提醒一次，再过同样的时间还没有就自动停止，免得卡在登录或确认上一直显示执行中。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={idle}
                    onChange={(e) => setIdle(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!idleValid}
                    className={cn('h-9', !idleValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('没有输出时提醒（分钟）')}
                  />
                  {!idleValid && (
                    <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不检测')}</span>
                  )}
                </div>
              </Row>
              <Row title="语言 · Language" desc={t('界面显示的语言，切换后页面会重新加载。')}>
                <Select
                  aria-label={t('语言')}
                  value={language}
                  onChange={async (e) => {
                    const v = e.target.value as Settings['language']
                    setLanguage(v)
                    // 文案在页面加载时就定了，保存后重新加载页面
                    try {
                      setSettings(await api.saveSettings({ ...value, language: v }))
                    } catch (err) {
                      return toast.error((err as Error).message)
                    }
                    switchLang(v)
                  }}
                  options={[
                    { value: 'auto', label: t('跟随浏览器 · Auto') },
                    ...LANGS.map((l) => ({ value: l.id, label: l.label })),
                  ]}
                  className="w-48"
                />
              </Row>
              <Row
                title={t('内容宽度')}
                desc={t('项目首页的输入框和任务列表、任务页的对话和工作流节点都用这个宽度，窗口窄时自动缩小。')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={640}
                    max={CONTENT_MAX}
                    step={20}
                    value={contentWidth}
                    aria-label={t('内容宽度')}
                    onChange={(e) => {
                      const w = Number(e.target.value)
                      setContentWidth(w)
                      // 拖动时立即生效，不用等保存
                      applyContentWidth(w)
                    }}
                    className="w-40 cursor-pointer accent-[var(--color-accent)]"
                  />
                  <span className="w-14 font-mono text-[13px] text-muted tabular-nums">{contentWidth}px</span>
                  {contentWidth !== CONTENT_WIDTH && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setContentWidth(CONTENT_WIDTH)
                        applyContentWidth(CONTENT_WIDTH)
                      }}
                    >
                      {t('恢复默认')}
                    </Button>
                  )}
                </div>
              </Row>
              {!demo && (
                <Row
                  title={t('启动后打开浏览器')}
                  desc={t('启动面板服务后，自动用默认浏览器打开 http://127.0.0.1:8787。')}
                >
                  <Switch aria-label={t('启动后打开浏览器')} checked={openBrowser} onCheckedChange={setOpenBrowser} />
                </Row>
              )}
              {!demo && (
                <Row
                  title={t('访问令牌')}
                  desc={t(
                    '打开后，只有用启动时显示的地址（带 token）打开过的浏览器能访问面板，本机的其他程序不能直接调用接口。这个浏览器会自动获得授权。',
                  )}
                >
                  <Switch aria-label={t('访问令牌')} checked={requireToken} onCheckedChange={setRequireToken} />
                </Row>
              )}
              {!demo && (
                <Row
                  title={t('网络代理')}
                  desc={t(
                    '检查更新、下载新版本时使用。访问不了 GitHub 时填本机代理的地址；留空时用环境变量 HTTPS_PROXY。',
                  )}
                >
                  <Input
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder="http://127.0.0.1:7890"
                    className="w-[240px] font-mono text-[13px]"
                    spellCheck={false}
                    aria-label={t('网络代理')}
                  />
                </Row>
              )}
              <Row
                title={t('任务完成时通知我')}
                desc={t('页面不在前台时，任务完成或失败会弹出系统通知。需要浏览器允许通知。')}
              >
                <Switch
                  aria-label={t('任务完成时通知我')}
                  checked={notify}
                  disabled={!notifySupported()}
                  onCheckedChange={async (on) => {
                    const ok = await setNotify(on)
                    setNotifyOn(ok)
                    if (on && !ok) toast.error(t('浏览器没有允许通知，可以在地址栏左侧的网站设置里打开'))
                  }}
                />
              </Row>
            </Group>
          )}

          {cur.id === 'models' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                {t(
                  'Agent 可以不指定 CLI，选「系统默认」时用这里的 CLI；模型可以只选高、中、低一档，执行时换成那个 CLI 对应档位的模型和思考强度。改这里就能让所有用默认设置的 Agent 一起切换。',
                )}
              </p>
              <Group>
                <Row title={t('默认 CLI')} desc={t('Agent 选了「系统默认」或没有指定 CLI 时使用')}>
                  <Select
                    aria-label={t('默认 CLI')}
                    value={defCli}
                    onChange={(e) => setDefCli(e.target.value)}
                    className="w-[240px]"
                    // 停用或没安装的 CLI 不给选；当前的默认照常显示，并标出原因
                    options={ordered
                      .filter((c) => {
                        const st = statusOf(c.id)
                        return !st || (st.installed && st.enabled) || c.id === defCli
                      })
                      .map((c) => {
                        const st = statusOf(c.id)
                        const note = !st
                          ? ''
                          : !st.installed
                            ? ` · ${t('未安装')}`
                            : !st.enabled
                              ? ` · ${t('已停用')}`
                              : ''
                        return { value: c.id, label: c.name + note }
                      })}
                  />
                </Row>
              </Group>
              <Group title={t('{cli} 的模型', { cli: defDef.name })}>
                <Row
                  title={t('三档模型')}
                  desc={
                    <>
                      {t('跟随 {cli} 自己的档位设置，要改请到', { cli: defDef.name })}{' '}
                      <button
                        className="cursor-pointer text-accent hover:underline"
                        onClick={() => onSection(`cli:${defCli}`)}
                      >
                        {defDef.name}
                      </button>{' '}
                      {t('里修改。')}
                    </>
                  }
                  stack
                >
                  <TierTable
                    def={defDef}
                    value={drafts[defCli].tiers}
                    defaultModel={drafts[defCli].defaultModel}
                    readOnly
                  />
                </Row>
                {/* 默认模型和思考强度也只展示，在对应 CLI 里改 */}
                <Row
                  title={t('默认模型')}
                  desc={t('Agent 没有指定模型时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                >
                  <ReadValue mono>{defaultModelText(defDef, drafts[defCli])}</ReadValue>
                </Row>
                <Row
                  title={t('默认思考强度')}
                  desc={t('Agent 和档位都没有指定时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                >
                  <ReadValue>{defaultEffortText(defDef, drafts[defCli])}</ReadValue>
                </Row>
              </Group>
              <Group title={t('图片生成')}>
                <Row
                  title={t('图片生成 CLI')}
                  desc={t(
                    'UI 设计里生成图片时使用。目前只有 Codex 内置了生图工具，用 ChatGPT 账号登录即可，不需要 API Key。',
                  )}
                >
                  <Select
                    aria-label={t('图片生成 CLI')}
                    value={imageGen.cli}
                    onChange={(e) => setImageGen({ ...imageGen, cli: e.target.value, model: '' })}
                    className="w-[240px]"
                    options={ordered
                      .filter((c) => {
                        const st = statusOf(c.id)
                        return c.images && (!st || (st.installed && st.enabled) || c.id === imageGen.cli)
                      })
                      .map((c) => {
                        const st = statusOf(c.id)
                        const note = !st
                          ? ''
                          : !st.installed
                            ? ` · ${t('未安装')}`
                            : !st.enabled
                              ? ` · ${t('已停用')}`
                              : ''
                        return { value: c.id, label: c.name + note }
                      })}
                  />
                </Row>
                <Row title={t('图片生成模型')} desc={t('调用生图工具的模型，不选时用这个 CLI 的高档模型')}>
                  <div className="w-[240px]">
                    <AssistModel
                      cli={imageGen.cli}
                      draft={drafts[imageGen.cli]}
                      value={imageGen.model}
                      onChange={(model) => setImageGen({ ...imageGen, model })}
                      label={t('图片生成模型')}
                      fallback="@high"
                    />
                  </div>
                </Row>
                <Row
                  title={t('同时生成几张')}
                  desc={t(
                    'CLI 是每张图各开一个进程，最多同时开这么多个；浏览器是在选中的 Gemini / ChatGPT 标签页里只开这么多个对话（网页左边的对话列表里能看到），之后的图排队，哪个对话空了就接着用哪个。',
                  )}
                >
                  <Select
                    aria-label={t('同时生成几张')}
                    value={String(imageGen.concurrency)}
                    onChange={(e) => setImageGen({ ...imageGen, concurrency: Number(e.target.value) })}
                    className="w-[240px]"
                    options={Array.from({ length: 10 }, (_, i) => ({
                      value: String(i + 1),
                      label: i + 1 === 3 ? t('{n} 个（默认）', { n: i + 1 }) : t('{n} 个', { n: i + 1 }),
                    }))}
                  />
                </Row>
              </Group>
              <CustomClis demo={demo} />
            </>
          )}

          {cur.cli && (
            <CliSection
              key={cur.cli.id}
              def={cur.cli}
              draft={drafts[cur.cli.id]}
              status={statusOf(cur.cli.id)}
              isDefault={defCli === cur.cli.id}
              onChange={(d) => setDrafts((ds) => ({ ...ds, [cur.cli!.id]: d }))}
              onDetect={detect}
              detecting={detecting}
            />
          )}

          {cur.id === 'data' && <DataSection />}
          {cur.id === 'update' && <UpdateSection />}

          {cur.id === 'categories' && <ProjectCategoryList />}

          {cur.id === 'assist' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                {t(
                  '在 Agent 和工作流页面可以用本机 CLI 对话生成或优化配置。CLI 按固定格式输出，面板校验通过后才能应用。',
                )}
              </p>
              <Group>
                <Row title={t('使用的 CLI')} desc={t('默认用「CLI」里设为默认的那个')}>
                  <Select
                    aria-label={t('AI 创建使用的 CLI')}
                    value={assist.cli || defCli}
                    // 选回默认的就不单独记，之后换了默认 CLI 会跟着变
                    // 换 CLI 时模型名不通用，清空回到那个 CLI 的默认模型
                    onChange={(e) =>
                      setAssist({ ...assist, cli: e.target.value === defCli ? '' : e.target.value, model: '' })
                    }
                    options={ordered
                      .filter((c) => {
                        const st = statusOf(c.id)
                        return !st || (st.installed && st.enabled) || c.id === (assist.cli || defCli)
                      })
                      .map((c) => ({
                        value: c.id,
                        label: `${c.name}${c.id === defCli ? t('（默认）') : ''}`,
                      }))}
                  />
                </Row>
                <Row title={t('模型')} desc={t('默认用这个 CLI 设置里的默认模型')}>
                  <AssistModel
                    key={assist.cli || defCli}
                    cli={assist.cli || defCli}
                    draft={drafts[assist.cli || defCli]}
                    value={assist.model}
                    onChange={(v) => setAssist({ ...assist, model: v })}
                  />
                </Row>
                <Row title={t('创建 Agent 的补充规则')} desc={t('会加进提示词，例如命名习惯、团队约定')} stack>
                  <Textarea
                    rows={4}
                    value={assist.agentRules}
                    onChange={(e) => setAssist({ ...assist, agentRules: e.target.value })}
                    placeholder={t(
                      '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的 Agent 默认用 Claude Code',
                    )}
                    className="font-mono text-[13px]"
                  />
                </Row>
                <Row title={t('创建工作流的补充规则')} stack>
                  <Textarea
                    rows={4}
                    value={assist.workflowRules}
                    onChange={(e) => setAssist({ ...assist, workflowRules: e.target.value })}
                    placeholder={t('例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮')}
                    className="font-mono text-[13px]"
                  />
                </Row>
              </Group>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 设置弹窗，参考 Claude 的设置：左边分类，右边一行一项，改动自动保存 */
export function SettingsDialog({
  open,
  section,
  onOpenChange,
}: {
  open: boolean
  section?: string
  onOpenChange: (open: boolean) => void
}) {
  const { settings } = useData()
  const [cur, setCur] = useState(section ?? 'general')
  useEffect(() => {
    if (open) setCur(section ?? 'general')
  }, [open, section])
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          // 点设置外面的空白处不关闭，避免改到一半误关；用右上角的关闭按钮或 Esc 关闭
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 h-[min(840px,calc(100dvh-2rem))] w-[min(1200px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <D.Title className="sr-only">{t('设置')}</D.Title>
          {settings && <SettingsBody initial={settings} section={cur} onSection={setCur} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
