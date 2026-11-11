/** 英文词典的一部分，键是中文原文：设置页「钩子」、钩子规范的校验提示（ADR 0049） */
export const EN_HOOKS: Record<string, string> = {
  名称不能为空: 'Name is required',
  脚本不能为空: 'Script is required',
  地址不对: 'Invalid URL',
  没做完不收尾: "Don't stop half-done",
  压缩后补回计划: 'Restore the plan after compaction',
  '压缩上下文之后，把当前计划和进度、派单的目标、在等什么补给模型，免得它忘了做到哪':
    'After the context is compacted, give the model the current plan and progress, the task goal, and what it is waiting on, so it does not lose its place',
  只读身份守卫: 'Read-only guard',
  '调研、评审、排查分析这类只读的角色，以及只统筹不动手的父对话，要改文件时直接拒绝并说明原因；项目 .tmp/ 和系统临时目录里的临时文件放行':
    'Refuse file edits from read-only roles (research, review, root-cause analysis) and from parent conversations that only coordinate, and say why. Temp files in the project .tmp/ folder or the system temp folder are allowed',
  临时文件位置守卫: 'Temp file location guard',
  '往盘符根目录、面板的数据目录里写文件时拒绝，说明临时文件该放到项目的 .tmp/ 或系统临时目录':
    "Refuse writes to a drive's root folder or the panel's data folder, and point temp files to the project's .tmp/ or the system temp folder",
  改文件后推送教训: 'Share lessons after editing',
  '第一次改到某个文件时，把项目教训里管这个文件的几条补给模型':
    'The first time a file is edited, give the model the project lessons that cover that file',
  '输出要是一个 JSON 对象': 'The output must be a JSON object',
  '{event} 不支持这些字段：{list}': '{event} does not support these fields: {list}',
  '{key} 要是字符串': '{key} must be a string',
  '拦住或拒绝时要写 reason，告诉模型为什么': 'When blocking or refusing, include a reason that tells the model why',
  没有这个内置钩子: 'No such built-in hook',
  没有钩子定义: 'Missing hook definition',
  事件不对: 'Invalid event',
  钩子: 'Hooks',
  '只有工具前、工具后的钩子能按工具、路径、命令匹配':
    'Only before-tool and after-tool hooks can match by tool, path, or command',
  '出错时拒绝只对工具前的钩子有效，其余事件出错都放行':
    'Refuse on error only applies to before-tool hooks; errors in other events always let it through',
  '里面像是写了真实的密钥：要用凭据就从环境变量读':
    'This looks like it contains a real secret. Read credentials from environment variables instead',
  '脚本有语法错误：{error}': 'The script has a syntax error: {error}',
  '这些 CLI 不支持这个事件，在它们的对话里不会触发：{list}':
    "These CLIs don't support this event, so it won't fire in their conversations: {list}",
  '试跑没通过：{error}': 'The trial run failed: {error}',
  '支持：{list}': 'Supported: {list}',
  '目前没有 CLI 支持这个事件': 'No CLI supports this event yet',
  '不支持：{list}（这些 CLI 的对话里不会触发）': "Not supported: {list} (won't fire in their conversations)",
  '已保存「{name}」，看过后在列表里打开': 'Saved "{name}". Turn it on in the list after reviewing it',
  '正在读取钩子…': 'Loading hooks…',
  '钩子在 Agent 执行到固定时刻自动运行：模型准备结束这一轮、调用工具前后、压缩上下文之后。只按工具、文件、计划这些事实判断，不读模型回复的文字。':
    "Hooks run automatically at fixed points while an agent works: when the model is about to end its turn, before and after tool calls, and after the context is compacted. They decide from facts like tools, files, and the plan, never from the text of the model's reply.",
  内置钩子: 'Built-in hooks',
  我的钩子: 'My hooks',
  新建钩子: 'New hook',
  脚本: 'Script',
  '让 AI 改写': 'Rewrite with AI',
  '还没有自己的钩子。新建一个，或者让 AI 按你的描述写一个':
    'No hooks of your own yet. Create one, or let AI write one from your description',
  最近触发: 'Recent runs',
  '{ms} 毫秒': '{ms} ms',
  还没有触发过: 'Nothing has run yet',
  '删除钩子「{name}」？': 'Delete the hook "{name}"?',
  '删掉后它不会再触发，脚本也一起删掉': 'It will stop running, and its script is deleted too',
  拦住: 'Blocked',
  补了说明: 'Added context',
  不表态: 'No opinion',
  编辑钩子: 'Edit hook',
  '例如：锁文件不要手改': "For example: don't hand-edit lock files",
  一句话说明它做什么: 'One sentence on what it does',
  '哪些 CLI': 'Which CLIs',
  '都不选表示全部；不支持这个事件的 CLI 不会触发：{list}':
    "None selected means all. CLIs that don't support this event won't fire it: {list}",
  哪些项目: 'Which projects',
  都不选表示全部: 'None selected means all',
  哪些角色: 'Which roles',
  改文件: 'Edit files',
  跑命令: 'Run commands',
  '读文件、搜索': 'Read and search',
  文件路径: 'File path',
  '相对项目根的通配，例如 src/**/*.ts': 'A glob relative to the project root, e.g. src/**/*.ts',
  命令开头: 'Command starts with',
  '例如 git push': 'e.g. git push',
  动作: 'Action',
  运行脚本: 'Run a script',
  '发 HTTP 请求': 'Send an HTTP request',
  'Node 脚本': 'Node script',
  'stdin 进一段 JSON，stdout 写一个 JSON 或什么都不写；要用密钥就从 process.env 读，不要写进脚本':
    'Reads JSON from stdin and writes a JSON object, or nothing, to stdout. Read secrets from process.env; never put them in the script',
  出错时: 'On error',
  '超时、退出码不是 0、输出不是 JSON 都算出错':
    "A timeout, a non-zero exit code, or output that isn't JSON all count as errors",
  放行: 'Let it through',
  '拒绝这次工具调用（只对工具前）': 'Refuse the tool call (before-tool only)',
  '试跑结果（{ms} 毫秒）': 'Trial run result ({ms} ms)',
  '不表态（放行）': 'No opinion (let it through)',
  '面板把同样的 JSON POST 过去，响应体按同样的格式读':
    'The panel POSTs the same JSON and reads the response body in the same format',
  '值只能引用环境变量：密钥不进钩子定义，也就不会跟着导出出去':
    'Values can only reference environment variables, so secrets stay out of the hook definition and out of exports',
  环境变量名: 'Environment variable',
  加一个请求头: 'Add a header',
  结束前: 'Before end',
  工具前: 'Before tool',
  工具后: 'After tool',
  压缩后: 'After compaction',
  '模型准备结束这一轮时；可以拦住，让它在同一轮里接着做':
    'When the model is about to end its turn; can block it and keep it going in the same turn',
  '工具执行前；可以拒绝这次调用，或补一段说明': 'Before a tool runs; can refuse the call or add context',
  '工具返回后；可以补一段说明': 'After a tool returns; can add context',
  '压缩上下文、续接之后；可以补一段说明': 'After the context is compacted or resumed; can add context',
  '用 AI 创建钩子': 'Create a hook with AI',
  '本机 Agent 按钩子规范写出定义和脚本，校验、试跑都通过才能保存；保存后默认关着，看过再打开':
    'A local agent writes the definition and script to the hook spec. It can only be saved after validation and a trial run pass, and it stays off until you turn it on',
  '说说想在什么时候做什么，例如：': 'Describe when it should run and what it should do, for example:',
  描述你想要的钩子: 'Describe the hook you want',
  生成的钩子会显示在这里: 'The generated hook will appear here',
  保存钩子: 'Save hook',
  '只读的评审角色不许跑 git commit': "Don't let the read-only review role run git commit",
  '改完 .ts 文件提醒模型跑类型检查': 'After editing a .ts file, remind the model to run the type check',
  '对话要结束时，如果计划还有没做完的步骤就拦住':
    'When a conversation is about to end, block it if the plan still has unfinished steps',
  '正在校验并试跑一次…': 'Validating and doing a trial run…',
  校验和试跑都通过了: 'Validation and trial run passed',
  '超过 {n} 秒没跑完': "Didn't finish within {n} seconds",
  '退出码 {code}': 'Exit code {code}',
  '输出不是 JSON：{text}': "Output isn't JSON: {text}",
  '面板的钩子没能在 Codex 里生效（{error}），这一轮改用一轮结束后的提醒':
    "The panel's hooks couldn't be enabled in Codex ({error}); this turn falls back to the end-of-turn reminder",
  对话完成: 'Conversation done',
  对话失败: 'Conversation failed',
  计划完成一步: 'Plan step done',
  计划任务跑完: 'Scheduled task finished',
  '对话完成一轮时；只通知，输出不看': 'When a conversation finishes a turn; notify only, output is ignored',
  '对话执行失败时；只通知，输出不看': 'When a conversation fails; notify only, output is ignored',
  '对话停下来等你回复或确认时；只通知，输出不看':
    'When a conversation stops to wait for your reply or approval; notify only, output is ignored',
  '子对话请父对话收尾时；只通知，输出不看':
    'When a child conversation asks its parent to wrap up; notify only, output is ignored',
  '计划里的某一步做完时；只通知，输出不看': 'When a plan step is done; notify only, output is ignored',
  '计划任务成功启动、启动失败、错过或上游没成功时；只通知，HTTP 钩子失败会重试，结果记在计划上':
    'When a scheduled task starts, fails to start, is missed, or is blocked upstream; notify only. HTTP hooks are retried on failure and the result is recorded on the schedule',
  '已并入「钩子」': 'Moved into Hooks',
  '在「钩子」里新建一个「计划任务跑完」事件的 HTTP 钩子：计划成功启动、启动失败、错过或上游没成功时 POST 结果，失败最多重试 {n} 次。以前填的地址已经自动迁过去了。':
    'Create an HTTP hook on the "Scheduled task finished" event in Hooks: the result is POSTed when a schedule starts, fails to start, is missed, or is blocked upstream, retried at most {n} times. A URL you set before has been moved there automatically.',
  去钩子: 'Open Hooks',
  '计划任务 Webhook': 'Scheduled task webhook',
  '从设置里原来的「计划 Webhook」迁过来：计划任务跑完时把结果 POST 到这个地址':
    'Moved from the old "Schedule webhook" setting: POSTs the result to this URL when a scheduled task finishes',
  '「{name}」的参数': 'Parameters of "{name}"',
  内置钩子的开关: 'Built-in hook switches',
  '所有项目（全局）': 'All projects (global)',
  '只在「{name}」': 'Only in "{name}"',
  '这个项目单独设的开关优先，没设的跟着全局': "This project's own switches win; the rest follow the global ones",
  '跟随全局（{state}）': 'Follow global ({state})',
  开: 'on',
  关: 'off',
  '面板这次启动以来最近 50 次钩子的运行（内置钩子只记拦下和补说明的）':
    'The last 50 hook runs since the panel started (built-in hooks are recorded only when they block or add context)',
  另外拦下的命令: 'Also block these commands',
  '计划没做完、子对话请求收尾还没处理、子对话做完了却没请父对话收尾、没列计划却做了一半就要结束时，在同一轮里拦住让它接着做（Chat 页一问一答不拦）':
    "Keeps the agent going in the same turn when the plan isn't done, a child's wrap-up request is unhandled, a finished child hasn't asked its parent to wrap up, or work stopped halfway without a plan (not on the Chat page)",
  '只读角色另外不许跑的命令前缀，一行一个，例如 make deploy':
    'Extra command prefixes read-only roles may not run, one per line, e.g. make deploy',
  推送授权守卫: 'Push authorization guard',
  '按项目的「推送到远端」设置和这个对话的授权拦 git push、合并 PR：没授权先让它调 ask_push，用户拒绝过、项目不推送、子对话和子任务都直接拒绝并说明原因':
    'Checks git push and PR merges against the project\'s "Push to remote" setting and this conversation\'s authorization: without authorization it must call ask_push first; refused pushes, no-push projects, child conversations and subtasks are denied with the reason',
  'Bug 先诊断守卫': 'Diagnose-first guard',
  '父对话派来的 Bug：诊断报告还没被用户确认就改文件、或者改到确认方案以外的文件时拒绝，免得改完收尾时才被打回':
    'For bugs handed down by a parent: denies edits before the diagnosis is approved, or to files outside the approved plan, so the work is not rejected at wrap-up',
  危险命令守卫: 'Dangerous command guard',
  '拦下不可挽回的命令：递归删除根目录、家目录、项目、面板数据目录，原分支上 reset --hard / clean / 撤销整个工作区，强推，删主干分支':
    'Blocks irreversible commands: recursive deletes of the root, home, project or panel data directory; reset --hard / clean / reverting the whole working tree on the original branch; force pushes; deleting the main branch',
  '另外当成危险命令拦下的命令前缀，一行一个，例如 docker system prune':
    'Extra command prefixes to block as dangerous, one per line, e.g. docker system prune',
  长命令转后台: 'Long commands to background',
  '完整测试、端到端、界面检查、开发服务器、UE 编译打包、整份装依赖、从项目根起的全项目 grep -r 这类长命令放在前台跑时拒绝，让它交给面板的后台命令，执行中发来的消息不用等它跑完':
    "Denies full test suites, end-to-end and UI checks, dev servers, UE builds and packaging, full dependency installs, and whole-project grep -r scans from the project root in the foreground and has them run as the panel's background commands, so messages sent meanwhile don't wait",
  另外算长命令的命令前缀: 'Extra long-command prefixes',
  '一行一个，例如 npm run build、cargo test': 'One per line, e.g. npm run build, cargo test',
  测试步骤归属守卫: 'Test step ownership guard',
  '项目里设成「合回后由父对话跑」的测试步骤，子对话在独立分支里跑时拒绝':
    'Denies test steps the project runs in the parent after merging when a child runs them in its own branch',
  凭据守卫: 'Credential guard',
  '往项目文件里写像是真实密钥、令牌、私钥的内容时拒绝，让它改成从环境变量读；本机的 .env 这类文件放行':
    'Denies writing what looks like a real key, token or private key into project files and asks for environment variables instead; local files like .env are allowed',
  可以写凭据的文件: 'Files that may hold credentials',
  '相对项目根的路径通配，一行一个；.env、.env.* 已经放行':
    'Path globs relative to the project root, one per line; .env and .env.* are already allowed',
  独立分支越界守卫: 'Branch boundary guard',
  '子对话在自己的独立分支里，要改分支目录以外的文件（比如原仓库里的）时拒绝':
    "Denies a child working in its own branch editing files outside that branch's directory (such as the original repository)",
  另外允许写的目录: 'Also allowed directories',
  '绝对路径，一行一个': 'Absolute paths, one per line',
  没有这个参数: 'No such parameter',
  '要是 1 到 100 之间的整数': 'Must be a whole number from 1 to 100',
  '各 CLI 的事件': 'Events per CLI',
  '{event}要 {min} 以上': '{event} needs {min} or later',
  '本机版本 {v}': 'Installed version {v}',
  还没检测到版本: 'Version not detected yet',
  '这个 CLI 没有能装的钩子事件，只有一轮结束后的提醒兜底':
    'This CLI has no hook events to install; only the end-of-turn reminder applies',
  '版本太老，这些事件不装：{list}': 'Version too old, these events are not installed: {list}',
  原地打转提醒: 'Going-in-circles hint',
  '同一条命令连续失败几次时，补一句让它换个思路或者说明卡在哪（要 CLI 报得出失败：Claude Code、Pi、Command Code）':
    'When the same command fails several times in a row, adds a note to try another approach or say where it is stuck (needs a CLI that reports failures: Claude Code, Pi, Command Code)',
  连续失败几次提醒: 'Failures in a row before the hint',
  '1 到 100，默认 3': '1 to 100, default 3',
  计划没跟上提醒: 'Plan falling behind hint',
  '项目里的对话改文件、跑命令时，计划没有进行中的步骤，或者进行中的那一步动手多次还没更新，补一句让它先用 set_plan 标完成、标下一步（同一步提醒几次可以设置）':
    'When a project conversation edits files or runs commands while its plan has no step in progress, or the step in progress has gone many actions without an update, adds a note to mark it done and start the next one with set_plan first (how many times per step is configurable)',
  动手几次没更新就提醒: 'Actions without a plan update before the hint',
  '1 到 100，默认 20；超过 3 分钟没更新时，到三分之一就提醒':
    '1 to 100, default 20; after 3 minutes without an update, a third of that is enough',
  同一步最多提醒几次: 'Most hints per step',
  '1 到 100，默认 1；提醒过后再动手到上面的次数才提醒下一次':
    '1 to 100, default 1; after a hint, the next one comes only after that many more actions',
  改完没验证: 'Edited but not verified',
  '这条消息以来改过文件，之后却一条命令都没跑就要结束时，拦一次让它跑一下检查（或说明为什么不用跑）':
    'When files were edited since this message but no command ran afterwards, blocks once so it runs a check (or explains why none is needed)',
  面板工具: 'Panel tools',
  工具名: 'Tool name',
  '面板工具的名字，例如 submit_merge': 'Name of the panel tool, e.g. submit_merge',
}
