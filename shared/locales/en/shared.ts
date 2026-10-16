/** 英文词典的一部分，键是中文原文 */
export const EN_SHARED: Record<string, string> = {
  // clis.ts：模型档位、思考强度、权限模式
  高: 'High',
  中: 'Medium',
  低: 'Low',
  很高: 'Extra high',
  最高: 'Max',
  '复杂任务、架构设计': 'Complex tasks, architecture design',
  日常开发: 'Everyday development',
  '简单改动、速度优先': 'Simple changes, speed first',
  自动接受改文件: 'Auto-accept edits',
  '可以直接读写文件；需要审批的命令会在任务页上请你确认':
    'Reads and writes files directly; commands that need approval are confirmed on the task page',
  跳过所有确认: 'Skip all confirmations',
  '可以执行任意命令，只在信任的项目里用': 'Can run any command. Use only in trusted projects',
  只读规划: 'Read-only planning',
  '只分析和出方案，不改文件': 'Only analyzes and proposes a plan; does not edit files',
  逐项确认: 'Confirm each action',
  改文件和需要审批的命令都会在任务页上请你确认:
    'File edits and commands that need approval are confirmed on the task page',
  可写项目目录: 'Workspace write',
  '沙箱内运行，可以改项目目录里的文件；需要越过沙箱时在任务页上请你确认':
    'Runs in a sandbox and can edit files in the project directory; leaving the sandbox is confirmed on the task page',
  只读: 'Read-only',
  只能读文件和跑只读命令: 'Can only read files and run read-only commands',
  完全访问: 'Full access',
  '不使用沙箱、不确认，只在信任的项目里用': 'No sandbox, no confirmations. Use only in trusted projects',
  'Command Code 非交互执行时，改文件和跑命令仍会被拦下，只能读代码和分析；要让它动手请选「跳过所有确认」':
    'In non-interactive mode, Command Code still blocks file edits and commands, so it can only read and analyze code. To let it make changes, choose "Skip all confirmations"',
  '可以改文件、执行任意命令，只在信任的项目里用': 'Can edit files and run any command. Use only in trusted projects',
  标准: 'Standard',
  非交互执行时改文件和跑命令都会被拦下: 'File edits and commands are blocked in non-interactive mode',
  '<任务描述>': '<task>',

  // data.ts：数据分类
  配置: 'Configuration',
  '设置、Agent、工作流和分类': 'Settings, Agents, workflows and categories',
  项目: 'Projects',
  '添加的项目（不会动项目目录里的文件）；清理时任务记录一起清掉':
    'Added projects (files in project directories are never touched); clearing also removes their task history',
  任务记录: 'Task history',
  '执行过的工作流、对话和聊天，包括输出和用量':
    'Past workflow runs, conversations and chats, including output and usage',
  附件: 'Attachments',
  任务里附上的文件和图片: 'Files and images attached to tasks',
  缓存: 'Cache',
  '下载的更新包、损坏文件的备份，可以随时清理':
    'Downloaded updates and backups of corrupted files. Safe to clear anytime',

  // icons.ts：Agent 图标含义
  通用: 'General',
  规划: 'Planning',
  调度: 'Orchestration',
  编码: 'Coding',
  前端: 'Frontend',
  后端: 'Backend',
  设计: 'Design',
  测试: 'Testing',
  排错: 'Debugging',
  审查: 'Code review',
  调研: 'Research',
  文档: 'Docs',
  运维: 'DevOps',
  发布: 'Release',
  优化: 'Optimization',
  创意: 'Creative',

  // settings.ts
  'CLI 默认': 'CLI default',
  '{tier}档 · {model}': '{tier} tier · {model}',
  '默认 · {model}': 'Default · {model}',

  // schema.ts
  名称不能为空: 'Name is required',
  分类名不能为空: 'Category name is required',
  请描述任务: 'Please describe the task',
  内容不能为空: 'Content is required',
  标题不能为空: 'Title is required',
  '默认 Agent': 'Default Agent',
  '使用默认 CLI 的默认模型和思考强度，对话时可以临时调整':
    'Uses the default model and effort of the default CLI. You can adjust them during a chat',
  主流程: 'Main flow',

  // flow.ts
  未命名子流程: 'Untitled subflow',
  '分析需求、拆分任务': 'Analyze requirements and split tasks',
  实现: 'Implement',
  验收: 'Review',
  '（流程已删除）': '(Flow deleted)',
  '（工作流已删除）': '(Workflow deleted)',
  '节点 {n}': 'Node {n}',
  开始: 'Start',
  结束: 'End',
  执行: 'Run',

  // engine.ts：写进任务对话的系统消息和错误
  执行失败: 'Run failed',
  '「{title}」的开始流程失败：{error}': 'Start flow of "{title}" failed: {error}',
  '「{title}」没有可执行的 Agent，请先给工作流选择主 Agent':
    '"{title}" has no Agent to run it. Choose a main Agent for the workflow first',
  '「{title}」的验收流程失败：{error}': 'Review flow of "{title}" failed: {error}',
  '「{title}」的验收流程没有写「验收结论」，按通过处理。':
    'The review flow of "{title}" gave no verdict, so it was treated as passed.',
  '「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}':
    '"{title}" still failed review after {round} rounds. Feedback from the last round:\n{feedback}',
  '「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。':
    '"{title}" failed review in round {round}. The feedback was sent back to the node for another pass.',
  '「{title}」的结束流程失败：{error}': 'End flow of "{title}" failed: {error}',
  '引用的流程不存在，可能已被删除': 'The referenced flow does not exist. It may have been deleted',
  '流程嵌套超过 {max} 层，请检查是否循环引用':
    'Flows are nested more than {max} levels deep. Check for circular references',
  '已暂停。点「继续执行」从中断的地方接着做，或者在下面输入新的要求。':
    'Paused. Click "Resume" to pick up where it left off, or enter new instructions below.',
  '「{title}」': '"{title}"',
  '、': ', ',
  有节点: 'Some nodes',
  '{nodes}执行失败，原因见节点里的错误。可以点「继续执行」重试，或者在下面输入新的要求。':
    '{nodes} failed. See the error in the node for details. Click "Resume" to retry, or enter new instructions below.',
  '工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线':
    'No node in the main flow is connected to "Start" yet. Draw a connection from "Start" in the flow chart first',
  '工作流不存在，可能已被删除': 'The workflow does not exist. It may have been deleted',
  '没有可以回答的 Agent，请先给工作流选择主 Agent':
    'No Agent is available to respond. Choose a main Agent for the workflow first',
}
