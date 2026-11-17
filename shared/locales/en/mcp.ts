/** 英文词典的一部分：项目设置里的 MCP 分节（项目里识别到的配置、导入、AI 排查） */
export const EN_MCP: Record<string, string> = {
  项目里已经没有这条配置了: 'This entry is no longer in the project',
  项目里识别到的配置: 'Found in the project',
  '共 {n} 条': '{n} entries',
  '全部导入（{n}）': 'Import all ({n})',
  没有找到: 'None found',
  '（没有填命令或地址）': '(no command or URL)',
  '名字里有空格或特殊字符，导入前要在项目文件里改名':
    'The name has spaces or special characters; rename it in the project file before importing',
  已导入: 'Imported',
  覆盖已有配置: 'Overwrite existing',
  导入: 'Import',
  '用 AI 排查这条': 'Diagnose this one with AI',
  面板管理的工具: 'Managed by the panel',
  '用 AI 排查整页': 'Diagnose all with AI',
  '还没有面板管理的 MCP 工具：点右上角「添加」，或导入上面识别到的配置。':
    'No panel-managed MCP tools yet: click "Add" at the top right, or import the config found above.',
  编辑中的配置: 'The config being edited',
  '导入「{name}」？': 'Import “{name}”?',
  '导入这 {n} 条配置？': 'Import these {n} entries?',
  '先创建项目，再管这个项目的 MCP 配置。': 'Create the project first, then manage its MCP config.',
  '这个项目还没设本地目录，所以识别不到项目里的配置。在「常规」里填好目录并保存后再回来。':
    'This project has no local directory yet, so config in the project cannot be found. Fill in the directory under "General", save, and come back.',
  '没找到项目里的 MCP 配置。支持 .mcp.json、.claude/settings*.json、.cursor/mcp.json、.vscode/mcp.json、.codex/config.toml。':
    'No MCP config found in the project. Supported: .mcp.json, .claude/settings*.json, .cursor/mcp.json, .vscode/mcp.json, .codex/config.toml.',
  '已导入 {n} 条配置': 'Imported {n} entries',
  '{n} 条没有导入：{reason}': '{n} entries were not imported: {reason}',
  '项目的 MCP「{name}」': 'Project MCP “{name}”',
  '项目的 MCP 配置': 'Project MCP config',
  '项目：{name}（{path}）': 'Project: {name} ({path})',
  '这一条的来源：{origin}': 'Source of this entry: {origin}',
  '当前配置：\n{raw}': 'Current config:\n{raw}',
  '项目里识别到的配置：\n{list}': 'Config found in the project:\n{list}',
  '面板管理的配置（各 Agent 的全局配置）：\n{list}':
    "Configs managed by the panel (each agent's global config):\n{list}",
  '读不懂的配置文件：\n{list}': 'Config files that could not be read:\n{list}',
  '从 JSON 填入': 'Fill from JSON',
  'JSON 里有 {n} 个工具，点名字切换要填的那个': 'The JSON has {n} tools; click a name to fill that one',
  '已填入下面的表单，保存前可以再改': 'Filled in the form below; you can still edit it before saving',
  '粘贴文档里的 MCP 配置，点「分析」自动填好下面各项':
    'Paste an MCP config from the docs and click "Analysis" to fill in the fields below',
  '（没有名字）': '(no name)',
  '先粘贴 MCP 配置的 JSON': 'Paste the MCP config JSON first',
  'JSON 格式不对：{error}': 'Invalid JSON: {error}',
  '没在 JSON 里找到 MCP 工具的配置': 'No MCP tool config found in the JSON',
  '导入成只在这个项目生效的 MCP 并打开，之后由面板管理；项目里的配置文件不会改动。面板里已有同名的会用项目里的配置覆盖。':
    'Imported as an MCP for this project only and turned on here, managed by the panel from then on; config files in the project are left untouched. A same-named entry in the panel is overwritten with the project config.',
  'MCP 工具让 Agent 连上外部的服务和数据。项目目录里自带的配置读到就自动导入并在这个项目打开，你关掉的不会再被打开；Agent 自己只对这个项目配的识别出来，要你一键导入。这里的改动立即生效，不用下面的按钮保存。':
    'MCP tools connect agents to external services and data. Configs shipped in the project folder are imported and turned on for this project automatically, and ones you turn off stay off; ones an agent keeps for this project in its own config are detected for you to import with one click. Changes here apply immediately; no need to press Save below.',
  还没导入: 'Not imported',
  和面板里的一致: 'Same as panel',
  和面板里的不同: 'Differs from panel',
  本项目已打开: 'On in this project',
  本项目已关闭: 'Off in this project',
  '已导入并启用项目里的 MCP：{names}': 'Imported and turned on MCP from the project: {names}',
  '{cli} 里只对本项目生效的配置': '{cli} config for this project only',
}
