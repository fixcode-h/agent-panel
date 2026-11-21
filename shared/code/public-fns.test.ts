import assert from 'node:assert/strict'
import test from 'node:test'
import { publicFnsAdded, publicFnsInDiff } from './public-fns.ts'

test('新增公开函数：TS 认 export function 和 export const 箭头函数，不认内部函数和普通常量', () => {
  assert.deepEqual(
    publicFnsAdded('src/a.ts', [
      'export function topLocation(actor: Actor) {',
      'export async function load() {',
      'export const sum = (a: number, b: number): number => a + b',
      'export const LIMIT = 3',
      'function helper() {}',
      'const local = () => 1',
    ]),
    ['topLocation', 'load', 'sum'],
  )
})

test('新增公开函数：UE 头文件认 UFUNCTION 下一行的声明和 XXX_API 导出，不认 class XXX_API', () => {
  assert.deepEqual(
    publicFnsAdded('Source/Game/Public/HomeLib.h', [
      '\tUFUNCTION(BlueprintCallable, Category = "Home")',
      '\tstatic FVector GetActorTopLocation(const AActor* Actor);',
      'GAME_API void Execute();',
      'class GAME_API UHomeLib : public UBlueprintFunctionLibrary',
      '\tvoid PrivateHelper();',
    ]),
    ['GetActorTopLocation', 'Execute'],
  )
  assert.deepEqual(publicFnsAdded('Source/Game/Private/HomeLib.cpp', ['GAME_API void Execute() {}']), [])
})

test('新增公开函数：Lua 认模块表上的函数，不认 local function；Python 只认顶层非下划线', () => {
  assert.deepEqual(
    publicFnsAdded('Script/Home.lua', [
      'function M.GetTop(actor)',
      'function M:OnClick()',
      'M.Reset = function()',
      'local function inner()',
    ]),
    ['GetTop', 'OnClick', 'Reset'],
  )
  assert.deepEqual(publicFnsAdded('tool.py', ['def run(x):', 'def _hidden():', '    def nested():']), ['run'])
  assert.deepEqual(publicFnsAdded('README.md', ['export function x() {}']), [])
})

test('新增公开函数：从 git diff 里按文件取，只看加号行，删掉的文件不算', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    '-export function old() {}',
    '+export function fresh() {}',
    ' export function kept() {}',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '-export function gone() {}',
  ].join('\n')
  assert.deepEqual(publicFnsInDiff(diff), [{ path: 'src/a.ts', name: 'fresh' }])
})
