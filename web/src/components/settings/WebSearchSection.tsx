import { t } from '@shared/i18n'
import { SEARCH_PROVIDERS, searchProvider, switchSearchProvider } from '@shared/web-search'
import type { Settings } from '@shared/schema'
import { Input, Select } from '@/components/ui/input'
import { Advanced, Group, Row } from './parts'

/**
 * 设置里的「联网搜索」：CLI 调 web_search / web_fetch 时用哪个搜索服务、密钥和地址。
 * 开关不在这里：它属于 CLI 自己的能力（设置 → 某个 CLI 的「联网搜索」开关，默认关），
 * 关着时面板根本不会给 CLI 注入这个扩展，这一页填的源和密钥也就不会被用到。
 */
export function WebSearchSection({
  value,
  onChange,
}: {
  value: Settings['webSearch']
  onChange: (v: Settings['webSearch']) => void
}) {
  const provider = searchProvider(value.provider)
  // 地址是所有源共用的一个字段：归属对不上就说明它是上一源留下的，服务端会忽略它（见 resolveSearchEndpoint），
  // 输入框也按实际生效的情况显示成空，不然用户会以为这个地址还在用
  const endpointShown = value.endpointProvider && value.endpointProvider !== provider.id ? '' : value.endpoint
  // SearXNG 没有默认地址、必须填，不能折起来：只有带默认地址的源才收进「高级」
  const endpointRow = (
    <Row
      title={t('地址')}
      desc={provider.endpoint ? t('留空用默认地址 {url}', { url: provider.endpoint }) : t('填自己实例的主机地址')}
      hint={
        provider.endpoint
          ? t('也可以填自己的网关或代理。')
          : t(
              '公共实例一般不开放 JSON 接口。只填主机就行（例如 https://searxng.example.com），/search 路径会自动补上。',
            )
      }
    >
      <Input
        aria-label={t('搜索源地址')}
        value={endpointShown}
        onChange={(e) => onChange({ ...value, endpoint: e.target.value, endpointProvider: provider.id })}
        placeholder={provider.endpoint || 'https://searxng.example.com'}
        spellCheck={false}
        className="font-mono text-body"
      />
    </Row>
  )
  return (
    <>
      <Group title={t('搜索服务')}>
        <Row
          title={t('服务')}
          desc={provider.needsKey ? t('这个服务要填密钥') : t('不用密钥')}
          hint={
            <>
              {t(
                'Claude Code、Codex、Command Code 用它们自带的搜索，不走这里。默认是 DeepSeek 官方搜索，要填 DeepSeek 的 API key 才能用，没填时搜索会直接报错，不会换成别的源。也可以换成自建的 SearXNG，或 Brave、Tavily。',
              )}
              {/* 选中源自己的说明（计费、用哪种 key）：跟着下拉切换，用户换源前就看得到要花钱 */}
              {provider.note && <span className="mt-1 block">{provider.note}</span>}
            </>
          }
        >
          <Select
            aria-label={t('搜索源')}
            value={provider.id}
            onChange={(e) => onChange(switchSearchProvider(value, e.target.value))}
            options={SEARCH_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
          />
        </Row>
        {provider.needsKey && (
          <Row
            title={t('密钥')}
            desc={t('只存在本机，模型拿不到')}
            hint={t('只存在本机数据目录的设置文件里。搜索请求由面板代发，扩展脚本和模型都拿不到密钥。')}
          >
            <Input
              type="password"
              aria-label={t('搜索源的密钥')}
              value={value.key}
              onChange={(e) => onChange({ ...value, key: e.target.value })}
              placeholder="sk-xxxx"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-body"
            />
          </Row>
        )}
        {provider.endpoint ? <Advanced label={t('自定义地址')}>{endpointRow}</Advanced> : endpointRow}
      </Group>
      <Group title={t('怎么打开')}>
        <p className="text-body text-subtle">
          {t('模型要用 web_search / web_fetch，还要在对应 Agent 的设置里打开「联网搜索」开关（默认关闭）。')}
        </p>
      </Group>
    </>
  )
}
