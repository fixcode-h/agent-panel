/**
 * 回复里提到文件时写完整路径（用户 2026-11-06 定的）：对话里的文件标记按 Agent 写的路径解析，
 * 只写 `DefaultEngine.ini:567` 时面板只能拼到项目根下（实际在 Config/ 里），悬停显示「找不到这个文件」。
 * 用户要求就是 Agent 自己给完整路径，不靠面板按文件名拼接或猜位置；文件后来被删了打不开的不管。
 * 提示词是给 Agent 的指令，不写进 shared/locales。
 */

/** 完整规则：跟「截图和临时文件放哪」一起进系统提示词（没有系统提示词参数的 CLI 接在新会话第一轮） */
export const PATH_RULES = `## 提到文件时写完整路径
回复里（正文、列表、表格、给父对话的结果）提到任何文件或目录，一律写从盘符或根目录开始的完整绝对路径，放在行内代码里；要定位到行就在后面加 \`:行号\`，例如 \`G:/Project/Game/Config/DefaultEngine.ini:567\`、\`/home/me/app/src/main.ts:12\`。
- 不要只写文件名（\`DefaultEngine.ini\`），也不要写相对路径（\`Config/DefaultEngine.ini\`、\`./src/a.ts\`）：面板只按你写的路径打开文件，不会替你拼项目目录或按文件名去找。
- 路径以你实际读写的位置为准（工具调用里用的那个完整路径）；只知道文件名时先找到它在哪再写。在 worktree 或子目录里工作时写那里的完整路径。
- 只是在说一个名字（讨论命名、举例）而不是指向某个具体文件时，不放进行内代码。`

/** 每轮末尾的一句话提醒（接在语言提醒后面，见 shared/prompt-lang.ts 的 REMINDERS） */
export const PATH_REMINDER = {
  zh: '提到文件时写完整的绝对路径（可加 :行号），不要只写文件名或相对路径。',
  en: 'When you mention a file, write its full absolute path (optionally with :line), never just the file name or a relative path.',
} as const
