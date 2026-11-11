/** 导表脚本的占位替换：按命令行环境加引号、外面写了引号不重复加、有 {files} 时只执行一次 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportLines, fillCommand, quoteFor } from './table-export.ts'

test('加引号：sh 普通路径不加、带空格用单引号；cmd 用双引号；PowerShell 单引号里的单引号写两个', () => {
  assert.equal(quoteFor('sh', '/a/b.xlsx'), '/a/b.xlsx')
  assert.equal(quoteFor('sh', "/a b/it's.xlsx"), `'/a b/it'\\''s.xlsx'`)
  assert.equal(quoteFor('cmd', 'D:\\表 格\\a.xlsx'), '"D:\\表 格\\a.xlsx"')
  assert.equal(quoteFor('powershell', "D:\\x'y.xlsx"), "'D:\\x''y.xlsx'")
})

test('占位：外面有引号原样放；不认识的花括号留着', () => {
  assert.equal(fillCommand('tool "{file}" {x}', { file: 'D:\\a b.xlsx' }, 'cmd'), 'tool "D:\\a b.xlsx" {x}')
  assert.equal(
    fillCommand('tool {file} -o {project}/out', { file: '/p/a b.xlsx', project: '/p' }, 'sh'),
    "tool '/p/a b.xlsx' -o /p/out",
  )
})

test('每张表执行一次；写了 {files} 时一次传全部', () => {
  const ts = [
    { file: '/p/T/Item.xlsx', rel: 'T/Item.xlsx' },
    { file: '/p/T/Role.csv', rel: 'T/Role.csv' },
  ]
  assert.deepEqual(exportLines('exp {file} {name} {folder} {rel}', ts, '/p', 'sh'), [
    'exp /p/T/Item.xlsx Item /p/T T/Item.xlsx',
    'exp /p/T/Role.csv Role /p/T T/Role.csv',
  ])
  assert.deepEqual(exportLines('exp {files}', ts, '/p', 'sh'), ['exp /p/T/Item.xlsx /p/T/Role.csv'])
  assert.deepEqual(exportLines('exp {file}', [], '/p', 'sh'), [])
})

test('占位写在一段引号里：不再加引号，只转义会打断引号的字符', () => {
  assert.equal(fillCommand('echo "out/{name}.json"', { name: 'a b' }, 'sh'), 'echo "out/a b.json"')
  assert.equal(fillCommand('echo "x{name}"', { name: 'a"$b' }, 'sh'), 'echo "xa\\"\\$b"')
  assert.equal(fillCommand("echo 'x{name}'", { name: "it's" }, 'sh'), "echo 'xit'\\''s'")
  assert.equal(fillCommand('echo "a\\"{name}" {name}', { name: 'q r' }, 'sh'), `echo "a\\"q r" 'q r'`)
  assert.equal(fillCommand("tool '{file}'", { file: 'D:\\a b.xlsx' }, 'cmd'), `tool '"D:\\a b.xlsx"'`)
})
