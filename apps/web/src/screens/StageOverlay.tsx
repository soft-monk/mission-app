// mission-app · apps/web/src/screens/StageOverlay.tsx
//
// 步 3–5 覆盖层的**外壳**：处理两件跟业务无关、但不处理就难看/难读的事。
//
// ① 顶部压条（`StageStrip`）：把 `MapStage` 顶部那条自证信息条盖住，换成与参考图一致的
//    "显示模式 / 阶段 / 链路 / 无人机"一行。**压在它上面而不是改它**（MapStage 是主 agent 的
//    文件）：排障后门 `?stage=map` 仍然能看到原始信息条。
//    配套的一条页面级 CSS 写在 `index.html` 里（`[data-ma-stagestrip]`）：那条信息条的
//    末项是 `/health` 的原始文本（实测 3.6 KB 一行），不截断就会换行把地图挤下去。
//
// ② 覆盖层容器：只负责铺一层"不挡地图"的绝对定位层（pointer-events 交给各面板自己）。
import type { CSSProperties, ReactNode } from 'react'
import { C } from '../theme'

/** 覆盖层层壳：不额外包一层定位容器（各面板自己绝对定位到地图台那一层），只做统一入口。 */
export function StageOverlay({ children }: { children: ReactNode }) {
  return <>{children}</>
}

/**
 * 顶部压条（高度 28 px，正好压住 MapStage 那条信息条）。
 * 里面每一项都来自宿主负载或本屏 verb 的回执，**没有写死的业务值**。
 */
export function StageStrip({ items, right }: { items: { k: string; v: string; color?: string }[]; right?: ReactNode }) {
  return (
    <div style={stripStyle}>
      {items.map((it) => (
        <span key={it.k} style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline' }}>
          <span style={{ color: C.textDim }}>{it.k}</span>
          <span style={{ color: it.color ?? C.text }}>{it.v}</span>
        </span>
      ))}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  )
}

const stripStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, top: 0, height: 28, zIndex: 19,
  display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px',
  background: 'rgba(4,24,47,.94)', borderBottom: `1px solid ${C.border}`,
  fontSize: 12, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none',
}
