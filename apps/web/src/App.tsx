// mission-app · apps/web/src/App.tsx
//
// 最小页面：一个全屏 <MapView>。
// ★ 纪律：页面**不做任何业务判断** —— 没有阶段规则、没有评分、没有告警逻辑。
//   它只做两件事：① 从宿主拿瓦片模板喂给地图；② 把 /health 与 /stats 的读数显示出来。
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { MapView, type MapData } from 'map-2d'

/** 瓦片模板缺省值（与 config.json 的 tiles.template 一致；运行时以宿主 /runtime-config 为准） */
const DEFAULT_TILE_TEMPLATE = '/tiles/{z}/{x}/{y}.jpg'

interface EngineRow {
  linked: boolean
  instantiated: boolean
  ok: boolean
  note?: string
}

interface RuntimeConfig {
  version: string
  tiles: { template: string }
  stats: { engines: Record<string, EngineRow> }
}

/** 页面用的最小地图数据：只有底图配置，其他图元一律为空（P0 不出业务图元）。 */
function emptyMapData(tileTemplate: string): MapData {
  return {
    config: {
      center: [116.3974, 39.9093],
      zoom: 11,
      minZoom: 3,
      maxZoom: 18,
      basemap: { tileUrlTemplate: tileTemplate, attribution: 'geo-data' },
    },
    scenarioKey: '',
    phase: '',
    targets: [],
    groups: [],
    uavs: [],
    edges: [],
    topology: null,
    track: [],
  } as unknown as MapData
}

const barStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10,
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  padding: '6px 12px',
  background: 'rgba(4, 24, 47, 0.82)',
  borderBottom: '1px solid rgba(95, 176, 255, 0.25)',
  backdropFilter: 'blur(4px)',
  pointerEvents: 'none',
  fontVariantNumeric: 'tabular-nums',
}

const noteStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  zIndex: 10,
  maxWidth: '60vw',
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(4, 24, 47, 0.82)',
  border: '1px solid rgba(95, 176, 255, 0.25)',
  pointerEvents: 'none',
}

export function App() {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null)
  const [health, setHealth] = useState<string>('(未探测)')
  const [note, setNote] = useState<string>('')

  // 装配信息（瓦片模板 + 各引擎是否就绪）。拿不到就用缺省值 —— 页面一样能开。
  useEffect(() => {
    let alive = true
    fetch('/runtime-config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: RuntimeConfig) => { if (alive) setCfg(j) })
      .catch((e: unknown) => { if (alive) setNote(`/runtime-config 没读到（${String(e)}）`) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/health')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (alive) setHealth(t) })
      .catch((e: unknown) => { if (alive) setHealth(`不可达（${String(e)}）`) })
    return () => { alive = false }
  }, [])

  // 瓦片拉不到时给一句提示（地图自己会回落纯色缺口底色，不需要页面兜底逻辑）。
  useEffect(() => {
    const onError = (ev: Event) => {
      const el = ev.target as HTMLElement | null
      const src = el && 'src' in el ? String((el as HTMLImageElement).src) : ''
      if (!src.includes('/tiles/')) return
      setNote('底图瓦片不可达 → 地图回落纯色兜底（P0 不托管瓦片包，这是预期内的）')
    }
    window.addEventListener('error', onError, true)
    return () => window.removeEventListener('error', onError, true)
  }, [])

  const tileTemplate = cfg?.tiles?.template || DEFAULT_TILE_TEMPLATE
  const data = useMemo(() => emptyMapData(tileTemplate), [tileTemplate])

  const engines = cfg?.stats?.engines ?? {}
  const keys = Object.keys(engines)
  const readyCount = keys.filter((k) => engines[k].instantiated).length

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={barStyle}>
        <strong>mission-app</strong>
        <span>P0 装配骨架</span>
        <span>engines 就绪 {keys.length ? `${readyCount}/${keys.length}` : '—'}</span>
        <span>/health {health}</span>
        <span>瓦片 {tileTemplate}</span>
      </div>

      <MapView data={data} />

      {note ? <div style={noteStyle}>{note}</div> : null}
    </div>
  )
}

export default App
