import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：speech.ts 按数据目录找识别库和模型，不能碰真正的 ~/.agent-panel
const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-speech-'))
process.env.AGENT_PANEL_DATA = data

const { speechApi, speechStatus } = await import('./speech.ts')
const { getSettings, saveSettings } = await import('./settings.ts')
const { t } = await import('../shared/i18n.ts')
const { SHERPA_VERSION, encodePcm16, sherpaPlatformPackage, speechModel } = await import('../shared/speech.ts')

/**
 * 语音输入的接口：默认什么都没下载、关着时不识别；识别库用一个假的 sherpa-onnx-node 代替
 * （真的是原生扩展，单测里不加载），检查配置和录音按约定交给它、结果原样回来。
 */
const app = speechApi()
const post = (body: unknown) =>
  app.request('/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const audio = Buffer.from(encodePcm16(new Float32Array(1600).fill(0.1))).toString('base64')

test('语音识别接口：默认没下载、关着不识别、录音校验，下载好后交给识别库并整理结果', async (c) => {
  // 默认什么都没下载
  const st = speechStatus()
  assert.equal(st.runtime, false)
  assert.deepEqual(st.models, [])
  assert.equal(st.job, undefined)

  // 没打开语音输入时拒绝识别，并说清去哪打开
  const off = await post({ audio })
  assert.equal(off.status, 400)
  assert.equal(((await off.json()) as { error: string }).error, t('语音输入没有打开，请到设置 → 语音输入里打开'))

  // 打开了但模型没下载：报要下载哪个
  const s = await getSettings()
  await saveSettings({ ...s, speech: { ...s.speech, enabled: true } })
  const missing = await post({ audio })
  assert.equal(missing.status, 400)
  const name = speechModel(s.speech.model)!.name
  assert.equal(
    ((await missing.json()) as { error: string }).error,
    t('还没有下载 {name}，请到设置 → 语音输入里下载', { name }),
  )

  // 录音不是 base64 字符串、或者太长时拒绝
  assert.equal((await post({})).status, 400)
  const long = Buffer.alloc(16000 * 2 * 121).toString('base64')
  assert.equal((await post({ audio: long })).status, 400)

  // 识别库和模型都在时：配置和录音交给识别库，结果原样回来
  const pkg = sherpaPlatformPackage(platform(), arch())
  if (!pkg) return c.skip('识别库没有这个平台的包')
  const m = speechModel(s.speech.model)!
  const mods = path.join(data, 'speech', `sherpa-onnx-${SHERPA_VERSION}`, 'node_modules')
  mkdirSync(path.join(mods, pkg), { recursive: true })
  writeFileSync(path.join(mods, pkg, 'sherpa-onnx.node'), '')
  mkdirSync(path.join(mods, 'sherpa-onnx-node'), { recursive: true })
  writeFileSync(path.join(mods, 'sherpa-onnx-node', 'package.json'), '{"name":"sherpa-onnx-node","main":"index.js"}')
  // 假识别库：记下收到的配置和采样数，回一段带空白的文字
  writeFileSync(
    path.join(mods, 'sherpa-onnx-node', 'index.js'),
    `exports.OfflineRecognizer = { async createAsync(config) {
      globalThis.__speechConfig = config
      return {
        createStream() { return { acceptWaveform(w) { globalThis.__speechSamples = w.samples.length; globalThis.__speechRate = w.sampleRate } } },
        async decodeAsync() { return { text: ' 把按钮改成蓝色。 ' } },
      }
    } }`,
  )
  const dir = path.join(data, 'speech', 'models', m.id)
  mkdirSync(dir, { recursive: true })
  for (const f of m.files) writeFileSync(path.join(dir, f.name), '')
  assert.deepEqual(speechStatus().models, [m.id])

  const r = await post({ audio })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { text: '把按钮改成蓝色。' })
  const g = globalThis as unknown as {
    __speechConfig: { modelConfig: { tokens: string } }
    __speechSamples: number
    __speechRate: number
  }
  assert.equal(g.__speechConfig.modelConfig.tokens, path.join(dir, 'tokens.txt'))
  assert.equal(g.__speechSamples, 1600)
  assert.equal(g.__speechRate, 16000)
})
