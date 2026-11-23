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
  '填镜像站给的前缀，例如 https://mirror.example.com/ ，取文件时用「前缀 + 原地址」。镜像是第三方服务，请只填信得过的站点；列表里预置的 gh-proxy 可以关掉，不能删。':
    'Enter the prefix the mirror gives you, e.g. https://mirror.example.com/ . Files are fetched from "prefix + original address". Mirrors are third-party services, so only add ones you trust; the preset gh-proxy in the list can be turned off but not removed.',
  'gh-proxy 加速（IPv6）': 'gh-proxy accelerator (IPv6)',
  'gh-proxy 的 IPv6 节点，走 Cloudflare 优选线路；本机没有 IPv6 时连不上，会自动换下一个来源':
    "gh-proxy's IPv6 node on optimized Cloudflare routes; if this machine has no IPv6 it cannot connect and the next source is tried automatically",
  镜像前缀: 'Mirror prefix',
  原地址: 'Original address',
  '按原来的地址取；「使用代理」打开时经过代理和本机代理回退，关着时直连':
    'Fetch from the original address; through the proxy and local proxy fallback when "Use a proxy" is on, directly when it is off',
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
  // 面板更新包按来源下载（server/update/fetch-package.ts）
  '镜像 {host}': 'Mirror {host}',
  'GitHub API 限流（HTTP {status}）': 'GitHub API rate limited (HTTP {status})',
  'GitHub API 没有给出下载地址（HTTP {status}）': 'GitHub API returned no download address (HTTP {status})',
  '{n} 秒没有收到数据': 'No data received for {n} seconds',
  '下载安装包失败，试过的来源都不行：{list}。可以在「设置 · 网络与代理」里配代理或加镜像前缀，或先下载好安装包再用「用本地安装包更新」。':
    'Failed to download the package; every source failed: {list}. Set a proxy or add a mirror prefix in "Settings · Network & proxy", or download the package yourself and use "Update from local package".',
  '限流中，暂时跳过': 'Rate limited, skipped for now',
  '下载来源：{source}': 'Downloading from: {source}',
  '已换掉 {source}：{error}': 'Gave up on {source}: {error}',
  超时: 'Timed out',
  '经 api.github.com 取仓库文件；用环境变量里的令牌，每小时 5000 次':
    'Fetch repository files through api.github.com; using the token from the environment, 5000 requests per hour',
  '经 api.github.com 取仓库文件；已用 {tool} 登录（{account}），每小时 5000 次':
    'Fetch repository files through api.github.com; signed in with {tool} ({account}), 5000 requests per hour',
  '经 api.github.com 取仓库文件；已用 {tool} 登录，每小时 5000 次':
    'Fetch repository files through api.github.com; signed in with {tool}, 5000 requests per hour',
  国内镜像: 'Mirrors in China',
  官方: 'Official',
  '开了「用国内镜像」的功能先从镜像站取，取不到再回官方站；没开的只从官方站取。':
    'Features with "Use mirrors in China" turned on download from the mirror first and fall back to the official site; the others only use the official site.',
  '语音输入的识别库、UE 插件的文字识别（OCR）': 'Speech input runtime, OCR in the UE plugin',
  '语音输入、本机生图的模型': 'Models for speech input and local image generation',
  '本机生图的 Python 依赖': 'Python dependencies for local image generation',
  '视频插件的 FFmpeg': 'FFmpeg for the video plugin',
}
