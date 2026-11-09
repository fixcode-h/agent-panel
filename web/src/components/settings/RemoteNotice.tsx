import { ExternalLink } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'

/** 报错原文里的网址：frpc、tailscale 的报错常带着要去打开的链接 */
const URL_RE = /(https?:\/\/[^\s'"<>]+)/g

/** 把文字里的网址做成可点的链接（新窗口打开），其余照原文显示 */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="break-all underline underline-offset-2 hover:opacity-80"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  )
}

/**
 * Tailscale 还没在后台开启 Serve / Funnel：tailscale 给了开启链接、正在后台等。
 * 告诉用户去开、开好后会自己连上，不用再点「重新连接」
 */
export function TailscaleEnableNotice({ url, funnel }: { url: string; funnel: boolean }) {
  const feature = funnel ? 'Funnel' : 'Serve'
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-footnote leading-relaxed">
      <p className="text-fg">
        {t('你的 Tailscale 网络还没开启 {feature}：点下面的按钮到 Tailscale 后台点 Enable，开好后这里会自动连上。', {
          feature,
        })}
      </p>
      <Button size="sm" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
        <ExternalLink className="h-3.5 w-3.5" />
        {t('去 Tailscale 开启 {feature}', { feature })}
      </Button>
      <span className="break-all text-subtle">{url}</span>
    </div>
  )
}
