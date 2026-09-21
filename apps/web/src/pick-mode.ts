// mission-app  apps/web/src/pick-mode.ts
//
// **选择模式：浏览 / 编辑**（2026-09-20 需求："选择按钮应该是两个状态 
//   浏览：只拖地图、缩放，点图元不选中；编辑：点图元  高亮，可拖拽编辑位置，点位吸附"）。
//
// 为什么单独放一个模块：这个模式要**跨组件**用 
//    态势屏的工具条：显示当前模式、点击切换；
//    MapStage（全局地图）：决定"点图元要不要选中/高亮、要不要进编辑态、按 Delete 要不要弹删除确认"。
// 所以做成一个极小的全局 store，两边都读它（默认浏览）。
import { create } from 'zustand'

export type PickMode = 'browse' | 'edit'

interface PickModeState {
  mode: PickMode
  setMode(m: PickMode): void
}

export const usePickMode = create<PickModeState>((set) => ({
  /** 默认「浏览」（2026-09-20 需求方定：进来就是纯看图，切到编辑才可能改图元） */
  mode: 'browse',
  setMode(m) { set({ mode: m }) },
}))

/** 给事件回调（非 React 场景）读当前模式用 */
export const pickModeNow = (): PickMode => usePickMode.getState().mode
