import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiConfig, apiVars } from './accounts.ts'
import { apiBalanceUrl, apiBaseUrl, isVendorUrl } from './api-vendors.ts'

/** 选了 DeepSeek、接口地址留空的一条 API：地址全按厂家默认解析 */
const deepseek = ApiConfig.parse({ id: 'a1', name: 'DeepSeek', protocol: 'openai-chat' })

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

test('认得出哪些地址是内置厂家给的（旧版本写进真实值的那些）', () => {
  assert.equal(isVendorUrl('https://api.deepseek.com/v1'), true)
  assert.equal(isVendorUrl('  https://api.openai.com/v1  '), true)
  assert.equal(isVendorUrl('https://mine.example.com/v1'), false)
  assert.equal(isVendorUrl(''), false)
})

test('余额接口：厂家定义里有才能查', () => {
  assert.equal(apiBalanceUrl({ name: 'DeepSeek' }), 'https://api.deepseek.com/user/balance')
  assert.equal(apiBalanceUrl({ name: 'OpenAI' }), '')
  assert.equal(apiBalanceUrl({ name: '自定义 API' }), '')
})
