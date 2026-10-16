/** 英文词典的一部分，键是中文原文 */
export const EN_SETTINGS: Record<string, string> = {
  // 设置弹窗与分类
  设置: 'Settings',
  设置分类: 'Settings sections',
  关闭设置: 'Close settings',
  常规: 'General',
  项目分类: 'Project categories',
  '默认 CLI': 'Default CLI',
  'AI 创建': 'Create with AI',
  数据: 'Data',
  版本更新: 'Updates',
  已接入: 'Connected',
  拖动调整顺序: 'Drag to reorder',
  '拖动调整顺序，或按 Alt + ↑ / ↓': 'Drag to reorder, or press Alt + ↑ / ↓',
  默认: 'Default',
  '超时时间需要是 0 到 1440 的整数': 'Timeout must be a whole number from 0 to 1440',

  // 常规
  '在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 CLI。':
    'The online demo has no local environment, so task output is sample data. Download and run it locally to call real CLIs.',
  单个步骤最长运行时间: 'Max run time per step',
  '分钟，填 0 不限制。超时后会停止这一步，任务标记为失败。':
    'In minutes; 0 means no limit. A step that times out is stopped and the task is marked as failed.',
  '单个步骤最长运行时间（分钟）': 'Max run time per step (minutes)',
  '填 0 到 1440 之间的整数，0 表示不限制': 'Enter a whole number from 0 to 1440; 0 means no limit',
  '界面显示的语言，切换后页面会重新加载。': 'The interface language. The page reloads after you switch.',
  语言: 'Language',
  '跟随浏览器 · Auto': 'Follow browser · Auto',
  内容宽度: 'Content width',
  '项目首页的输入框和任务列表、任务页的对话和工作流节点都用这个宽度，窗口窄时自动缩小。':
    'Used by the input box and task list on the project home, and by the conversation and workflow nodes on the task page. Shrinks automatically in narrow windows.',
  恢复默认: 'Reset to default',
  启动后打开浏览器: 'Open browser on startup',
  '启动面板服务后，自动用默认浏览器打开 http://127.0.0.1:8787。':
    'Open http://127.0.0.1:8787 in your default browser when the panel server starts.',
  任务完成时通知我: 'Notify me when tasks finish',
  '页面不在前台时，任务完成或失败会弹出系统通知。需要浏览器允许通知。':
    'Show a system notification when a task finishes or fails while the page is in the background. Requires browser notification permission.',
  '浏览器没有允许通知，可以在地址栏左侧的网站设置里打开':
    'Notifications are blocked by the browser. You can allow them in the site settings next to the address bar.',

  // 默认 CLI
  'Agent 可以不指定 CLI，选「系统默认」时用这里的 CLI；模型可以只选高、中、低一档，执行时换成那个 CLI 对应档位的模型和思考强度。改这里就能让所有用默认设置的 Agent 一起切换。':
    'Agents can leave the CLI unset: "System default" uses the CLI chosen here. A model can be just a High, Medium or Low tier, which resolves to that CLI\'s model and effort for the tier at run time. Changing this switches every Agent that uses the defaults.',
  'Agent 选了「系统默认」或没有指定 CLI 时使用': 'Used when an Agent picks "System default" or has no CLI set',
  已停用: 'Disabled',
  未安装: 'Not installed',
  '{cli} 的模型': '{cli} models',
  '跟随 {cli} 自己的档位设置，要改请到': "Follows {cli}'s own tier settings. To change them, go to",
  '里修改。': 'settings.',
  'Agent 没有指定模型时使用，跟随 {cli} 的设置': "Used when an Agent has no model set. Follows {cli}'s settings",
  'Agent 和档位都没有指定时使用，跟随 {cli} 的设置':
    "Used when neither the Agent nor the tier sets one. Follows {cli}'s settings",

  // 单个 CLI
  系统默认: 'System default',
  '检测中…': 'Detecting…',
  '已安装 · {version}': 'Installed · {version}',
  '没有检测到：{error}': 'Not detected: {error}',
  安装: 'Install',
  '当前 {current}，npm 上最新是 {latest}': 'Current {current}, latest on npm is {latest}',
  更新中: 'Updating',
  '更新到 {tag}': 'Update to {tag}',
  卸载: 'Uninstall',
  重新检测: 'Detect again',
  '启用 {cli}': 'Enable {cli}',
  '点「安装」用 npm 安装，或者在终端里运行': 'Click "Install" to install with npm, or run in a terminal',
  '自己装好后点右边的刷新重新检测。': 'After installing it yourself, click refresh on the right to detect again.',
  '卸载 {cli}？': 'Uninstall {cli}?',
  会运行: 'This runs',
  '。用这个 CLI 的 Agent 之后都无法执行，直到重新安装。登录信息和它自己的配置不会被删除。':
    ". Agents that use this CLI can't run until it's reinstalled. Sign-in info and its own config are kept.",
  '有任务正在用它执行，请等任务完成或先停止。':
    'A task is running with it. Wait for the task to finish or stop it first.',
  模型: 'Model',
  三档模型: 'Model tiers',
  'Agent 选了高、中、低档时使用的模型和思考强度。模型留空时跟随下面的默认模型，没设默认模型时用建议值。':
    'The model and effort used when an Agent picks the High, Medium or Low tier. An empty model follows the default model below, or the suggested one if no default is set.',
  默认模型: 'Default model',
  'Agent 没有指定模型时使用，可以选一个档位': 'Used when an Agent has no model set. Can be a tier',
  默认思考强度: 'Default effort',
  'Agent 和档位都没有指定时使用': 'Used when neither the Agent nor the tier sets one',
  '{cli} 默认模型': '{cli} default model',
  '{cli} 默认思考强度': '{cli} default effort',
  运行: 'Execution',
  权限: 'Permissions',
  '{cli} 权限': '{cli} permissions',
  可执行文件: 'Executable',
  '留空时从 PATH 查找 {command}': 'Leave empty to look up {command} in PATH',
  额外参数: 'Extra arguments',
  '每次调用都会追加，Agent 自己的参数排在后面': "Appended to every call; the Agent's own arguments come after",
  '例如 --add-dir ../shared': 'e.g. --add-dir ../shared',
  环境变量: 'Environment variables',
  '每行一个 KEY=VALUE，只传给这个 CLI': 'One KEY=VALUE per line, passed only to this CLI',
  '实际调用（任务描述从 stdin 传入）': 'Actual command (task description is passed via stdin)',

  // 模型列表来源
  '正在从本机 {cli} 读取可用的模型…': 'Reading available models from local {cli}…',
  '已用 {from} 登录，': 'Signed in with {from}. ',
  '已用账号登录，': 'Signed in with an account. ',
  '用的是 API 方式，下面是 {from} 里配置的模型，': 'Using an API key; the models below are configured in {from}. ',
  '用的是 API 方式，配置文件里没有写模型，': 'Using an API key; no models are set in the config file. ',
  '{how}已从本机 {cli} 读到 {n} 个可用模型。': '{how}Found {n} available models from local {cli}.',
  '下面是常用的型号，也可以直接填写模型名。': 'Below are common models, or you can type a model name.',
  '没能从 {cli} 读到模型列表（{error}），下面是内置的建议，也可以直接填写模型名。':
    "Couldn't read the model list from {cli} ({error}). Below are built-in suggestions, or you can type a model name.",
  '{cli} 没有列出模型的命令，下面是常用的型号，也可以直接填写完整的模型名。':
    '{cli} has no command to list models. Below are common models, or you can type a full model name.',
  '下面是内置的建议，也可以直接填写模型名。': 'Below are built-in suggestions, or you can type a model name.',

  // 档位表
  档位: 'Tier',
  思考强度: 'Effort',
  '{tier}档': '{tier} tier',
  '{cli} {tier}档模型': '{cli} {tier} tier model',
  '{cli} {tier}档思考强度': '{cli} {tier} tier effort',
  '（默认）': ' (default)',
  '自动（默认）': 'Auto (default)',

  // 安装 / 更新 / 卸载
  复制安装命令: 'Copy install command',
  '正在安装…': 'Installing…',
  '正在更新…': 'Updating…',
  '正在卸载…': 'Uninstalling…',
  安装完成: 'Installed',
  更新完成: 'Updated',
  卸载完成: 'Uninstalled',
  安装没有成功: 'Install failed',
  更新没有成功: 'Update failed',
  卸载没有成功: 'Uninstall failed',
  收起输出: 'Hide output',
  查看输出: 'Show output',
  关闭: 'Close',
  在终端里运行: 'Run in a terminal',
  '等待输出…': 'Waiting for output…',
  没有输出: 'No output',
  '{name} 已安装': '{name} installed',
  '{name} 已更新': '{name} updated',
  '{name} 已卸载': '{name} uninstalled',
  '{name} 安装失败': '{name} install failed',
  '{name} 更新失败': '{name} update failed',
  '{name} 卸载失败': '{name} uninstall failed',

  // AI 创建
  '在 Agent 和工作流页面可以用本机 CLI 对话生成或优化配置。CLI 按固定格式输出，面板校验通过后才能应用。':
    'On the Agent and Workflow pages, you can chat with a local CLI to generate or refine configs. The CLI replies in a fixed format, and changes apply only after the panel validates them.',
  '使用的 CLI': 'CLI',
  '默认用「CLI」里设为默认的那个': 'Defaults to the one set as default under "CLI"',
  'AI 创建使用的 CLI': 'CLI for AI assist',
  'AI 创建使用的模型': 'Model for AI assist',
  '默认用这个 CLI 设置里的默认模型': "Defaults to this CLI's default model",
  '创建 Agent 的补充规则': 'Extra rules for creating Agents',
  '会加进提示词，例如命名习惯、团队约定': 'Added to the prompt, e.g. naming habits or team conventions',
  '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的 Agent 默认用 Claude Code':
    'For example:\n- Every role definition has three sections: Responsibilities / Way of working / Deliverables\n- Frontend Agents use Claude Code by default',
  创建工作流的补充规则: 'Extra rules for creating Workflows',
  '例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮':
    'For example:\n- Every coding node gets a code review step\n- At most 2 review rounds',

  // 数据
  '面板的配置、项目、任务记录都保存在用户目录下，和 ~/.codex、~/.claude 一样，升级或换安装位置都不受影响。':
    "The panel's settings, projects and task history live in your home directory, like ~/.codex and ~/.claude, so upgrades or moving the install don't affect them.",
  打开: 'Open',
  占用: 'Usage',
  '共 {size}': '{size} total',
  '面板进程内存 {size}': 'Panel memory {size}',
  刷新占用: 'Refresh usage',
  '{n} 个文件': '{n} files',
  清理: 'Clear',
  '已清理{name}': 'Cleared {name}',
  '清理{name}？': 'Clear {name}?',
  迁移: 'Migrate',
  '导出成一个文件，在另一台电脑的设置里导入。导入时，文件里包含的每类数据会整体替换掉这里现有的。':
    'Export to a file, then import it in Settings on another computer. Each kind of data in the file fully replaces what is here.',
  导出数据: 'Export data',
  导入数据: 'Import data',
  '导入数据？': 'Import data?',
  '文件不是有效的 JSON': 'The file is not valid JSON',
  '已导入 {n} 个文件，正在刷新': 'Imported {n} files, reloading',
  '会删除所有项目和它们的任务记录。项目目录里的文件不会动。删除后不能恢复，需要的话先导出。':
    "Deletes all projects and their task history. Files in project folders are untouched. This can't be undone, so export first if needed.",
  '会删除所有任务记录，包括输出和用量。删除后不能恢复，需要的话先导出。':
    "Deletes all task history, including output and usage. This can't be undone, so export first if needed.",
  '会删除任务里附上的文件和图片，任务记录里的附件就打不开了。':
    'Deletes files and images attached to tasks. Attachments in task history will no longer open.',
  '会删除下载的更新包和损坏文件的备份。': 'Deletes downloaded update packages and backups of corrupted files.',
  '「{name}」包含：{kinds}。这些数据会整体替换成文件里的，导入后页面会刷新。':
    '"{name}" contains: {kinds}. This data will be fully replaced with the contents of the file, and the page will reload.',
  '、': ', ',

  // 版本更新
  预览版: 'Preview',
  正式版: 'Stable',
  '没有更新说明。': 'No release notes.',
  查看更新说明: 'View release notes',
  当前: 'Current',
  '下载 zip 包（约 {size}）': 'Download zip (about {size})',
  '下载 zip 包': 'Download zip',
  下载: 'Download',
  '下载并替换当前程序，数据会保留': 'Download and replace the current app; your data is kept',
  只有发布的包能在这里切换版本: 'Only released packages can switch versions here',
  更新到此版本: 'Update to this version',
  切换到此版本: 'Switch to this version',
  '在 GitHub 上查看': 'View on GitHub',
  当前版本: 'Current version',
  从源码运行: 'Running from source',
  检查更新: 'Check for updates',
  '已安装 v{version}，正在重启，完成后页面会自动刷新…':
    'Installed v{version}. Restarting; the page will reload when done…',
  '。可以稍后再试，或到': '. Try again later, or go to',
  '手动下载。': 'to download manually.',
  '正在检查…': 'Checking…',
  已是最新版本: "You're up to date",
  '在线演示不能安装，可以下载包到本机运行。':
    "The online demo can't install updates. Download a package to run locally.",
  '更新会下载 GitHub 上的包，替换程序文件后自动重启；data 目录里的数据会保留。有任务在执行时不能更新。':
    "Updating downloads the package from GitHub, replaces the app files and restarts automatically. Data in the data folder is kept. You can't update while tasks are running.",
  '从源码运行时请用 git 拉取更新；这里可以查看和下载发布的包。':
    'When running from source, pull updates with git. You can still view and download released packages here.',
  '当前是预览版，会提示所有更新的包；正式版只提示正式版。':
    'This is a preview build, so all newer packages are shown; stable builds only see stable releases.',
  最近的版本: 'Recent versions',
  '正在读取…': 'Loading…',
  '暂时没有读到发布的包。': 'No released packages found yet.',
  '更新到 {tag}？': 'Update to {tag}?',
  '切换到 {tag}？': 'Switch to {tag}?',
  '会下载这个较旧的包并替换当前程序，然后自动重启。旧版本可能读不懂新版本写的部分数据，建议先备份 data 目录。':
    'Downloads this older package, replaces the current app and restarts automatically. An older version may not understand some data written by a newer one, so back up the data folder first.',
  '会下载这个包并替换当前程序，然后自动重启。data 目录里的数据会保留。':
    'Downloads this package, replaces the current app and restarts automatically. Data in the data folder is kept.',
  更新: 'Update',
  切换: 'Switch',
  更新失败: 'Update failed',
  '新版本已经装好，但服务没有自动重启成功，请手动重新启动面板':
    "The new version is installed, but the server didn't restart automatically. Please restart the panel manually.",

  // 在线演示提示条
  关闭提示: 'Dismiss',
  恢复: 'Restore',
  没有输出时提醒: 'Warn when there is no output',
  '分钟，填 0 不检测。CLI 这么久没有任何输出时在任务里提醒一次，再过同样的时间还没有就自动停止，免得卡在登录或确认上一直显示执行中。':
    'Minutes; 0 turns it off. When a CLI prints nothing for this long the task shows a warning, and if it stays silent for the same time again it is stopped, so a CLI stuck on a login or confirmation prompt doesn\'t stay "running" forever.',
  '没有输出时提醒（分钟）': 'Warn when there is no output (minutes)',
  '填 0 到 1440 之间的整数，0 表示不检测': 'Enter a whole number from 0 to 1440; 0 turns it off',
  '回到上一个版本 v{version}': 'Back to previous version v{version}',
  '回到 v{version}？': 'Go back to v{version}?',
  '会换回更新前的程序文件，然后自动重启，数据会保留。之后还可以再换回当前版本。':
    'Restores the program files from before the update and restarts. Your data is kept, and you can switch back to the current version later.',
  回到上一个版本: 'Go back',
}
