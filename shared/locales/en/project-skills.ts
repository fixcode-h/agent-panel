/** 英文词典的一部分，键是中文原文：项目设置里的 Skill 分节 */
export const EN_PROJECT_SKILLS: Record<string, string> = {
  '先创建项目，再管理项目里的技能。': 'Create the project first, then manage its skills.',
  '本地目录改了，先点「确认」保存，再管理新目录里的技能。':
    'The folder changed. Click "Confirm" to save it, then manage the skills in the new folder.',
  'Skill「{name}」格式有问题': 'Skill "{name}" has format problems',
  '项目：{path}': 'Project: {path}',
  'SKILL.md：{file}': 'SKILL.md: {file}',
  '当前的 SKILL.md：': 'Current SKILL.md:',
  '这个项目里的技能，放在项目目录下的技能目录里，跟着项目一起提交。Agent 按 SKILL.md 里的 description 判断什么时候用；改了这里的内容，新开的对话就会读到。':
    'Skills of this project live in the skill folders inside the project, and are committed with it. Agents use the description in SKILL.md to decide when to use one; new conversations pick up changes made here.',
  '先在「常规」里填好项目目录，再管理这里的技能。':
    'Fill in the project folder under "General" first, then manage skills here.',
  还没有: 'none yet',
  '还没有项目技能。点「新建 Skill」写一个，或者把已有的技能文件夹放进上面的目录。':
    'No project skills yet. Click "New skill" to write one, or put an existing skill folder into the directories above.',
  '{clis} 会读这里': '{clis} read this folder',
  '{n} 个问题': '{n} issue(s)',
  '没写 description：Agent 不知道什么时候该用它': 'No description: agents cannot tell when to use it',
  '把 SKILL.md 和问题一起交给 AI 排查并修好': 'Send SKILL.md and the issues to an agent to diagnose and fix',
  '让 AI 改写 SKILL.md：说明和触发条件写清楚，看完再决定用不用':
    'Let an agent rewrite SKILL.md: clearer instructions and trigger conditions, you decide whether to keep it',
  '编辑 {name}': 'Edit {name}',
  '各 Agent 还能看到的用户级技能': 'User-level skills each agent can also see',
  '用户目录里的技能不在这个项目里，改它们去 Skills 页；这里只是看清项目里的 Agent 一共能用哪些。':
    'Skills in your home folder are not part of this project; edit them on the Skills page. This only shows what agents can use here.',
  '已创建 {dir}，接着改里面的 SKILL.md': 'Created {dir}; edit its SKILL.md next',
  '已更新 {dir}/SKILL.md': 'Updated {dir}/SKILL.md',
  '删除 Skill「{name}」': 'Delete skill "{name}"',
  '会删掉项目里的整个文件夹 {dir}（包括里面的脚本等文件），删了要去 Git 里找回来。':
    'Deletes the whole folder {dir} in the project, including scripts and other files; recover it from Git if you need it back.',
  '已删除 {dir}': 'Deleted {dir}',
  这个目录里已经有同名的了: 'That folder already has a skill with this name',
  '也是文件夹名，建好后不能改': 'Also the folder name; it cannot be changed later',
  放在哪个目录: 'Which folder',
  '{clis} 会读这个目录': '{clis} read this folder',
  一句话说明什么时候用它: 'One line on when to use it',
  '例如：按团队约定写提交说明，先看改动再写':
    'For example: write commit messages the way the team does, reading the diff first',
  '写在 SKILL.md 的 description 里，Agent 靠它判断什么时候该用；之后也可以让 AI 改写':
    'Goes into the description of SKILL.md; agents use it to decide when to apply the skill. An agent can rewrite it later.',
  '已保存 {file}': 'Saved {file}',
  '编辑「{name}」': 'Edit "{name}"',
  '让 AI 改写这份 SKILL.md，看完再决定用不用': 'Let an agent rewrite this SKILL.md; you decide whether to keep it',
  '把当前内容和问题一起交给 AI 排查并修好': 'Send the current content and the issues to an agent to diagnose and fix',
  '文件夹里还有：{files}': 'Also in the folder: {files}',
  'SKILL.md 内容': 'SKILL.md content',
  '格式没问题：name、description 和正文都齐了。': 'Looks fine: name, description and body are all there.',
  '开头缺少 --- 包起来的 front matter（里面要写 name 和 description）':
    'Missing the --- front matter at the top (it should contain name and description)',
  'front matter 里缺少 name': 'front matter has no name',
  'front matter 的 name 是「{name}」，和文件夹名「{dir}」不一致':
    'front matter name is "{name}" but the folder is "{dir}"',
  'front matter 里缺少 description：Agent 靠它判断什么时候用这个技能':
    'front matter has no description: agents rely on it to decide when to use the skill',
  'description 只有 {n} 个字，说不清什么时候该用它':
    'description is only {n} characters, too vague to say when the skill applies',
  '只有 front matter，没有写具体怎么做': 'Only front matter, no instructions',
  '在这里写步骤和注意事项：先做什么、看哪些文件、要遵守什么约定。':
    'Write the steps and notes here: what to do first, which files to read, which conventions to follow.',
  '这个目录不能放 Skill：{dir}': 'Skills cannot live in this folder: {dir}',
  '名字只能用字母、数字、. _ -，以字母或数字开头':
    'The name may only contain letters, digits, . _ - and must start with a letter or digit',
  先在项目设置里填好项目目录: 'Fill in the project folder in the project settings first',
  'SKILL.md 不能为空': 'SKILL.md cannot be empty',
  // 全局技能的生效方式（全局 / 按项目，工作包 W4）
  '按项目生效的技能不装进用户目录，每轮只给打开了它的项目带上':
    'Per-project skills are not installed in your home folder; each turn they are given only to projects that turned them on',
  '已改成按项目。下面这些被改过或目标已有同名的，留在原处没动，仍对所有项目生效：{list}':
    'Switched to per project. These were edited or already exist at the destination, so they stayed where they were and still apply to every project: {list}',
  '已改回全局。下面这些目标已有同名的，没挪回去：{list}':
    'Switched back to global. These already exist at the destination and were not moved back: {list}',
  已改成按项目: 'Switched to per project',
  已改回全局: 'Switched back to global',
  技能的生效方式: 'Where the skill applies',
  '只在项目「能力」里打开了它的项目里交给 Agent，每轮带上，不放在用户目录':
    'Given to the agent only in projects that turned it on under "Capabilities", added each turn and kept out of your home folder',
  '放在用户目录，所有项目、所有对话都读得到': 'Kept in your home folder, so every project and conversation can read it',
  '；{clis} 不能按会话加载技能，改成在提示里列出它的路径':
    '; {clis} cannot load skills per session, so its path is listed in the prompt instead',
  '这个项目打开的技能没能交给 Codex（{error}），这一轮用不了它们':
    'The skills turned on for this project could not be given to Codex ({error}); they are unavailable this turn',
  '这个项目打开的技能这一轮没能带上，Agent 暂时用不了它们。':
    'The skills turned on for this project could not be added this turn, so the agent cannot use them for now.',
  '没有这个技能：{name}': 'No such skill: {name}',
}
