/**
 * 子对话报了不是它改出来的错、请父对话安排修复（见 shared/fix-route.ts）：子对话那条消息的开头和结尾、叫醒父对话的话、
 * 一直没人回时的提醒。几处按开头、结尾互相认，所以放在一起改
 */
import { clip } from '../../text.ts'

/** 子对话发给父对话的修复请求的开头一行 */
export const FIX_HEAD = '【报错不是我改出来的，请安排修复后通知我】'
/** 叫醒文案里要去掉的那一行开头（叫醒文案自己说了是什么事） */
export const FIX_HEAD_LINE = /^【报错不是我改出来的[^】\n]*】/
/** 父对话里那条修复请求的结尾（remindParentFix 按它找回当时的报错） */
export const FIX_TAIL = (id: string) => `（修好后用 send_to_conversation 通知这个子对话重跑验证，id: ${id}）`
/** 叫醒父对话时直接带上的报错正文长度：只说「在收件箱里」的话，收件箱万一没写进去父对话就无从下手 */
const FIX_WAKE_CHARS = 1500

interface Conv {
  id: string
  title: string
}

/** 叫醒父对话安排修复：text 是子对话那条消息的原文（带开头一行） */
export const fixAskWake = (child: Conv, text: string) =>
  `子对话「${child.title}」（id: ${child.id}）报了一个不是它改出来的报错，请你安排修复：\n${clip(text.replace(FIX_HEAD_LINE, '').trim(), FIX_WAKE_CHARS)}\n\n按出错的文件找出改出它的子对话，用 send_to_conversation 交给它修；没有对应的子对话、或是你自己改出来的，就自己修或新建子对话修。修好后用 send_to_conversation 通知「${child.title}」（id: ${child.id}）重跑验证：它卡住的那一步在等你的通知。`

/** 子对话还在等父对话安排修复：body 是当时报错的正文（找不到时为空） */
export const fixWaitingWake = (child: Conv, body: string) =>
  `【面板】子对话「${child.title}」（id: ${child.id}）还在等你安排修复：它报的错还没人回它，它那一步一直挂着等你的通知。${body ? `\n${clip(body.trim(), FIX_WAKE_CHARS)}\n` : ''}\n按出错的文件找出改出它的子对话，用 send_to_conversation 交给它修；没有对应的子对话、或是你自己改出来的，就自己修或新建子对话修。修好后用 send_to_conversation 通知「${child.title}」重跑验证；确实不用修了也用 send_to_conversation 告诉它，别让它一直等。`
