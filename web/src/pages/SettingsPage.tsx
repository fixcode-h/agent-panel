import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from '@/lib/toast'
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
  Network,
  ShieldCheck,
  GraduationCap,
  Gauge,
  Keyboard,
  Mic,
  Search,
  Component,
  Box,
} from 'lucide-react'
import { CLIS, type CliDefinition } from '@shared/clis'
import { type CliSettings, type Settings, CONTENT_MAX, CONTENT_WIDTH } from '@shared/schema'
import { applyContentWidth, switchLang } from '@/lib/data'
import { LANGS, t } from '@shared/i18n'
import { WEBHOOK_MAX_ATTEMPTS } from '@shared/schedule'
import { defaultCli, orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { loadCliModels, preloadCliModels, setCliMode, useCliDef } from '@/lib/cli-models'
import { useModelCatalog } from '@/lib/model-catalog'
import { resumeInstallJobs, setInstallFinish } from '@/lib/cli-install'
import { notifyEnabled, notifySupported, setNotify } from '@/lib/notify'
import { useAutosave } from '@/lib/useAutosave'
import { onSettingsReloaded } from '@/lib/ui-actions'
import { hotkeyLabel } from '@/lib/hotkey'
import { pickButtonLabel } from '@/lib/element-pick'
import { cn, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/modal'
import { Badge } from '@/components/ui/badge'
import { NavRow } from '@/components/ui/sidebar'
import { Kbd } from '@/components/ui/kbd'
import { SaveIndicator } from '@/components/layout/Detail'
import { UpdateSection } from '@/components/settings/UpdateSection'
import { StylesSettings } from '@/components/settings/StylesSettings'
import { ApiSection } from '@/components/settings/ApiSection'
import { DataSection } from '@/components/settings/DataSection'
import { UsageSection } from '@/components/usage/UsageSection'
import { LocalImageSection } from '@/components/settings/LocalImageSection'
import { BlenderSection } from '@/components/settings/BlenderSection'
import { TagsSection } from '@/components/settings/TagsSection'
import { GlobalLessonsSection } from '@/components/projects/Lessons'
import { RemoteSection } from '@/components/settings/RemoteSection'
import { NetworkSection } from '@/components/settings/NetworkSection'
import { WebSearchSection } from '@/components/settings/WebSearchSection'
import { SpeechSection } from '@/components/settings/SpeechSection'
import { IntegrationsSection } from '@/components/settings/IntegrationsSection'
import { DeploySection } from '@/components/settings/DeploySection'
import { FontSection } from '@/components/settings/FontSection'
import { ComponentsSection } from '@/components/settings/ComponentsSection'
import { ShortcutsSection } from '@/components/settings/ShortcutsSection'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/projects/ProjectSettingsDialog'
import { useAppUpdate } from '@/lib/app-update'
import { deployedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { Group, ReadValue, Row } from '@/components/settings/parts'
import { SectionToc, revealSetting, setSectionScroll } from '@/components/settings/section-nav'
import { SettingsSearchBox, SettingsSearchResults, type SettingsHitGroup } from '@/components/settings/SettingsSearch'
import { fillVars, searchSettings, searchTerms, type SettingsItem } from '@/lib/settings-search'
import settingsIndex from 'virtual:settings-index'
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

/** 抓取键的显示名（「常规」里的开发者模式那行写着，细则在「快捷键」） */
const pickLabel = pickButtonLabel

// 左栏按分组列出，组内顺序就是这里的顺序
const sectionsFor = (clis: CliDefinition[]): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2, group: t('通用') },
  { id: 'shortcuts', label: t('快捷键'), icon: Keyboard, group: t('通用') },
  { id: 'speech', label: t('语音输入'), icon: Mic, group: t('通用') },
  { id: 'fonts', label: t('外观'), icon: Type, group: t('通用') },
  { id: 'components', label: t('组件'), icon: Component, group: t('通用') },
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
  { id: 'network', label: t('网络与代理'), icon: Network, group: t('连接') },
  { id: 'web-search', label: t('联网搜索'), icon: Search, group: t('连接') },
  { id: 'local-image', label: t('本机生图'), icon: ImageIcon, group: t('生图') },
  { id: 'styles', label: t('风格库'), icon: Palette, group: t('生图') },
  { id: 'blender', label: 'Blender', icon: Box, group: t('建模') },
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
  const [childAsk, setChildAsk] = useState(String(initial.childIdleAskMinutes))
  const [presence, setPresence] = useState(String(initial.presenceGraceMinutes))
  const [unread, setUnread] = useState(String(initial.unreadGraceMinutes))
  const [keepAlive, setKeepAlive] = useState(String(initial.keepAliveLimit))
  const [archiveDays, setArchiveDays] = useState(String(initial.autoArchiveDays))
  const [reclaim, setReclaim] = useState(initial.reclaimIdleCli)
  const [bgLimit, setBgLimit] = useState(String(initial.backgroundLimit))
  const [largeMB, setLargeMB] = useState(String(initial.largeFileMB))
  const [longPaste, setLongPaste] = useState(String(initial.longPasteChars))
  const [notify, setNotifyOn] = useState(notifyEnabled)
  const [webhookOn, setWebhookOn] = useState(initial.webhook.enabled)
  const [webhookUrl, setWebhookUrl] = useState(initial.webhook.url)
  const [openBrowser, setOpenBrowser] = useState(initial.openBrowser)
  const [requireToken, setRequireToken] = useState(initial.requireToken)
  const [remoteAccess, setRemoteAccess] = useState(initial.remoteAccess)
  const [askUserDefault, setAskUserDefault] = useState(initial.askUserDefault)
  const [userName, setUserName] = useState(initial.userName)
  const [childAskUserDefault, setChildAskUserDefault] = useState(initial.childAskUserDefault)
  const [developerMode, setDeveloperMode] = useState(initial.developerMode)
  const [elementPicker, setElementPicker] = useState(initial.elementPicker)
  const [shell, setShell] = useState(initial.shell)
  const [proxy, setProxy] = useState(initial.proxy)
  const [proxyOn, setProxyOn] = useState(initial.networkProxyEnabled)
  const [webSearch, setWebSearch] = useState(initial.webSearch)
  const [speech, setSpeech] = useState(initial.speech)
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
  // 在线演示没有服务端，外网访问和网络代理的开关不显示
  const SECTIONS = sectionsFor(ordered).filter((s) => !(demo && (s.id === 'remote' || s.id === 'network')))
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
  const [blender, setBlender] = useState(initial.blender)
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
  const childAskMin = Number(childAsk)
  const childAskValid = childAsk !== '' && Number.isInteger(childAskMin) && childAskMin >= 0 && childAskMin <= 1440
  const presenceMin = Number(presence)
  const presenceValid = presence !== '' && Number.isInteger(presenceMin) && presenceMin >= 0 && presenceMin <= 1440
  const unreadMin = Number(unread)
  const unreadValid = unread !== '' && Number.isInteger(unreadMin) && unreadMin >= 0 && unreadMin <= 1440
  const keepN = Number(keepAlive)
  const keepValid = keepAlive !== '' && Number.isInteger(keepN) && keepN >= 0 && keepN <= 50
  const archiveN = Number(archiveDays)
  const archiveValid = archiveDays !== '' && Number.isInteger(archiveN) && archiveN >= 0 && archiveN <= 3650
  const bgN = Number(bgLimit)
  const bgValid = bgLimit !== '' && Number.isInteger(bgN) && bgN >= 1 && bgN <= 64
  const largeN = Number(largeMB)
  const largeValid = largeMB !== '' && Number.isInteger(largeN) && largeN >= 1 && largeN <= 50
  const pasteN = Number(longPaste)
  const pasteValid = longPaste !== '' && Number.isInteger(pasteN) && pasteN >= 0 && pasteN <= 1_000_000
  const webhookUrlTrimmed = webhookUrl.trim()
  // 只接受 http / https：填错时提示并沿用原来的地址，不把半截地址存进去（和超时那一项同一个口径）
  const webhookValid = !webhookUrlTrimmed || /^https?:\/\//.test(webhookUrlTrimmed)
  const tier = (x: CliSettings['tiers']['high']) => ({ ...x, model: x.model.trim() })
  const value: Settings = {
    defaultsVersion: initial.defaultsVersion,
    openBrowser,
    requireToken,
    remoteAccess,
    askUserDefault,
    userName: userName.trim(),
    childAskUserDefault,
    developerMode,
    elementPicker,
    shell,
    proxy: proxy.trim(),
    networkProxyEnabled: proxyOn,
    contentWidth,
    appearance,
    fileFormat,
    language,
    cliOrder,
    stepTimeoutMinutes: valid ? minutes : initial.stepTimeoutMinutes,
    idleTimeoutMinutes: idleValid ? idleMin : initial.idleTimeoutMinutes,
    childIdleAskMinutes: childAskValid ? childAskMin : initial.childIdleAskMinutes,
    // 只存设置，地址属外部配置：没填就存空字符串，不发请求；投递规则见 server/webhook.ts
    webhook: { enabled: webhookOn, url: webhookValid ? webhookUrlTrimmed : initial.webhook.url },
    // 联网搜索：搜索源和密钥（开关在 CLI 自己的设置里，不在这份全局设置里）
    webSearch,
    speech,
    presenceGraceMinutes: presenceValid ? presenceMin : initial.presenceGraceMinutes,
    unreadGraceMinutes: unreadValid ? unreadMin : initial.unreadGraceMinutes,
    keepAliveLimit: keepValid ? keepN : initial.keepAliveLimit,
    autoArchiveDays: archiveValid ? archiveN : initial.autoArchiveDays,
    reclaimIdleCli: reclaim,
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
    blender: { path: blender.path.trim() },
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
  // 「部署」那份和这一版不同时，左栏的「Agent」和二级列表的「部署」都亮点（侧栏「设置」读同一份派生值）
  const deployDot = deployedUpdateHint(useSkillUpdates())
  // 提示挂在 aria-describedby 上：放进按钮里会被算进可访问名称，按名字找这一项就找不到了
  const agentHintId = useId()
  const deployHintId = useId()
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!
  const defDraft = drafts[defCli]
  const defApi = defDraft.authMode === 'api' ? apis.find((a) => a.id === defDraft.apiId) : undefined
  const defProtocol = defApi?.protocol

  // 搜索：跨所有页搜设置项（索引在构建时从源码抽出，见 scripts/lib/settings-index.mjs）
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const terms = searchTerms(query)
  const searching = terms.length > 0
  const sectionPath = (s: Section) => (cliPage(s) && s.id !== 'models' ? `Agent › ${s.label}` : s.label)
  const sectionIcon = (s: Section) =>
    s.cli ? (
      <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: cliColor(s.cli.id) }} />
    ) : s.id === 'models' ? (
      <SquareTerminal className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
    ) : (
      s.icon && <s.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
    )
  const defName = CLIS.find((c) => c.id === defCli)?.name ?? defCli
  // 索引存的是中文原文：翻成当前语言再搜；各个 CLI 共用的那页（@cli）落到默认 CLI 上
  const searchItems = useMemo(() => {
    const vars = { cli: defName }
    const pages = new Set(SECTIONS.map((s) => s.id))
    const tr = (zh?: string) => (zh ? fillVars(t(zh), vars) : undefined)
    const items: SettingsItem[] = SECTIONS.map((s) => ({
      section: s.id,
      title: s.id === 'models' ? 'Agent' : s.label,
      isSection: true,
      zh: s.id,
    }))
    for (const e of settingsIndex) {
      const section = e.section === '@cli' ? `cli:${defCli}` : e.section
      if (!pages.has(section)) continue
      items.push({
        section,
        title: tr(e.title)!,
        group: e.isGroup ? undefined : tr(e.group),
        desc: tr(e.desc),
        isGroup: e.isGroup,
        zh: [e.title, e.group, e.desc].filter(Boolean).join('\n'),
      })
    }
    return items
    // SECTIONS 每次渲染都重建，按它的 id 序列判断变化即可
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [SECTIONS.map((s) => s.id).join(), defCli, defName])
  // 结果按左栏的顺序分组；整页那一项排在组里最前面
  const hitGroups: SettingsHitGroup[] = searching
    ? SECTIONS.flatMap((s) => {
        const items = searchSettings(
          searchItems.filter((it) => it.section === s.id),
          query,
        )
        return items.length ? [{ section: s.id, label: sectionPath(s), icon: sectionIcon(s), items }] : []
      })
    : []
  const hits = hitGroups.flatMap((g) => g.items)
  const hitCount = (id: string) => hitGroups.find((g) => g.section === id)?.items.length ?? 0
  // 左栏每一项命中几条：Agent 那一项合计默认 Agent、部署、API 和各个 CLI 页
  const navHits = (s: Section) =>
    (s.id === 'models' ? SECTIONS.filter(cliPage) : [s]).reduce((n, x) => n + hitCount(x.id), 0)
  // 换了搜索词从第一项开始选
  useEffect(() => setHit(0), [query])
  const pick = (it: SettingsItem) => {
    setQuery('')
    onSection(it.section)
    if (it.isSection) return
    const css = (v: string) => CSS.escape(v)
    revealSetting(
      it.isGroup
        ? [`[data-setting-group="${css(it.title)}"] > h3`]
        : [
            ...(it.group ? [`[data-setting-group="${css(it.group)}"] [data-setting="${css(it.title)}"]`] : []),
            `[data-setting="${css(it.title)}"]`,
          ],
    )
  }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      setQuery('')
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setHit((i) => (i + d + hits.length) % hits.length)
    } else if (e.key === 'Enter' && hits[hit]) {
      e.preventDefault()
      pick(hits[hit])
    }
  }
  // Ctrl / ⌘ + F 聚焦搜索框（照 VS Code 的设置页），不弹浏览器自己的页内查找
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label={t('设置分类')}
        className="flex min-h-0 shrink-0 border-b bg-rail md:w-[220px] md:flex-col md:border-r md:border-b-0"
      >
        {/* 标题和搜索框固定在左栏顶部，不跟着分类滚动：滚到下面的分类（例如 Agent）时还认得出这是设置、随时能搜。
            只让下面的分类列表滚动，滚动条从搜索框下面开始，不越过搜索框（用户要求） */}
        <div className="flex shrink-0 items-center p-2 pr-0 md:block md:px-2.5 md:pt-3 md:pb-0">
          <span className="hidden px-2.5 pt-1 pb-4 font-serif text-[1.25rem] font-semibold tracking-tight md:block">
            {t('设置')}
          </span>
          <SettingsSearchBox value={query} onChange={setQuery} onKeyDown={onSearchKey} inputRef={searchRef} />
        </div>
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto p-2 md:min-h-0 md:flex-col md:overflow-x-visible md:overflow-y-auto md:px-2.5 md:pt-0 md:pb-3">
          {SECTIONS.filter((s) => !cliPage(s) || s.id === 'models').map((s, i, list) => {
            // CLI 相关的几页（默认 CLI 和各个 CLI）在左栏里合成一项「CLI」
            // 搜索时内容区是结果列表，左栏不再标当前页
            const on = !searching && (s.id === 'models' ? inCli : s.id === cur.id)
            const head = s.group && s.group !== list[i - 1]?.group
            return (
              <div key={s.id} className="contents">
                {head && (
                  // 窄屏左栏是横向的一行，不显示组名
                  <span
                    className={cn(
                      'hidden px-2.5 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-subtle md:block',
                      i > 0 ? 'pt-4' : 'pt-0',
                    )}
                  >
                    {s.group}
                  </span>
                )}
                {/* 窄屏左栏是横向一行：行宽按文字走（w-auto），md 以上竖排才撑满 */}
                <NavRow
                  onClick={() => {
                    setQuery('')
                    onSection(s.id)
                  }}
                  on={on}
                  aria-describedby={s.id === 'models' && deployDot ? agentHintId : undefined}
                  className={cn(
                    'w-auto shrink-0 whitespace-nowrap md:w-full',
                    searching && !navHits(s) && 'opacity-50',
                  )}
                  icon={
                    s.id === 'models' ? (
                      <SquareTerminal className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={1.8} />
                    ) : (
                      s.icon && (
                        <s.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={1.8} />
                      )
                    )
                  }
                  label={s.id === 'models' ? 'Agent' : s.label}
                  trailing={
                    <>
                      {/* 搜索时每页右边写命中几项，没命中的页淡下去 */}
                      {searching && navHits(s) > 0 && (
                        <span className="shrink-0 text-[0.75rem] text-subtle tabular-nums">{navHits(s)}</span>
                      )}
                      {s.id === 'update' && update && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有新版本')} />
                      )}
                      {/* 「部署」在 Agent 的二级列表里：自带技能要更新时先在这一项上亮点 */}
                      {s.id === 'models' && deployDot && (
                        <span
                          aria-hidden="true"
                          title={deployDot}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        />
                      )}
                    </>
                  }
                />
                {s.id === 'models' && deployDot && (
                  <span id={agentHintId} className="sr-only">
                    {deployDot}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </nav>

      {inCli && !searching && (
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
                  <span className="hidden items-center justify-between px-2.5 pt-4 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-subtle md:flex">
                    {t('已接入')}
                    <span className="font-normal tracking-normal text-subtle/70">{t('拖动调整顺序')}</span>
                  </span>
                )}
                {firstOff && (
                  <span className="hidden px-2.5 pt-4 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-subtle md:flex">
                    {t('未启用')}
                  </span>
                )}
                <NavRow
                  onClick={() => onSection(s.id)}
                  on={on}
                  aria-describedby={s.id === 'deploy' && deployDot ? deployHintId : undefined}
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
                    'group w-auto shrink-0 whitespace-nowrap md:w-full',
                    s.cli && dragging === s.cli.id && 'opacity-50',
                  )}
                  icon={
                    s.cli ? (
                      <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(s.cli.id) }} />
                    ) : (
                      s.icon && (
                        <s.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={1.8} />
                      )
                    )
                  }
                  label={s.label}
                  trailing={
                    <>
                      {s.id === 'deploy' && deployDot && (
                        <span
                          aria-hidden="true"
                          title={deployDot}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        />
                      )}
                      {/* 选中行的底色就是 sel，「默认」小签换成卡片底才分得开（同侧栏的 SidebarCount） */}
                      {s.cli && defCli === s.cli.id && (
                        <Badge className={cn('px-1.5 text-[0.625rem]', on && 'bg-card')}>{t('默认')}</Badge>
                      )}
                      {s.cli && (
                        <GripVertical className="hidden h-3.5 w-3.5 shrink-0 text-subtle opacity-0 group-hover:opacity-100 md:block" />
                      )}
                      {st && (
                        <span
                          className={cn(
                            'hidden h-1.5 w-1.5 shrink-0 rounded-full md:block',
                            st.installed && st.enabled ? 'bg-success' : 'bg-line-strong',
                          )}
                        />
                      )}
                    </>
                  }
                />
                {s.id === 'deploy' && deployDot && (
                  <span id={deployHintId} className="sr-only">
                    {deployDot}
                  </span>
                )}
              </div>
            )
          })}
        </nav>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-4 md:px-9 md:pt-6">
          <h2 className="min-w-0 flex-1 truncate font-serif text-[1.25rem] font-semibold tracking-tight">
            {searching ? t('搜索设置') : cur.label}
            {searching && hits.length > 0 && (
              <span className="ml-2.5 font-sans text-[0.8125rem] font-normal tracking-normal text-subtle">
                {t('{n} 项', { n: hits.length })}
              </span>
            )}
          </h2>
          <SaveIndicator {...save} invalid={valid ? undefined : t('超时时间需要是 0 到 1440 的整数')} />
          <DialogCloseButton label={t('关闭设置')} />
        </header>
        {/* 这一节有多个小节时，标题下面多一条页内导航（见 section-nav.tsx） */}
        {!searching && <SectionToc />}
        <div
          ref={setSectionScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-12 [scrollbar-gutter:stable] md:px-9"
        >
          {searching && (
            <SettingsSearchResults
              groups={hitGroups}
              terms={terms}
              query={query}
              active={hit}
              onActive={setHit}
              onPick={pick}
            />
          )}
          {/* 搜索时各页照常挂着、只是藏起来：切回来时没保存的输入、读好的数据都还在 */}
          <div hidden={searching}>
            {cur.id === 'styles' && <StylesSettings />}
            {cur.id === 'fonts' && <FontSection value={appearance} onChange={setAppearance} />}
            {cur.id === 'components' && <ComponentsSection />}
            {cur.id === 'shortcuts' && <ShortcutsSection value={elementPicker} onChange={setElementPicker} />}
            {cur.id === 'remote' && <RemoteSection value={remoteAccess} onChange={setRemoteAccess} />}
            {cur.id === 'network' && (
              <NetworkSection
                enabled={proxyOn}
                proxy={proxy}
                onChange={({ enabled, proxy: url }) => {
                  setProxyOn(enabled)
                  setProxy(url)
                }}
              />
            )}
            {cur.id === 'apis' && <ApiSection apis={apis} onChange={setApis} />}
            {cur.id === 'web-search' && <WebSearchSection value={webSearch} onChange={setWebSearch} />}
            {cur.id === 'speech' && <SpeechSection value={speech} onChange={setSpeech} />}
            {cur.id === 'integrations' && <IntegrationsSection />}
            {cur.id === 'general' && (
              <>
                {demo && (
                  <p className="mb-2 flex gap-2.5 rounded-xl bg-sel/50 p-3.5 text-[0.8125rem] leading-relaxed text-subtle">
                    <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
                    {t('在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 Agent。')}
                  </p>
                )}
                <Group title={t('执行与超时')}>
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
                      {!valid && (
                        <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不限制')}</span>
                      )}
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
                    title={t('子对话没有输出时自动询问')}
                    desc={t(
                      '分钟，填 0 关闭。子对话这么久没有任何输出时，面板以父对话的名义问它当前在做什么、是否卡住；收到回复就重新计时，最多问 3 次后交给上面的「没有输出时提醒」。这两个时间互不影响，自动询问只问、不停止对话。',
                    )}
                  >
                    <div className="flex flex-col gap-1">
                      <Input
                        inputMode="numeric"
                        value={childAsk}
                        onChange={(e) => setChildAsk(e.target.value.replace(/[^\d]/g, ''))}
                        aria-invalid={!childAskValid}
                        className={cn(
                          'h-9',
                          !childAskValid && 'border-danger focus:border-danger focus:ring-danger/20',
                        )}
                        aria-label={t('子对话没有输出时自动询问（分钟）')}
                      />
                      {!childAskValid && (
                        <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不问')}</span>
                      )}
                    </div>
                  </Row>
                </Group>
                <Group title={t('Webhook 通知')}>
                  <Row
                    title={t('计划执行时发送 Webhook')}
                    desc={t(
                      '计划成功启动、启动失败、错过或上游没成功时，向这个地址 POST 一份 JSON，里面有计划、项目、这一轮的时间和结果。投递失败只记在计划上、不影响计划执行，最多重试 {n} 次。',
                      { n: WEBHOOK_MAX_ATTEMPTS },
                    )}
                  >
                    <div className="flex flex-col gap-1">
                      <Input
                        value={webhookUrl}
                        placeholder="https://example.com/hook"
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        aria-invalid={!webhookValid}
                        aria-label={t('Webhook 地址')}
                        className={cn('h-9', !webhookValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                      />
                      {!webhookValid && <span className="text-xs text-danger">{t('填 http 或 https 开头的地址')}</span>}
                    </div>
                  </Row>
                  <Row title={t('启用 Webhook')} desc={t('关掉时计划照常执行，只是不往外发。')}>
                    <Switch aria-label={t('启用 Webhook')} checked={webhookOn} onCheckedChange={setWebhookOn} />
                  </Row>
                </Group>
                <Group title={t('会话保活')}>
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
                        className={cn(
                          'h-9',
                          !presenceValid && 'border-danger focus:border-danger focus:ring-danger/20',
                        )}
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
                </Group>
                <Group title={t('对话归档')}>
                  <Row
                    title={t('自动归档不动的对话')}
                    desc={t(
                      '对话（连同子对话）这么多天没有动静、没在执行、回复也都看过了，就自动归档：列表里不再显示，在筛选里选「已归档」还能找到，随时可以取消归档。填 0 表示不自动归档。',
                    )}
                  >
                    <div className="flex flex-col gap-1">
                      <Input
                        inputMode="numeric"
                        value={archiveDays}
                        onChange={(e) => setArchiveDays(e.target.value.replace(/[^\d]/g, ''))}
                        aria-invalid={!archiveValid}
                        className={cn('h-9', !archiveValid && 'border-danger focus:border-danger focus:ring-danger/20')}
                        aria-label={t('自动归档不动的对话')}
                      />
                      {!archiveValid && (
                        <span className="text-xs text-danger">{t('填 0 到 3650 之间的整数，单位是天')}</span>
                      )}
                    </div>
                  </Row>
                </Group>
                <Group title={t('后台命令')}>
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
                </Group>
                <Group title={t('界面与启动')}>
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
                      <Switch
                        aria-label={t('启动后打开浏览器')}
                        checked={openBrowser}
                        onCheckedChange={setOpenBrowser}
                      />
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
                </Group>
                <Group title={t('输入与文件')}>
                  <Row
                    title={t('称呼')}
                    desc={t('提问卡片、子对话提问这些地方怎么称呼你，例如「需要用户回答」。不填写「用户」。')}
                  >
                    <Input
                      aria-label={t('称呼')}
                      value={userName}
                      maxLength={20}
                      placeholder={t('用户')}
                      onChange={(e) => setUserName(e.target.value)}
                      className="w-40"
                    />
                  </Row>
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
                    title={t('子对话默认也提问')}
                    desc={t(
                      '新建的父对话里「子对话也提问」默认打开：它之后新建的子对话会向你提问，而不是自己决定。已经创建的父对话和子对话不受影响，父对话上右键提问按钮可以单独改。',
                    )}
                  >
                    <Switch
                      aria-label={t('子对话默认也提问')}
                      checked={childAskUserDefault}
                      onCheckedChange={setChildAskUserDefault}
                    />
                  </Row>
                  <Row
                    title={t('开发者模式')}
                    desc={t(
                      '打开后对话输入框上多一个「抓取界面元素」按钮，也可以按快捷键开启抓取：抓取期间左键、右键照常可用，用设置里的鼠标键（默认中键）点选面板界面上的元素，它的源码位置、组件、文字和样式会作为引用放进输入框，发给 AI 修改面板自己的代码。Esc 退出。',
                    )}
                  >
                    <Switch aria-label={t('开发者模式')} checked={developerMode} onCheckedChange={setDeveloperMode} />
                  </Row>
                  <Row title={t('抓取元素的方式')} desc={t('快捷键和用哪个鼠标键抓取，到「快捷键」里改。')}>
                    <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                      <Kbd className="h-auto px-1.5 py-0.5 text-[0.75rem]">{hotkeyLabel(elementPicker.hotkey)}</Kbd>
                      <span>{t('＋')}</span>
                      <span>{pickLabel(elementPicker.button)}</span>
                      <Button variant="ghost" size="sm" onClick={() => onSection('shortcuts')}>
                        {t('去修改')}
                      </Button>
                    </div>
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
                          onChange={(e) =>
                            setFileFormat({ ...fileFormat, eol: e.target.value as typeof fileFormat.eol })
                          }
                          className="w-[190px]"
                          options={[
                            { value: 'lf', label: 'LF（Linux / macOS）' },
                            { value: 'crlf', label: 'CRLF（Windows）' },
                          ]}
                        />
                      </label>
                    </div>
                  </Row>
                </Group>
                <Group title={t('提示与通知')}>
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
              </>
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
                        <Button variant="link" className="inline" onClick={() => onSection(`cli:${defCli}`)}>
                          {defDef.name}
                        </Button>{' '}
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
                  <Row
                    title={t('默认模型')}
                    desc={t('角色没有指定模型时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                  >
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
            {cur.id === 'blender' && (
              <BlenderSection path={blender.path} onPath={(path) => setBlender({ ...blender, path })} />
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
  // 对话里的 AI 改了设置：窗口里的表单用新值重建，免得自动保存把旧值写回去
  const [rev, setRev] = useState(0)
  useEffect(() => onSettingsReloaded(() => setRev((n) => n + 1)), [])
  useEffect(() => {
    if (open) setCur(section ?? 'general')
  }, [open, section])
  return (
    // 点设置外面的空白处不关闭（Modal 默认），避免改到一半误关；用右上角的关闭按钮或 Esc 关闭。
    // 标题栏、左栏都由 SettingsBody 自己画，所以用 bare 外壳
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('设置')}
      bare
      size="xl"
      className="h-[min(840px,calc(100dvh-2rem))] max-w-[1200px]"
      // 搜索框里有字时 Esc 先清空搜索（框自己处理），不关掉整个设置
      onEscapeKeyDown={(e) => {
        const el = e.target
        if (el instanceof HTMLInputElement && el.hasAttribute('data-settings-search') && el.value) e.preventDefault()
      }}
    >
      {/* data-settings-dialog：index.css 按它换设置里的细滚动条 */}
      <div data-settings-dialog className="h-full min-h-0">
        {settings && <SettingsBody key={rev} initial={settings} section={cur} onSection={setCur} />}
      </div>
    </Modal>
  )
}
