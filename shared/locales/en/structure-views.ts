/** 英文词典的一部分，键是中文原文：诊断报告的功能结构页签（调用栈 / 时序图 / 类图 / 架构页）和插件市场里的包装配方 */
export const EN_STRUCTURE_VIEWS: Record<string, string> = {
  功能结构: 'Structure',
  图的最大高度: 'Max diagram height',
  '显示「它选的」理由': 'Show why the default was picked',
  列出节点在代码里的位置: 'List where nodes are in the code',
  架构页: 'Architecture page',
  节点在代码里: 'Nodes in code',
  '先看{name}': 'See the {name} first',
  画成一页能点的架构页: 'Draw a clickable architecture page',
  'Archify 还没装': 'Archify not installed',
  'Archify 没打开': 'Archify is off',
  '一个功能牵涉五六个模块、几十个节点，图放不下时，Archify 会画成单页 HTML：模块总览，点一个模块展开它的调用和数据流，出错点标红。画好在右栏网页页签里打开。':
    'When a feature spans five or six modules and dozens of nodes, Archify draws it as a single HTML page: a module overview where clicking a module expands its calls and data flow, with the fault marked in red. It opens in the web tab of the right panel.',
  'Archify 已经装好：这一版没有画架构页。要的话在报告上提问「补一张架构页」，下一版它会画好放在这里。':
    'Archify is installed, but this version has no architecture page. Ask "add an architecture page" on the report and the next version will put it here.',
  'Archify 装了但没打开，打开后 Agent 才能用它画。':
    'Archify is installed but turned off. Turn it on so the agent can draw with it.',
  '安装 Archify（官方配方）': 'Install Archify (official recipe)',
  去插件页打开: 'Turn on in Plugins',
  '装好后这里直接显示 HTML 卡片': 'Once installed, the HTML card shows here',
  '它选的：{why}': 'Picked because: {why}',
  '官方包装配方：把 {repo} 包装成插件，版本跟着上游走':
    'Official wrap recipe: packages {repo} as a plugin and follows upstream versions',
  包装: 'Wrapped',
}
