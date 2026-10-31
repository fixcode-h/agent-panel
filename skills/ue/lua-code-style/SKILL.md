---
name: lua-code-style
description: 编写或修改 Lua 代码时使用；规定换行（一条语句写一行，条件表达式、return 表达式、函数调用不按列宽拆成续行）、常用写法（local、`:` 与 `.`、拼接）、校验与防御（什么时候判空、什么时候做类型校验，避免过度防御）和日志（格式 `[模块名称] 类名/模块名=>函数名  具体日志内容`，避免高频日志），缩进、命名、引号沿用项目既有约定。触发：写或改 Lua 代码、Lua 排版、Lua 日志。不用于 C++/UE 或 C#。
user-invocable: true
---

# Lua 代码格式

## 使用边界

只约束新增或修改的 Lua 代码的排版与日志；不批量重排或重写未涉及的旧代码和旧日志，不改变现有日志接口、过滤或级别语义。缩进、命名、引号等本技能没写的格式沿用所在文件的写法。模块与状态、元表、生命周期、协程、热重载、序列化和性能等架构规则不属于本技能范围。

## 换行

**一条语句写一行，不按列宽换行。** `if` / `elseif` / `while` 的条件、`return` 后的表达式、赋值右边、函数调用和参数列表，都写在同一行，不管有多少个 `and` / `or`、这一行有多长。不要自己设一个 80 或 120 列的上限去折行。

```lua
-- 错：条件被拆成续行
return CurrentState == ZoneState.EntryPreparing or CurrentState == ZoneState.Underground
    or CurrentState == ZoneState.ExitPreparing

if CurrentState == ZoneState.EntryPreparing or CurrentState == ZoneState.Underground
    or CurrentState == ZoneState.ExitPreparing then

-- 对：整条写在一行
return CurrentState == ZoneState.EntryPreparing or CurrentState == ZoneState.Underground or CurrentState == ZoneState.ExitPreparing

if CurrentState == ZoneState.EntryPreparing or CurrentState == ZoneState.Underground or CurrentState == ZoneState.ExitPreparing then
```

- 唯一例外：项目里有格式化配置明确规定了列宽（如 `.stylua.toml` 的 `column_width`、`.editorconfig` 的 `max_line_length`），按配置来；没有配置就不折行。
- 条件真的复杂到一行看不懂（多层括号混着 `and` / `or`），把其中一部分提成命名清楚的局部变量或函数，不要拆成续行。像上面这样几个同类比较连起来的，照样写一行，不提取。
- 多行 table 构造、多行字符串、函数体本身照常分行；这一条只管「一个表达式被拆到几行」。
- 改已有代码时，原来就折了行的不顺手合并，除非就是这次要改的那一句。

## 写法

- 变量和函数默认加 `local`，不制造全局变量；模块对外的内容放进模块 table 返回。
- 类 / 对象方法用 `:` 定义和调用（`function Foo:Bar()`、`obj:Bar()`），模块函数用 `.`，两者不混。
- 判空写 `if not value then`；要区分 `false` 和 `nil` 时写 `value == nil`。不等用 `~=`。
- 字符串里拼可能为 `nil` 或非字符串的值先包 `tostring()`，`..` 遇到 `nil` 会直接报错；循环里拼大量字符串用 `table.concat`。
- 提前 `return` 处理异常分支，少套 `if` 层级；一行只写一条语句，不用 `;` 把几条挤在一行。
- 命名、缩进、引号跟所在文件；注释写「为什么」，不复述代码。

## 校验与防御：不过度

先问一句：**这个值从哪来，会不会真的是 nil 或别的类型？** 只有答案是「会」时才写检查。

**不加检查：**

- 调用方都在项目里、传什么很清楚的参数：内部函数、私有方法、同模块里互相调用的函数。不对这类参数做 `type()` 判断，也不逐个判空。
- 刚创建、刚赋值、刚检查过的值；上一层已经判过空的，下一层不再判。
- 生命周期有保证的成员：在 `Init` / 构造里一定赋值的字段，后面的方法直接用。
- 不写 `x = x or {}`、`if type(cb) == "function" then cb() end` 这种「以防万一」的兜底，除非这个参数本来就是可选的。

