import type { McpToolTitle } from './tool-titles.ts'

/**
 * 面板替几家常见的别家 MCP 服务备好的中文显示名：服务自己没在 tools/list 里报 `_meta.titles` 时用（见 tool-titles.ts 的 externalToolTitle）。
 * JetBrains IDE 自带的 MCP 服务（2025.x 条目名 `jetbrains`，2026.1 起按产品名，如 `idea`、`rider`）只报英文名；
 * 装在 IDE 里的插件（例如 EmmyLua 的 lua_debug_*）把工具注册进这个服务后，插件自己写的中文名也带不过来，所以都记在这里。
 * 写成数据（同 _meta.titles 的形状），不走 t()：英文界面直接用工具原名，和服务报的英文名一样好认。
 */
const JETBRAINS: Record<string, string> = {
  // 代码分析
  analyze_calls: '查看调用层级',
  build_project: '编译项目',
  get_file_problems: '检查文件问题',
  get_project_problems: '检查项目问题',
  get_project_dependencies: '查看项目依赖',
  get_project_modules: '查看项目模块',
  lint_files: '批量检查文件',
  get_symbol_info: '查看符号信息',
  // 数据库
  cancel_sql_query: '取消 SQL 查询',
  create_database_connection: '新建数据库连接',
  edit_database_connection: '修改数据库连接',
  execute_sql_query: '执行 SQL 查询',
  fetch_query_result: '取查询结果',
  get_database_object_description: '查看数据库对象结构',
  introspect_schema: '读取数据库结构',
  list_database_connections: '查看数据库连接',
  list_database_schemas: '查看数据库 schema',
  list_recent_sql_queries: '查看最近的 SQL 查询',
  list_schema_object_kinds: '查看数据库对象类型',
  list_schema_objects: '查看数据库对象',
  preview_table_data: '预览表数据',
  test_database_connection: '测试数据库连接',
  // 调试器
  xdebug_control_session: '调试：继续 / 单步 / 停止',
  xdebug_evaluate_expression: '调试：求值',
  xdebug_get_debugger_status: '查看调试状态',
  xdebug_get_frame_values: '调试：查看变量',
  xdebug_get_stack: '调试：查看调用栈',
  xdebug_get_threads: '调试：查看线程',
  xdebug_get_value_by_path: '调试：展开变量',
  xdebug_list_breakpoints: '查看断点',
  xdebug_remove_breakpoint: '删除断点',
  xdebug_run_to_line: '调试：运行到行',
  xdebug_set_breakpoint: '设断点',
  xdebug_set_variable: '调试：改变量值',
  xdebug_start_debugger_session: '启动调试',
  // 运行配置
  execute_run_configuration: '执行运行配置',
  get_run_configurations: '查看运行配置',
  // 文件与编辑器
  create_new_file: '新建文件',
  get_all_open_file_paths: '查看打开的文件',
  list_directory_tree: '查看目录树',
  open_file_in_editor: '在编辑器打开文件',
  reformat_file: '格式化文件',
  read_file: '读文件',
  get_file_text_by_path: '读文件',
  replace_text_in_file: '改文件内容',
  apply_patch: '应用补丁',
  rename_refactoring: '重命名符号',
  // 检查脚本
  validate_inspection_kts: '校验检查脚本',
  generate_inspection_kts_api: '查看检查脚本接口',
  generate_inspection_kts_examples: '查看检查脚本示例',
  generate_psi_tree: '生成 PSI 树',
  run_inspection_kts: '运行检查脚本',
  // 搜索
  search_file: '按名字找文件',
  search_regex: '正则搜索',
  search_symbol: '搜索符号',
  search_text: '搜索文本',
  skill_search: '搜索',
  find_files_by_glob: '按名字找文件',
  find_files_by_name_keyword: '按名字找文件',
  search_in_files_by_text: '搜索文本',
  search_in_files_by_regex: '正则搜索',
  // 终端与版本控制
  execute_terminal_command: '运行终端命令',
  get_repositories: '查看代码仓库',
  git_status: '查看 Git 状态',
  execute_tool: '调用 IDE 工具',
  // EmmyLua 插件注册进 IDE 服务的工具（fixcode-h/IntelliJ-EmmyLua，插件里的 titleZh）
  lua_code: 'Lua 代码查找',
  lua_debug_session: 'Lua 调试：会话与单步',
  lua_debug_breakpoints: 'Lua 断点',
  lua_debug_inspect: 'Lua 调试：栈和变量',
}

/** JetBrains 系 IDE 的 MCP 服务名：IDE 自动配置写的条目名，也认用户手写的 intellij、idea-xxx 这类 */
const JETBRAINS_SERVER =
  /^(?:jetbrains|intellij|idea|rider|pycharm|webstorm|goland|clion|phpstorm|rubymine|datagrip|rustrover|android-?studio|aqua|fleet)(?:[-_ ][\w-]*)?$/i

/** 服务没报中文名时，面板备好的显示名；不认识的服务或工具返回 undefined */
export function knownToolTitle(server: string, tool: string): McpToolTitle | undefined {
  if (!JETBRAINS_SERVER.test(server.trim())) return undefined
  const zh = JETBRAINS[tool]
  return zh ? { titles: { zh } } : undefined
}
