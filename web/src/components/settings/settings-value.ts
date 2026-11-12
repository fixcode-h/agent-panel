import type { CliSettings, Settings } from '@shared/schema'
import { mergeCliEnv } from '@shared/settings'
import { splitArgs } from '@/lib/utils'
import { textToEnv, type toDraft } from '@/components/settings/CliSection'
import type { GeneralChecks, GeneralDraft } from '@/components/settings/general-draft'

/** 设置页上由各分区编辑、一起自动保存的几块（「常规」和 CLI 草稿另算，见 GeneralDraft、useCliDrafts） */
export type SettingsForm = Pick<
  Settings,
  | 'remoteAccess'
  | 'notifyChannels'
  | 'elementPicker'
  | 'proxy'
  | 'networkProxyEnabled'
  | 'autoCheckUpdates'
  | 'speech'
  | 'readAloud'
  | 'appearance'
  | 'apis'
  | 'assist'
  | 'imageGen'
  | 'designRestore'
  | 'modelCatalog'
  | 'usagePricingModel'
>

export const toSettingsForm = (initial: Settings): SettingsForm => ({
  remoteAccess: initial.remoteAccess,
  notifyChannels: initial.notifyChannels,
  elementPicker: initial.elementPicker,
  proxy: initial.proxy,
  networkProxyEnabled: initial.networkProxyEnabled,
  autoCheckUpdates: initial.autoCheckUpdates,
  speech: initial.speech,
  readAloud: initial.readAloud,
  appearance: initial.appearance,
  apis: initial.apis,
  assist: initial.assist,
  imageGen: initial.imageGen,
  designRestore: initial.designRestore,
  modelCatalog: initial.modelCatalog,
  // 用量统计的计价模型（存在设置里，跟着自动保存）
  usagePricingModel: initial.usagePricingModel,
})

const tier = (x: CliSettings['tiers']['high']) => ({ ...x, model: x.model.trim() })

/**
 * 把各分区的草稿拼回一整份设置，交给自动保存（从 pages/SettingsPage.tsx 挪出）。
 * 别的地方自己保存的字段（额度恢复、经验、保活……）沿用打开时或最新的值，不在这里改。
 */
export function buildSettings({
  initial,
  live,
  general: g,
  checks: c,
  form,
  cli,
}: {
  initial: Settings
  /** 页面上最新的设置（自己保存的分区写进去的） */
  live: Settings | null | undefined
  general: GeneralDraft
  checks: GeneralChecks
  form: SettingsForm
  cli: { cliOrder: string[]; defCli: string; drafts: ReturnType<typeof toDraft> }
}): Settings {
  return {
    defaultsVersion: initial.defaultsVersion,
    plugins: initial.plugins,
    openBrowser: g.openBrowser,
    requireToken: g.requireToken,
    remoteAccess: form.remoteAccess,
    notifyChannels: form.notifyChannels,
    askUserDefault: g.askUserDefault,
    bugAuthor: g.bugAuthor,
    userName: g.userName.trim(),
    developerMode: g.developerMode,
    elementPicker: form.elementPicker,
    shell: g.shell,
    proxy: form.proxy.trim(),
    networkProxyEnabled: form.networkProxyEnabled,
    autoCheckUpdates: form.autoCheckUpdates,
    contentWidth: g.contentWidth,
    appearance: form.appearance,
    fileFormat: g.fileFormat,
    language: g.language,
    cliOrder: cli.cliOrder,
    stepTimeoutMinutes: c.timeout.ok ? c.timeout.n : initial.stepTimeoutMinutes,
    idleTimeoutMinutes: c.idle.ok ? c.idle.n : initial.idleTimeoutMinutes,
    childIdleAskMinutes: c.childAsk.ok ? c.childAsk.n : initial.childIdleAskMinutes,
    // 「面板提醒次数」去掉了（2026-11-05：提醒不限次数，靠 end_turn 和空转保护收住）：旧值原样留着，不再用
    nudgeMax: initial.nudgeMax,
    // 计划 Webhook 已并入「钩子」（schedule.finished 上的 HTTP 钩子，ADR 0049 第三期）：旧字段原样留着，只用来迁移
    webhook: initial.webhook,
    speech: form.speech,
    readAloud: form.readAloud,
    presenceGraceMinutes: c.presence.ok ? c.presence.n : initial.presenceGraceMinutes,
    childDoneKeepMinutes: c.childKeep.ok ? c.childKeep.n : initial.childDoneKeepMinutes,
    autoArchiveDays: c.archive.ok ? c.archive.n : initial.autoArchiveDays,
    reclaimIdleCli: g.reclaim,
    // 在设置 →「数据」的保活列表里改，这里沿用原来的值
    lowMemoryReleasePercent: initial.lowMemoryReleasePercent,
    resumeAfterRestart: g.resumeRestart,
    quotaResume: live?.quotaResume ?? initial.quotaResume, // QuotaResumeGroup 自己保存：带上最新的，别把旧值写回去
    backgroundLimit: c.bg.ok ? c.bg.n : initial.backgroundLimit,
    largeFileMB: c.large.ok ? c.large.n : initial.largeFileMB,
    // 内存采样间隔在设置 →「数据」里改，这里沿用原来的值
    memorySampleSeconds: initial.memorySampleSeconds,
    experience: initial.experience, // 在设置 →「经验」里改（ExperienceSection 自己保存）
    longPasteChars: c.paste.ok ? c.paste.n : initial.longPasteChars,
    defaultCli: cli.defCli,
    clis: Object.fromEntries(
      Object.entries(cli.drafts).map(([id, d]) => [
        id,
        {
          enabled: d.enabled,
          command: d.command.trim(),
          defaultModel: d.defaultModel.trim(),
          defaultEffort: d.defaultEffort,
          tiers: { high: tier(d.tiers.high), medium: tier(d.tiers.medium), low: tier(d.tiers.low) },
          permission: d.permission,
          extraArgs: splitArgs(d.args),
          // 定义自带的环境变量改过的值存成同名覆盖，和自由添加的合成一份（同名以覆盖为准）
          env: mergeCliEnv(textToEnv(d.envText), d.envOverrides),
          showLimits: d.showLimits,
          autoCompact: d.autoCompact,
          maxTurns: d.maxTurns,
          options: d.options,
          authMode: d.authMode,
          apiId: d.apiId,
          apiProtocol: d.apiProtocol,
        },
      ]),
    ),
    apis: form.apis,
    assist: { ...form.assist, model: form.assist.model.trim() },
    imageGen: { ...form.imageGen, model: form.imageGen.model.trim() },
    designRestore: form.designRestore,
    modelCatalog: form.modelCatalog,
    usagePricingModel: form.usagePricingModel,
  }
}
