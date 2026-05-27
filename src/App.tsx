/**
 * Stage E0.1 placeholder — proves the Electron+Vite+React pipeline works.
 * Will be replaced with the full MT-style layout in E0.2.
 */
export function App() {
  return (
    <div className="boot-screen">
      <div className="boot-brand">⚡ TRADING APP</div>
      <div className="boot-sub">Stage E0.1 — Electron + Vite + React + TypeScript</div>
      <div className="boot-status">
        <div className="boot-line"><span className="ok">●</span> Electron main process — OK</div>
        <div className="boot-line"><span className="ok">●</span> Vite dev server — OK</div>
        <div className="boot-line"><span className="ok">●</span> React renderer — OK</div>
        <div className="boot-line"><span className="pending">○</span> Layout (E0.2) — pending</div>
        <div className="boot-line"><span className="pending">○</span> Bybit client (E0.3) — pending</div>
        <div className="boot-line"><span className="pending">○</span> Chart component (E0.4) — pending</div>
      </div>
    </div>
  );
}
