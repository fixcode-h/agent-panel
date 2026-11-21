/**
 * 面板自己的提示词里写的工具参数名要和工具真实的参数表一致（A2，designs/Agent写代码能力-提升与扩展分析.md）。
 *
 * 为什么要测：提示词、工具说明、报错里常写「spawn_agents 的 resume」「submit_merge 里传 review_override」，
 * 工具改了参数名，这些话不会跟着改，模型照着写就是一次失败的调用（#398 是别家工具的同一类问题）。
 * 这里扫描 shared/、server/、skills/ 里「工具名 的 / 里传 / 带 参数名」这种写法，参数名必须在那个工具的 inputSchema 里
 * （任一层的属性名，或者枚举取值）。说的是返回里的字段（不是参数）的，登记在 OUTPUT_FIELDS。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { Orchestra } from '../../shared/engine/host.ts'
import { AUDIENCE_REPS } from '../mcp-catalog/audiences.ts'
import { PANEL_TOOLS } from './registry.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** 这些写法说的是工具返回里的字段：「list_conversations 里的 id」是列出来的子对话编号，不是参数 */
const OUTPUT_FIELDS: Record<string, string[]> = {
  list_conversations: ['id'],
  request_user_action: ['id'],
}

/** 每个工具在任一身份下的全部参数名和枚举取值：同一个工具不同身份给的参数不一样（submit_merge 只有独立分支才有 build） */
function contractWords(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const walk = (s: unknown, words: Set<string>) => {
    if (!s || typeof s !== 'object') return
    const o = s as Record<string, unknown>
    if (Array.isArray(o.enum)) for (const v of o.enum) words.add(String(v))
    if (o.properties && typeof o.properties === 'object')
      for (const [k, v] of Object.entries(o.properties)) {
        words.add(k)
        walk(v, words)
      }
    walk(o.items, words)
    for (const k of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(o[k])) for (const x of o[k] as unknown[]) walk(x, words)
  }
  for (const rep of Object.values(AUDIENCE_REPS))
    for (const ueBuild of ['', 'child', 'parent'] as const)
      for (const isolated of [true, false]) {
        const o = { ...rep, ueBuild, isolated } as Orchestra
        for (const t of PANEL_TOOLS) {
          if (!t.def || !t.when(o)) continue
          const words = out.get(t.name) ?? new Set<string>()
          walk(t.def(o).inputSchema, words)
          out.set(t.name, words)
        }
      }
  return out
}

function sources(): string[] {
  const files: string[] = []
  const rec = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f.startsWith('.') || f === 'fixtures') continue
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) rec(p)
      else if (/\.(ts|md)$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p)
    }
  }
  for (const d of ['shared', 'server', 'skills']) rec(path.join(ROOT, d))
  return files
}

test('提示词里写的面板工具参数名都在工具的参数表里', () => {
  const words = contractWords()
  // 长名字排前面：免得 finish_plan 先被 plan 这种短名字截走（现在没有，但名字是会加的）
  const names = [...words.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(`\\b(${names.join('|')})\`?\\s*(?:的|里传|里的|里|带上|带|传)\\s*\`?([a-z][a-z0-9_]*)\\b`, 'g')
  const bad: string[] = []
  let seen = 0
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(re)) {
      seen++
      const [, tool, word] = m
      if (words.get(tool)?.has(word) || OUTPUT_FIELDS[tool]?.includes(word)) continue
      const line = text.slice(0, m.index).split('\n').length
      bad.push(`${path.relative(ROOT, file)}:${line} 「${m[0]}」：${tool} 没有参数 ${word}`)
    }
  }
  // 扫描本身要真的扫到东西：写法变了（全换成别的连接词）时这条测试会悄悄变成空检查
  assert.ok(seen > 30, `只扫到 ${seen} 处，扫描的写法可能对不上了`)
  assert.deepEqual(bad, [], `提示词里写的参数名和工具的参数表对不上：\n${bad.join('\n')}`)
})
