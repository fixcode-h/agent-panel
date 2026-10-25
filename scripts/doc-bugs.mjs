// 按 docs/modules/<模块>/bugs/<bug-id>.md 的元数据重新生成 bugs.md 索引。
// 默认模式改写索引；`--check` 只判定（给 npm run lint 用），不一致就退出码 1。
// 两种模式都复查详情文件的必填字段：写完索引再跑一遍判定，剩下的就是「缺字段」这类
// 生成前就有、写完也不会消失的问题，让跑命令的人当场看到，而不是等到 npm run lint。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBugIndexesInRoot, syncBugIndexesInRoot } from './lib/doc-bugs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

// --check 不改文件；默认模式先重写再判定，判定的是刚写完的结果
const written = check ? [] : syncBugIndexesInRoot(root)
if (!check) {
  console.log(written.length ? `已重新生成：${written.join('、')} 的 bugs.md` : 'Bug 索引已是最新，没有改写')
}

const errors = checkBugIndexesInRoot(root)
if (!errors.length) {
  if (check) console.log('Bug 索引和 bugs/ 下的详情文件一致')
} else {
  for (const e of errors) console.error(e)
  process.exitCode = 1
}
