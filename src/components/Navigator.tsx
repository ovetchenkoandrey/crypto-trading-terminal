function dragStart(e: React.DragEvent, kind: string) {
  e.dataTransfer.setData("application/x-indicator", JSON.stringify({ kind }));
  e.dataTransfer.effectAllowed = "copy";
}

const DRAGGABLE_INDICATORS: { label: string; kind: string }[] = [
  { label: "Moving Average", kind: "sma" },
  { label: "EMA", kind: "ema" },
  { label: "RSI", kind: "rsi" },
  { label: "MACD", kind: "macd" },
  { label: "Bollinger Bands", kind: "bollinger" },
];

export function Navigator() {
  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Навигатор
      </div>
      <div className="nav-tree">
        <div className="nav-cat"><span className="chev">▾</span>📁 Индикаторы</div>
        {DRAGGABLE_INDICATORS.map(({ label, kind }) => (
          <div
            key={kind}
            className="nav-item nav-item-draggable"
            draggable
            data-indicator-kind={kind}
            onDragStart={(e) => dragStart(e, kind)}
          >
            <span className="ico">📈</span>{label}
          </div>
        ))}
        <div className="nav-item"><span className="ico">📈</span>Stochastic</div>
        <div className="nav-item"><span className="ico">📈</span>ATR</div>
        <div className="nav-item"><span className="ico">📈</span>Volume Profile</div>

        <div className="nav-cat"><span className="chev">▾</span>🤖 Эксперты (боты)</div>
        <div className="nav-item">
          <span className="ico">🤖</span>Grid Bot
          <span className="badge running">RUN</span>
        </div>
        <div className="nav-item"><span className="ico">🤖</span>DCA Strategy</div>
        <div className="nav-item"><span className="ico">🤖</span>MA Crossover EA</div>
        <div className="nav-item"><span className="ico">🤖</span>Mean Reversion</div>

        <div className="nav-cat"><span className="chev">▾</span>📜 Скрипты</div>
        <div className="nav-item"><span className="ico">📜</span>close_all_positions</div>
        <div className="nav-item"><span className="ico">📜</span>export_history_csv</div>

        <div className="nav-cat"><span className="chev">▸</span>⚙ Сервисы</div>
      </div>
    </>
  );
}
