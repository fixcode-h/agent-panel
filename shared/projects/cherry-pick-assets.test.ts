import assert from 'node:assert/strict'
import test from 'node:test'
import { assetExtsOf, isAssetPath, parseAssetExts } from './cherry-pick-assets.ts'

test('cherry-pick 资源文件清单：几种写法都认，没设时用默认，设成空只看二进制', () => {
  assert.deepEqual(parseAssetExts('uasset, *.PNG，.umap  .uasset\n带/路径'), ['.uasset', '.png', '.umap'])
  assert.ok(assetExtsOf(undefined).includes('.uasset'))
  assert.ok(assetExtsOf({}).includes('.umap'))
  assert.deepEqual(assetExtsOf({ cherryPickAssets: [] }), [])
  assert.equal(isAssetPath('Content/UI/Hero.UASSET', ['.uasset']), true)
  assert.equal(isAssetPath('Source/Hero.cpp', ['.uasset']), false)
  assert.equal(isAssetPath('.png', ['.png']), false, '只有扩展名、没有文件名的不算')
})
