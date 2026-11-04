import { useState } from 'react'
import { Loader2, Radar } from 'lucide-react'
import { t } from '@shared/i18n'
import { DEFAULT_PROXY_URL, type DetectedProxy } from '@shared/proxy'
import { netApi } from '@/lib/api-net'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Group, Row } from './parts'

/**
 * 设置里的「网络与代理」：访问不了 GitHub 时（检查更新、下载新版本）走哪条路。
 * 开关和地址放在一起：关掉开关只是不用这一页填的地址，环境变量、系统代理和本机代理自动探测照旧，
 * 说明文字按 `server/net.ts` 的实际行为写（`configuredProxy` → `planFor` → 失败后的回退）。
 * 「检测」按钮重新探测本机正在运行的 http 代理（`detectProxies`），找到就打开开关并填上第一个。
 */
export function NetworkSection({
  enabled,
  proxy,
  onChange,
}: {
  enabled: boolean
  proxy: string
  onChange: (v: { enabled: boolean; proxy: string }) => void
}) {
  const [detecting, setDetecting] = useState(false)
  /** 上一次检测的结果；undefined 表示还没检测过 */
  const [found, setFound] = useState<DetectedProxy[]>()

  const detect = async () => {
    setDetecting(true)
    try {
      const { proxies } = await netApi.detectProxies()
      setFound(proxies)
      if (proxies.length) onChange({ enabled: true, proxy: proxies[0].url })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  const label = (p: DetectedProxy) => (p.source === 'system' ? t('系统代理') : t('端口探测'))

  return (
    <Group>
      <Row
        title={t('使用代理')}
        desc={t('检查和下载更新时走这个代理')}
        hint={t(
          '检查更新、下载新版本时用下面填的代理。关掉后不用这个地址，依次走环境变量 HTTPS_PROXY（设了的话）、系统代理（代理软件开了「系统代理」时）、直连；请求失败后再自动找本机正在运行的代理（常见端口）。',
        )}
      >
        <Switch aria-label={t('启用代理')} checked={enabled} onCheckedChange={(v) => onChange({ enabled: v, proxy })} />
      </Row>
      <Row
        title={t('代理地址')}
        indent
        desc={
          found === undefined ? (
            t('只支持 http 代理')
          ) : found.length ? (
            t('已填入检测到的代理（{source}）', { source: label(found[0]) })
          ) : (
            <span className="text-warning">
              {t('没有检测到能用的 http 代理：确认代理软件已打开，或手动填写它的 http 端口')}
            </span>
          )
        }
        hint={t(
          '本机代理的地址，例如 {proxy}。点右边的检测按钮会找本机正在运行的代理（系统代理和常见端口）并自动填入。留空时就不用这个地址，顺序和关掉开关一样（环境变量 → 系统代理 → 直连 → 本机代理）。只支持 http 代理：v2rayN 默认的入站是 SOCKS，面板用不了，要把它改成 http / mixed 入站，或者填它的 http 入站端口。',
          { proxy: DEFAULT_PROXY_URL },
        )}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={proxy}
              onChange={(e) => onChange({ enabled, proxy: e.target.value })}
              placeholder={DEFAULT_PROXY_URL}
              disabled={!enabled}
              className="font-mono text-body"
              spellCheck={false}
              aria-label={t('代理地址')}
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-9 shrink-0"
              aria-label={t('检测本机代理')}
              title={t('检测本机正在运行的代理并填入')}
              disabled={detecting}
              onClick={() => void detect()}
            >
              {detecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
              {t('检测')}
            </Button>
          </div>
          {/* 找到不止一个时列出来，点哪个用哪个；当前用的那个高亮 */}
          {found && found.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {found.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => onChange({ enabled: true, proxy: p.url })}
                  className={cn(
                    'rounded-md border px-2 py-0.5 font-mono text-caption transition-colors',
                    proxy === p.url
                      ? 'border-accent/50 bg-accent-soft text-fg'
                      : 'border-line text-subtle hover:bg-sel hover:text-fg',
                  )}
                >
                  {p.url.replace(/^https?:\/\//, '')}
                  <span className="ml-1.5 font-sans text-muted">{label(p)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Row>
    </Group>
  )
}
