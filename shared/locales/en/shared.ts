/** 英文词典的一部分，键是中文原文 */
export const EN_SHARED: Record<string, string> = {
  '开始执行计划（{name}）：{input}': 'Starting plan ({name}): {input}',
  按工作流走一遍: 'run through the workflow',
  '找不到要执行的工作流：{id}': 'Workflow to run not found: {id}',
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
  '<任务描述>': '<task>',

  // data.ts：数据分类
  配置: 'Configuration',
  '设置、角色、工作流和分类': 'Settings, roles, workflows and categories',
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
  'Agent 默认': 'Agent default',
  '{tier}档 · {model}': '{tier} tier · {model}',

  // schema.ts
  名称不能为空: 'Name is required',
  配置项名不能为空: 'Setting name is required',
  '配置项名只能用字母、数字、下划线和横线': 'Setting names may only use letters, digits, underscores and hyphens',
  分类名不能为空: 'Category name is required',
  请描述任务: 'Please describe the task',
  内容不能为空: 'Content is required',
  标题不能为空: 'Title is required',
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
  '「{title}」没有可执行的角色，请先给工作流选择主角色':
    '"{title}" has no role to run it. Choose a main role for the workflow first',
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
  '{nodes}执行失败，原因见节点里的错误。可以点「继续流程」重试，或者在下面输入新的要求。':
    '{nodes} failed. See the error in the node for details. Click "Continue flow" to retry, or enter new instructions below.',
  '已暂停。点「继续流程」从中断的地方接着做，或者在下面输入新的要求。':
    'Paused. Click "Continue flow" to pick up where it left off, or enter new instructions below.',
  '点「继续执行」': 'Resume',
  '点「继续流程」': 'Continue flow',
  '这一轮被中断：{reason}。{next}从中断的地方接着做，或者在下面输入新的要求。':
    'This turn was interrupted: {reason}. {next} to pick up where it left off, or enter new instructions below.',
  '工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线':
    'No node in the main flow is connected to "Start" yet. Draw a connection from "Start" in the flow chart first',
  '工作流不存在，可能已被删除': 'The workflow does not exist. It may have been deleted',
  '这次执行已经花了 ${used}，达到工作流设定的上限 ${limit}，已暂停。点「继续执行」会再给一份同样的额度。':
    'This run has spent ${used}, reaching the workflow limit of ${limit}, so it is paused. Click "Continue" to grant the same amount again.',
  '这次执行已经用了 {used} token，达到工作流设定的上限 {limit}，已暂停。点「继续执行」会再给一份同样的额度。':
    'This run has used {used} tokens, reaching the workflow limit of {limit}, so it is paused. Click "Continue" to grant the same amount again.',
  '「{title}」没有写「结论」，按通过处理。': '"{title}" did not state a verdict; treating it as a pass.',
  '主角色评估「{title}」：通过，走「{branch}」分支': 'Main role reviewed "{title}": pass, taking the "{branch}" branch',
  '主角色评估「{title}」：通过': 'Main role reviewed "{title}": pass',
  '。交代后续：{note}': '. Note for the next nodes: {note}',
  '主角色把「{title}」退回修改：{feedback}': 'Main role sent "{title}" back for changes: {feedback}',
  '（没有写具体意见）': '(no specific feedback)',
  '主角色把「{title}」相关的事委派给工作流「{workflow}」':
    'Main role delegated work on "{title}" to the workflow "{workflow}"',
  '主角色停下了流程：{reason}': 'Main role stopped the flow: {reason}',
  '（没有写原因）': '(no reason given)',
  '主角色起了新的一次运行：{input}': 'Main role started a new run: {input}',
  按流程图再走一遍: 'go through the flow again',
  '主角色重做这次运行：{feedback}': 'Main role is redoing this run: {feedback}',
  '（没有写具体原因）': '(no specific reason)',
  '主角色直接回答，没有起运行': 'Main role answered directly without starting a run',
  '主角色起了第 {n} 次运行：{input}': 'Main role started run {n}: {input}',
  这次要求: 'This request',
  第一条要求: 'First request',
  '主角色评估「{title}」失败：{error}': 'Main role failed to review "{title}": {error}',
  '主角色没有写调度决定，「{title}」按通过处理。': 'Main role did not write a decision; treating "{title}" as a pass.',
  '主角色退回「{title}」{n} 次后仍不满意：{feedback}':
    'Main role is still not satisfied after sending "{title}" back {n} times: {feedback}',
  '「{title}」委派的工作流「{name}」失败：{error}': 'The workflow "{name}" delegated from "{title}" failed: {error}',
  '主角色整理结果失败：{error}': 'Main role failed to write the final result: {error}',
  '「{title}」派出 {n} 个子角色：{list}': '"{title}" started {n} sub-roles: {list}',
  '「{title}」在原来的子任务里重试：{list}': '"{title}" is retrying in the original subtasks: {list}',
  '「{title}」{note}': '{title}: {note}',
  '已转交父对话创建「{title}」{id}': 'Handed "{title}" to the parent conversation{id}',
  '（id: {id}）': ' (id: {id})',
  已转交父对话: 'Handed to the parent conversation',
  '转交父对话创建：{list}（结果交回父对话，这个对话不用等）':
    'Handed to the parent conversation: {list} (the result goes back to the parent; this conversation does not wait)',
  '没能转交：{list}': 'Could not hand over: {list}',
  '「{title}」向主角色提问：{question}': '"{title}" asked the main role: {question}',
  委派: 'Delegated',
  'Kimi（月之暗面）': 'Kimi (Moonshot)',
  '智谱 GLM': 'GLM (Zhipu)',
  '通义千问（阿里云百炼）': 'Qwen (Alibaba Bailian)',
  '豆包（火山方舟）': 'Doubao (Volcano Ark)',
  腾讯混元: 'Tencent Hunyuan',
  百度千帆: 'Baidu Qianfan',
  硅基流动: 'SiliconFlow',
  'Ollama（本机）': 'Ollama (local)',
  '，在父对话中执行': ', runs in parent',
  自己: 'self',
  '（第 {n} 次，按最后一次算）': ' (attempt {n}, last one counts)',
}
