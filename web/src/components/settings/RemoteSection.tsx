import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import type { RemoteAccess } from '@shared/schema'
import type { RemoteAccessStatus } from '@shared/remote'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Advanced, CopyText, Group, Row } from './parts'
import { FrpCloudGroup } from './FrpCloudGroup'
import { FrpMappingsGroup } from './FrpMappingsGroup'
import { FrpTest } from './FrpTest'
import { GuardGroup } from './GuardGroup'
import { ProxyGuide } from './ProxyGuide'
import { TailscaleGroup } from './TailscaleGroup'
import { LinkedText, TailscaleEnableNotice } from './RemoteNotice'

const STATE_TEXT: Record<RemoteAccessStatus['state'], string> = {
  off: t('未启用'),
  starting: t('正在连接'),
  running: t('已连接'),
  error: t('出错'),
}

const MODE_DESC: Record<RemoteAccess['mode'], string> = {
  frp: t('一键配置云服务器，本机没有公网 IP 也能用'),
  tailscale: t('用 Tailscale 组网，不要公网 IP 也不要服务器'),
  custom: t('Caddy、NPM、nginx，或直接监听局域网 / 公网'),
}

const port = (v: string, fallback: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

/**
 * 设置里的「外部访问」：开关、访问方式（frp / Tailscale / 自建反代）、访问密码与登录的设备、连接状态。
 * 外网一律要密码登录（服务端的登录门在 server/guard/），和本机访问分开
 */
export function RemoteSection({ value, onChange }: { value: RemoteAccess; onChange: (v: RemoteAccess) => void }) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .remoteStatus()
        .then((s) => {
          if (alive) setStatus(s)
        })
        .catch(() => {})
    void load()
    // frpc 连接、下载进度都在服务端，打开这一页时定时刷新
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 「重新连接」：立刻重启外网端口和 frpc / tailscale，不用把外部访问关掉再打开
  const [restarting, setRestarting] = useState(false)
  const restart = async () => {
    setRestarting(true)
    try {
      setStatus(await api.remoteRestart())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRestarting(false)
    }
  }

  // Tailscale 在等你去后台开启 Serve / Funnel：不是出错，也不是还在连，单独说清楚
  const waitingEnable = value.mode === 'tailscale' && !!status?.enableUrl
  const tone =
    status?.state === 'running'
      ? 'bg-success'
      : status?.state === 'error'
        ? 'bg-danger'
        : waitingEnable
          ? 'bg-warning'
          : 'bg-line-strong'
  const custom = value.mode === 'custom'
  const lan = status?.lanIps[0] ?? ''
  // 自建反代转发的目标：反代在本机就是 127.0.0.1；监听所有网卡时多半是 Docker 里的 NPM / Caddy，给局域网 IP
  const upstream = `${value.listenHost === '0.0.0.0' && lan ? lan : '127.0.0.1'}:${value.localPort}`

  return (
    <>
      <Group>
        <Row
          title={t('允许外部访问')}
          desc={t('让其他电脑和手机也能打开这个面板')}
          hint={t(
            '默认关闭。打开后另起一个外网专用端口，经 frp、Tailscale 或反向代理连进来；本机和其他设备打开的是同一个面板，数据、任务进度和对话实时同步。外网打开时一律要输访问密码。',
          )}
        >
          <Switch
            aria-label={t('允许外部访问')}
            checked={value.enabled}
            onCheckedChange={(on) => onChange({ ...value, enabled: on })}
          />
        </Row>
      </Group>

      {value.enabled && (
        <>
          <Group title={t('访问方式')}>
            <Row title={t('方式')} desc={MODE_DESC[value.mode]}>
              <Select
                aria-label={t('访问方式')}
                value={value.mode}
                onChange={(e) => onChange({ ...value, mode: e.target.value as RemoteAccess['mode'] })}
                className="w-[200px]"
                options={[
                  { value: 'frp', label: t('云服务器（frp）') },
                  { value: 'tailscale', label: 'Tailscale' },
                  { value: 'custom', label: t('自建反向代理') },
                ]}
              />
            </Row>
            {custom && (
              <>
                <Row
                  title={t('监听地址')}
                  desc={
                    value.listenHost === '0.0.0.0'
                      ? t('局域网和公网能直接连，反向代理在 Docker 里时也选这个')
                      : t('只给本机的反向代理转发')
                  }
                >
                  <Select
                    aria-label={t('监听地址')}
                    value={value.listenHost}
                    onChange={(e) => onChange({ ...value, listenHost: e.target.value as RemoteAccess['listenHost'] })}
                    className="w-[200px]"
                    options={[
                      { value: '127.0.0.1', label: t('仅本机（127.0.0.1）') },
                      { value: '0.0.0.0', label: t('所有网卡（0.0.0.0）') },
                    ]}
                  />
                </Row>
                <Row
                  title={t('外网专用端口')}
                  desc={t('反向代理转到这个端口；从这里进来的请求都要密码登录')}
                  hint={t('主端口仍然只给本机用。反向代理改写了 Host 也不会被当成本机请求。')}
                >
                  <Input
                    value={String(value.localPort)}
                    onChange={(e) => onChange({ ...value, localPort: port(e.target.value, value.localPort) })}
                    inputMode="numeric"
                    className="w-[96px] font-mono text-body"
                    aria-label={t('外网专用端口')}
                  />
                </Row>
              </>
            )}
            {value.mode !== 'tailscale' && (
              <Row
                title={t('访问地址')}
                desc={custom ? t('反向代理的域名，或直连时的 IP:端口') : t('在云服务器上配了域名时填，没有就留空')}
                hint={t('登录时用它核对请求来源，也用来生成下面的反向代理配置。')}
              >
                <Input
                  value={value.publicUrl}
                  onChange={(e) => onChange({ ...value, publicUrl: e.target.value })}
                  placeholder="https://panel.example.com"
                  spellCheck={false}
                  className="font-mono text-body"
                  aria-label={t('外部访问地址')}
                />
              </Row>
            )}
            {custom && value.listenHost === '0.0.0.0' && (
              <Advanced label="HTTPS">
                <Row
                  title={t('HTTPS 证书')}
                  desc={
                    value.tlsCert && value.tlsKey
                      ? t('已启用 HTTPS')
                      : t('直接对外时建议配上：明文 HTTP 下密码和登录状态可能被同一网络里的人截获')
                  }
                  stack
                >
                  <div className="flex flex-col gap-2">
                    <Input
                      value={value.tlsCert}
                      onChange={(e) => onChange({ ...value, tlsCert: e.target.value })}
                      placeholder={t('证书文件路径（fullchain.pem）')}
                      spellCheck={false}
                      className="font-mono text-body"
                      aria-label={t('证书文件路径（fullchain.pem）')}
                    />
                    <Input
                      value={value.tlsKey}
                      onChange={(e) => onChange({ ...value, tlsKey: e.target.value })}
                      placeholder={t('私钥文件路径（privkey.pem）')}
                      spellCheck={false}
                      className="font-mono text-body"
                      aria-label={t('私钥文件路径（privkey.pem）')}
                    />
                  </div>
                </Row>
              </Advanced>
            )}
          </Group>

          {value.mode === 'frp' && (
            <FrpCloudGroup value={value} onChange={onChange} status={status} onStatus={setStatus} />
          )}
          {value.mode === 'frp' && value.frp.token && (
            <FrpMappingsGroup value={value} onChange={onChange} status={status} />
          )}
          {value.mode === 'tailscale' && (
            <TailscaleGroup value={value} onChange={onChange} status={status} onStatus={setStatus} />
          )}

          <Group title={t('连接状态')}>
            <Row title={t('状态')} stack>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-body">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
                  <span>
                    {!status ? t('检测中…') : waitingEnable ? t('等你在 Tailscale 开启') : STATE_TEXT[status.state]}
                  </span>
                  <Button size="sm" variant="ghost" onClick={restart} disabled={restarting} className="ml-auto">
                    <RefreshCw className={`h-3.5 w-3.5 ${restarting ? 'animate-spin' : ''}`} />
                    {restarting ? t('正在重新连接…') : t('重新连接')}
                  </Button>
                  {value.mode === 'frp' && status?.download?.running && (
                    <span className="text-muted">
                      {status.download.percent >= 0
                        ? t('正在下载 frpc {n}%', { n: String(status.download.percent) })
                        : t('正在下载 frpc…')}
                    </span>
                  )}
                </div>
                {waitingEnable && status && (
                  <TailscaleEnableNotice url={status.enableUrl} funnel={value.tailscale.funnel} />
                )}
                {status?.error && (
                  <p className="text-footnote leading-relaxed whitespace-pre-wrap text-danger">
                    <LinkedText text={status.error} />
                  </p>
                )}
              </div>
            </Row>
            {status?.url && (
              <Row title={t('外网地址')} desc={t('在其他设备上打开，输入访问密码登录')} stack>
                <div className="flex min-w-0 items-center gap-3">
                  <CopyText text={status.url} title={t('复制地址')} />
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-body text-accent-text hover:underline"
                  >
                    {t('打开')}
                  </a>
                </div>
              </Row>
            )}
            {value.mode === 'frp' && <FrpTest />}
          </Group>

          <GuardGroup value={value} onChange={onChange} />

          {custom && <ProxyGuide publicUrl={value.publicUrl} upstream={upstream} />}
          {value.mode === 'frp' && value.frp.token && (
            <ProxyGuide publicUrl={value.publicUrl} upstream={`127.0.0.1:${value.frp.remotePort}`} cloud />
          )}
        </>
      )}
    </>
  )
}
