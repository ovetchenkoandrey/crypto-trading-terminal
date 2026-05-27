interface StatusBarProps {
  connected: boolean;
  latencyMs: number | null;
  candleCount: number;
}

export function StatusBar({ connected, latencyMs, candleCount }: StatusBarProps) {
  const now = new Date();
  const time = now.toLocaleTimeString("ru-RU", { hour12: false });

  return (
    <div className="status-bar">
      <span className={connected ? "ok" : ""}>
        Bybit · {connected ? "Connected" : "Connecting…"}
      </span>
      <span className="sep-dot">·</span>
      <span>Latency: {latencyMs !== null ? `${latencyMs} ms` : "— ms"}</span>
      <span className="sep-dot">·</span>
      <span className="accent">Аккаунт: paper-trading</span>
      <span className="sep-dot">·</span>
      <span>Свечей загружено: {candleCount}</span>
      <span className="spacer" />
      <span>UTC+3 · {time}</span>
      <span className="sep-dot">·</span>
      <span>v0.1.0</span>
    </div>
  );
}
