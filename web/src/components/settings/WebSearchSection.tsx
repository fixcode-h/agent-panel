import { t } from '@shared/i18n'
import { SEARCH_PROVIDERS, searchProvider, switchSearchProvider } from '@shared/web-search'
import type { Settings } from '@shared/schema'
import { Input, Select } from '@/components/ui/input'
import { Group, Row } from './parts'

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
  return (
    <>
      <Group>
        <Row
          title={t('搜索源')}
          desc={t(
            '模型联网搜索时用哪个服务。Degoog 不需要密钥，但查询会发给 degoog.org 这个第三方聚合服务（会把查询再转给别的搜索引擎）；需要密钥的源按用量计费，只有自己选了并填了密钥才会用到。',
          )}
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
            title={t('搜索源的密钥')}
            desc={t('只存在本机数据目录的设置文件里。搜索请求由面板代发，扩展脚本和模型都拿不到密钥。')}
          >
            <Input
              type="password"
              aria-label={t('搜索源的密钥')}
              value={value.key}
              onChange={(e) => onChange({ ...value, key: e.target.value })}
              placeholder="sk-xxxx"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[0.8125rem]"
            />
          </Row>
        )}
        <Row
          title={t('搜索源地址')}
          desc={
            provider.endpoint
              ? t('留空用默认地址 {url}；也可以填自己的网关或代理。', { url: provider.endpoint })
              : t(
                  'SearXNG 要填自己实例的地址：公共实例一般不开放 JSON 接口。只填主机就行（例如 https://searxng.example.com），/search 路径会自动补上。',
                )
          }
        >
          <Input
            aria-label={t('搜索源地址')}
            value={endpointShown}
            onChange={(e) => onChange({ ...value, endpoint: e.target.value, endpointProvider: provider.id })}
            placeholder={provider.endpoint || 'https://searxng.example.com'}
            spellCheck={false}
            className="font-mono text-[0.8125rem]"
          />
        </Row>
      </Group>
      <Group title={t('怎么打开')}>
        <p className="border-b py-4 text-[0.8125rem] leading-relaxed text-subtle">
          {t(
            '这一页只管搜索源和密钥。模型要真正能用 web_search / web_fetch，还要在对应 CLI 的设置里打开「联网搜索」开关（默认关闭，打开前先确认搜索源）。',
          )}
        </p>
      </Group>
    </>
  )
}
