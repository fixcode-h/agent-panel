/**
 * 本机语音输入的共用逻辑：模型目录、下载地址、识别配置、录音编码。不加载识别库、不联网。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Settings } from './schema.ts'
import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  cleanTranscript,
  decodePcm16,
  encodePcm16,
  npmTarball,
  recognizerConfig,
  resample,
  sherpaPlatformPackage,
  speechFileUrl,
  speechModel,
} from './speech.ts'

test('默认关着：旧设置里没有 speech 也按关闭读', () => {
  const s = Settings.parse({})
  assert.equal(s.speech.enabled, false)
  assert.equal(s.speech.model, DEFAULT_SPEECH_MODEL)
  // 设置文件里写了不认识的模型（以后删掉的模型）回到默认，不让整份设置作废
  assert.equal(Settings.parse({ speech: { enabled: true, model: 'gone' } }).speech.model, DEFAULT_SPEECH_MODEL)
})

test('模型目录：id 不重复，每个模型都有词表和模型文件', () => {
  assert.equal(new Set(SPEECH_MODELS.map((m) => m.id)).size, SPEECH_MODELS.length)
  for (const m of SPEECH_MODELS) {
    assert.ok(
      m.files.some((f) => f.name.includes('tokens')),
      m.id,
    )
    assert.ok(
      m.files.some((f) => f.name.endsWith('.onnx')),
      m.id,
    )
  }
  assert.equal(SPEECH_MODELS.filter((m) => m.recommended).length, 1)
})

test('识别库按平台取预编译包，Windows 包名写 win，没有的平台给空串', () => {
  assert.equal(sherpaPlatformPackage('win32', 'x64'), 'sherpa-onnx-win-x64')
  assert.equal(sherpaPlatformPackage('darwin', 'arm64'), 'sherpa-onnx-darwin-arm64')
  assert.equal(sherpaPlatformPackage('linux', 'x64'), 'sherpa-onnx-linux-x64')
  assert.equal(sherpaPlatformPackage('freebsd', 'x64'), '')
})

test('下载地址：镜像只换主机', () => {
  const m = speechModel(DEFAULT_SPEECH_MODEL)!
  assert.equal(speechFileUrl(m, 'tokens.txt', false), `https://huggingface.co/${m.repo}/resolve/main/tokens.txt`)
  assert.equal(speechFileUrl(m, 'tokens.txt', true), `https://hf-mirror.com/${m.repo}/resolve/main/tokens.txt`)
  assert.equal(
    npmTarball('sherpa-onnx-node', '1.0.0', true),
    'https://registry.npmmirror.com/sherpa-onnx-node/-/sherpa-onnx-node-1.0.0.tgz',
  )
})

test('识别配置按模型种类填对应的字段', () => {
  const at = (f: string) => `/m/${f}`
  const sv = recognizerConfig(speechModel('sense-voice-int8')!, at, 2)
  assert.deepEqual(sv.modelConfig.senseVoice, {
    model: '/m/model.int8.onnx',
    language: 'auto',
    useInverseTextNormalization: 1,
  })
  assert.equal(sv.modelConfig.tokens, '/m/tokens.txt')
  assert.equal(sv.modelConfig.numThreads, 2)
  const pf = recognizerConfig(speechModel('paraformer-zh-small-int8')!, at, 1)
  assert.deepEqual(pf.modelConfig.paraformer, { model: '/m/model.int8.onnx' })
  const wh = recognizerConfig(speechModel('whisper-small-int8')!, at, 1)
  assert.equal(wh.modelConfig.whisper?.encoder, '/m/small-encoder.int8.onnx')
  assert.equal(wh.modelConfig.whisper?.decoder, '/m/small-decoder.int8.onnx')
  assert.equal(wh.modelConfig.tokens, '/m/small-tokens.txt')
})

test('16 位 PCM 编码来回不丢形状，超出范围的削顶', () => {
  const back = decodePcm16(encodePcm16(new Float32Array([0, 0.5, -0.5, 1.5, -2])))
  assert.equal(back.length, 5)
  assert.ok(Math.abs(back[1] - 0.5) < 1e-3)
  assert.ok(Math.abs(back[2] + 0.5) < 1e-3)
  assert.ok(back[3] <= 1 && back[3] > 0.99)
  assert.equal(back[4], -1)
})

test('重采样：48k 到 16k 长度变成三分之一，同采样率原样返回', () => {
  const x = new Float32Array(4800).fill(0.25)
  const y = resample(x, 48000)
  assert.equal(y.length, 1600)
  assert.ok(y.every((v) => Math.abs(v - 0.25) < 1e-6))
  assert.equal(resample(x, 16000), x)
})

test('只剩标点和空白的结果算没听到', () => {
  assert.equal(cleanTranscript(' 你好。 '), '你好。')
  assert.equal(cleanTranscript('。'), '')
  assert.equal(cleanTranscript('  '), '')
})
