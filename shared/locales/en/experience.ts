/** 英文词典的一部分（项目经验：设置、项目设置页、学习和评审的提示），键是中文原文 */
export const EN_EXPERIENCE: Record<string, string> = {
  // 种类和校验
  找位置: 'Location',
  叫法对照: 'Naming',
  验证: 'Verify',
  做法: 'Recipe',
  '标题不超过 {n} 字': 'Title must be at most {n} characters',
  '说明不超过 {n} 字': 'Note must be at most {n} characters',
  至少写一个关键词: 'Add at least one keyword',
  '关键词最多 {n} 个': 'At most {n} keywords',
  '路径最多 {n} 个': 'At most {n} paths',
  // 学习、评审、存储
  '找不到 Agent：{cli}': 'Agent not found: {cli}',
  '超过 3 分钟没有完成，已停止': 'Stopped after not finishing within 3 minutes',
  '{cli} 执行失败': '{cli} failed',
  'JSON 里没有 items 数组': 'The JSON has no items array',
  'JSON 里没有 verdicts 数组': 'The JSON has no verdicts array',
  '路径都不存在：{paths}': 'None of the paths exist: {paths}',
  '经验已经有 {n} 条，这次没再学：先到项目设置的「经验」里用 AI 评审清理一下':
    'There are already {n} experiences, so nothing new was learned. Clean them up with AI review in Project settings → Experience.',
  '经验提炼失败，没有重试': 'Learning experience failed; not retried',
  '经验提炼失败：模型的回复格式不对，没有重试':
    "Learning experience failed: the model's reply was malformed; not retried",
  学到的经验没能保存: 'The learned experience could not be saved',
  '学到经验：{titles}': 'Learned: {titles}',
  项目不存在或没有目录: 'The project does not exist or has no folder',
  这条经验已经不在了: 'This experience no longer exists',
  'AI 评审失败：{error}': 'AI review failed: {error}',
  'AI 评审的回复格式不对：{error}': 'The AI review reply was malformed: {error}',
  '没有 {start} 开始标记': 'Missing the {start} start marker',
  '第 {n} 行在经验标记之外': 'Line {n} is outside the experience markers',
  '缺 {end} 结束标记': 'Missing the {end} end marker',
  '这个项目没有目录，存不了经验': 'This project has no folder, so experiences cannot be saved',
  '经验文件写入失败：{error}': 'Failed to write the experience file: {error}',
  // 对话
  查项目经验: 'Search project experience',
  更新经验: 'Update experience',
  记下经验: 'Record experience',
  '把一件事学成一条项目经验：在哪找、叫什么、用什么命令，下次直接用':
    'Learn one thing as a project experience: where to look, what it is called, which command to use',
  '<要学的，例如：表格相关的代码在哪>': '<what to learn, e.g. where the table code lives>',
  // 项目设置 → 项目经验
  项目经验: 'Project experience',
  '做某类事最快的路：在哪个目录找、你的说法在代码里叫什么、用什么命令、怎么验证。整个对话完成后面板自动学，学到就加；对话里发「/learn 要学的」也能让角色专门学一条。Agent 需要时按关键词查，不会整份塞进提示词。这里的改动直接保存。':
    'The fastest way to do a kind of task: which folder to look in, what your words are called in the code, which command to run, how to verify. The panel learns them after a whole conversation finishes and adds them right away; send "/learn <topic>" in a conversation to have the agent learn one on purpose. Agents search them by keyword when needed; they are never stuffed into the prompt. Changes here are saved immediately.',
  '搜索标题、关键词、路径': 'Search titles, keywords, paths',
  搜索经验: 'Search experience',
  '其中 {n} 条是自动学到的': '{n} learned automatically',
  '让 Agent 逐条判断符不符合「经验记什么」，不符合的和写得太细的列出来，你勾选后删掉或精简':
    'Have an agent check each entry against what experience should hold; entries that do not fit or are too detailed are listed for you to delete or trim',
  '评审中…': 'Reviewing…',
  '这些文件格式不对，已跳过（没有改动它们）：{list}':
    'These files are malformed and were skipped (left untouched): {list}',
  '已处理 {n} 条': 'Handled {n}',
  按种类筛选: 'Filter by kind',
  '还没有经验。整个对话完成后，面板会看这次是不是绕了很多路才找到地方、命令是不是试了几次才成，值得的话自动记一条；也可以在这里手动加。':
    'No experience yet. After a whole conversation finishes, the panel checks whether it took a long search to find the right place or several tries to get a command right, and records one if worthwhile. You can also add them here.',
  没有匹配的经验: 'No matching experience',
  整个对话完成后面板自动学到的: 'Learned automatically after a conversation finished',
  自动学到: 'Learned',
  删除这条经验: 'Delete this experience',
  '{time}改过': 'edited {time}',
  '在 {branch} 分支学到': 'learned on branch {branch}',
  '存在 {dir}': 'Stored in {dir}',
  经验的种类: 'Experience kind',
  '一句话：要做的事 + 去哪 / 用什么': 'One line: the task + where to go / what to use',
  '例如：表格相关的代码和配置在哪': 'e.g. Where the table code and data live',
  关键词: 'Keywords',
  '你的说法和代码里的叫法都写上，逗号分隔；Agent 按它查':
    'Write both your words and the names used in code, comma-separated; agents search by these',
  '例如：表格, 配表, DataTable': 'e.g. table, config table, DataTable',
  '目录或 glob（相对项目根），命令类写命令本身；写到目录为止，最多 4 个':
    'Folders or globs relative to the project root (the command itself for commands); stop at folder level, at most 4',
  '一两句就够：经验是指路牌，不是文档': 'A sentence or two: experience is a signpost, not documentation',
  'AI 评审结果': 'AI review',
  '符合 {good} 条，不符合或写得太细 {bad} 条': '{good} fit, {bad} do not fit or are too detailed',
  '（只评了前 {n} 条）': ' (only the first {n} were reviewed)',
  '都符合「经验记什么」，不用清理。': 'Everything fits; nothing to clean up.',
  精简: 'Trim',
  不该记: "Shouldn't be kept",
  写得太细: 'Too detailed',
  '精简为：{text}': 'Trim to: {text}',
  '收起符合的 {n} 条': 'Hide the {n} that fit',
  '看符合的 {n} 条': 'Show the {n} that fit',
  '处理勾选的 {n} 条': 'Apply to {n} selected',
  // 设置 → 经验
  经验: 'Experience',
  '经验是项目里「做某类事最快的路」：某类东西在哪个目录、你的说法在代码里叫什么、用什么命令、怎么验证。整个对话完成后面板自动学，存在项目文档的 agent-knowledge/experience/；Agent 需要时按关键词查，不会整份塞进提示词。教训管防错，经验管提速。':
    'Experience is "the fastest way to do a kind of task" in a project: which folder something lives in, what your words are called in the code, which command to run, how to verify. The panel learns it after a whole conversation finishes and stores it in agent-knowledge/experience/ in the project docs. Agents search it by keyword when needed; it is never stuffed into the prompt. Lessons prevent mistakes; experience saves time.',
  启用经验: 'Enable experience',
  '关掉后不学、不查，新会话开头也不提': 'When off, nothing is learned or searched, and new sessions do not mention it',
  整个对话完成后自动学: 'Learn after a whole conversation finishes',
  '对话和它的子对话都完成、空闲一段时间后在后台学，不挡你':
    'Runs in the background once the conversation and its sub-conversations are done and idle for a while',
  '先只看工具调用算这次绕了多少路（不花 token），绕路明显或命令反复试错时才调一次模型提炼，最多 2 条。':
    'First counts detours from tool calls alone (no tokens); only when there was a clear detour or repeated command failures does it call a model once, recording at most 2 entries.',
  新会话开头附上相关经验: 'Attach related experience to new sessions',
  '按需求原文在本地匹配，命中了附上最多两条的标题和位置':
    'Matches the request locally and attaches the title and location of up to two hits',
  学习: 'Learning',
  学得勤不勤: 'How eagerly to learn',
  '绕路多少次才值得学：少一点 12 次、适中 8 次、勤一点 5 次':
    'Detours needed before learning: fewer 12, normal 8, more 5',
  少一点: 'Fewer',
  适中: 'Normal',
  勤一点: 'More',
  对话完成后等多久再学: 'Wait after the conversation finishes',
  '这段时间里你接着追问，就重新计时': 'Sending a follow-up during this time restarts the wait',
  每个项目每天最多提炼: 'Max learning runs per project per day',
  '到了上限当天不再调模型，只做不花 token 的那一步':
    'After the limit, only the token-free step runs for the rest of the day',
  '提炼和 AI 评审用的模型': 'Model for learning and AI review',
  '默认跟随对话的 Agent 和模型；AI 评审跟随默认 Agent':
    "Follows the conversation's agent and model by default; AI review uses the default agent",
  '经验用的 Agent': 'Agent for experience',
  '跟随对话的 Agent': "Follow the conversation's agent",
  经验用的模型: 'Model for experience',
}
