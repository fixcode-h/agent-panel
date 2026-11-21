/**
 * 编译报错里「接口没对上」的几类：按错误码认、取出符号，中英文 VS 和 clang 都认。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { compileHintText, compileHits } from './hints.ts'
import { digestLines, digestText } from '../log-digest.ts'

const sym = (lines: string[]) => compileHits(lines).map((h) => `${h.id} ${h.symbol}`)

test('英文 MSVC：不是成员拼上类型，找不到、参数不对取名字，链接错误从签名取函数名', () => {
  assert.deepEqual(
    sym([
      "G:/P/Source/A.cpp(12): error C2039: 'GetTopLocation': is not a member of 'AHomeActor'",
      "G:/P/Source/A.cpp(13): error C3861: 'FindWidget': identifier not found",
      "G:/P/Source/A.cpp(14): error C2065: 'GWorldX': undeclared identifier",
      "G:/P/Source/A.cpp(15): error C2660: 'UGameplayStatics::GetPlayerController': function does not take 1 arguments",
      "G:/P/Source/A.cpp(16): error C2664: 'void UMyLib::Apply(const FVector &)': cannot convert argument 1 from 'int' to 'const FVector &'",
      'Module.A.cpp.obj : error LNK2019: unresolved external symbol "__declspec(dllimport) public: void __cdecl USomeSubsystem::Refresh(int)" (__imp_?Refresh@USomeSubsystem@@QEAAXH@Z) referenced in function "void __cdecl Foo(void)"',
    ]),
    [
      'not-member AHomeActor::GetTopLocation',
      'undeclared FindWidget',
      'undeclared GWorldX',
      'args UGameplayStatics::GetPlayerController',
      'args UMyLib::Apply',
      'link USomeSubsystem::Refresh',
    ],
  )
})

test('中文 VS 的说明是中文：按错误码认，从中文引号里取名字', () => {
  assert.deepEqual(
    sym([
      'G:/P/Source/A.cpp(12): error C2039: “GetTopLocation”: 不是“AHomeActor”的成员',
      'G:/P/Source/A.cpp(13): error C3861: “FindWidget”: 找不到标识符',
      'G:/P/Source/A.cpp(15): error C2660: “UFoo::Bar”: 函数不接受 2 个参数',
      'A.cpp.obj : error LNK2001: 无法解析的外部符号 "public: static class UClass * __cdecl UFoo::StaticClass(void)" (?StaticClass@UFoo@@SAPEAVUClass@@XZ)',
    ]),
    ['not-member AHomeActor::GetTopLocation', 'undeclared FindWidget', 'args UFoo::Bar', 'link UFoo::StaticClass'],
  )
})

test('clang：按英文说明认，类型去掉 class 前缀；同一个符号报多次只列一次', () => {
  assert.deepEqual(
    sym([
      "/p/A.cpp:12:5: error: no member named 'GetTopLocation' in 'AHomeActor'",
      "/p/A.cpp:13:5: error: no member named 'GetTopLocation' in 'AHomeActor'",
      "/p/A.cpp:14:5: error: use of undeclared identifier 'FindWidget'",
      "/p/A.cpp:15:5: error: no matching member function for call to 'Apply'",
      "A.o: undefined reference to `USomeSubsystem::Refresh(int)'",
    ]),
    ['not-member AHomeActor::GetTopLocation', 'undeclared FindWidget', 'args Apply', 'link USomeSubsystem::Refresh'],
  )
})

test('别的错误不提醒；提醒里写清先查签名、怎么查', () => {
  assert.equal(
    compileHintText(["A.cpp(1): error C2143: syntax error: missing ';' before '}'", 'a.ts(1,2): error TS2322: x']),
    '',
  )
  const s = compileHintText(["A.cpp(12): error C2039: 'Foo': is not a member of 'UBar'"])
  assert.match(s, /`UBar::Foo`（不是成员）/)
  assert.match(s, /get_members type_name=/)
  assert.match(s, /不要换个名字/)
})

test('编译失败的提炼里带上提醒，成功的不带', () => {
  const lines = ["A.cpp(12): error C2039: 'Foo': is not a member of 'UBar'", 'Build failed']
  const d = digestLines(lines)
  assert.match(digestText(lines, d, false), /接口没对上/)
  assert.doesNotMatch(digestText(lines, d, true), /接口没对上/)
})
