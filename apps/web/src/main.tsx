// mission-app · apps/web/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
// map-2d 自己注入控件样式，宿主只补 maplibre 的基础样式
import 'maplibre-gl/dist/maplibre-gl.css'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
