/** 英文词典的一部分，键是中文原文：插件系统（设置 →「插件」、插件的设计模式页，ADR 0059） */
export const EN_PLUGINS: Record<string, string> = {
  扩展: 'Extensions',
  插件没有打开: 'Plugin is not enabled',
  '这一页来自插件，插件关掉或删除后就没有了。到设置 →「插件」里打开。':
    'This page comes from a plugin and goes away when the plugin is turned off or removed. Turn it on in Settings → Plugins.',
  '压缩包 · {name}': 'Zip · {name}',
  '本机目录 · {dir}': 'Local folder · {dir}',
  插件参数已保存: 'Plugin settings saved',
  '对应环境变量 {env}': 'Environment variable {env}',
  保存参数: 'Save settings',
  '插件启动失败：{error}': 'Plugin failed to start: {error}',
  '已删除插件 {name}，保留了 {n} 个改过或在用的副本': 'Removed plugin {name}; kept {n} edited or in-use copies',
  '已删除插件 {name}': 'Removed plugin {name}',
  '正在统计会清掉的内容…': 'Checking what will be cleaned up…',
  '会删掉没改过、没人用的副本（先备份）：{list}': 'Unedited, unused copies will be deleted (backed up first): {list}',
  '本机没有要清掉的角色和工作流副本。': 'No role or workflow copies to clean up.',
  '下面这些会保留：': 'These will be kept:',
  含代码: 'Runs code',
  '上游 {name} {version}（{license}）': 'Upstream {name} {version} ({license})',
  '关掉插件 {name}': 'Turn off plugin {name}',
  '打开插件 {name}': 'Turn on plugin {name}',
  '关掉后保留了这些副本：': 'Kept these copies after turning it off:',
  '关掉插件「{name}」？': 'Turn off plugin “{name}”?',
  关掉: 'Turn off',
  '会停掉它的后台和工具，对话里不再挂它的工具，它带的钩子、测试步骤和「/」命令一起撤掉，它装的没改过的技能也一起删掉。':
    'Its background service and tools stop, conversations no longer get its tools, its hooks, test steps and / commands are withdrawn, and the unedited skills it installed are removed.',
  '删除插件「{name}」？': 'Remove plugin “{name}”?',
  '插件目录、插件自己的数据和它的参数都会删掉，以后可以从插件市场或压缩包重新安装。面板的其他功能不受影响。':
    'The plugin folder, its own data and its settings are deleted. You can reinstall it later from the marketplace or a zip. Nothing else in the panel is affected.',
  '插件给面板加上一组能力（工具、技能、角色、工作流、页面），装在数据目录里，可以随时关掉或删除，删掉后面板其他功能不受影响。':
    'Plugins add a set of capabilities (tools, skills, roles, workflows, pages). They live in the data folder and can be turned off or removed at any time without affecting the rest of the panel.',
  插件仓库: 'Plugin repository',
  'GitHub 仓库（owner/repo）。仓库根上的 plugins.json 列出里面的插件；没有的话整个仓库当作一个插件。':
    'A GitHub repository (owner/repo). plugins.json at its root lists the plugins in it; without one, the whole repository is treated as a single plugin.',
  '这个仓库没有插件目录，可以直接把整个仓库当作插件安装。':
    'This repository has no plugin list; you can install the whole repository as one plugin.',
  '这个仓库的插件目录是空的。': 'This repository’s plugin list is empty.',
  插件目录: 'Plugin folder',
  '链接本机的插件构建目录，不复制：重新构建后关掉再打开插件就生效。':
    'Links a local plugin build folder without copying it: after rebuilding, turn the plugin off and on again.',
  '已更新插件 {name}': 'Updated plugin {name}',
  '已安装插件 {name}，打开开关后生效': 'Installed plugin {name}; turn it on to use it',
  更新插件: 'Update plugin',
  安装插件: 'Install plugin',
  '作者：{name}': 'Author: {name}',
  '已经装着 v{v}：会换成这个版本，参数保留。':
    'v{v} is installed: it will be replaced with this version and its settings kept.',
  '这个插件带代码，打开后会在本机以面板的权限运行（读写文件、启动程序、联网）。只安装你信任的来源。':
    'This plugin contains code. Once turned on it runs on this computer with the panel’s permissions (reading and writing files, starting programs, network access). Only install plugins from sources you trust.',
  '角色：{list}': 'Roles: {list}',
  '工作流：{list}': 'Workflows: {list}',
  '技能：{list}': 'Skills: {list}',
  '给 Agent 的工具服务：{list}': 'Tool servers for agents: {list}',
  '在线演示不能安装插件，要在本机运行面板': 'Plugins can’t be installed in the online demo; run the panel locally',
  '在用：{list}': 'In use: {list}',
  改过: 'Edited',
  在用: 'In use',
  // 检查更新、升级
  '上次检查 {time}': 'Last checked {time}',
  '升级到 v{v}': 'Upgrade to v{v}',
  插件参数: 'Plugin settings',
  已开启的插件: 'Enabled plugins',
  加载出错: 'Failed to load',
  还没有开启的插件: 'No plugins enabled',
  '还没有开启的插件。先在「插件」页安装并打开插件，这里就会列出它的参数。':
    'No plugins are enabled. Install and turn on a plugin on the Plugins page, and its settings will appear here.',
  去插件页: 'Go to Plugins',
  参数设置: 'Settings',
  '这个插件没有可配置的参数。': 'This plugin has no settings.',
  运行状态: 'Status',
  能看这个文件的插件已经关掉了: 'The plugin that can view this file has been turned off',
  // 插件接口 3：插件带的钩子、测试步骤、「/」命令
  插件带的钩子: 'Hooks from plugins',
  '带来：': 'Adds:',
  '插件带的测试步骤：接在上面的步骤后面，同样按适用改动筛。关掉插件后自动撤掉；只想在这个项目不用就关掉开关。':
    'Test steps from plugins run after the steps above and are filtered by changed files the same way. They go away when the plugin is turned off; turn a switch off to skip one in this project only.',
  '适用改动：{globs}': 'Applies to: {globs}',
  '只在项目根有 {files} 时生效': 'Only when the project root has {files}',
  '在这个项目用「{name}」': 'Use “{name}” in this project',
  '没有这个插件钩子，插件可能关掉了': 'No such plugin hook. The plugin may have been turned off',
  脚本不在插件包里: 'The script is not inside the plugin package',
  '插件没在运行，或者服务端入口没有 hook()': 'The plugin is not running, or its server entry has no hook()',
  '插件 · {name}': 'Plugin · {name}',
  '钩子：{list}': 'Hooks: {list}',
  '测试步骤：{list}': 'Test steps: {list}',
  '「/」命令：{list}': '/ commands: {list}',
  '插件没有打开，或没有这一页': 'The plugin is not enabled, or has no such page',
  // 插件用到的开放模块面板没有（shared/plugins/host-modules-check.ts）
  '插件要用面板的模块 {list}{more}，这个版本的面板没有开放，请先升级面板':
    'The plugin needs panel modules {list}{more}, which this panel version does not provide. Please upgrade the panel first',
  ' 等 {n} 个': ' and {n} in total',
  // 退回上一版（web/src/plugins/PluginCard.tsx）
  '已退回 {name} {version}': 'Rolled {name} back to {version}',
  '退回上一版 v{version}': 'Roll back to v{version}',
  '退回插件「{name}」的上一版？': 'Roll back plugin "{name}"?',
  退回: 'Roll back',
  '会从 v{current} 换回升级前的 v{version} 并重新启动插件，参数和插件数据不动。之后想回到 v{current} 可以再点一次退回。':
    'Switches from v{current} back to v{version}, the version before the upgrade, and restarts the plugin. Settings and plugin data are kept. To return to v{current}, roll back again.',
  // 插件在新会话开头的提示（server/exec/plugin-run.ts）
  '插件「{name}」：{text}': 'Plugin "{name}": {text}',
  // 项目设置里插件加的页，插件关掉后（web/src/components/projects/settings/PluginSectionPage.tsx）
  这一页来自的插件已经关掉或删除了: 'The plugin that added this page has been turned off or removed',
  // 设置 →「组件」里插件的示例组（web/src/components/settings/PluginSpecimens.tsx）
  '{name}（插件）': '{name} (plugin)',
  // 插件页重设计：顶上一行的市场仓库、刷新和其他方式安装，已安装 / 可安装两段（web/src/plugins/）
  '读取失败，显示的是 {time}的结果': "Couldn't refresh; showing results from {time}",
  换插件市场仓库: 'Change plugin market repository',
  插件市场仓库: 'Plugin market repository',
  其他方式安装: 'Other ways to install',
  '上传压缩包（.zip）': 'Upload a package (.zip)',
  '链接本机目录（开发）': 'Link a local folder (development)',
  链接本机目录: 'Link a local folder',
  主页: 'Homepage',
  '插件 {name} 的更多操作': 'More actions for plugin {name}',
  重新链接: 'Link again',
  打开主页: 'Open homepage',
  删除插件: 'Remove plugin',
  '还没有安装插件。从下面挑一个，或者用「其他方式安装」上传插件压缩包。':
    'No plugins installed yet. Pick one below, or upload a plugin package with "Other ways to install".',
  可安装: 'Available',
  '这个市场里的插件都装好了。': 'Every plugin in this market is already installed.',
  '{n} 个有新版本': '{n} with a new version',
}
