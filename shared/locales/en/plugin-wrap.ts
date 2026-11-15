/** 英文词典的一部分，键是中文原文：从 GitHub 链接包装插件（ADR 0068） */
export const EN_PLUGIN_WRAP: Record<string, string> = {
  'Claude Code 插件': 'Claude Code plugin',
  'MCP 服务': 'MCP server',
  命令行: 'Command line',
  官方配方: 'Official recipe',
  '社区配方 · 插件市场审核过': 'Community recipe · reviewed in the plugin market',
  'AI 写的配方 · 未经市场审核': 'AI-written recipe · not reviewed by the market',
  '任意链接 · 未经市场审核': 'Any link · not reviewed by the market',
  '包装 {kind} {path}': 'Wrap {kind} {path}',
  '跳过：{why}': 'Skipped: {why}',
  '固定在 {sha}': 'Pinned to {sha}',
  '没有许可证：作者没给授权，只建议自己用': 'No license: the author granted no rights, personal use only',
  在网页里看仓库: 'View repository on the web',
  识别出的内容: 'What was recognized',
  '按配方 {file}': 'Using recipe {file}',
  '按 AI 写的配方': 'Using the AI-written recipe',
  '自动识别，可以改勾选': 'Detected automatically, you can change the selection',
  '没认出能装进面板的东西。': 'Nothing that can be installed into the panel was recognized.',
  装上后会做什么: 'What installing will do',
  '带 MCP、托管进程或命令行，建议只在打开了它的项目里生效':
    'Includes MCP, managed processes or command-line tools: best enabled only in projects that turn it on',
  '只有技能和环境变量，不起进程、不挂 MCP，全局也只是多一个技能':
    'Only skills and environment variables: no processes, no MCP, so global just adds one skill',
  '和装着的 v{v} 比': 'Compared with installed v{v}',
  '新增权限：{what}': 'New permission: {what}',
  权限没有变化: 'No permission changes',
  '新增 {n} 处扫描发现（列在下面）': '{n} new scan findings (listed below)',
  没有新增扫描发现: 'No new scan findings',
  '从 GitHub 链接包装…': 'Wrap from a GitHub link…',
  '贴一个开源项目的链接，自动识别成技能、MCP、命令行或网页应用':
    'Paste an open-source project link to turn it into skills, MCP, a command-line tool or a web app',
  '从 GitHub 链接包装的插件': 'Plugin wrapped from a GitHub link',
  '包装 · GitHub': 'Wrapped · GitHub',
  重新包装: 'Re-wrap',
  '没有自动更新到 v{v}：{error}': 'Not updated to v{v} automatically: {error}',
  'AI 包装 {repo}': 'AI wrap {repo}',
  更新包装插件: 'Update wrapped plugin',
  '从 GitHub 包装插件': 'Wrap a plugin from GitHub',
  '装好后在插件页能关、能删，删掉不留东西':
    'Once installed you can turn it off or delete it; deleting leaves nothing behind',
  'AI 帮我包装': 'Let AI wrap it',
  包装并安装: 'Wrap and install',
  'GitHub 链接': 'GitHub link',
  '贴一个开源项目的链接，自动识别成技能、MCP、命令行或网页应用，生成标准插件包。分析时只下载、不运行任何代码；插件市场里有审核过的配方时按配方来。':
    'Paste an open-source project link; it is recognized as skills, MCP, a command-line tool or a web app and turned into a standard plugin package. Analysis only downloads and never runs code; a reviewed recipe from the plugin market is used when there is one.',
  '正在下载 {repo} 并识别（不运行任何代码）…': 'Downloading {repo} and recognizing it (no code is run)…',
  '这个仓库里没找到技能、MCP 服务、命令行工具或网页应用。可以让 AI 读一遍仓库写一份配方：开一个分析对话，写好后回到这里预览，照样过扫描和确认。':
    'No skills, MCP server, command-line tool or web app found in this repository. AI can read it and write a recipe in an analysis conversation; you then come back here to preview it, with the same scan and confirmation.',
  '权限有变化（{list}），点「升级」看清楚再装':
    'Permissions changed ({list}); click "Upgrade" to review before installing',
  '有新增的扫描发现，点「升级」看清楚再装': 'There are new scan findings; click "Upgrade" to review before installing',
  'npm 装依赖时会自动运行的脚本（包装器用 --ignore-scripts 不跑它，但手动安装会跑）':
    'A script npm runs automatically when installing dependencies (the wrapper uses --ignore-scripts, but a manual install would run it)',
  '压缩或混淆过的代码，看不出它做什么；确认是上游的构建产物再装':
    'Minified or obfuscated code whose behavior cannot be read; make sure it is an upstream build artifact before installing',
  '从网上下载脚本直接执行：内容随时能被换掉，Agent 照着做就会运行它':
    'Downloads a script and runs it directly: its content can change at any time, and an Agent following this would run it',
  '包里带着可执行的二进制文件，扫描看不到它的内容':
    'The package contains an executable binary whose content the scan cannot see',
  '代码里出现的外部网址：装上后可能会连这些地方':
    'External addresses found in the code: once installed it may connect to them',
  插件包装: 'Plugin wrapping',
}
