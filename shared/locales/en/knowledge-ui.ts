/** 英文词典的一部分（项目设置的「候选」「提炼」页、教训的触发与反馈字段），键是中文原文 */
export const EN_KNOWLEDGE_UI: Record<string, string> = {
  // 候选页
  已收下: 'Accepted',
  已忽略: 'Dismissed',
  候选: 'Candidates',
  '还没生效的教训和经验：命令失败后换了做法才成功时，面板会记下失败的命令、报错和改对的命令；同一个报错在另一个对话里再出现就自动转成教训。子对话记下的也先放在这里。收下就写进项目教训或经验，忽略就删掉。这里的改动直接保存。':
    'Lessons and experience that are not active yet: when a command fails and a different approach then succeeds, the panel records the failed command, the error and the fix; if the same error shows up again in another conversation, it becomes a lesson automatically. What sub-conversations record lands here too. Accept to add it to project lessons or experience, dismiss to delete it. Changes here are saved right away.',
  '现在没有候选。命令失败后换了做法才成功、或子对话记下教训和经验时，会出现在这里。':
    'No candidates yet. They appear here when a command fails and a different approach then succeeds, or when a sub-conversation records a lesson or experience.',
  没配上的查询: 'Unmatched queries',
  'Agent 搜了、查了却没有经验对得上的说法。反复出现的说明值得补一条经验，可以到「提炼」页让 AI 补。':
    'Terms the agent searched or looked up with no matching experience. Ones that keep coming up are worth an experience entry; the Distill page can have AI add it.',
  '（还没写标题）': '(No title yet)',
  失败后改对: 'Fixed after a failure',
  子对话记录: 'From a sub-conversation',
  '对话记录（只在记下它的对话里生效）': 'Recorded in a conversation (active only there)',
  '出现在 {n} 个对话': 'Seen in {n} conversations',
  同一个报错在不止一个对话里出现过: 'The same error has shown up in more than one conversation',
  复发: 'Recurring',
  '报错：{text}': 'Error: {text}',
  忽略: 'Dismiss',
  收下为教训: 'Accept as lesson',
  收下为经验: 'Accept as experience',
  '{n} 次': '{n} times',
  // 提炼页
  '写成 AGENTS.md 补丁': 'Write an AGENTS.md patch',
  '挑出用上很多次、帮上过的教训，写成项目说明里的规则；改动在对话里给你过目，确认后才算数。':
    'Picks lessons that were used often and helped, and writes them as rules in the project instructions; you review the change in the conversation before it counts.',
  合进模块文档: 'Merge into module docs',
  '按模块把相关的教训和经验合进模块文档，已有的合并不覆盖。':
    'Merges related lessons and experience into each module’s docs, merging with what is there instead of overwriting.',
  面板改进建议: 'Panel improvement ideas',
  '从反复推送、反复被违反的条目里找出该由面板自己改进的地方，写成建议清单。':
    'Finds what the panel itself should improve from entries that keep getting pushed or violated, and writes them up as a list.',
  补没配上的查询: 'Fill unmatched queries',
  '看 Agent 搜了却没有经验对得上的说法，查清位置后补成经验。':
    'Looks at terms the agent searched with no matching experience, finds where they live and adds them as experience.',
  现在没有可提炼的条目: 'Nothing to distill right now',
  'AI 提炼': 'AI distill',
  提炼: 'Distill',
  '教训和经验攒多了，常用的值得写进项目说明或模块文档，总是被违反的值得做成钩子或改进面板。每个动作会在这个项目里新开一个对话，改动照常给你过目。':
    'As lessons and experience pile up, the frequently used ones belong in the project instructions or module docs, and the ones that keep getting violated belong in a hook or a panel fix. Each action opens a new conversation in this project, and you review the changes as usual.',
  '{n} 条可提炼': '{n} ready',
  开始: 'Start',
  // 教训的新字段
  错的做法: 'Wrong approach',
  '看到这样做时要停下；面板推送时跟在规则后面':
    'Stop when you see this; the panel appends it after the rule when pushing',
  '例如：直接在 Windows 上跑 npm run test:e2e': 'e.g. running npm run test:e2e directly on Windows',
  命令触发键: 'Command triggers',
  '跑这些命令之前推送这条（按开头几个词比），逗号分隔；说明里用反引号写的命令也会自动算上':
    'Push this before these commands run (compared by the first few words), comma-separated; commands in backticks in the note count too',
  报错触发: 'Error triggers',
  '面板记下的报错特征：同样的报错再出现时推送这条':
    'Error fingerprints the panel recorded: push this when the same error shows up again',
  提醒强度: 'Strength',
  '拦截：跑对得上的命令前直接拒绝，并告诉角色对的做法':
    'Block: refuse matching commands before they run and tell the agent the right approach',
  只在查询里: 'Lookup only',
  按触发推送: 'Push on trigger',
  拦截: 'Block',
  生效: 'Active',
  置顶: 'Pinned',
  '已提炼（不再推送）': 'Distilled (no longer pushed)',
  '过时（推送降权）': 'Stale (pushed less)',
  '帮上 {n}': 'Helped {n}',
  '违反 {n}': 'Violated {n}',
  '漏推 {n}': 'Missed {n}',
  '帮上：推送后同样的命令一次就过；违反：推送了还是出现了记下的报错；漏推：报错对上了这条，事前却没推到':
    'Helped: the same command passed first time after the push. Violated: the recorded error still happened after the push. Missed: the error matched this lesson but it was not pushed beforehand',
  升级为拦截: 'Upgrade to block',
  标为过时: 'Mark stale',
  可以提炼: 'Ready to distill',
  '（到「提炼」页处理）': ' (handle it on the Distill page)',
  转成钩子: 'Turn into hook',
  '把这条教训的命令写成项目钩子，跑对得上的命令前拒绝':
    'Write this lesson’s commands as a project hook that refuses matching commands',
  改写知识: 'Rewrite knowledge',
  '推送后仍犯了 {n} 次': 'Still broken {n} times after being pushed',
  管的路径已经不在了: 'The paths it covers no longer exist',
  '{n} 天没用上': 'Unused for {n} days',
  '在 {n} 个对话里帮上过': 'Helped in {n} conversations',
  查项目知识: 'Look up project knowledge',
  记下项目知识: 'Record project knowledge',
  这条候选已经不在了: 'This candidate no longer exists',
  '第 {n} 行的 triggers 要写成 JSON 对象': 'triggers on line {n} must be a JSON object',
}
