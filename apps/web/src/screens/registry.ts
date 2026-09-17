// mission-app · apps/web/src/screens/registry.ts
//
// **屏注册表**（需求专篇 DES-APP-001 §1）：屏 ↔ 宿主步号 ↔ 左导航 ↔ 显示模式。
//
// ★ 为什么要有它：图上流程是 **20 屏**，而宿主只认 11 步（`config.json` 的 `flow.steps`）。
//   两者不是一一对应：一步可能对应 2–3 屏（例：步 6 = 链路拓扑 SH-07 / 链路稳定 SH-08 / 侦察展开 SH-09）。
//   所以"到第几步"由宿主说了算（`state.step`），"这一步里的哪一屏"由本表 + 用户点击决定，
//   并且可以用 `?screen=SH-09` 深链直达（截图脚本用）。
import type { NavKey } from '../shell/AppShell'

export interface ScreenDef {
  /** 屏编号（与需求专篇 §3 一致） */
  id: string
  /** 屏名（按参考图；用于左上角流程徽标与截图文件名） */
  title: string
  /** 左导航高亮项（按参考图） */
  nav: NavKey
  /** 该屏属于宿主的哪一步（大屏 SH-19/SH-20 不属于任何步 → 空数组） */
  steps: number[]
  /** 地图右上"显示模式"下拉的取值（按参考图；无 → 该屏图上没有这个控件） */
  displayMode?: string
}

export const SCREENS: ScreenDef[] = [
  { id: 'SH-01', title: '启动加载界面', nav: '态势', steps: [1] },
  { id: 'SH-02', title: '自检校验界面', nav: '态势', steps: [2] },
  { id: 'SH-03', title: '任务态势主界面', nav: '态势', steps: [3], displayMode: '综合态势' },
  { id: 'SH-04', title: '场景确认界面', nav: '态势', steps: [3], displayMode: '综合态势' },
  { id: 'SH-05', title: '集群编组界面', nav: '任务', steps: [4], displayMode: '综合态势' },
  { id: 'SH-06', title: '方案确认界面', nav: '任务', steps: [5], displayMode: '综合态势' },
  { id: 'SH-07', title: '链路拓扑界面', nav: '任务', steps: [6] },
  { id: 'SH-08', title: '链路稳定界面', nav: '任务', steps: [6] },
  { id: 'SH-09', title: '侦察展开地图界面', nav: '态势', steps: [6], displayMode: '侦察展开' },
  { id: 'SH-10', title: '侦察数据融合界面', nav: '态势', steps: [7], displayMode: '侦察融合' },
  { id: 'SH-11', title: '目标列表界面', nav: '态势', steps: [7], displayMode: '目标识别' },
  { id: 'SH-12', title: '目标详情界面', nav: '态势', steps: [7], displayMode: '目标识别' },
  { id: 'SH-13', title: 'AI决策界面', nav: '态势', steps: [8], displayMode: '任务规划' },
  { id: 'SH-14', title: '打击确认界面', nav: '态势', steps: [9], displayMode: '打击确认' },
  { id: 'SH-15', title: '执行态势界面', nav: '态势', steps: [10], displayMode: '实时态势' },
  { id: 'SH-16', title: '引导控制界面', nav: '态势', steps: [10], displayMode: '引导控制' },
  { id: 'SH-17', title: '毁伤评估地图界面', nav: '态势', steps: [10], displayMode: '复核态势' },
  { id: 'SH-18', title: '任务总结界面', nav: '态势', steps: [11], displayMode: '结果汇总' },
  { id: 'SH-19', title: '任务执行态势（大屏）', nav: '态势', steps: [] },
  { id: 'SH-20', title: '红方侦察态势（大屏）', nav: '态势', steps: [] },
]

export const SCREEN_BY_ID: Record<string, ScreenDef> = Object.fromEntries(SCREENS.map((s) => [s.id, s]))

/** 宿主步号 → 该步的**默认屏**（按图：进这一步先看到哪一屏，与 `steps` 的先后无关）。 */
export const STEP_DEFAULT: Record<number, string> = {
  1: 'SH-01',   // 启动加载界面（无交互，自动跳 SH-02）
  2: 'SH-02',   // 自检校验界面
  3: 'SH-03',   // 任务态势主界面
  4: 'SH-05',   // 集群编组界面
  5: 'SH-06',   // 方案确认界面
  6: 'SH-07',   // 链路拓扑界面
  7: 'SH-09',   // 侦察展开地图界面（图上"进入侦察阶段"落在这里；融合/目标是它的后续屏）
  8: 'SH-13',   // AI决策界面
  9: 'SH-14',   // 打击确认界面
  10: 'SH-15',  // 执行态势界面
  11: 'SH-18',  // 任务总结界面
}

export function defaultScreenForStep(step: number): string {
  return STEP_DEFAULT[step] ?? SCREENS.find((s) => s.steps.includes(step))?.id ?? 'SH-03'
}

/** 某一步可用的屏（用于"本步内有几屏"的提示与测试）。 */
export function screensOfStep(step: number): ScreenDef[] {
  return SCREENS.filter((s) => s.steps.includes(step))
}

/**
 * 左导航点击 → 去哪一屏（按图：导航是"功能视图"入口）。
 * 本期只实现"态势/任务/目标"三个入口（对应现有的屏组），其余按图保留但如实提示未实现。
 */
export const NAV_TARGET: Partial<Record<NavKey, { screens: string[]; needStep: number }>> = {
  态势: { screens: ['SH-03', 'SH-04', 'SH-09', 'SH-10', 'SH-11', 'SH-12', 'SH-13', 'SH-14', 'SH-15', 'SH-16', 'SH-17', 'SH-18'], needStep: 3 },
  任务: { screens: ['SH-05', 'SH-06', 'SH-07', 'SH-08'], needStep: 4 },
  目标: { screens: ['SH-11', 'SH-12'], needStep: 7 },
}
