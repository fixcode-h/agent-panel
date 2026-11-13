import { useEffect, useState } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Modal } from '@/components/ui/modal'
import { ScanFindings } from '@/components/ui/scan-findings'
import { configScanApi } from '@/lib/api-config-scan'
import { pluginApi, type InstallPreview } from './api'
import { pluginIcon } from './icon'
import { loadPlugins } from './registry'

/**
 * 安装确认：来源、版本、会不会在本机运行代码、会不会覆盖已装的版本，以及配置安全扫描的发现；
 * 有高级发现时要勾选「我看过了，仍然安装」才能点安装（不直接禁止：自己的插件也可能有合理的命中）
 */
export function InstallConfirm({ preview, onClose }: { preview?: InstallPreview; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState(false)
  // 点过「这条没问题」的从列表里拿掉（服务端也记下了，下次预览不再出现）
  const [gone, setGone] = useState<Set<string>>(new Set())
  useEffect(() => {
    setAck(false)
    setGone(new Set())
  }, [preview?.token])
  const m = preview?.manifest
  const scan = (preview?.scan ?? []).filter((f) => !gone.has(`${f.rule}|${f.file}|${f.line}|${f.snippet}`))
  const needAck = scan.some((f) => f.level === 'high')
  const confirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await pluginApi.confirm(preview.token)
      await loadPlugins()
      toast.success(
        preview.installed
          ? t('已更新插件 {name}', { name: m!.name })
          : t('已安装插件 {name}，打开开关后生效', { name: m!.name }),
      )
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const Icon = pluginIcon(m?.icon ?? '')
  return (
    <Modal
      open={!!preview}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={preview?.installed ? t('更新插件') : t('安装插件')}
      footer={
        <>
          {needAck && <Checkbox checked={ack} onChange={setAck} label={t('我看过了，仍然安装')} disabled={busy} />}
          <Button variant="secondary" className="ml-auto" onClick={onClose} disabled={busy}>
            {t('取消')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || (needAck && !ack)}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {preview?.installed ? t('更新') : t('安装')}
          </Button>
        </>
      }
    >
      {m && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-prose font-semibold">
                {m.name} <span className="text-body font-normal text-subtle">v{m.version}</span>
              </p>
              {m.description && <p className="text-body leading-relaxed text-muted">{t(m.description)}</p>}
              {m.author && <p className="text-xs text-subtle">{t('作者：{name}', { name: m.author })}</p>}
            </div>
          </div>
          {preview.installed && (
            <p className="text-body text-muted">
              {t('已经装着 v{v}：会换成这个版本，参数保留。', { v: preview.installed.version })}
            </p>
          )}
          {preview.hasCode && (
            <div className="flex gap-2 rounded-lg bg-warning/10 p-3 text-body text-warning">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t('这个插件带代码，打开后会在本机以面板的权限运行（读写文件、启动程序、联网）。只安装你信任的来源。')}
              </span>
            </div>
          )}
          <ScanFindings
            findings={scan}
            onIgnore={async (f) => {
              await configScanApi.ignore(f, preview.scanScope ?? '')
              setGone((g) => new Set(g).add(`${f.rule}|${f.file}|${f.line}|${f.snippet}`))
            }}
          />
          <ul className="flex flex-col gap-0.5 text-xs text-subtle">
            {!!m.agents.length && (
              <li>{t('角色：{list}', { list: m.agents.map((a) => a.agent.name).join(t('、')) })}</li>
            )}
            {!!m.workflows.length && (
              <li>{t('工作流：{list}', { list: m.workflows.map((w) => w.name).join(t('、')) })}</li>
            )}
            {!!Object.keys(m.skillGuide).length && (
              <li>{t('技能：{list}', { list: Object.keys(m.skillGuide).join(t('、')) })}</li>
            )}
            {!!m.mcpServers.length && <li>{t('给 Agent 的工具服务：{list}', { list: m.mcpServers.join(t('、')) })}</li>}
            {!!m.hooks?.length && <li>{t('钩子：{list}', { list: m.hooks.map((h) => t(h.name)).join(t('、')) })}</li>}
            {!!m.testSteps?.length && (
              <li>{t('测试步骤：{list}', { list: m.testSteps.map((s) => t(s.name)).join(t('、')) })}</li>
            )}
            {!!m.commands?.length && (
              <li>{t('「/」命令：{list}', { list: m.commands.map((c) => `/${c.name}`).join(t('、')) })}</li>
            )}
          </ul>
        </div>
      )}
    </Modal>
  )
}
