/** 英文词典：联网搜索（web_search / web_fetch 的开关、设置页和错误提示） */
export const EN_WEB_SEARCH: Record<string, string> = {
  搜索源: 'Search provider',
  '模型联网搜索时用哪个服务。Degoog 不需要密钥，但查询会发给 degoog.org 这个第三方聚合服务（会把查询再转给别的搜索引擎）；需要密钥的源按用量计费，只有自己选了并填了密钥才会用到。':
    'Which service the model searches with. Degoog needs no key, but the query goes to degoog.org, a third-party meta-search service that forwards it to other engines. Providers that need a key bill per use and are only used after you pick one and enter its key.',
  '只存在本机数据目录的设置文件里。搜索请求由面板代发，扩展脚本和模型都拿不到密钥。':
    'Stored only in the settings file in the local data folder. Requests are sent by the panel, so extension scripts and the model never see the key.',
  搜索源的密钥: 'Search provider key',
  '留空用默认地址 {url}；也可以填自己的网关或代理。': 'Leave empty for {url}, or enter your own gateway or proxy.',
  'SearXNG 要填自己实例的地址：公共实例一般不开放 JSON 接口。':
    'SearXNG needs the address of your own instance: public instances usually keep the JSON API disabled.',
  搜索源地址: 'Search provider address',
  怎么打开: 'How to enable',
  '这一页只管搜索源和密钥。模型要真正能用 web_search / web_fetch，还要在对应 CLI 的设置里打开「联网搜索」开关（默认关闭，打开前先确认搜索源）。':
    'This page only sets the provider and key. To let the model actually use web_search / web_fetch, also turn on “Web search” in that CLI’s settings (off by default; check the provider first).',
  联网搜索: 'Web search',
  'Degoog（免密钥）': 'Degoog (no key)',
  'SearXNG（自建实例）': 'SearXNG (self-hosted)',
  'Brave Search API（需要密钥）': 'Brave Search API (key required)',
  'Tavily（需要密钥）': 'Tavily (key required)',
  '{field} 里只能写域名，例如 example.com，不要带协议、端口或路径：{value}':
    '{field} only accepts domains such as example.com, without a scheme, port or path: {value}',
  'query 至少要有 {n} 个字': 'query must be at least {n} characters',
  'query 太长了，最多 {n} 个字': 'query is too long, at most {n} characters',
  'allowed_domains 和 blocked_domains 不能同时给，选一个': 'Give either allowed_domains or blocked_domains, not both',
  'url 是必填的': 'url is required',
  '这不是一个有效的网址：{url}': 'Not a valid URL: {url}',
  '只支持 http 和 https 网址：{url}': 'Only http and https URLs are supported: {url}',
  '网址里不能带用户名和密码：{url}': 'URLs with a username or password are not allowed: {url}',
  '网址里没有主机名：{url}': 'The URL has no host name: {url}',
  '不抓取本机地址：{url}': 'Refusing to fetch a local address: {url}',
  '不抓取内网主机名：{url}': 'Refusing to fetch an intranet host name: {url}',
  '不抓取内网或本机地址：{url}': 'Refusing to fetch a private or local address: {url}',
  '域名 {host} 解析失败：{error}': 'Could not resolve {host}: {error}',
  '域名 {host} 指向内网地址 {ip}，不抓取': '{host} resolves to the private address {ip}; refusing to fetch',
  '抓取 {url} 失败：{error}': 'Fetching {url} failed: {error}',
  '跳转超过 {n} 次，停止抓取：{url}': 'More than {n} redirects; stopping at {url}',
  '搜索源 {provider} 需要填写地址，请在「设置 · 联网搜索」里补上':
    '{provider} needs an address; set it under Settings · Web search',
  '搜索源 {provider} 需要密钥，请在「设置 · 联网搜索」里填写':
    '{provider} needs a key; set it under Settings · Web search',
  '{provider} 请求失败：{error}': '{provider} request failed: {error}',
  '{provider} 返回 {status}：{body}': '{provider} returned {status}: {body}',
  '{provider} 返回的不是 JSON：{body}': '{provider} did not return JSON: {body}',
  这一轮已经结束了: 'This run has already ended',
}
