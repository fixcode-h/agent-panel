import type { EngineHost } from './engine.ts'

/**
 * 编译、测试报错不卡住计划（用户 2026-10-30 定的）：先分清是不是自己改出来的，自己的自己修；
 * 不是的子对话交给父对话分派给改出它的子对话，自己那一步挂上等父对话通知，接着做别的步骤
 */
export function fixRoutePart(host: EngineHost, coordinator: boolean) {
  if (!host.task.projectId) return ''
  const child = !!host.task.parentTaskId && !!host.messageParent
  const head = `## 编译、测试报错不要卡住计划
- 先查清报错是谁改出来的：看报错指向的文件和行，对照你这次的改动（git diff、你改过的文件）。是你改出来的就自己修好、重跑，直到通过。`
  if (child)
    return `${head}
- 不是你改出来的（报错在你没碰过的文件里、是别的子对话在改的模块、你开工前就有）：不要去改别人的文件，也不要停下干等。调用 message_parent，text 写报错原文、出错的文件和判断依据，wait_fix 写被它卡住的计划步骤；然后接着做计划里不依赖它的步骤。父对话安排好修复会发消息给你，那时那一步退回进行中，重跑它的编译 / 测试。`
  return `${head}
- 不是你改出来的（开工前就有、别人改的）：不要卡在这里，先如实告诉用户报错原文和判断依据，在计划里记下这一步在等什么，接着做不依赖它的步骤。${
    coordinator
      ? `
- 子对话发来「报错不是我改出来的，请安排修复后通知我」时：按出错的文件和各子对话负责的范围（list_conversations）找出改出它的子对话，用 send_to_conversation 交给它修，写清报错原文、是谁报的；没有对应的子对话、或是你自己改出来的，就自己修或新建子对话修。修好后（那个子对话报了完成）用 send_to_conversation 通知报错的那个子对话重跑验证。不要让报错的子对话去改别人的文件。`
      : ''
  }`
}
