/** 英文词典的一部分，键是中文原文：校验和改动生效（ADR 0086）——自建工具的「用途」页、调用记录里的校验行、能力表的说明 */
export const EN_VERIFY_APPLY: Record<string, string> = {
  用途: 'Role',
  '校验和编译会接进工具路由：面板按它自动检查、改道':
    'Check and build tools join tool routing: the panel runs checks and reroutes with them',
  '普通工具（由 Agent 自己调）': 'Regular tool (the agent calls it)',
  '校验：改完对得上的文件后面板自己跑': 'Check: the panel runs it after matching files are edited',
  '编译：Agent 自己拼编译命令时改用它': 'Build: used instead when the agent types its own build command',
  '校验工具要是只读的：在「影响和输出」里把影响改成只读。':
    'Check tools must be read-only: set the effect to read-only under "Effect and output".',
  改了哪些文件要查: 'Files to check',
  '相对项目根，** 表示任意层；只把报错推给 Agent，没报错不打扰':
    'Relative to the project root, ** matches any depth. Only errors are sent to the agent; a clean check stays quiet',
  改过的文件填进哪个参数: 'Parameter for the edited files',
  '不选时用第一个路径参数；没有参数就不带文件跑一次':
    'Defaults to the first path parameter; with no parameters it runs once without files',
  '自动（{name}）': 'Automatic ({name})',
  不带文件: 'no files',
  写成清单文件一次查完: 'Pass a list file and check them all at once',
  '一行一个路径；不开时按文件一个个跑': 'One path per line; when off, files are checked one by one',
  顶替的程序: 'Replaces programs',
  'Agent 自己跑这些程序时，改道模式下改走这个工具；只写程序名，如 luac':
    'When the agent runs one of these programs itself, enforce mode routes it to this tool. Program names only, such as luac',
  '{to}（{decision}，按 {by} 认的；改道模式，真的改了）':
    '{to} ({decision}, matched by {by}; enforce mode, actually rerouted)',
  '{n} 个文件：{files}': '{n} files: {files}',
  '日志 {file}': 'log {file}',
  '{n} 处报错': '{n} errors',
  没通过: 'failed',
  没跑起来: "couldn't start",
  '校验 · {tool} · {result}': 'Check · {tool} · {result}',
  '面板自己跑（改完自动校验）': 'Run by the panel (check after edits)',
  '面板改用 {to} 代答': 'Answered by the panel via {to}',
  '没执行，让 Agent 改用 {to}': 'Not run; the agent was told to use {to}',
  '自建工具 role.replaces 登记的程序': "Programs listed in a custom tool's role.replaces",
  'UE 的编译命令改用 request_build 或项目自己的编译工具；Live Coding、Lua 热重载等插件接口 22（第四期）再接。':
    "UE build commands go to request_build or the project's own build tool; Live Coding and Lua hot reload arrive with plugin API 22 (phase four).",
  '自建工具 role=build': 'Custom tools with role=build',
}
