import { useState } from 'react'
import { t } from '@shared/i18n'
import type { RemoteAccess } from '@shared/schema'
import type { RemoteAccessStatus } from '@shared/remote'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Advanced, Group, Row } from './parts'

/**
 * 「Tailscale」：用户自己装好并登录 Tailscale，面板用 tailscale serve（只有自己的设备）或 funnel（公网）
 * 把 https://<机器名>.ts.net 转到外网专用端口。不要公网 IP、不要服务器，证书由 Tailscale 发
 */
export function TailscaleGroup({
  value,
  onChange,
  status,
  onStatus,
}: {
  value: RemoteAccess
  onChange: (v: RemoteAccess) => void
  status: RemoteAccessStatus | null
  onStatus: (s: RemoteAccessStatus) => void
}) {
  const ts = value.tailscale
  const info = status?.tailscale
  const [checking, setChecking] = useState(false)
  const set = (patch: Partial<RemoteAccess['tailscale']>) => onChange({ ...value, tailscale: { ...ts, ...patch } })

  const check = async () => {
    setChecking(true)
    try {
      onStatus(await api.remoteTailscaleCheck())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Group title="Tailscale">
      <Row
        title="Tailscale"
        desc={t('先在这台电脑和要访问的设备上装好 Tailscale，登录同一个账号')}
        hint={t('Linux 上 tailscale serve 要有权限：执行一次 sudo tailscale set --operator=$USER。')}
      >
        <div className="flex flex-col items-end gap-1.5 text-body">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={check} disabled={checking}>
              {checking ? t('检测中…') : t('重新检测')}
            </Button>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${info?.running ? 'bg-success' : 'bg-line-strong'}`} />
            <span className={info?.running ? 'text-fg' : 'text-muted'}>
              {!info
                ? t('检测中…')
                : info.running
                  ? info.dnsName || t('已连接')
                  : info.installed
                    ? t('未登录')
                    : t('未安装')}
            </span>
          </div>
          {info && !info.running && <span className="text-footnote leading-relaxed text-subtle">{info.error}</span>}
          {info && !info.installed && (
            <a
              href="https://tailscale.com/download"
              target="_blank"
              rel="noreferrer"
              className="text-footnote text-accent-text hover:underline"
            >
              {t('下载 Tailscale')}
            </a>
          )}
        </div>
      </Row>
      <Row
        title={t('开放到公网（Funnel）')}
        desc={
          ts.funnel
            ? t('任何人拿到地址都能打开登录页，靠访问密码挡住')
            : t('关着时只有登录了你的 Tailscale 的设备能打开')
        }
        hint={t(
          'Funnel 要先在 Tailscale 后台的 Access controls 里允许这台机器使用；没开时这里会报出 tailscale 给的提示。',
        )}
      >
        <Switch
          aria-label={t('开放到公网（Funnel）')}
          checked={ts.funnel}
          onCheckedChange={(on) => set({ funnel: on })}
        />
      </Row>
      <Advanced label="Tailscale">
        <Row title={t('HTTPS 端口')} desc={t('Funnel 只允许 443、8443、10000')}>
          <Select
            aria-label={t('HTTPS 端口')}
            value={String(ts.httpsPort)}
            onChange={(e) => set({ httpsPort: Number(e.target.value) as RemoteAccess['tailscale']['httpsPort'] })}
            className="w-[120px]"
            options={[
              { value: '443', label: '443' },
              { value: '8443', label: '8443' },
              { value: '10000', label: '10000' },
            ]}
          />
        </Row>
        <Row title={t('tailscale 路径')} desc={t('自动找到的不用填')}>
          <Input
            value={ts.command}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="tailscale"
            spellCheck={false}
            className="font-mono text-body"
            aria-label={t('tailscale 路径')}
          />
        </Row>
      </Advanced>
    </Group>
  )
}
