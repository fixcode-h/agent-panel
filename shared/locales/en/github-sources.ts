/** 英文词典的一部分，键是中文原文：GitHub 下载来源（多来源兜底、设置页「GitHub 下载来源」） */
export const EN_GITHUB_SOURCES: Record<string, string> = {
  'GitHub 下载来源': 'GitHub download sources',
  换来源下载: 'Fall back to other sources',
  '原地址取不到时，按下面的顺序换来源再取': 'When the original address fails, try the sources below in order',
  '插件目录、插件升级包、面板更新这类从 GitHub 取的文件，都先按原地址取（经过上面的代理设置）；连不上、服务器出错或被限流时，依次换下面打开的来源。仓库里的文件能换 GitHub API、GitHub 网页、jsDelivr；Release 附件和源码包只能换镜像前缀。哪个来源成功了，接下来 10 分钟先用它。全都失败时，错误里会列出每个来源的原因。':
    'Files fetched from GitHub (plugin catalogs, plugin updates, panel updates) are first fetched from the original address (through the proxy settings above). If that cannot connect, the server errors, or it is rate limited, the enabled sources below are tried in order. Repository files can come from the GitHub API, the GitHub web page or jsDelivr; release assets and source archives can only use a mirror prefix. Whichever source works is tried first for the next 10 minutes. If every source fails, the error lists the reason for each one.',
  '逐个来源取一次样例文件，看通不通': 'Fetch a sample file from each source to see which ones work',
  '可用 · {ms} 毫秒': 'Works · {ms} ms',
  不通: 'Unreachable',
  删除这个镜像: 'Remove this mirror',
  加镜像前缀: 'Add mirror prefix',
  '要写成 http(s):// 开头的地址': 'Must start with http(s)://',
  已经加过这个镜像: 'This mirror is already in the list',
  '第三方加速站，原地址前面加上它再取': 'A third-party mirror, put in front of the original address',
  '填镜像站给的前缀，例如 https://mirror.example.com/ ，取文件时用「前缀 + 原地址」。镜像是第三方服务，面板不内置任何一个，请只填信得过的站点。':
    'Enter the prefix the mirror gives you, e.g. https://mirror.example.com/ . Files are fetched from "prefix + original address". Mirrors are third-party services and none is built in, so only add ones you trust.',
  镜像前缀: 'Mirror prefix',
  原地址: 'Original address',
  '按原来的地址取，经过「代理」里的设置和本机代理回退':
    'Fetch from the original address, using the proxy settings and local proxy fallback',
  '经 api.github.com 取仓库文件；不登录每小时限 60 次':
    'Fetch repository files via api.github.com; limited to 60 requests an hour without signing in',
  'GitHub 网页': 'GitHub web page',
  '打开 github.com 上这个文件的网页，从页面里取出文件内容；只适用文本文件':
    "Open the file's page on github.com and take the content from the page; text files only",
  '经 cdn.jsdelivr.net 取仓库文件；按分支名取时可能晚几个小时才更新':
    'Fetch repository files via cdn.jsdelivr.net; by branch name it can lag a few hours behind',
  '原地址前面加上镜像站的前缀再取，Release 附件和源码包也能走':
    'Put the mirror prefix in front of the original address; works for release assets and source archives too',
  检测下载来源的参数不对: 'Invalid parameters for checking download sources',
  'Release 附件和源码包只能经代理或镜像前缀下载：可以在「设置 · 网络与代理 · GitHub 下载来源」里加一个镜像前缀。':
    'Release assets and source archives can only be downloaded through a proxy or a mirror prefix: add a mirror prefix in Settings · Network & proxy · GitHub download sources.',
  '网页上没有文件内容（文件太大或不是文本）': 'The page has no file content (the file is too large or not text)',
  'GitHub 的各个下载来源都没成功（{url}）。{list}': 'None of the GitHub download sources worked ({url}). {list}',
  返回的不是文件内容: 'The response is not the file content',
}
