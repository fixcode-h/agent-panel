/**
 * 右栏默认宽度：没有拖动记录时，右栏和中间对话各占一半（用户 2026-11 提的「功能面板和对话面板各占一半」）。
 * 这里测的就是界面上量到的那条口径：这一行分给右栏一半；容器还没挂上时按窗口减掉左栏估算；窄窗口按下限。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paneHalfWidth, RAIL_WIDTH, rowWidthFromWindow } from './pane-width.ts'

test('常规窗口：右栏和中间对话各占一半', () => {
  // 1440 的窗口：左栏 224，剩下的 1216 各占 608
  assert.equal(paneHalfWidth(rowWidthFromWindow(1440), 320), 608)
  assert.equal(paneHalfWidth(rowWidthFromWindow(1920), 320), 848)
  // 除不尽时四舍五入，两边最多差 1px
  assert.equal(paneHalfWidth(rowWidthFromWindow(1441), 320), Math.round((1441 - RAIL_WIDTH) / 2))
  // AI 分析窗口比窗口窄（弹窗内缩），按自己那一行量出来才是真的对半
  assert.equal(paneHalfWidth(1352, 320), 676)
})

test('窄窗口：一半小于下限时按下限，不把右栏压没', () => {
  // 1000 的窗口一半是 388，还在下限之上、仍是对半；800 只有 288，按下限 320
  assert.equal(paneHalfWidth(rowWidthFromWindow(1000), 320), 388)
  assert.equal(paneHalfWidth(rowWidthFromWindow(800), 320), 320)
  // 正好一半等于下限的时候还是对半
  assert.equal(paneHalfWidth(640, 320), 320)
})
