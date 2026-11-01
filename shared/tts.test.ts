import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TTS_VOICE, TTS_MODELS, TTS_VOICES, encodeWav, ttsConfig, ttsModelFiles } from './tts.ts'

test('Kokoro v1.1 的音色：103 个，编号连续，名字和模型元数据（id2speaker）对得上', () => {
  assert.equal(TTS_VOICES.length, 103)
  assert.deepEqual(
    TTS_VOICES.map((v) => v.sid),
    TTS_VOICES.map((_, i) => i),
  )
  // 抽几个和模型元数据核对：3->zf_001、57->zf_099、58->zm_009、102->zm_100
  const name = (sid: number) => TTS_VOICES[sid].name
  assert.deepEqual(
    [name(0), name(2), name(3), name(57), name(58), name(102)],
    ['af_maple', 'bf_vale', 'zf_001', 'zf_099', 'zm_009', 'zm_100'],
  )
  assert.equal(TTS_VOICES.filter((v) => v.group === 'zf').length, 55)
  assert.equal(TTS_VOICES.filter((v) => v.group === 'zm').length, 45)
  assert.equal(TTS_VOICES[DEFAULT_TTS_VOICE].group, 'zf', '默认是中文女声')
})

test('ttsConfig：Kokoro 的文件都指到模型目录里，中英两份词典都带上', () => {
  const m = TTS_MODELS[0]
  const c = ttsConfig(m, (f) => `/m/${f}`, 2)
  assert.equal(c.model.kokoro.model, `/m/${m.model}`)
  assert.equal(c.model.kokoro.lexicon, '/m/lexicon-us-en.txt,/m/lexicon-zh.txt')
  assert.equal(c.ruleFsts, '/m/date-zh.fst,/m/phone-zh.fst,/m/number-zh.fst')
  assert.ok(ttsModelFiles(m).includes(m.model))
})

test('encodeWav：44 字节头 + 16 位单声道 PCM，采样率写在头里', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 24000)
  const v = new DataView(wav.buffer)
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
  assert.equal(wav.length, 44 + 8)
  assert.equal(v.getUint32(24, true), 24000)
  assert.equal(v.getInt16(46, true), 0x7fff)
  assert.equal(v.getInt16(48, true), -0x8000)
  assert.equal(v.getInt16(50, true), 0x7fff, '超出范围的样本截到最大值')
})
