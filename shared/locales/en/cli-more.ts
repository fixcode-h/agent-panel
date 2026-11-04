/** 英文词典的一部分，键是中文原文：CLI 的项目信任、插件市场、CLI 自己的配置项（ADR 0050） */
export const EN_CLI_MORE: Record<string, string> = {
  项目配置: 'Project configuration',
  '{cli} 只在信任过这个项目后才读项目里的配置、扩展和 Skill；面板里运行时不会弹窗问，没有保存过决定就当不信任。选「信任」后项目里的扩展代码会在 {cli} 里执行，下次启动生效':
    '{cli} reads the configuration, extensions and skills in a project only after you trust it. When the panel runs it, nothing asks, so without a saved decision the project counts as untrusted. Choosing "Trust" lets the project\'s extension code run inside {cli}; it takes effect the next time {cli} starts',
  '{cli} 项目配置': '{cli} project configuration',
  '跟随 {cli}': 'Follow {cli}',
  信任: 'Trust',
  不信任: "Don't trust",
  '这个项目里有 {cli} 的项目配置：{files}。没在终端里信任过这个目录时，面板里运行的 {cli} 不会加载它们':
    "This project has {cli} project configuration: {files}. Unless you trusted this folder in a terminal, {cli} won't load them when the panel runs it",
  '本机 {cli} {version}，{list}，低于这个版本时面板不装':
    "{cli} {version} is installed. {list}; the panel doesn't install them on older versions",
  '{what}要 {min} 以上': '{what} need {min} or later',
}
