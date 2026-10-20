import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { t } from '@shared/i18n'
import type { RemoteAccess } from '@shared/schema'
import type { RemoteAccessStatus } from '@shared/remote'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CopyText, Group, Row } from './parts'

const STATE_TEXT: Record<RemoteAccessStatus['state'], string> = {
  off: t('未启用'),
  starting: t('正在连接'),
  running: t('已连接'),
  error: t('出错'),
}

/** 设置里的「外部访问」：开关、访问方式、cloudflared 环境检测与连接状态 */
export function RemoteSection({ value, onChange }: { value: RemoteAccess; onChange: (v: RemoteAccess) => void }) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [checking, setChecking] = useState(false)

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
    // 隧道启动、下载进度都在服务端，打开这一页时定时刷新
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const install = async () => {
    try {
      setStatus(await api.remoteInstall())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const check = async () => {
    setChecking(true)
    try {
      setStatus(await api.remoteCheck())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const cf = status?.cloudflared
  const tone = status?.state === 'running' ? 'bg-success' : status?.state === 'error' ? 'bg-danger' : 'bg-line-strong'

  return (
    <>
      <Group>
        <Row
          title={t('允许外部访问')}
          desc={t(
            '默认关闭。打开后，服务仍然只监听 127.0.0.1，由隧道或反向代理把外网的请求转进来；本机和其他电脑打开的是同一个面板，数据、任务进度和对话实时同步。外网访问一律要求访问令牌。',
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
            <Row
              title={t('方式')}
              desc={
                value.mode === 'quick'
                  ? t('用 cloudflared 生成一个临时地址，不用账号，重启后地址会变。适合临时给别的电脑看。')
                  : value.mode === 'token'
                    ? t('在 Cloudflare 后台建好 Tunnel，把 token 和域名填进来，地址固定不变。')
                    : t('已经用 frp、nginx 等把 127.0.0.1:8787 转到了外网时选这个，面板只负责校验地址。')
              }
            >
              <Select
                aria-label={t('访问方式')}
                value={value.mode}
                onChange={(e) => onChange({ ...value, mode: e.target.value as RemoteAccess['mode'] })}
                className="w-[240px]"
                options={[
                  { value: 'quick', label: t('临时地址') },
                  { value: 'token', label: t('固定域名') },
                  { value: 'custom', label: t('自建反向代理') },
                ]}
              />
            </Row>
            {value.mode === 'token' && (
              <Row
                title={t('Tunnel Token')}
                desc={t('Cloudflare 后台创建 Tunnel 时给出的 token，只保存在本机数据目录里。')}
              >
                <Input
                  type="password"
                  value={value.tunnelToken}
                  onChange={(e) => onChange({ ...value, tunnelToken: e.target.value })}
                  placeholder="eyJhIjoi..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-[280px] font-mono text-[0.8125rem]"
                  aria-label={t('Tunnel Token')}
                />
              </Row>
            )}
            {value.mode !== 'quick' && (
              <Row
                title={t('外部访问地址')}
                desc={
                  value.mode === 'token'
                    ? t('这个 Tunnel 对外提供服务的域名，例如 https://panel.example.com。')
                    : t('反向代理后的完整地址，例如 https://panel.example.com。')
                }
              >
                <Input
                  value={value.publicUrl}
                  onChange={(e) => onChange({ ...value, publicUrl: e.target.value })}
                  placeholder="https://panel.example.com"
                  spellCheck={false}
                  className="w-[280px] font-mono text-[0.8125rem]"
                  aria-label={t('外部访问地址')}
                />
              </Row>
            )}
          </Group>

          {value.mode !== 'custom' && (
            <Group title={t('环境检测')}>
              <Row
                title="cloudflared"
                desc={t(
                  '外网访问靠 cloudflared 建立隧道，不需要在路由器上开放端口。没有安装时可以直接下载到面板的数据目录。',
                )}
              >
                <div className="flex flex-col items-start gap-2">
                  <div className="flex items-center gap-2 text-[0.8125rem]">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${cf?.installed ? 'bg-success' : 'bg-line-strong'}`}
                    />
                    <span className={cf?.installed ? 'text-fg' : 'text-muted'}>
                      {!status
                        ? t('检测中…')
                        : cf?.installed
                          ? t('已安装 {version}', { version: cf.version })
                          : t('未安装')}
                    </span>
                  </div>
                  {!cf?.installed && status && (
                    <Button size="sm" variant="secondary" onClick={install} disabled={status.download?.running}>
                      {status.download?.running
                        ? status.download.percent >= 0
                          ? t('正在下载 {n}%', { n: String(status.download.percent) })
                          : t('正在下载…')
                        : t('下载 cloudflared')}
                    </Button>
                  )}
                  {cf?.installed && cf.path && (
                    <span className="max-w-[280px] truncate font-mono text-[0.71875rem] text-subtle" title={cf.path}>
                      {cf.path}
                    </span>
                  )}
                  {!cf?.installed && cf?.error && (
                    <span className="text-[0.75rem] leading-relaxed text-subtle">{cf.error}</span>
                  )}
                  {status?.download?.error && (
                    <span className="max-w-[280px] text-[0.75rem] leading-relaxed text-danger">
                      {status.download.error}
                    </span>
                  )}
                </div>
              </Row>
              <Row title={t('cloudflared 路径')} desc={t('自动找到的不用填；装在别处时填可执行文件的完整路径。')}>
                <Input
                  value={value.command}
                  onChange={(e) => onChange({ ...value, command: e.target.value })}
                  placeholder="cloudflared"
                  spellCheck={false}
                  className="w-[280px] font-mono text-[0.8125rem]"
                  aria-label={t('cloudflared 路径')}
                />
              </Row>
              <Row title={t('重新检测')} desc={t('自己装好了 cloudflared（例如用 Homebrew、winget）时点一下。')}>
                <Button size="sm" variant="secondary" onClick={check} disabled={checking}>
                  {checking ? t('检测中…') : t('重新检测')}
                </Button>
              </Row>
            </Group>
          )}

          <Group title={t('连接状态')}>
            <Row title={t('状态')} desc={status?.error || undefined} stack>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[0.8125rem]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
                  <span>{status ? STATE_TEXT[status.state] : t('检测中…')}</span>
                </div>
                {status?.error && (
                  <p className="text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-danger">{status.error}</p>
                )}
              </div>
            </Row>
            {status?.url && (
              <Row
                title={t('外网地址')}
                desc={t('在其他电脑的浏览器里打开。第一次打开会要求访问令牌，这个链接里已经带上了。')}
                stack
              >
                <div className="flex min-w-0 items-center gap-3">
                  <CopyText text={status.link || status.url} title={t('复制地址')} />
                  <a
                    href={status.link || status.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-[0.8125rem] text-accent hover:underline"
                  >
                    {t('打开')}
                  </a>
                </div>
              </Row>
            )}
          </Group>
        </>
      )}
    </>
  )
}
