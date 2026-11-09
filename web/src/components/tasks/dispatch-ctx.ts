import { createContext } from 'react'

/**
 * 最新一轮：这一轮里没办完的派单画成带操作的现场行，运行区不再重复列它们
 * （设计稿：回复折叠与派单行重设计 §5.2）；旧轮里的只画精简的一行，现场行在运行区
 */
export const LatestTurnCtx = createContext(false)

/**
 * 最新一轮里已经画在原位的对象：运行区跳过它们。后台命令不在里面：它的派单行还是原来的工具行，
 * 没有计时和终止，现场行照旧留在运行区
 */
export interface InPlace {
  children: Set<string>
  helpers: Set<string>
}
export const InPlaceCtx = createContext<InPlace | null>(null)
