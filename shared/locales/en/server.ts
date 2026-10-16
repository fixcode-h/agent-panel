/** 英文词典的一部分，键是中文原文 */
export const EN_SERVER: Record<string, string> = {
  // 生成 Agent / 工作流
  '格式不对，已让 CLI 修正。': 'Output was malformed; asked the CLI to fix it.',
  已停止: 'Stopped',
  '超过 5 分钟没有完成，已停止': 'Stopped after not finishing within 5 minutes',
  '{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。':
    '{error}. Make sure {cli} is installed ({hint}), or set its path in Settings.',
  '{cli} 执行失败：{detail}': '{cli} failed: {detail}',
  没有更多信息: 'No further details',
  '{cli} 两次都没有按格式输出：{error}': '{cli} returned malformed output twice: {error}',
  '未知的 CLI：{cli}': 'Unknown CLI: {cli}',
  '{cli} 在设置里被停用了': '{cli} is disabled in Settings',
  '要优化的 Agent 不存在': 'The Agent to refine no longer exists',
  要优化的工作流不存在: 'The workflow to refine no longer exists',
  '找不到这次生成，可能已过期': 'Generation not found; it may have expired',
  找不到这次生成: 'Generation not found',

  // 数据导入导出
  '有任务正在执行，等它们结束后再操作': 'Tasks are running. Try again after they finish.',
  这类数据不能清理: 'This kind of data can’t be cleared',
  请选择要导出的数据: 'Select data to export',
  '不是 Agent 面板导出的数据文件': 'Not a data file exported from Agent Panel',
  '数据文件里有不认识的路径：{path}': 'Unrecognized path in data file: {path}',

  // 检测 / 模型列表
  检测超时: 'Detection timed out',
  '退出码 {code}': 'Exit code {code}',
  未知错误: 'Unknown error',
  'ChatGPT 账号': 'ChatGPT account',
  'Codex 返回错误：{error}': 'Codex returned an error: {error}',
  'Codex 没有在 20 秒内返回模型列表': 'Codex didn’t return the model list within 20 seconds',
  'Codex 退出了（退出码 {code}）': 'Codex exited (exit code {code})',
  '默认模型（config.toml）': 'Default model (config.toml)',
  '审查用的模型（review_model）': 'Review model (review_model)',
  'Command Code 账号': 'Command Code account',
  '环境变量 ANTHROPIC_MODEL': 'ANTHROPIC_MODEL environment variable',
  'opus 对应的模型': 'Model used for opus',
  'sonnet 对应的模型': 'Model used for sonnet',
  'haiku 对应的模型': 'Model used for haiku',
  'settings.json 里的默认模型': 'Default model in settings.json',
  'settings.json / 环境变量': 'settings.json / environment variables',

  // Codex 沙箱和权限请求
  'Codex 的 Windows 沙箱初始化失败（{reason}），命令和改文件都无法执行。可以在终端里运行一次 codex 按提示完成沙箱设置，或在设置里把 Codex 的权限改成「完全访问」。':
    'Codex’s Windows sandbox failed to initialize ({reason}), so it can’t run commands or edit files. Run codex once in a terminal and follow the prompts to set up the sandbox, or set Codex’s permission to “Full access” in Settings.',
  启动会话失败: 'Failed to start session',
  '无法续接之前的会话（thread not found）：{error}': 'Couldn’t resume the previous session (thread not found): {error}',
  '运行命令：{cmd}': 'Run command: {cmd}',
  运行一条需要越过沙箱的命令: 'Run a command outside the sandbox',
  '目录：{dir}': 'Directory: {dir}',
  '允许写入目录：{dir}': 'Allow writing to directory: {dir}',
  修改沙箱以外的文件: 'Edit files outside the sandbox',
  联网: 'network access',
  '访问 {paths}': 'access to {paths}',
  '、': ', ',
  '，': ', ',
  '需要额外权限：{what}': 'Needs extra permissions: {what}',
  越过沙箱: 'bypass the sandbox',
  有一个问题需要你回答: 'A question needs your answer',
  '写入文件：{file}': 'Write file: {file}',
  '修改文件：{file}': 'Edit file: {file}',
  '访问网页：{url}': 'Fetch web page: {url}',
  '使用工具：{name}': 'Use tool: {name}',

  // 工具调用
  被拒绝: 'Denied',
  新建: 'New',
  删除: 'Delete',
  修改: 'Edit',
  写入: 'Write',
  失败: 'Failed',
  工具: 'Tool',
  网页搜索: 'Web search',
  查看图片: 'View image',
  查找文件: 'Find files',
  打开网页: 'Open web page',
  待办: 'Todos',
  更新待办清单: 'Update todo list',
  '{n} 项': '{n} items',
  命令: 'Command',
  '（还有 {n} 个字符没有显示）': '({n} more characters not shown)',

  // 执行
  执行出错: 'Execution error',
  已中断: 'Interrupted',
  'Codex 没有完成这一轮就退出了': 'Codex exited before finishing the turn',
  '找不到命令「{cmd}」': 'Command not found: “{cmd}”',
  解析输出出错: 'Output parse error',
  '你回答了「{title}」：{answer}': 'You answered “{title}”: {answer}',
  '你允许了：{title}': 'You allowed: {title}',
  '你拒绝了：{title}': 'You denied: {title}',
  ' 或 ': ' or ',
  '· 模型「{model}」走的是 Command Code 官方服务，不是你在 providers.json 里接的接口。想用自己的接口，请把模型换成「{alt}」（模型下拉的「配置文件」分组里）。':
    '· Model “{model}” is routed through Command Code’s own service, not the provider you set up in providers.json. To use your own provider, switch the model to “{alt}” (under the “Config file” group in the model dropdown).',
  '· 和模型服务的连接中途断开了。常见于一次要输出很长的内容（例如写入一个大文件）时，连接被服务端或代理断开；可以点「继续执行」重试，或者换一个接口、让 Agent 分几次写。':
    '· The connection to the model service dropped. This often happens when a single response is very long (such as writing a large file) and the server or a proxy cuts the connection. Click “Resume” to retry, switch to another provider, or have the Agent write in smaller pieces.',
  '找不到执行这一步的 Agent，可能已被删除': 'The Agent for this step wasn’t found; it may have been deleted',
  'Agent「{name}」已停用': 'Agent “{name}” is disabled',
  '项目目录不存在：{dir}': 'Project directory doesn’t exist: {dir}',
  '（未设置）': '(not set)',
  '<角色设定>': '<instructions>',
  '超过 {n} 分钟没有完成，已停止': 'Stopped after not finishing within {n} minutes',
  '{error}。请确认已安装 {cli}（{hint}），或在设置里填写可执行文件的完整路径。':
    '{error}. Make sure {cli} is installed ({hint}), or set the full path to its executable in Settings.',
  '{cli} 执行失败（退出码 {code}），自动续接 {n} 次后仍然失败：':
    '{cli} failed (exit code {code}), still failing after {n} automatic resumes:',
  '{cli} 执行失败（退出码 {code}）：': '{cli} failed (exit code {code}):',
  '{cli} 执行失败，自动续接 {n} 次后仍然失败：': '{cli} failed, still failing after {n} automatic resumes:',
  '{cli} 执行失败：': '{cli} failed:',
  '原始输出：': 'Raw output:',

  // 本地目录
  主目录: 'Home',

  // 接口校验
  只接受来自本机的访问: 'Only local access is allowed',
  不接受其他网站发来的请求: 'Requests from other sites are not accepted',
  '请求必须是 JSON': 'Request body must be JSON',
  分类不存在: 'Category not found',
  '主 Agent 不存在': 'Main Agent not found',
  工作流至少要有一个流程: 'A workflow needs at least one flow',
  '流程 id 重复': 'Duplicate flow id',
  '流程「{flow}」里有重复的节点 id': 'Flow “{flow}” has duplicate node ids',
  '流程「{flow}」的节点 id 不能是 start / end': 'Node ids in flow “{flow}” can’t be start / end',
  '流程「{flow}」里的节点连成了环：{cycle}，执行时会一直等不到上游':
    'Nodes in flow “{flow}” form a cycle: {cycle}. They would wait on their upstream forever.',
  '流程之间循环调用：{cycle}': 'Flows call each other in a loop: {cycle}',
  '分类「{name}」已存在': 'Category “{name}” already exists',
  'Agent 不存在': 'Agent not found',
  '默认 Agent 是自带的，不能删除': 'The default Agent is built in and can’t be deleted',
  '正在被工作流使用：{names}，请先从工作流中移除': 'Used by workflows: {names}. Remove it from them first.',
  '「{name}」': '“{name}”',
  工作流不存在: 'Workflow not found',
  '项目分类「{name}」': 'project category “{name}”',
  '项目「{name}」': 'project “{name}”',
  '正在被使用：{names}，请先改用其他工作流': 'In use by {names}. Switch them to another workflow first.',
  项目分类不存在: 'Project category not found',
  项目不存在: 'Project not found',
  这个项目还没有选择目录: 'No directory selected for this project yet',
  '无法读取项目文件：{error}': 'Couldn’t read project files: {error}',
  '目录不存在：{dir}': 'Directory doesn’t exist: {dir}',
  '无法读取目录：{error}': 'Couldn’t read directory: {error}',

  // 安装 / 卸载 CLI
  '没有权限写入安装目录。请用管理员身份打开终端运行下面的命令。':
    'No permission to write to the install directory. Open a terminal as administrator and run the command below.',
  '没有权限写入 npm 的全局目录。可以在终端里用 sudo 运行下面的命令，或者把 npm 的全局目录改到自己的用户目录下。':
    'No permission to write to npm’s global directory. Run the command below with sudo in a terminal, or move npm’s global directory into your user folder.',
  '连不上 npm 仓库，请检查网络或代理（可以在终端里设置 npm 镜像）后重试。':
    'Can’t reach the npm registry. Check your network or proxy (you can set an npm mirror in a terminal) and try again.',
  '安装失败，详细信息见下面的输出。': 'Install failed. See the output below for details.',
  '卸载失败，详细信息见下面的输出。': 'Uninstall failed. See the output below for details.',
  'del "{bin}" 并删除 "{data}"': 'del "{bin}" and delete "{data}"',
  已删除: 'Deleted',
  'PATH 里先找到的是 {path}（{version}），已改用 npm 安装的 {npm}。':
    '{path} ({version}) comes first on PATH; switched to the npm-installed {npm}.',
  旧版本: 'older version',
  '没有找到 brew。': 'brew not found.',
  '没有找到 npm。请先安装 Node.js（https://nodejs.org），它自带 npm。':
    'npm not found. Install Node.js first (https://nodejs.org); it includes npm.',
  '超过 10 分钟还没有完成，已停止。可以复制下面的命令到终端里运行。':
    'Stopped after 10 minutes without finishing. You can copy the command below and run it in a terminal.',
  '已经执行了卸载，但还能找到 {path}。它不是 npm 、Homebrew 或官方安装脚本装的，请手动删除这个文件，或用安装它的方式卸载。':
    'Uninstall ran, but {path} is still there. It wasn’t installed by npm, Homebrew or the official install script; delete it manually or uninstall it the way it was installed.',
  '安装完成，但还找不到「{command}」。可能需要重新打开终端或重启本服务让 PATH 生效，或者在下面填写可执行文件的完整路径。':
    'Installed, but “{command}” still can’t be found. You may need to reopen your terminal or restart this server for PATH to update, or enter the full path to the executable below.',
  '更新命令执行完了，但运行的 {path} 还是 {version}。可能还有另一份旧的装在别处，请在下面的「可执行文件」里填新版本的完整路径。':
    'The update command finished, but {path} is still {version}. An older copy may be installed elsewhere; enter the full path to the new version under “Executable” below.',
  '未知的 CLI': 'Unknown CLI',
  '有一个安装 / 卸载还在进行，请等它完成': 'An install / uninstall is in progress. Wait for it to finish.',
  查不到最新版本: 'Couldn’t find the latest version',
  没有这个操作: 'Operation not found',

  // 任务
  '面板关闭或重启时任务还在执行，已中断。点「继续执行」从中断的节点接着做（会续接那个节点的 CLI 会话）。':
    'The task was interrupted because the panel closed or restarted while it was running. Click “Resume” to pick up from the interrupted step (its CLI session will be resumed).',
  聊天: 'Chat',
  任务所属的项目已经不存在: 'The task’s project no longer exists',
  '执行出错：{error}': 'Execution error: {error}',
  任务不存在: 'Task not found',
  缺少项目: 'Project is required',
  '项目还没有指定工作流，请选择一个工作流或改用直接对话':
    'This project has no workflow yet. Choose a workflow or use direct chat instead.',
  '请选择对话的 Agent': 'Choose an Agent to chat with',
  '任务正在执行，请等它完成或先停止': 'The task is running. Wait for it to finish or stop it first.',
  任务正在执行: 'The task is running',
  只有失败或停止的任务可以继续: 'Only failed or stopped tasks can be resumed',
  这个请求已经结束了: 'This request has already ended',

  // 更新面板
  'GitHub 返回 {status}（访问太频繁，稍后再试）': 'GitHub returned {status} (rate limited, try again later)',
  'GitHub 返回 {status}': 'GitHub returned {status}',
  下载中: 'Downloading',
  '下载失败：{status}': 'Download failed: {status}',
  解压中: 'Extracting',
  '解压失败：{error}': 'Extraction failed: {error}',
  '包里缺少 server.mjs 或 dist，可能下载不完整':
    'The package is missing server.mjs or dist; the download may be incomplete',
  替换文件: 'Replacing files',
  正在重启: 'Restarting',
  '检查更新失败：{error}': 'Failed to check for updates: {error}',
  '从源码运行时请用 git 更新，只有发布的包能在这里更新':
    'Running from source: update with git. Only released packages can update here.',
  '正在更新，请稍等': 'Update in progress, please wait',
  '有任务正在执行，请等它完成或先停止再更新':
    'Tasks are running. Wait for them to finish or stop them before updating.',
  '读取版本列表失败：{error}': 'Failed to load releases: {error}',
  '找不到版本 {tag}': 'Version not found: {tag}',
  准备中: 'Preparing',
  找不到这次更新: 'Update not found',

  // 附件
  上传的内容不对: 'Invalid upload',
  '「{name}」超过 {size} MB': '“{name}” exceeds {size} MB',
  不是附件: 'Not an attachment',
  附件已经不在了: 'The attachment no longer exists',
  '工作流已经被删除，只能按任务创建时的工作流继续':
    'The workflow was deleted; you can only resume with the workflow the task was created with',
  这条要求已经开始处理了: 'This message is already being handled',
  这个文件不在任务的改动里: "This file is not among the task's changes",
  '任务正在执行，等它停下后再撤销': 'The task is running; revert after it stops',
  '项目不是 git 仓库，没法知道改动前的内容，不能自动撤销':
    'The project is not a git repository, so the original content is unknown and the change cannot be reverted automatically',
  '这个文件在任务开始前就有没提交的改动，撤销会一起丢掉，请在编辑器里手动处理':
    'This file had uncommitted changes before the task started, and reverting would discard them too. Please handle it in your editor',
  '撤销失败：{error}': 'Revert failed: {error}',
  文件不在项目目录里: 'The file is not inside the project directory',
  恢复失败: 'Restore failed',
  '…（差异太长，只显示前面一部分）': '… (the diff is too long; only the beginning is shown)',
}
