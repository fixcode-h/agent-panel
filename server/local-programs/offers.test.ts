// 本机程序没装的提醒（server/local-programs/offers.ts）：报一次只出一张卡、拒绝后不再问、装好撤掉、一键安装只用找得到的包管理器
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  declineOffer,
  listOffers,
  offerFailed,
  offerInstalled,
  platformOf,
  reportMissing,
  resetOffers,
  setupSteps,
} from './offers.ts'

test('缺 rg 报多次只有一张卡；失败留原因，装好撤掉；拒绝后再报也不问，未知程序不报', () => {
  resetOffers()
  reportMissing('rg')
  reportMissing('rg')
  reportMissing('no-such-program')
  assert.deepEqual(
    listOffers().map((o) => o.id),
    ['rg'],
  )
  assert.ok(listOffers()[0].installHint, '带手动安装命令')
  offerFailed('rg', '没装上')
  assert.equal(listOffers()[0].error, '没装上')
  offerInstalled('rg')
  assert.equal(listOffers().length, 0)
  reportMissing('rg')
  declineOffer('rg')
  reportMissing('rg')
  assert.equal(listOffers().length, 0, '拒绝了这次运行期间不再问')
  resetOffers()
})

test('一键安装只挑本机找得到的包管理器；sudo 还要看后面的包管理器在不在', () => {
  const steps = setupSteps('rg', (c) => c === 'sudo' || c === 'apt-get' || c === 'scoop')
  const want = {
    win32: [['scoop', 'install', 'ripgrep']],
    darwin: [],
    linux: [['sudo', '-n', 'apt-get', 'install', '-y', 'ripgrep']],
  }
  assert.deepEqual(steps, want[platformOf()])
  assert.deepEqual(
    setupSteps('rg', () => false),
    [],
    '都找不到就没有一键安装',
  )
})
