import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiConfig, apiVars } from './accounts.ts'
import { apiBalanceUrl, apiBaseUrl, findVendor, isVendorUrl, vendorEndpoint } from './api-vendors.ts'

/** 选了 DeepSeek、接口地址留空的一条 API：地址全按厂家默认解析 */
const deepseek = ApiConfig.parse({ id: 'a1', name: 'DeepSeek', protocol: 'openai-chat' })
/** OpenDesign：OpenAI 兼容和 Anthropic 两种协议各一个地址，默认协议是 openai-chat */
const openDesign = ApiConfig.parse({ id: 'a2', name: 'OpenDesign', protocol: 'openai-chat' })

test('接口地址：用户填了用用户的，留空时用厂家按协议给的默认地址', () => {
  assert.equal(apiBaseUrl(deepseek), 'https://api.deepseek.com/v1')
  assert.equal(apiBaseUrl({ ...deepseek, baseUrl: '  https://mine.example.com/v1 ' }), 'https://mine.example.com/v1')
  assert.equal(apiBaseUrl({ ...deepseek, protocol: 'anthropic' }), 'https://api.deepseek.com/anthropic')
  // 厂家没有这个协议的地址、或者名字不是内置厂家时没有默认值
  assert.equal(apiBaseUrl({ ...deepseek, protocol: 'gemini' }), '')
  assert.equal(apiBaseUrl({ ...deepseek, name: '自定义 API' }), '')
})

test('写进 CLI 配置的地址也按实际要用的地址算', () => {
  const own = apiVars(deepseek)
  assert.equal(own.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(own.root, 'https://api.deepseek.com')
  // 用户自己填过就用自己的
  assert.equal(apiVars({ ...deepseek, baseUrl: 'https://mine.example.com/v9' }).baseUrl, 'https://mine.example.com/v9')
})

test('OpenDesign 的地址：OpenAI 兼容带 /v1，Anthropic 协议不带 /v1', () => {
  assert.equal(apiBaseUrl(openDesign), 'https://amr-link.open-design.ai/v1')
  assert.equal(apiBaseUrl({ ...openDesign, protocol: 'anthropic' }), 'https://amr-link.open-design.ai')
  // 用户自己填了地址仍以用户填的为准
  assert.equal(apiBaseUrl({ ...openDesign, baseUrl: 'https://mine.example.com/v1' }), 'https://mine.example.com/v1')
})

test('OpenDesign 的默认协议是 openai-chat，不支持当前协议时回退到它', () => {
  // 先断言列表里有这一条：厂家改名时这里给出可读的失败信息，而不是后续的解构报错
  const vendor = findVendor('OpenDesign')
  assert.ok(vendor)
  assert.deepEqual(vendorEndpoint(vendor, 'anthropic'), {
    protocol: 'anthropic',
    baseUrl: 'https://amr-link.open-design.ai',
  })
  // Gemini 这类它没有的协议回退到厂家默认的 openai-chat
  assert.deepEqual(vendorEndpoint(vendor, 'gemini'), {
    protocol: 'openai-chat',
    baseUrl: 'https://amr-link.open-design.ai/v1',
  })
})

test('认得出哪些地址是内置厂家给的（旧版本写进真实值的那些）', () => {
  assert.equal(isVendorUrl('https://api.deepseek.com/v1'), true)
  assert.equal(isVendorUrl('  https://api.openai.com/v1  '), true)
  // 切换厂家或协议时这两个地址要被认出来清掉，两种协议都要认
  assert.equal(isVendorUrl('https://amr-link.open-design.ai/v1'), true)
  assert.equal(isVendorUrl('https://amr-link.open-design.ai'), true)
  assert.equal(isVendorUrl('https://mine.example.com/v1'), false)
  assert.equal(isVendorUrl(''), false)
})

test('余额接口：厂家定义里有才能查', () => {
  assert.equal(apiBalanceUrl({ name: 'DeepSeek' }), 'https://api.deepseek.com/user/balance')
  assert.equal(apiBalanceUrl({ name: 'OpenAI' }), '')
  // OpenDesign 没有查证到公开的余额接口，定义里不加 balance，界面上就说明不支持查询
  assert.equal(apiBalanceUrl({ name: 'OpenDesign' }), '')
  assert.equal(apiBalanceUrl({ name: '自定义 API' }), '')
})
