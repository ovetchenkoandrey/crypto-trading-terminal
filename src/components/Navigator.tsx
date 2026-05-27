export function Navigator() {
  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Навигатор
      </div>
      <div className="nav-tree">
        <div className="nav-cat"><span className="chev">▾</span>📁 Индикаторы</div>
        <div className="nav-item"><span className="ico">📈</span>Moving Average</div>
        <div className="nav-item"><span className="ico">📈</span>EMA</div>
        <div className="nav-item"><span className="ico">📈</span>RSI</div>
        <div className="nav-item"><span className="ico">📈</span>MACD</div>
        <div className="nav-item"><span className="ico">📈</span>Bollinger Bands</div>
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
