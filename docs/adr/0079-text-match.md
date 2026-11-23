# ADR 0079：文本匹配统一（通配、路径 glob、列表搜索）

状态：已接受 · 2026-11-23

## 背景

「可统一能力盘点」第 10 项：路径 glob 有 5 份（hooks、项目教训、测试步骤、表格的两处），`**/` 能不能匹配零层、不带通配的写法算不算目录前缀各不一样；UE 插件里两个 `wildcard` 参数顺序相反；列表搜索有的分词有的不分，只有表格的文件树认拼音首字母。

## 决策

`shared/text-match/index.ts`（开放给插件）：

- `wildcard(subject, pattern)`：`*` 任意串、`?` 一个字符，不分大小写，被比的在前（和 UE 的 `FString::MatchesWildcard` 一样）。
- `globRe` / `globMatch(glob, file, { ignoreCase?, dirPrefix? })`：`**/` 能匹配零层，`*` 不跨 `/`，`{a,b}`；`dirPrefix` 时不带通配的写法按目录前缀算（教训、测试步骤的 paths）。编译结果缓存。
- `textHit(fields, query)`：空格分开的词都要命中某个字段，纯字母的词也认拼音首字母；`textScore(text, query)`：整句 > 开头 > 词首 > 包含 > 拼音首字母，排序用。

已换过来的：hooks 的 `globMatch`、教训的 `globToRegExp`、测试步骤的 `matchesGlob`、带搜索的下拉 `filterOptions`、树搜索 `hitText`（高亮按词）、表格的 `globHit` / `pathGlobRe` / 页签通配 / 文件树搜索、UE 的危险命令匹配、批量 select 的通配、GM 快速执行栏的补全排序。

## 影响

- 新写的通配、glob、列表搜索一律用这里的，不再自己拼正则。
- `**/` 现在能匹配零层：hooks 的 `src/**/*.ts` 能匹配 `src/a.ts`（以前不能），教训和表格本来就能。
- UE 的「跳到」搜索（插件 `ue/web/jump/index-match.ts`）保持自己的打分：它对几十万条预先小写好的资源路径逐条比，还要认贴进来的对象路径，换成通用打分会慢一截。
