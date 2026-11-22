/** 英文词典的一部分，键是中文原文：「小工具」页和 GitHub 加速下载（web/src/components/tools、server/tools） */
export const EN_TOOLS: Record<string, string> = {
  小工具: 'Tools',
  搜索工具: 'Search tools',
  '没有符合的工具。': 'No matching tools.',
  'GitHub 加速下载': 'GitHub accelerated download',
  '贴一个 GitHub 地址，经代理或镜像加速下载到本机':
    'Paste a GitHub address and download it to this machine through a proxy or mirror',
  'GitHub 地址': 'GitHub address',
  '将下载 {name}': 'Will download {name}',
  '支持文件网页、Release 附件、源码包、raw 文件；贴仓库或分支的地址会下载源码 zip':
    'Works with file pages, release assets, source archives and raw files; a repository or branch address downloads the source zip',
  下载来源: 'Download source',
  '自动（按设置里的顺序，卡住就换）': 'Automatic (settings order, switch when stuck)',
  '{label}（设置里关着）': '{label} (off in settings)',
  '在「设置 · 网络与代理 · GitHub 下载来源」里加镜像前缀、调顺序、开关来源':
    'Add mirror prefixes, reorder and toggle sources in Settings · Network & proxy · GitHub download sources',
  管理来源: 'Manage sources',
  保存到: 'Save to',
  '先试 {source}': 'Tries {source} first',
  复制这个地址: 'Copy this address',
  交给浏览器下载: 'Download in the browser',
  下载记录: 'Downloads',
  '还没有下载过。记录只保留到面板重启，文件留在磁盘上。':
    'Nothing downloaded yet. The list is kept until the panel restarts; files stay on disk.',
  重新下载: 'Download again',
  从记录里移除: 'Remove from list',
  下载进度: 'Download progress',
  '{speed}/秒': '{speed}/s',
  '来源：{source}': 'Source: {source}',
  '下载失败，试过的来源都不行：{list}。可以换一个来源，或在「设置 · 网络与代理 · GitHub 下载来源」里加镜像前缀。':
    'Download failed; every source failed: {list}. Pick another source, or add a mirror prefix in Settings · Network & proxy · GitHub download sources.',
  '先填一个 GitHub 地址': 'Enter a GitHub address first',
  这不是一个有效的地址: 'This is not a valid address',
  '只支持 GitHub 的地址（github.com、raw.githubusercontent.com 等）':
    'Only GitHub addresses are supported (github.com, raw.githubusercontent.com, ...)',
  '地址里要有仓库：github.com/<用户>/<仓库>/…': 'The address needs a repository: github.com/<owner>/<repo>/…',
  '这个地址不是文件：请贴文件、Release 附件或仓库的地址':
    'This address is not a file: paste a file, release asset or repository address',
  下载参数不对: 'Invalid download parameters',
  保存目录要写完整路径: 'The save folder must be a full path',
  '没有可用的下载来源：选的来源不适用这个地址，或设置里的来源都关了':
    'No download source available: the chosen source does not apply to this address, or every source is off in settings',
  找不到这条下载记录: 'Download not found',
  文件还没下载好: 'The file has not finished downloading',
  '文件已经不在了：{path}': 'The file is gone: {path}',
}
