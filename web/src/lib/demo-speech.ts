/** 在线演示里的语音输入、语音朗读接口（从 demo-backend.ts 拆出来，那个文件有行数上限） */

/** 语音输入：演示里没有麦克风识别，下载一点就好，识别回一句示例 */
const demoSpeechModels = new Set<string>()
export function demoSpeech(method: string, seg: string[]): unknown {
  const [, a, id, b] = seg
  if (a === 'transcribe') return { text: '（在线演示）把登录页的报错提示改得更清楚一些' }
  if (a === 'models' && id && method === 'POST' && b === 'download') demoSpeechModels.add(id)
  if (a === 'models' && id && method === 'DELETE') demoSpeechModels.delete(id)
  return {
    supported: true,
    platform: 'demo',
    runtime: demoSpeechModels.size > 0,
    models: [...demoSpeechModels],
    dir: '~/.agent-panel/speech',
  }
}

/** 语音朗读：演示里模型下载一下就好；真的念用浏览器语音（演示里没有本机模型可以生成） */
const demoTtsModels = new Set<string>()
export function demoTts(method: string, seg: string[]): unknown {
  const [, a, id, b] = seg
  if (a === 'models' && id && method === 'POST' && b === 'download') demoTtsModels.add(id)
  if (a === 'models' && id && method === 'DELETE') demoTtsModels.delete(id)
  return {
    supported: true,
    platform: 'demo',
    runtime: demoTtsModels.size > 0,
    models: [...demoTtsModels],
    dir: '~/.agent-panel/speech/tts',
  }
}
