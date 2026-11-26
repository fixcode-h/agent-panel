/** 英文词典的一部分，键是中文原文：按模型档位加强扶持、情境规则（shared/models/support.ts、shared/hooks/situational.ts） */
export const EN_MODEL_SUPPORT: Record<string, string> = {
  '已按{tier}模型加强扶持': 'Extra support for a {tier} model',
  '已按{tier}档加强扶持': 'Extra support at the {tier} tier',
  按哪一档: 'Based on',
  '选了{slot}档': 'Picked {slot}',
  '模型本身{tier}': 'Model is {tier}',
  '角色或节点选了高、中、低档时按选的档套用下面这一列；直接写了模型名的按模型目录里的档':
    "When a role or node picks the high, medium or low tier, that tier's column applies; a model named directly uses its tier in the model catalog",
  按模型档位加强扶持: 'Extra support by model tier',
  自动加强: 'Auto boost',
  '弱模型（例如 deepseek-flash）守不住长规则，面板替它多做几件事：严格档钩子、先列计划、多推几条情境规则、计划没跟上早点提醒。只往严里推，项目里手动选的钩子档位优先；对话的会话栏会写「已按弱模型加强扶持」':
    'Weak models (such as deepseek-flash) do not keep long rules well, so the panel does more for them: strict hooks, a plan first, more situational rules, and earlier plan reminders. It only ever makes things stricter; a hook tier chosen for a project wins. The session panel shows "Extra support for a weak model"',
  '{min} 到 {max}': '{min} to {max}',
  情境规则: 'Situational rules',
  '只在某个情境才用得上的细则（例如弱模型第一次改文件前还没列计划），不常驻在角色设定里，到那一刻才推给模型；每条在一个对话里只推一次，只提醒不拦截':
    'Detailed rules that only matter in a certain situation (for example a weak model about to edit a file with no plan yet) are not kept in the role setup; the panel hands them to the model at that moment. Each is pushed once per conversation and only reminds, never blocks',
  先列实现计划: 'Plan before coding',
  'IDE 服务的调用规矩': 'IDE service call rules',
  改用自建工具: 'Use the custom tool instead',
  钩子档位: 'Hook tier',
  '和全局档位取更严的；项目里单独选了档位时以项目为准，钩子页逐个改过的开关也照旧优先':
    'The stricter of this and the global tier is used; a tier chosen for a project wins, and hooks switched one by one keep their setting',
  '「每次都要」时，第一次改文件前还没有计划，面板推一句让它先用 set_plan 列实现计划（只提醒，不拦）':
    'With "Every time", if there is no plan before the first file edit, the panel reminds the model to write an implementation plan with set_plan first (a reminder, not a block)',
  '3 步以上': '3+ steps',
  每次都要: 'Every time',
  情境推送条数: 'Items per push',
  '跑命令、改文件、报错时一次最多推几条教训、经验和情境规则；和面板默认的 3 条取多的':
    "At most how many lessons, experience entries and situational rules to push at once when running a command, editing a file or hitting an error; the larger of this and the panel's default of 3 is used",
  计划没跟上的阈值: 'Plan lag threshold',
  '进行中的那一步改文件、跑命令几次还没更新就提醒；和钩子「计划没跟上提醒」的参数取小的':
    'Remind after this many edits or commands without updating the step in progress; the smaller of this and the "Plan lag reminder" hook setting is used',
  弱: 'weak',
  强: 'strong',
  没有这一项扶持: 'No such support item',
  '要是 {min} 到 {max} 之间的整数': 'Must be a whole number from {min} to {max}',
}
