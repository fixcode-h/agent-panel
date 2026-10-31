/** 英文词典：联网搜索（web_search / web_fetch 的开关、设置页和错误提示） */
export const EN_WEB_SEARCH: Record<string, string> = {
  搜索源: 'Search provider',
  'DeepSeek 官方的搜索接口，用 DeepSeek 平台的 API key（不是中转站的 key）。按次计费：约 $0.75 / 千次成功请求，失败和没有结果的请求不计费。':
    'DeepSeek’s official search API, using a DeepSeek platform API key (not a reseller’s key). Billed per request: about $0.75 per 1,000 successful requests; failed and empty requests are free.',
  'DeepSeek 搜索的 query（含 site: 域名过滤）最多 {n} 个字，现在是 {len} 个字：缩短搜索词或少给几个域名':
    'DeepSeek search queries (including site: domain filters) are limited to {n} characters, this one has {len}: shorten the query or pass fewer domains',
  '只存在本机数据目录的设置文件里。搜索请求由面板代发，扩展脚本和模型都拿不到密钥。':
    'Stored only in the settings file in the local data folder. Requests are sent by the panel, so extension scripts and the model never see the key.',
  搜索源的密钥: 'Search provider key',
  搜索源地址: 'Search provider address',
  怎么打开: 'How to enable',
  联网搜索: 'Web search',
  'SearXNG（自建实例）': 'SearXNG (self-hosted)',
  'Brave Search API（需要密钥）': 'Brave Search API (key required)',
  'Tavily（需要密钥）': 'Tavily (key required)',
  'DeepSeek（官方，需要密钥）': 'DeepSeek (official, key required)',
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
