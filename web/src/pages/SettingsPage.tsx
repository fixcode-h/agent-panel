import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  Cpu,
  ImageIcon,
  FlaskConical,
  Settings2,
  Palette,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
  Layers,
  HardDrive,
  GripVertical,
  KeyRound,
  Tag as TagIcon,
  Rocket,
  Type,
  Globe,
  ShieldCheck,
  GraduationCap,
  Gauge,
} from 'lucide-react'
import { CLIS, type CliDefinition } from '@shared/clis'
import { type CliSettings, type Settings, CONTENT_MAX, CONTENT_WIDTH } from '@shared/schema'
import { applyContentWidth, switchLang } from '@/lib/data'
import { LANGS, t } from '@shared/i18n'
import { defaultCli, orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { loadCliModels, preloadCliModels, setCliMode, useCliDef } from '@/lib/cli-models'
import { useModelCatalog } from '@/lib/model-catalog'
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
import { ApiSection } from '@/components/settings/ApiSection'
import { DataSection } from '@/components/settings/DataSection'
import { UsageSection } from '@/components/usage/UsageSection'
import { LocalImageSection } from '@/components/settings/LocalImageSection'
import { TagsSection } from '@/components/settings/TagsSection'
import { GlobalLessonsSection } from '@/components/projects/Lessons'
import { RemoteSection } from '@/components/settings/RemoteSection'
import { IntegrationsSection } from '@/components/settings/IntegrationsSection'
import { DeploySection } from '@/components/settings/DeploySection'
import { FontSection } from '@/components/settings/FontSection'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/projects/ProjectSettingsDialog'
import { useAppUpdate } from '@/lib/app-update'
import { Group, ReadValue, Row } from '@/components/settings/parts'
import { ShellSetting } from '@/components/settings/ShellSetting'
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
  /** 左栏里的分组（CLI 二级列表里的页不用） */
  group?: string
}

