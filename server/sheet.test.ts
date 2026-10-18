import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sheetProblems } from '../shared/design.ts'

test('图集只放尺寸统一的小图标', () => {
  const icon = (id: string, w: number, sheet = 'items') => ({ id, width: w, height: w, sheet })
  assert.deepEqual(sheetProblems([icon('a', 96), icon('b', 96), icon('c', 96)]), [])
  assert.equal(sheetProblems([icon('a', 96), icon('b', 400)]).length, 2)
  assert.match(sheetProblems([icon('a', 96), icon('b', 128)])[0], /不统一/)
  assert.deepEqual(sheetProblems([{ id: 'bg', width: 1920, height: 1080 }]), [])
})
