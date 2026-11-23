/** 英文词典的一部分，键是中文原文：项目文件索引（项目设置「文件索引」、数据页「文件索引」） */
export const EN_FILE_INDEX: Record<string, string> = {
  文件索引: 'File index',
  '记下项目里每个文件的名字和位置（不读内容），按名字找文件、列某个文件夹时直接查它，不用每次扫目录。Agent 找文件也先查它。':
    'Keeps the name and location of every file in the project (never the contents). Finding a file by name or listing a folder reads the index instead of scanning the disk each time. Agents check it first when looking for files too.',
  收录哪些文件: 'Files to include',
  '「磁盘上的全部」按磁盘收，跳过下面的排除目录（Git 项目还跳过 .gitignore 忽略的），刚新建、还没加进版本管理的文件也找得到。「只收版本管理里的」只收已经提交 / 签入的文件。':
    '"Everything on disk" indexes what is on disk, skipping the excluded folders below (and anything .gitignore ignores in Git projects), so new files not yet added to version control are found too. "Only files under version control" indexes only committed / checked-in files.',
  '磁盘上的全部（跳过排除目录）': 'Everything on disk (skip excluded folders)',
  '只收 {vcs} 里的': 'Only files in {vcs}',
  只收版本管理里的: 'Only files under version control',
  盯着改动: 'Watch for changes',
  '自动：Windows、macOS 用系统的文件通知，改了马上进索引；Linux 不盯，查询时按目录核对。面板和 Agent 自己改的文件总是马上进索引。':
    'Auto: on Windows and macOS the system file notifications update the index right away; on Linux nothing is watched and folders are checked when the index is queried. Files changed by the panel or by agents always enter the index right away.',
  总是用系统通知: 'Always use system notifications',
  '不盯，按目录核对': "Don't watch, check folders",
  额外收录的目录: 'Extra folders to include',
  项目外也可以: 'Can be outside the project',
  '绝对路径，或相对项目根。项目外的文档根（ProjectDoc/docs）会自动加，不用写在这里。':
    'Absolute paths, or relative to the project root. A docs root outside the project (ProjectDoc/docs) is added automatically and does not need to be listed here.',
  '目录路径，回车添加': 'Folder path, press Enter to add',
  也收插件报来的目录: 'Also include folders reported by plugins',
  '例如 UE 插件报的引擎目录：找引擎里的头文件、插件也走索引。引擎目录大，第一次建要多花些时间。':
    'For example the engine folder reported by the UE plugin, so engine headers and plugins are found through the index too. The engine is large, so the first build takes a bit longer.',
  'Agent 改了文件': 'an agent changed files',
  面板里改了文件: 'files changed in the panel',
  系统通知: 'system notification',
  定时核对: 'periodic check',
  全量重建: 'Full rebuild',
  '核对了 {n} 个目录：新增 {a} 个、删除 {r} 个文件': 'Checked {n} folders: {a} files added, {r} removed',
  建立中: 'Building',
  已就绪: 'Ready',
  核对中: 'Checking',
  '{files} 个文件': '{files} files',
  '{dirs} 个目录': '{dirs} folders',
  文件索引建立进度: 'File index build progress',
  '已读 {dirs} 个目录': '{dirs} folders read',
  '最后更新 {ago}': 'Last updated {ago}',
  '（{by}）': ' ({by})',
  '上次全量 {ago}': 'Last full build {ago}',
  '，用时 {d}': ', took {d}',
  '盯着改动：系统文件通知，另外每 10 分钟按目录核对一次':
    'Watching: system file notifications, plus a folder check every 10 minutes',
  '盯着改动：不用系统通知，查询时超过 1 分钟没核对就先按目录核对':
    'Watching: no system notifications; a query first checks folders if they were not checked in the last minute',
  增量更新: 'Incremental update',
  '在「数据」里管理': 'Manage in Data',
  按名字找文件的分工: 'Who finds files by name',
  'C++ 源码先用 VS 的 uetovs/search_files，Lua 先用 IDEA 的 lua_code files，其他文件先查文件索引（file_index）。都没装或查不到时 Agent 才用 rg --files / find；排除目录里的文件不在索引里，直接用原命令找。':
    'C++ sources go to uetovs/search_files in VS first, Lua to lua_code files in IDEA first, and everything else to the file index (file_index). Only when those are not installed or find nothing do agents use rg --files / find. Files in excluded folders are not in the index, so agents use those commands directly for them.',
  '不收录、也不搜索的目录': 'Folders not indexed or searched',
  '文件索引不收这些目录，Agent 用 rg 搜代码时也跳过它们（编译产物、缓存这类）。AI 初始化分析项目时会填好；Git 项目里 .gitignore 已经忽略的目录会自动跳过，这里只需填它没覆盖的。要找这些目录里的文件时 Agent 直接用 rg / find。':
    'The file index leaves these folders out, and agents skip them when searching code with rg (build output, caches and the like). AI setup fills them in when it analyzes the project; in Git projects, folders already in .gitignore are skipped automatically, so only add the ones it does not cover. To find files in these folders, agents use rg / find directly.',
  '会删除所有项目的文件索引。项目用到时会自动重建，大项目第一次重建要几秒到几十秒。':
    'Deletes the file index of every project. Each is rebuilt automatically when the project needs it; for a large project the first rebuild takes from a few seconds to a few tens of seconds.',
  '已开始重建，建好后自动替换': 'Rebuild started; it replaces the current index when done',
  '{n} 份，共 {size}': '{n} indexes, {size} in total',
  无主: 'Orphaned',
  用它的项目已经删了: 'The projects using it were deleted',
  '更新于 {ago}': 'updated {ago}',
  '删除这份文件索引？': 'Delete this file index?',
  '只删索引，不动项目里的文件。还有项目在用时，下次用到会自动重建。':
    'Only the index is deleted; project files are untouched. If a project still uses it, it is rebuilt the next time it is needed.',
  '各项目的文件名索引（只记文件名，不含内容）；清理后项目用到时自动重建':
    'File name indexes of each project (names only, no contents); rebuilt automatically when a project needs them after clearing',
  查文件索引: 'Look up file index',
  '这份索引现在没有项目在用，删掉即可；项目用到时会自动重建':
    'No project is using this index right now; just delete it. It is rebuilt when a project needs it',
  找不到这个项目: 'Project not found',
  这个项目没有开文件索引: 'File index is turned off for this project',
  '索引里没有这个目录（不存在，或在排除目录里）':
    'This folder is not in the index (it does not exist, or it is excluded)',
  '文件索引出错，点开看原因': 'File index error, click for details',
  正在建立文件索引: 'Building file index',
  正在核对文件索引: 'Checking file index',
  文档根: 'Docs root',
  额外目录: 'Extra folder',
  '插件 {id}': 'Plugin {id}',
}
