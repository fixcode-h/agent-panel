import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { t } from '@shared/i18n'
import { proxyHost, proxySnippet, type ProxyKind } from '@shared/remote'
import { copyText } from '@/lib/copy-text'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Group, Row } from './parts'

/** 复制多行配置：按钮上只写「复制」，复制成功变对勾 */
function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() =>
        void copyText(text, { fail: false }).then((ok) => {
          if (!ok) return
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {t('复制配置')}
    </Button>
  )
}

/**
 * 「反向代理」：给 Caddy、Nginx Proxy Manager、nginx 拼好可以直接用的配置。
 * upstream 是反代连面板用的地址；cloud 为 true 时反代装在 frp 的云服务器上（转到 frps 开出来的面板端口），
 * 给面板加上域名和 HTTPS
 */
export function ProxyGuide({ publicUrl, upstream, cloud }: { publicUrl: string; upstream: string; cloud?: boolean }) {
  const [kind, setKind] = useState<ProxyKind>('caddy')
  const host = proxyHost(publicUrl)
  const snippet = proxySnippet(kind, publicUrl, upstream)
  return (
    <Group title={t('反向代理配置')}>
      <Row
        title={t('反向代理')}
        desc={
          cloud ? t('可选：在云服务器上装一个反向代理，用域名和 HTTPS 打开面板') : t('选你用的反向代理，复制下面的配置')
        }
        hint={t(
          '配置里转发了 Host 和 X-Forwarded-*（登录时核对来源、按访问者地址锁定要用），关掉了缓冲（任务进度是实时推送的），放大了上传上限。域名在上面的「访问地址」里填。',
        )}
      >
        <Segmented
          label={t('反向代理')}
          value={kind}
          onChange={setKind}
          options={[
            { id: 'caddy', label: 'Caddy' },
            { id: 'npm', label: 'NPM' },
            { id: 'nginx', label: 'nginx' },
          ]}
        />
      </Row>
      <Row title={kind === 'npm' ? t('设置步骤') : t('配置')} stack>
        <div className="flex flex-col gap-3">
          {kind === 'caddy' && (
            <p className="text-body leading-relaxed text-muted">
              {t('加到 Caddyfile 里，执行 caddy reload。域名解析到这台机器后，Caddy 会自动申请 HTTPS 证书。')}
            </p>
          )}
          {kind === 'nginx' && (
            <p className="text-body leading-relaxed text-muted">
              {t('放进 /etc/nginx/conf.d/，证书路径按 certbot 的默认位置写的，执行 nginx -t 检查后 nginx -s reload。')}
            </p>
          )}
          {kind === 'npm' && (
            <ol className="list-decimal space-y-1 pl-5 text-body leading-relaxed text-muted">
              <li>{t('Hosts → Proxy Hosts → Add Proxy Host，Domain Names 填 {host}', { host })}</li>
              <li>
                {t('Scheme 选 http，Forward Hostname / IP 和 Port 填 {upstream}', { upstream })}
                {!cloud &&
                  t(
                    '（NPM 跑在 Docker 里，127.0.0.1 指的是容器自己：要填本机局域网 IP，并把监听地址改成「所有网卡」）',
                  )}
              </li>
              <li>{t('打开 Websockets Support 和 Block Common Exploits')}</li>
              <li>{t('SSL 页签申请 Let’s Encrypt 证书，打开 Force SSL')}</li>
              <li>{t('Advanced 页签的 Custom Nginx Configuration 里粘贴下面几行')}</li>
            </ol>
          )}
          <pre className="overflow-x-auto rounded-lg bg-sel/60 px-3 py-2.5 font-mono text-caption leading-relaxed text-fg">
            {snippet}
          </pre>
          <div>
            <CopyBlock text={snippet} />
          </div>
        </div>
      </Row>
    </Group>
  )
}
