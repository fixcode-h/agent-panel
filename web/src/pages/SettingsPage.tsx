import { Suspense, useEffect, useState, type SetStateAction } from 'react'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useModelCatalog } from '@/lib/model-catalog'
import { useAutosave } from '@/lib/useAutosave'
import { onSettingsReloaded } from '@/lib/ui-actions'
import { Modal } from '@/components/ui/modal'
import * as pp from '@/plugins/PluginParamsNav'
import { McpNav, mcpPage, useMcpPages } from '@/components/settings/mcp/McpNav'
import { SaveIndicator } from '@/components/layout/Detail'
import { StylesSettings } from '@/components/settings/StylesSettings'
import { ApiSection } from '@/components/settings/ApiSection'
import { TagsSection } from '@/components/settings/TagsSection'
import { GlobalLessonsSection } from '@/components/projects/Lessons'
import { NetworkSection } from '@/components/settings/NetworkSection'
import { FontSection } from '@/components/settings/FontSection'
import { ShortcutsSection } from '@/components/settings/ShortcutsSection'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/ui/dialog-nav'
import { deployedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { SectionToc, setSectionScroll } from '@/components/settings/section-nav'
import { SettingsSearchResults } from '@/components/settings/SettingsSearch'
import { CliSection } from '@/components/settings/CliSection'
import { GeneralSection } from '@/components/settings/GeneralSection'
import { DefaultAgentSection } from '@/components/settings/DefaultAgentSection'
import { AssistSection } from '@/components/settings/AssistSection'
import { AgentSubNav, SettingsMainNav } from '@/components/settings/SettingsNav'
import { cliPage, sectionsFor, type Section } from '@/components/settings/settings-sections'
import {
  generalChecks,
  toGeneralDraft,
  type GeneralChecks,
  type GeneralDraft,
} from '@/components/settings/general-draft'
import { buildSettings, toSettingsForm, type SettingsForm } from '@/components/settings/settings-value'
import { useCliDrafts, type CliDrafts } from '@/components/settings/use-cli-drafts'
import { useSettingsSearch } from '@/components/settings/use-settings-search'
import {
  UpdateSection,
  DataSection,
  UsageSection,
  LocalImageSection,
  PluginsSection,
  PluginParamsSection,
  RemoteSection,
  SpeechSection,
  ReadAloudSection,
  ExperienceSection,
  ChatMemorySection,
  NotifyChannelsSection,
  HooksSection,
  IntegrationsSection,
  DeploySection,
  MarkdownSection,
  ComponentsSection,
  McpSection,
} from '@/components/settings/lazy-sections'

/** 改 SettingsForm 里的一块：各分区只拿到自己那一块的 setter */
type SetPart = <K extends keyof SettingsForm>(k: K) => (v: SetStateAction<SettingsForm[K]>) => void

/**
 * 各分区共用的东西，显式传给 SettingsContent：草稿都在设置页上（切页不丢、一起自动保存），
 * 每个分区只取自己那一块来读写。
 */
interface SectionCtx {
  form: SettingsForm
  setPart: SetPart
  general: GeneralDraft
  checks: GeneralChecks
  patchGeneral: (p: Partial<GeneralDraft>) => void
  saveNow: (patch: Partial<Settings>) => Promise<void>
  cli: CliDrafts
  catalog: ReturnType<typeof useModelCatalog>
  demo: boolean
  onSection: (s: string) => void
}

function SettingsBody({
  initial,
  section,
  onSection,
}: {
  initial: Settings
  section: string
  onSection: (s: string) => void
}) {
  const { settings: liveSettings, setSettings, clis, refreshClis } = useData()
  const [general, setGeneral] = useState(() => toGeneralDraft(initial))
  const patchGeneral = (p: Partial<GeneralDraft>) => setGeneral((g) => ({ ...g, ...p }))
  const [form, setForm] = useState(() => toSettingsForm(initial))
  const setPart: SetPart = (k) => (v) =>
    setForm((f) => ({
      ...f,
      [k]: typeof v === 'function' ? (v as (prev: SettingsForm[typeof k]) => unknown)(f[k]) : v,
    }))
  const demo = !!import.meta.env.VITE_DEMO
  const cli = useCliDrafts({ initial, clis, refreshClis, setSettings, apis: form.apis })
  // 在线演示没有服务端，外网访问和网络代理的开关不显示
  const pluginPages = pp.usePluginParamPages()
  const mcpPages = useMcpPages()
  const SECTIONS = sectionsFor(cli.ordered, pluginPages, mcpPages).filter(
    (s) => !(demo && (s.id === 'remote' || s.id === 'network')),
  )
  const catalogInfo = useModelCatalog()

  const checks = generalChecks(general)
  const value = buildSettings({ initial, live: liveSettings, general, checks, form, cli })
  const save = useAutosave(
    value,
    async (v) => {
      setSettings(await api.saveSettings(v))
      // 不强制重新检测：每次自动保存都把 CLI 跑一遍会让保存变得很慢
      await refreshClis(false)
      // 登录方式、选的 API 或它的模型变了：这个 CLI 的模型下拉要重新读（账号和 API 各列各的）
      cli.reloadChangedModels(v)
    },
    // 超时填错时这一项沿用原值，其他设置照常保存
    true,
  )
  const saveNow = async (patch: Partial<Settings>) => {
    setSettings(await api.saveSettings({ ...value, ...patch }))
  }

  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const inCli = cliPage(cur)
  const inPlugin = pp.pluginParamsPage(cur.id)
  // 「部署」那份和这一版不同时，左栏的「Agent」和二级列表的「部署」都亮点（侧栏「设置」读同一份派生值）
  const deployDot = deployedUpdateHint(useSkillUpdates())
  const search = useSettingsSearch({ sections: SECTIONS, defCli: cli.defCli, onSection })
  const { searching, hits } = search
  const ctx: SectionCtx = {
    form,
    setPart,
    general,
    checks,
    patchGeneral,
    saveNow,
    cli,
    catalog: catalogInfo,
    demo,
    onSection,
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <SettingsMainNav
        sections={SECTIONS}
        cur={cur}
        inCli={inCli}
        inPlugin={inPlugin}
        search={search}
        pluginPages={pluginPages}
        deployDot={deployDot}
        onSection={onSection}
      />

      {inCli && !searching && (
        <AgentSubNav sections={SECTIONS} cur={cur} cli={cli} deployDot={deployDot} onSection={onSection} />
      )}

      {inPlugin && !searching && <pp.PluginParamsNav pages={pluginPages} current={cur.id} onSection={onSection} />}

      {mcpPage(cur.id) && !searching && <McpNav current={cur.id} onSection={onSection} />}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-4 md:px-9 md:pt-6">
          <h2 className="min-w-0 flex-1 truncate font-serif text-title font-semibold tracking-tight">
            {searching ? t('搜索设置') : cur.label}
            {searching && hits.length > 0 && (
              <span className="ml-2.5 font-sans text-body font-normal tracking-normal text-subtle">
                {t('{n} 项', { n: hits.length })}
              </span>
            )}
          </h2>
          <SaveIndicator {...save} invalid={checks.timeout.ok ? undefined : t('超时时间需要是 0 到 1440 的整数')} />
          <DialogCloseButton label={t('关闭设置')} />
        </header>
        {/* 这一节有多个小节时，标题下面多一条页内导航（见 section-nav.tsx） */}
        {!searching && <SectionToc />}
        {/* 改这里的 pb-12 / px-5 / md:px-9 时要同步 DeploySection 吸底操作栏的偏移，不然栏下面会漏出列表 */}
        <div
          ref={setSectionScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-12 [scrollbar-gutter:stable] md:px-9"
        >
          {searching && (
            <SettingsSearchResults
              groups={search.hitGroups}
              terms={search.terms}
              query={search.query}
              active={search.hit}
              onActive={search.setHit}
              onPick={search.pick}
            />
          )}
          {/* 搜索时各页照常挂着、只是藏起来：切回来时没保存的输入、读好的数据都还在 */}
          <div hidden={searching}>
            <SettingsContent cur={cur} inPlugin={inPlugin} ctx={ctx} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 按当前页挂对应的分区。每个分区只拿自己那一块设置和对应的 setter。
 * 「cur.id === 'xxx' && …」的写法别改：设置搜索的索引按它判断每一行属于哪一页（scripts/lib/settings-index.mjs）。
 */
function SettingsContent({ cur, inPlugin, ctx }: { cur: Section; inPlugin: boolean; ctx: SectionCtx }) {
  const { form, setPart, cli, demo, onSection } = ctx
  const { appearance, imageGen } = form
  return (
    <Suspense fallback={null}>
      {cur.id === 'styles' && <StylesSettings />}
      {cur.id === 'fonts' && <FontSection value={appearance} onChange={setPart('appearance')} />}
      {cur.id === 'markdown' && <MarkdownSection value={appearance} onChange={setPart('appearance')} />}
      {cur.id === 'components' && <ComponentsSection value={appearance} onChange={setPart('appearance')} />}
      {cur.id === 'shortcuts' && <ShortcutsSection value={form.elementPicker} onChange={setPart('elementPicker')} />}
      {cur.id === 'remote' && <RemoteSection value={form.remoteAccess} onChange={setPart('remoteAccess')} />}
      {cur.id === 'notify-channels' && (
        <NotifyChannelsSection value={form.notifyChannels} onChange={setPart('notifyChannels')} />
      )}
      {cur.id === 'network' && (
        <NetworkSection
          enabled={form.networkProxyEnabled}
          proxy={form.proxy}
          onChange={({ enabled, proxy: url }) => {
            setPart('networkProxyEnabled')(enabled)
            setPart('proxy')(url)
          }}
        />
      )}
      {cur.id === 'apis' && <ApiSection apis={form.apis} onChange={setPart('apis')} />}
      {cur.id === 'speech' && <SpeechSection value={form.speech} onChange={setPart('speech')} />}
      {cur.id === 'read-aloud' && <ReadAloudSection value={form.readAloud} onChange={setPart('readAloud')} />}
      {cur.id === 'integrations' && <IntegrationsSection />}
      {cur.id === 'hooks' && <HooksSection />}
      {cur.id === 'chat-memory' && <ChatMemorySection />}
      {cur.id === 'general' && (
        <GeneralSection
          value={ctx.general}
          checks={ctx.checks}
          onChange={ctx.patchGeneral}
          elementPicker={form.elementPicker}
          demo={demo}
          onSection={onSection}
          saveNow={ctx.saveNow}
        />
      )}

      {cur.id === 'models' && (
        <DefaultAgentSection
          cli={cli}
          apis={form.apis}
          modelCatalog={form.modelCatalog}
          onModelCatalog={setPart('modelCatalog')}
          catalog={ctx.catalog}
          imageGen={imageGen}
          onImageGen={setPart('imageGen')}
          designRestore={form.designRestore}
          onDesignRestore={setPart('designRestore')}
          demo={demo}
          onSection={onSection}
        />
      )}

      {cur.cli && (
        <CliSection
          key={cur.cli.id}
          def={cur.cli}
          draft={cli.drafts[cur.cli.id]}
          status={cli.statusOf(cur.cli.id)}
          isDefault={cli.defCli === cur.cli.id}
          onChange={(d) => cli.setDrafts((ds) => ({ ...ds, [cur.cli!.id]: d }))}
          onDetect={cli.detect}
          detecting={cli.detecting}
          apis={form.apis}
          onGoApis={() => onSection('apis')}
          onAddApi={(a) => setPart('apis')((l) => [...l, a])}
        />
      )}

      {cur.id === 'local-image' && (
        <LocalImageSection value={imageGen.local} onChange={(local) => setPart('imageGen')({ ...imageGen, local })} />
      )}
      {cur.id === 'plugins' && <PluginsSection />}
      {inPlugin && <PluginParamsSection section={cur.id} />}
      {mcpPage(cur.id) && <McpSection section={cur.id} onSection={onSection} />}
      {cur.id === 'data' && <DataSection />}
      {cur.id === 'usage' && (
        <UsageSection pricingModel={form.usagePricingModel} onPricingModel={setPart('usagePricingModel')} />
      )}
      {cur.id === 'deploy' && <DeploySection />}
      {cur.id === 'tags' && <TagsSection />}
      {cur.id === 'global-lessons' && <GlobalLessonsSection />}
      {cur.id === 'experience' && <ExperienceSection clis={cli.ordered} drafts={cli.drafts} isReady={cli.isReady} />}
      {cur.id === 'update' && (
        <UpdateSection autoCheck={form.autoCheckUpdates} onAutoCheckChange={setPart('autoCheckUpdates')} />
      )}

      {cur.id === 'categories' && <ProjectCategoryList />}

      {cur.id === 'assist' && <AssistSection cli={cli} assist={form.assist} onAssist={setPart('assist')} />}
    </Suspense>
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
      className="h-[min(840px,calc(100dvh-3.75rem))] max-w-[1200px]"
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
