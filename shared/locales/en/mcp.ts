/** 英文词典的一部分：项目设置里的 MCP 分节（项目里识别到的配置、导入、AI 排查） */
export const EN_MCP: Record<string, string> = {
  '{cli} 不支持管理 MCP 工具': "{cli} doesn't support managing MCP tools",
  项目里已经没有这条配置了: 'This entry is no longer in the project',
  MCP: 'MCP',
  项目里识别到的配置: 'Found in the project',
  '共 {n} 条': '{n} entries',
  '全部导入（{n}）': 'Import all ({n})',
  没有找到: 'None found',
  '（没有填命令或地址）': '(no command or URL)',
  '名字里有空格或特殊字符，导入前要在项目文件里改名':
    'The name has spaces or special characters; rename it in the project file before importing',
  已导入: 'Imported',
  覆盖全局配置: 'Overwrite global',
  导入: 'Import',
  '用 AI 排查这条': 'Diagnose this one with AI',
  面板管理的工具: 'Managed by the panel',
  '用 AI 排查整页': 'Diagnose all with AI',
  '还没有面板管理的 MCP 工具：点右上角「添加」，或导入上面识别到的配置。':
    'No panel-managed MCP tools yet: click "Add" at the top right, or import the config found above.',
  编辑中的配置: 'The config being edited',
  '导入「{name}」？': 'Import “{name}”?',
  '导入这 {n} 条配置？': 'Import these {n} entries?',
  '写进各 Agent 的全局配置文件，之后由面板管理；项目里的配置文件不会改动。同名且配置不同的会覆盖全局那一份。':
    "Written to each agent's global config file and managed by the panel from then on; config files in the project are left untouched. A same-named entry with different config overwrites the global one.",
  'MCP 工具让 Agent 连上外部的服务和数据。这里管当前项目用的 MCP：面板写进各 Agent 的全局配置文件（和「MCP 工具」页是同一份），项目目录里已有的配置只读识别出来、可以一键导入。这里的改动立即生效，不用下面的按钮保存。':
    "MCP tools let agents reach external services and data. This section manages MCP for this project: the panel writes to each agent's global config file (the same data as the MCP tools page), and config already in the project directory is detected read-only and can be imported in one click. Changes here take effect immediately; the button below is not needed.",
  只在项目里: 'Project only',
  '和各 Agent 的配置一致': 'Same as agents',
  '和各 Agent 的配置不同': 'Differs from agents',
  '先创建项目，再管这个项目的 MCP 配置。': 'Create the project first, then manage its MCP config.',
  '这个项目还没设本地目录，所以识别不到项目里的配置。在「常规」里填好目录并保存后再回来。':
    'This project has no local directory yet, so config in the project cannot be found. Fill in the directory under "General", save, and come back.',
  '本地目录改了，先点「确认」保存，再管新目录里的 MCP 配置。':
    'The local directory changed — save with "Confirm" first, then manage MCP config in the new directory.',
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
}