// 左栏按分组列出，组内顺序就是这里的顺序
const sectionsFor = (clis: CliDefinition[]): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2, group: t('通用') },
  { id: 'fonts', label: t('字体'), icon: Type, group: t('通用') },
  { id: 'categories', label: t('项目分类'), icon: Layers, group: t('项目') },
  { id: 'tags', label: t('标签'), icon: TagIcon, group: t('项目') },
  { id: 'global-lessons', label: t('全局教训'), icon: GraduationCap, group: t('项目') },
  { id: 'models', label: t('默认 Agent'), icon: Cpu, group: t('Agent 与 AI') },
  // 部署和 API 也是 CLI 的事（写全局说明、放技能；各 CLI 用哪个 API），放在 CLI 二级列表里默认 CLI 下面
  { id: 'deploy', label: t('部署'), icon: Rocket },
  { id: 'apis', label: t('API 配置'), icon: KeyRound },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: t('AI 创建'), icon: Sparkles, group: t('Agent 与 AI') },
  // 外部 CLI 的授权（GitHub CLI 等），以后加新的授权工具只加定义
  { id: 'integrations', label: t('授权'), icon: ShieldCheck, group: t('连接') },
  { id: 'remote', label: t('外部访问'), icon: Globe, group: t('连接') },
  { id: 'local-image', label: t('本机生图'), icon: ImageIcon, group: t('生图') },
  { id: 'styles', label: t('风格库'), icon: Palette, group: t('生图') },
  { id: 'data', label: t('数据'), icon: HardDrive, group: t('系统') },
  { id: 'usage', label: t('用量统计'), icon: Gauge, group: t('系统') },
  { id: 'update', label: t('版本更新'), icon: ArrowUpCircle, group: t('系统') },
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
  const [presence, setPresence] = useState(String(initial.presenceGraceMinutes))
  const [unread, setUnread] = useState(String(initial.unreadGraceMinutes))
  const [keepAlive, setKeepAlive] = useState(String(initial.keepAliveLimit))
  const [reclaim, setReclaim] = useState(initial.reclaimIdleCli)
  const [children, setChildren] = useState(String(initial.childConcurrency))
  const [bgLimit, setBgLimit] = useState(String(initial.backgroundLimit))
  const [largeMB, setLargeMB] = useState(String(initial.largeFileMB))
  const [longPaste, setLongPaste] = useState(String(initial.longPasteChars))
  const [notify, setNotifyOn] = useState(notifyEnabled)
  const [openBrowser, setOpenBrowser] = useState(initial.openBrowser)
  const [requireToken, setRequireToken] = useState(initial.requireToken)
  const [remoteAccess, setRemoteAccess] = useState(initial.remoteAccess)
  const [askUserDefault, setAskUserDefault] = useState(initial.askUserDefault)
  const [shell, setShell] = useState(initial.shell)
  const [proxy, setProxy] = useState(initial.proxy)
  const [contentWidth, setContentWidth] = useState(initial.contentWidth)
  const [fileFormat, setFileFormat] = useState(initial.fileFormat)
  const [language, setLanguage] = useState(initial.language)
  const [appearance, setAppearance] = useState(initial.appearance)
  const [cliOrder, setCliOrder] = useState(() =>
    orderClis(CLIS, initial.cliOrder, (c) => initial.clis[c.id]?.enabled !== false).map((c) => c.id),
  )
  const demo = !!import.meta.env.VITE_DEMO
  // 侧栏里拖动 CLI 调整顺序：拖到哪一项上就插到那里
  const [dragging, setDragging] = useState('')
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const statusOf = (id: string) => clis.find((c) => c.id === id)
  const isOn = (id: string) => drafts[id]?.enabled ?? true
  // 没安装的 CLI 一律不启用：开关不显示，分组也按未启用算；装好后由安装完成的逻辑重新打开
  useEffect(() => {
    setDrafts((ds) => {
      let changed = false
      const next = { ...ds }
      for (const c of clis)
        if (c.installed === false && next[c.id]?.enabled) {
          next[c.id] = { ...next[c.id], enabled: false }
          changed = true
        }
      return changed ? next : ds
    })
  }, [clis])
  // 已安装并且启用才算已接入；没安装的统一归到「未启用」，免得和真在用的混在一起
  const isReady = (id: string) => isOn(id) && statusOf(id)?.installed !== false
  // 已接入的排在前面；同一组里按拖动过的顺序，没拖过的按名字比较
  const ordered = orderClis(CLIS, cliOrder, (c) => isReady(c.id))
  // 在线演示没有服务端，外网访问的开关不显示
  const SECTIONS = sectionsFor(ordered).filter((s) => !(demo && s.id === 'remote'))
  // 拖动只改同一组里的顺序，不能跨过启用和停用的分界
  const moveCli = (id: string, to: number) =>
    setCliOrder((o) => {
      const list = orderClis(CLIS, o, (c) => isReady(c.id)).map((c) => c.id)
      const from = list.indexOf(id)
      if (from < 0 || to < 0 || to >= list.length || from === to) return o
      const on = isReady(id)
      let start = from
      let end = from
      while (start > 0 && isReady(list[start - 1]) === on) start--
      while (end < list.length - 1 && isReady(list[end + 1]) === on) end++
      const dest = Math.max(start, Math.min(end, to))
      if (dest === from) return o
      const next = list.filter((x) => x !== id)
      next.splice(dest, 0, id)
      return next
    })
  // 每个 CLI 上次保存时的登录方式和 API，变了才重新读模型
  const modelSig = useRef<Record<string, string>>({})
  const [detecting, setDetecting] = useState(false)
  const [assist, setAssist] = useState(initial.assist)
  const [imageGen, setImageGen] = useState(initial.imageGen)
  const [modelCatalog, setModelCatalog] = useState(initial.modelCatalog)
  // 用量统计的计价模型（存在设置里，跟着自动保存）
  const [pricingModel, setPricingModel] = useState(initial.usagePricingModel)
  const catalogInfo = useModelCatalog()
  const [defCli, setDefCli] = useState(() => defaultCli(initial))
  const [apis, setApis] = useState(initial.apis)
  // 默认 CLI 被停用、又有别的启用了（例如新装后第一次打开一个）：默认换成按顺序第一个启用的
  useEffect(() => {
    if (drafts[defCli]?.enabled) return
    const first = ordered.find((c) => drafts[c.id]?.enabled)
    if (first) setDefCli(first.id)
    // 只跟着开关变化；ordered、defCli 变了不需要重新判断
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts])
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
  // 切换账号 / API 时模型下拉马上换成那种方式的列表，不等自动保存；
  // 模型从 CLI 列表读的（Command Code、Pi）两种方式的列表都提前读好，切换时不用等 CLI
  useEffect(() => {
    for (const c of CLIS) {
      const d = drafts[c.id]
      if (!d) continue
      setCliMode(c.id, { authMode: d.authMode, apiId: d.apiId })
      if (!d.enabled || c.auth?.api?.modelSource !== 'cli') continue
      preloadCliModels(c.id, { authMode: 'account' })
      if (d.apiId && apis.some((a) => a.id === d.apiId)) preloadCliModels(c.id, { authMode: 'api', apiId: d.apiId })
    }
  }, [drafts, apis])

  const minutes = Number(timeout)
  const valid = timeout !== '' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440
  const idleMin = Number(idle)
  const idleValid = idle !== '' && Number.isInteger(idleMin) && idleMin >= 0 && idleMin <= 1440
  const presenceMin = Number(presence)
  const presenceValid = presence !== '' && Number.isInteger(presenceMin) && presenceMin >= 0 && presenceMin <= 1440
  const unreadMin = Number(unread)
  const unreadValid = unread !== '' && Number.isInteger(unreadMin) && unreadMin >= 0 && unreadMin <= 1440
  const keepN = Number(keepAlive)
  const keepValid = keepAlive !== '' && Number.isInteger(keepN) && keepN >= 0 && keepN <= 50
  const childN = Number(children)
  const childValid = children !== '' && Number.isInteger(childN) && childN >= 1 && childN <= 20
  const bgN = Number(bgLimit)
  const bgValid = bgLimit !== '' && Number.isInteger(bgN) && bgN >= 1 && bgN <= 64
  const largeN = Number(largeMB)
  const largeValid = largeMB !== '' && Number.isInteger(largeN) && largeN >= 1 && largeN <= 50
  const pasteN = Number(longPaste)
  const pasteValid = longPaste !== '' && Number.isInteger(pasteN) && pasteN >= 0 && pasteN <= 1_000_000
  const tier = (x: CliSettings['tiers']['high']) => ({ ...x, model: x.model.trim() })
  const value: Settings = {
    openBrowser,
    requireToken,
    remoteAccess,
    askUserDefault,
    shell,
    proxy: proxy.trim(),
    contentWidth,
    appearance,
    fileFormat,
    language,
    cliOrder,
    stepTimeoutMinutes: valid ? minutes : initial.stepTimeoutMinutes,
    idleTimeoutMinutes: idleValid ? idleMin : initial.idleTimeoutMinutes,
    presenceGraceMinutes: presenceValid ? presenceMin : initial.presenceGraceMinutes,
    unreadGraceMinutes: unreadValid ? unreadMin : initial.unreadGraceMinutes,
    keepAliveLimit: keepValid ? keepN : initial.keepAliveLimit,
    reclaimIdleCli: reclaim,
    childConcurrency: childValid ? childN : initial.childConcurrency,
    backgroundLimit: bgValid ? bgN : initial.backgroundLimit,
    largeFileMB: largeValid ? largeN : initial.largeFileMB,
    // 内存采样间隔在设置 →「数据」里改，这里沿用原来的值
    memorySampleSeconds: initial.memorySampleSeconds,
    longPasteChars: pasteValid ? pasteN : initial.longPasteChars,
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
          maxTurns: d.maxTurns,
          options: d.options,
          authMode: d.authMode,
          apiId: d.apiId,
        },
      ]),
    ),
    apis,
    assist: { ...assist, model: assist.model.trim() },
    imageGen: { ...imageGen, model: imageGen.model.trim() },
    modelCatalog,
    usagePricingModel: pricingModel,
  }
  const save = useAutosave(
    value,
    async (v) => {
      setSettings(await api.saveSettings(v))
      // 不强制重新检测：每次自动保存都把 CLI 跑一遍会让保存变得很慢
      await refreshClis(false)
      // 登录方式、选的 API 或它的模型变了：这个 CLI 的模型下拉要重新读（账号和 API 各列各的）
      for (const c of CLIS) {
        const cs = v.clis[c.id]
        const a = cs?.authMode === 'api' ? v.apis.find((x) => x.id === cs.apiId) : undefined
        const sig = `${cs?.authMode ?? 'account'}|${a ? `${a.id}|${a.name}|${a.provider}|${a.protocol}|${a.baseUrl}|${a.apiKey}|${a.models.join(',')}` : ''}`
        if (modelSig.current[c.id] !== undefined && modelSig.current[c.id] !== sig)
          void loadCliModels(c.id, true).catch(() => {})
        modelSig.current[c.id] = sig
      }
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
  const cliPage = (s: Section) => s.id === 'models' || s.id === 'deploy' || s.id === 'apis' || !!s.cli
  const inCli = cliPage(cur)
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!
  const defDraft = drafts[defCli]
  const defApi = defDraft.authMode === 'api' ? apis.find((a) => a.id === defDraft.apiId) : undefined
  const defProtocol = defApi?.protocol

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label={t('设置分类')}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
      >
        <span className="hidden px-2.5 pt-1 pb-3 font-serif text-[1.25rem] font-semibold md:block">{t('设置')}</span>
        {SECTIONS.filter((s) => !cliPage(s) || s.id === 'models').map((s, i, list) => {
          // CLI 相关的几页（默认 CLI 和各个 CLI）在左栏里合成一项「CLI」
          const on = s.id === 'models' ? inCli : s.id === cur.id
          const head = s.group && s.group !== list[i - 1]?.group
          return (
            <div key={s.id} className="contents">
              {head && (
                // 窄屏左栏是横向的一行，不显示组名
                <span
                  className={cn('hidden px-2.5 pb-1 text-[0.6875rem] text-subtle md:block', i > 0 ? 'pt-3' : 'pt-0')}
                >
                  {s.group}
                </span>
              )}
              <button
                onClick={() => onSection(s.id)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] whitespace-nowrap transition-colors',
                  on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                )}
              >
                {s.id === 'models' ? (
                  <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                ) : (
                  s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                )}
                <span className="truncate">{s.id === 'models' ? 'Agent' : s.label}</span>
                {s.id === 'update' && update && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有新版本')} />
                )}
              </button>
            </div>
          )
        })}
      </nav>

      {inCli && (
        // CLI 的二级列表：默认 CLI 和各个 CLI，CLI 可以拖动调整顺序（新建 Agent、下拉框里也按这个顺序）
        <nav
          aria-label="Agent"
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3 md:pt-6"
        >
          {SECTIONS.filter(cliPage).map((s, i, list) => {
            const on = s.id === cur.id
            const st = s.cli && statusOf(s.cli.id)
            const at = s.cli ? ordered.findIndex((c) => c.id === s.cli!.id) : -1
            // 已接入的排在前面；已安装但停用、没安装的都归到「未启用」
            // 组头还要跟当前项自己的状态一致，否则已接入的 CLI 也会被当成未启用组的开头
            const ready = !!s.cli && isReady(s.cli.id)
            const firstReady = ready && !list.slice(0, i).some((x) => !!x.cli && isReady(x.cli.id))
            const firstOff = !!s.cli && !ready && !list.slice(0, i).some((x) => !!x.cli && !isReady(x.cli.id))
            return (
              <div key={s.id} className="contents">
                {firstReady && (
                  <span className="hidden items-center justify-between px-2.5 pt-3 pb-1 text-[0.6875rem] text-subtle md:flex">
                    {t('已接入')}
                    <span className="text-[0.65625rem] text-subtle/80">{t('拖动调整顺序')}</span>
                  </span>
                )}
                {firstOff && (
                  <span className="hidden px-2.5 pt-3 pb-1 text-[0.6875rem] text-subtle md:flex">{t('未启用')}</span>
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
                    if (s.cli.id !== dragging) moveCli(dragging, at)
                  }}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={() => setDragging('')}
                  onKeyDown={(e) => {
                    if (!s.cli || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                    e.preventDefault()
                    moveCli(s.cli.id, at + (e.key === 'ArrowUp' ? -1 : 1))
                  }}
                  className={cn(
                    'group flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] whitespace-nowrap transition-colors',
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
                    <span className="text-[0.6875rem] font-normal text-subtle">{t('默认')}</span>
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
          <h2 className="min-w-0 flex-1 truncate font-serif text-[1.25rem] font-semibold">{cur.label}</h2>
          <SaveIndicator {...save} invalid={valid ? undefined : t('超时时间需要是 0 到 1440 的整数')} />
          <DialogCloseButton label={t('关闭设置')} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">
          {cur.id === 'styles' && <StylesSettings />}
          {cur.id === 'fonts' && <FontSection value={appearance} onChange={setAppearance} />}
          {cur.id === 'remote' && <RemoteSection value={remoteAccess} onChange={setRemoteAccess} />}
          {cur.id === 'apis' && <ApiSection apis={apis} onChange={setApis} />}
          {cur.id === 'integrations' && <IntegrationsSection />}
          {cur.id === 'general' && (
            <Group>
              {demo && (
                <p className="mb-2 flex gap-2.5 rounded-xl border p-3.5 text-[0.8125rem] leading-relaxed text-subtle">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 Agent。')}
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
                  '分钟，填 0 不检测。Agent 这么久没有任何输出时在任务里提醒一次，再过同样的时间还没有就自动停止，免得卡在登录或确认上一直显示执行中。',
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
              <Row
                title={t('自动回收闲置 Agent')}
                desc={t(
                  '回复完没人看着的空闲 Agent 会在下面两段时间结束后回收，用户回来时重新启动（几秒，会话会续接）。正在执行的对话不受这两段时间和数量上限管，页面切到后台也照样跑完。关掉后不再按时间回收，只会按「同时保活的会话上限」收，进程会越攒越多。',
                )}
              >
                <Switch aria-label={t('自动回收闲置 Agent')} checked={reclaim} onCheckedChange={setReclaim} />
              </Row>
              <Row
                title={t('离开对话后保留多久')}
                desc={t(
                  '分钟，填 0 表示回复完就结束这一轮。对话页切走后，面板会把回复完的 Agent 留着，这段时间内回来发消息能直接接着说，不用重新启动 Agent；每个还在等的对话会占用一个 Agent 进程。只算回复完停在等下一句的空闲对话：正在执行的对话不管页面开着还是切到后台，都不会因为这个时长被收掉。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={presence}
                    onChange={(e) => setPresence(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!presenceValid}
                    className={cn('h-9', !presenceValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('离开对话后保留多久（分钟）')}
                  />
                  {!presenceValid && (
                    <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不保留')}</span>
                  )}
                </div>
              </Row>
              <Row
                title={t('没看过的回复保留多久')}
                desc={t(
                  '分钟，填 0 表示回复完就回收。这一轮回复完成、但对话还没打开看过（侧栏的橙点还亮着）时，最多再留这么久；到期回收，之后打开对话会重新启动 Agent 并续接会话。同样是只算空闲对话，正在执行的不受影响。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={unread}
                    onChange={(e) => setUnread(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!unreadValid}
                    className={cn('h-9', !unreadValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('没看过的回复保留多久（分钟）')}
                  />
                  {!unreadValid && (
                    <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不保留')}</span>
                  )}
                </div>
              </Row>
              <Row
                title={t('同时保活的会话上限')}
                desc={t(
                  '回复完停在等下一句、又没人在看的对话最多留几个，超过就结束最久没用（下次打开需要重新启动一次）。只统计回复完在等下一句的空闲对话：正在执行的对话（包括已经切到后台在跑的）不占名额，也不会被收掉。填 0 表示不限制。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={keepAlive}
                    onChange={(e) => setKeepAlive(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!keepValid}
                    className={cn('h-9', !keepValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('同时保活的会话上限')}
                  />
                  {!keepValid && <span className="text-xs text-danger">{t('填 0 到 50 之间的整数')}</span>}
                </div>
              </Row>
              <Row
                title={t('同时执行的子对话')}
                desc={t(
                  '一个项目对话下最多同时执行几个子对话，超出的排队，前面的做完再开始。每个子对话至少占一个 Agent 进程，跑工作流时更多。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={children}
                    onChange={(e) => setChildren(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!childValid}
                    className={cn('h-9', !childValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('同时执行的子对话')}
                  />
                  {!childValid && <span className="text-xs text-danger">{t('填 1 到 20 之间的整数')}</span>}
                </div>
              </Row>
              <Row
                title={t('同时运行的后台命令')}
                desc={t(
                  '所有对话交给面板在后台跑的命令（完整测试、编译）最多同时跑几条，超出的排队，前面的跑完一条再开始。机器配置低时调小，免得一起跑卡住。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={bgLimit}
                    onChange={(e) => setBgLimit(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!bgValid}
                    className={cn('h-9', !bgValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('同时运行的后台命令')}
                  />
                  {!bgValid && <span className="text-xs text-danger">{t('填 1 到 64 之间的整数')}</span>}
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
                  <span className="w-14 font-mono text-[0.8125rem] text-muted tabular-nums">{contentWidth}px</span>
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
                    '检查更新、下载新版本时使用。访问不了 GitHub 时填本机代理的地址；留空时先直连，连不上会自动尝试本机正在运行的代理（系统代理或常见端口），没开代理软件就不会走代理。也认环境变量 HTTPS_PROXY。',
                  )}
                >
                  <Input
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder="http://127.0.0.1:7890"
                    className="w-[240px] font-mono text-[0.8125rem]"
                    spellCheck={false}
                    aria-label={t('网络代理')}
                  />
                </Row>
              )}
              <Row
                title={t('新会话默认开启提问')}
                desc={t(
                  '输入框上的「提问」按钮在新会话里默认打开：AI 有问题时弹出卡片问你，等你回答再继续。关着时 AI 自己选最合适的做法。已有的会话保持各自的选择。',
                )}
              >
                <Switch
                  aria-label={t('新会话默认开启提问')}
                  checked={askUserDefault}
                  onCheckedChange={setAskUserDefault}
                />
              </Row>
              <Row
                title={t('大文件只引用路径')}
                desc={t(
                  'MB。粘贴、拖进输入框的文件超过这么大时不上传、不拷进对话目录，面板在本机找到原文件后直接引用它的路径。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={largeMB}
                    onChange={(e) => setLargeMB(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!largeValid}
                    className={cn('h-9', !largeValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('大文件只引用路径（MB）')}
                  />
                  {!largeValid && <span className="text-xs text-danger">{t('填 1 到 50 之间的整数')}</span>}
                </div>
              </Row>
              <Row
                title={t('长文字存成文件')}
                desc={t(
                  '字，填 0 不转。粘贴进输入框的纯文字超过这么多字时存成一个文本文件，输入框里只放这个文件的卡片，消息不会被一大段文字撑满。',
                )}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={longPaste}
                    onChange={(e) => setLongPaste(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!pasteValid}
                    className={cn('h-9', !pasteValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('长文字存成文件（字）')}
                  />
                  {!pasteValid && (
                    <span className="text-xs text-danger">{t('填 0 到 1000000 之间的整数，0 表示不转')}</span>
                  )}
                </div>
              </Row>
              <ShellSetting value={shell} onChange={setShell} />
              <Row
                title={t('新建文件的格式')}
                desc={t(
                  '面板写说明文件、部署全局说明，以及交给角色的约定都按这里来。默认 UTF-8（不带 BOM）+ LF：Windows 上编辑、WSL / Linux 里跑测试时，脚本不会因为 CRLF 或 BOM 报 bad interpreter。项目可以单独设置。',
                )}
                stack
              >
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">{t('编码')}</span>
                    <Select
                      aria-label={t('文件编码')}
                      value={fileFormat.encoding}
                      onChange={(e) =>
                        setFileFormat({ ...fileFormat, encoding: e.target.value as typeof fileFormat.encoding })
                      }
                      className="w-[190px]"
                      options={[
                        { value: 'utf8', label: t('UTF-8（不带 BOM）') },
                        { value: 'utf8-bom', label: 'UTF-8（带 BOM）' },
                      ]}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">{t('换行符')}</span>
                    <Select
                      aria-label={t('换行符')}
                      value={fileFormat.eol}
                      onChange={(e) => setFileFormat({ ...fileFormat, eol: e.target.value as typeof fileFormat.eol })}
                      className="w-[190px]"
                      options={[
                        { value: 'lf', label: 'LF（Linux / macOS）' },
                        { value: 'crlf', label: 'CRLF（Windows）' },
                      ]}
                    />
                  </label>
                </div>
              </Row>
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
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {t(
                  '角色可以不指定 Agent，选「系统默认」时用这里的 Agent；模型可以只选高、中、低一档，执行时换成那个 Agent 对应档位的模型和思考强度。改这里就能让所有用默认设置的角色一起切换。',
                )}
              </p>
              <Group>
                <Row title={t('默认 Agent')} desc={t('角色选了「系统默认」或没有指定 Agent 时使用')}>
                  <Select
                    aria-label={t('默认 Agent')}
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
                    value={defDraft.tiers}
                    defaultModel={defDraft.defaultModel}
                    protocol={defProtocol}
                    apiModelMap={defApi?.modelMap}
                    apiModelEfforts={defApi?.modelEfforts}
                    readOnly
                  />
                </Row>
                {/* 默认模型和思考强度也只展示，在对应 CLI 里改 */}
                <Row title={t('默认模型')} desc={t('角色没有指定模型时使用，跟随 {cli} 的设置', { cli: defDef.name })}>
                  <ReadValue mono>{defaultModelText(defDef, drafts[defCli])}</ReadValue>
                </Row>
                <Row
                  title={t('默认思考强度')}
                  desc={t('角色和档位都没有指定时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                >
                  <ReadValue>{defaultEffortText(defDef, defDraft)}</ReadValue>
                </Row>
              </Group>
              <Group title={t('模型目录')}>
                <Row
                  title={t('未知模型用 AI 补全')}
                  desc={t(
                    '模型目录里没有的模型，可以在三档模型旁边点「AI 补全」，用「AI 创建」里设置的 Agent 联网查上下文窗口、最大输出、默认和可选的思考强度。',
                  )}
                >
                  <Switch
                    aria-label={t('未知模型用 AI 补全')}
                    checked={modelCatalog.aiLookup}
                    onCheckedChange={(v) => setModelCatalog({ ...modelCatalog, aiLookup: v })}
                  />
                </Row>
                <Row
                  title={t('补充目录')}
                  desc={t('AI 补全的模型信息写在这里，和内置目录合并使用；目前收录 {n} 个模型。', {
                    n: catalogInfo?.entries.length ?? 0,
                  })}
                >
                  <ReadValue mono>{catalogInfo?.file || '~/.agent-panel/config/models.json'}</ReadValue>
                </Row>
              </Group>
              <Group title={t('图片生成')}>
                <Row
                  title={t('图片生成 Agent')}
                  desc={t(
                    'UI 设计里生成图片时使用。目前只有 Codex 内置了生图工具，用 ChatGPT 账号登录即可，不需要 API Key。',
                  )}
                >
                  <Select
                    aria-label={t('图片生成 Agent')}
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
                <Row title={t('图片生成模型')} desc={t('调用生图工具的模型，不选时用这个 Agent 的高档模型')}>
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
                    'Agent 是每张图各开一个进程，最多同时开这么多个；浏览器是在选中的 Gemini / ChatGPT 标签页里只开这么多个对话（网页左边的对话列表里能看到），之后的图排队，哪个对话空了就接着用哪个。',
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
              apis={apis}
              onGoApis={() => onSection('apis')}
              onAddApi={(a) => setApis((l) => [...l, a])}
            />
          )}

          {cur.id === 'local-image' && (
            <LocalImageSection value={imageGen.local} onChange={(local) => setImageGen({ ...imageGen, local })} />
          )}
          {cur.id === 'data' && <DataSection />}
          {cur.id === 'usage' && <UsageSection pricingModel={pricingModel} onPricingModel={setPricingModel} />}
          {cur.id === 'deploy' && <DeploySection />}
          {cur.id === 'tags' && <TagsSection />}
          {cur.id === 'global-lessons' && <GlobalLessonsSection />}
          {cur.id === 'update' && <UpdateSection />}

          {cur.id === 'categories' && <ProjectCategoryList />}

          {cur.id === 'assist' && (
            <>
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {t(
                  '在角色和工作流页面可以用本机 Agent 对话生成或优化配置。Agent 按固定格式输出，面板校验通过后才能应用。',
                )}
              </p>
              <Group>
                <Row title={t('使用的 Agent')} desc={t('默认用「Agent」里设为默认的那个')}>
                  <Select
                    aria-label={t('AI 创建使用的 Agent')}
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
                <Row title={t('模型')} desc={t('默认用这个 Agent 设置里的默认模型')}>
                  <AssistModel
                    key={assist.cli || defCli}
                    cli={assist.cli || defCli}
                    draft={drafts[assist.cli || defCli]}
                    value={assist.model}
                    onChange={(v) => setAssist({ ...assist, model: v })}
                  />
                </Row>
                <Row title={t('创建角色的补充规则')} desc={t('会加进提示词，例如命名习惯、团队约定')} stack>
                  <Textarea
                    rows={4}
                    value={assist.agentRules}
                    onChange={(e) => setAssist({ ...assist, agentRules: e.target.value })}
                    placeholder={t(
                      '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的角色默认用 Claude Code',
                    )}
                    className="font-mono text-[0.8125rem]"
                  />
                </Row>
                <Row title={t('创建工作流的补充规则')} stack>
                  <Textarea
                    rows={4}
                    value={assist.workflowRules}
                    onChange={(e) => setAssist({ ...assist, workflowRules: e.target.value })}
                    placeholder={t('例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮')}
                    className="font-mono text-[0.8125rem]"
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
