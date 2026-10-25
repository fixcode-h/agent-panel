import { t } from '@shared/i18n'
import { DEFAULT_PROXY_URL } from '@shared/proxy'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'

/**
 * 设置里的「网络与代理」：访问不了 GitHub 时（检查更新、下载新版本）走哪条路。
 * 开关和地址放在一起：关掉开关只是不用这一页填的地址，环境变量和本机代理自动探测照旧，
 * 说明文字按 `server/net.ts` 的实际行为写（`configuredProxy` → `planFor` → 失败后的回退）。
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
  return (
    <Group>
      <Row
        title={t('启用代理')}
        desc={t(
          '检查更新、下载新版本时用下面填的代理。关掉后不用这个地址，但仍会先走环境变量 HTTPS_PROXY（设了的话），没设时先直连；请求失败后再自动找本机正在运行的代理（系统代理或常见端口）。',
        )}
      >
        <Switch aria-label={t('启用代理')} checked={enabled} onCheckedChange={(v) => onChange({ enabled: v, proxy })} />
      </Row>
      <Row
        title={t('代理地址')}
        desc={t(
          '本机代理的地址，例如 {proxy}。留空时就不用这个地址，顺序和关掉开关一样（环境变量 → 直连 → 本机代理）。只支持 http 代理：v2rayN 默认的入站是 SOCKS，面板用不了，要把它改成 http / mixed 入站，或者填它的 http 入站端口。',
          { proxy: DEFAULT_PROXY_URL },
        )}
      >
        <Input
          value={proxy}
          onChange={(e) => onChange({ enabled, proxy: e.target.value })}
          placeholder={DEFAULT_PROXY_URL}
          disabled={!enabled}
          className="w-[240px] font-mono text-[0.8125rem]"
          spellCheck={false}
          aria-label={t('代理地址')}
        />
      </Row>
    </Group>
  )
}
