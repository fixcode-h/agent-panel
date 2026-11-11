/** 表格页（游戏配置表管理）：项目设置的「表格」、侧栏入口、文件树、内容搜索、保存、对比、AI 分析 */
export const EN_TABLES: Record<string, string> = {
  项目风格: 'Project style',
  '游戏配置表这类表格的目录。设好后侧栏多一个「表格」入口：按目录浏览、搜索、筛选、在线改单元格、看版本差异、跨项目对比。保存改动只改单元格的值，文件仍是原来的 Excel / WPS 格式。':
    'Folders with tables such as game config sheets. Once set, a "Tables" entry appears in the sidebar: browse by folder, search, filter, edit cells online, view version diffs and compare across projects. Saving only changes cell values; the file stays in its original Excel / WPS format.',
  表格目录: 'Table folders',
  '目录（一行一个，相对项目目录）': 'Folders (one per line, relative to the project folder)',
  '这些目录里（含子目录）的表格会列在表格页左侧。常见的写法：Config、Design/Tables、Content/DataTables。':
    'Tables in these folders (including subfolders) are listed on the left of the Tables page. Common values: Config, Design/Tables, Content/DataTables.',
  '逗号分隔的通配，比如 *.xlsx, *.csv；带 / 的按相对路径比':
    'Comma-separated wildcards such as *.xlsx, *.csv; patterns with / match the relative path',
  排除: 'Exclude',
  '默认跳过 Excel / WPS 打开文件时留下的 ~$ 锁文件': 'Skips the ~$ lock files Excel / WPS leave while a file is open',
  结构信息: 'Structure info',
  '表头规则、枚举、列的引用和取值范围这些结构信息永远不写进表格。存在项目目录里可以跟着版本控制给团队共用；只存本机就不会出现在项目目录里。':
    'Header rules, enums, column references and value ranges are never written into the tables. Store them in the project folder to share with the team via version control, or keep them on this machine only.',
  '项目目录 .agentpanel/tables（推荐）': 'Project folder .agentpanel/tables (recommended)',
  只存本机: 'This machine only',
  '表格页只能看、搜索、筛选和对比，不能改单元格。':
    'The Tables page can view, search, filter and compare, but not edit cells.',
  'AI 分析表格风格': 'AI table style analysis',
  '设好表格目录并点「确认」保存后，可以让 AI 读几张表，总结表头有几行、每行是什么、哪些列是枚举或引用。':
    'After setting table folders and clicking Confirm, AI can read a few tables and summarize how many header rows there are, what each row means, and which columns are enums or references.',
  '点「确认」保存后，侧栏会多一个「表格」入口。': 'After you click Confirm, a "Tables" entry appears in the sidebar.',
  '正在查找表格…': 'Looking for tables…',
  '找到 {n} 个表格文件': 'Found {n} table files',
  '（太多了，只列出前一部分）': ' (too many, only the first part is listed)',
  '找不到目录：{dirs}': 'Folders not found: {dirs}',
  打开表格页: 'Open Tables page',
  '输入要找的字，在所有表格的格子里找': 'Type text to search the cells of every table',
  '{n} 个表格里都没有「{q}」': 'No "{q}" in {n} tables',
  '{files} 个文件里找到 {n} 处': '{n} matches in {files} files',
  '（只列出前 {n} 处）': ' (showing the first {n})',
  '还有 {n} 处，打开文件后用表格里的查找': '{n} more; open the file and use Find in the table',
  打开的表格: 'Open tables',
  '关闭 {name}': 'Close {name}',
  '没有名字里带「{q}」的表格': 'No table name contains "{q}"',
  表格目录里还没有表格: 'No tables in the table folders yet',
  表格文件: 'Table files',
  '老的 .xls（Excel 97–2003）格式只能列出来，不能在这里打开和修改。用 Excel / WPS 另存为 .xlsx 后就能用了。':
    'Old .xls (Excel 97–2003) files can only be listed, not opened or edited here. Save as .xlsx in Excel / WPS to use them.',
  这个文件里没有工作表: 'This file has no sheets',
  '记在项目的表格结构文件里（项目设置 → 表格），表格文件一个字节都不改。':
    "Saved in the project's table structure files (Project settings → Tables); the table file itself is untouched.",
  '还没有项目设置表格目录。在项目设置 → 表格里填上配置表所在的目录，这里就会列出来。':
    'No project has table folders yet. Set the config table folders in Project settings → Tables and they will be listed here.',
  按文件名找: 'Find by file name',
  在所有表格的格子里找: 'Search cells of all tables',
  重新读取表格目录: 'Reload table folders',
  表格设置: 'Table settings',
  '表格太多，只列出了前一部分': 'Too many tables, only the first part is listed',
  '从左边选一张表打开；可以同时开几张，在上面的页签里切换。':
    'Pick a table on the left to open it; open several and switch between them with the tabs above.',
  '表格太大（超过 30 MB），请用表格软件打开': 'Table is too large (over 30 MB); open it in a spreadsheet app',
  '老的 .xls / .et 格式只能用表格软件打开，另存为 .xlsx 后能在这里看和改':
    'Old .xls / .et files can only be opened in a spreadsheet app; save as .xlsx to view and edit them here',
  不是表格文件: 'Not a table file',
  项目设置里把表格设成了只读: 'Tables are set to read-only in project settings',
  '表格太大，只读了前面一部分，不能在这里改':
    'Table is too large; only the first part was read and it cannot be edited here',
  表格结构格式不对: 'Invalid table structure format',
}