**可以判空（nil 是正常结果时）：**

- 查找类结果：`table[key]`、`FindXxx` / `GetXxx` 可能找不到，配置表里可能没这一行。
- 可选参数：文档或调用处明确允许不传，判空后给默认值。
- 异步回调、定时器、事件回调里用到的对象：回调到来时对象可能已销毁，用项目已有的有效性检查（如 `IsValid`）判一次。
- 宿主（C++ / UE）传进来、可能为空的对象。

**才做类型校验（来源不可控时）：**

- 外部数据：网络协议、存档、服务器下发、读进来的 JSON / 配置、玩家输入、GM 命令。
- 对外公开、调用方很多且不受控的通用接口（工具库、框架层 API），在入口校验一次即可。
- 函数本来就接受多种类型（如参数可以是 id 或 table），用 `type()` 分支处理。

**检查失败时：**

- 不能悄悄 `return` 把 bug 吞掉。nil 是正常情况就按正常流程处理（不打日志或给默认值）；nil 本不该出现就用 `LogError` 打一条或直接 `error` / `assert`，让问题暴露出来。
- 一个值只在进入可信区域的那一处检查，不在调用链每层都检查一遍。

```lua
-- 错：内部方法，参数来源明确，却逐个做类型判断和判空
function ZoneMgr:SetState(state, reason)
    if state == nil or type(state) ~= "number" then return end
    if reason ~= nil and type(reason) ~= "string" then return end
    self.CurrentState = state
end

-- 对：直接用；只在真的可能找不到的地方判空
function ZoneMgr:SetState(state)
    self.CurrentState = state
end

function ZoneMgr:EnterZone(zoneId)
    local cfg = ZoneConfig[zoneId]
    if not cfg then
        LogError("[区域] ZoneMgr=>EnterZone  缺少区域配置 zoneId=" .. tostring(zoneId))
        return
    end
    self:SetState(cfg.InitState)
end
```

## 日志

格式不变：

```text
类/对象方法：  [模块名称] 类名=>函数名  具体日志内容
模块函数：     [模块名称] 模块名=>函数名  具体日志内容
```

- 函数标识必须带定位，不能只写函数名；`[模块名称]` 后一个空格，函数标识和内容之间固定**两个**空格。
- 先确认日志所在的类 / 对象和函数，不根据文件名或日志内容去猜。
- 级别由已有日志接口表达（如 `LogError`、`LogWarn`），消息里不加 `Error=>` 之类的前缀；不新增日志函数或包装器。
- **避免高频日志，只在必要路径加必要的日志**：必要路径指失败 / 异常分支、重要状态切换、关键流程的结果。Tick、每帧回调、循环体、频繁调用的函数里一律不打；不给每一步打「开始 / 结束」；成功的常规路径默认不打；排查用的临时日志改完删掉。一条日志写清一件事，只带定位需要的关键参数。

```lua
-- 类/对象方法：类名=>函数名（接口名仅为示意，换成项目已有的）；只在失败分支打
function HomeDecoration:ApplyMaterial(materialId)
    local material = self:FindMaterial(materialId)
    if not material then
        LogError("[家园装饰] HomeDecoration=>ApplyMaterial  找不到材质 materialId=" .. tostring(materialId))
        return false
    end
    return self:SetMaterial(material)
end

-- 模块函数：模块名=>函数名
local function RefreshList()
    LogWarn("[家园装饰] HomeDecorationModule=>RefreshList  列表为空，跳过刷新")
end
```

## 自检

写完或改完逐条看：

1. 没有过度防御：来源明确的参数没做类型判断和判空，只在找不到 / 可选 / 异步 / 外部数据处检查，检查失败没有悄悄吞掉。
2. 新变量和函数都是 `local`，`:` / `.` 没混用，拼接的值不会是 `nil`。
3. 新写的条件、`return`、赋值、函数调用没有被拆成续行（项目格式化配置规定了列宽的除外）。
4. 日志是 `[模块名称] 类名/模块名=>函数名  具体日志内容`，定位完整、两个空格、没有级别前缀，只打在必要路径、没有高频日志。
5. 用的是项目已有日志接口，没有新增包装器；没动范围外的旧代码。
