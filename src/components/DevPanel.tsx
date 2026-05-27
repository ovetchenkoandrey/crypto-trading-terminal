import { useEffect, useState } from "react";
import { fetchKlines } from "../lib/bybit";
import type { Candle } from "../lib/types";

type Status = "loading" | "error" | "success";

function fmtTime(utcSeconds: number): string {
  return new Date(utcSeconds * 1000).toISOString();
}

function CandleRow({ label, c }: { label: string; c: Candle }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <strong style={{ color: "#aaa" }}>{label}</strong>
      <div style={{ fontFamily: "monospace", fontSize: 13, marginTop: 4 }}>
        <span style={{ color: "#888" }}>time: </span>{fmtTime(c.time)}{" "}
        <span style={{ color: "#888" }}>O: </span>{c.open}{" "}
        <span style={{ color: "#888" }}>H: </span>{c.high}{" "}
        <span style={{ color: "#888" }}>L: </span>{c.low}{" "}
        <span style={{ color: "#888" }}>C: </span>{c.close}{" "}
        <span style={{ color: "#888" }}>V: </span>{c.volume}
      </div>
    </div>
  );
}

export function DevPanel() {
  const [status, setStatus] = useState<Status>("loading");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    fetchKlines("BTCUSDT", "15", 200)
      .then((data) => {
        setCandles(data);
        setStatus("success");
      })
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0f1117",
    color: "#e0e0e0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "Inter, system-ui, sans-serif",
  };

  const cardStyle: React.CSSProperties = {
    background: "#1a1d27",
    border: "1px solid #2a2d3a",
    borderRadius: 12,
    padding: "32px 40px",
    minWidth: 520,
    maxWidth: 700,
  };

  if (status === "loading") {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ color: "#888", fontSize: 16 }}>Loading BTCUSDT klines…</div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, borderColor: "#ff4d4d" }}>
          <div style={{ color: "#ff4d4d", fontWeight: 700, marginBottom: 8 }}>Error</div>
          <div style={{ fontFamily: "monospace", fontSize: 13 }}>{errorMsg}</div>
        </div>
      </div>
    );
  }

  const first = candles[0];
  const last = candles[candles.length - 1];

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ color: "#666", fontSize: 12, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>
          Bybit Market Data — DevPanel
        </div>
        <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
          BTCUSDT · 15m · {candles.length} candles
        </div>

        {/* Latest close — the big number */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ color: "#666", fontSize: 12, marginBottom: 4 }}>LATEST CLOSE</div>
          <div style={{ fontSize: 42, fontWeight: 700, color: "#00e5a0", letterSpacing: "-1px" }}>
            ${last.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>

        <CandleRow label="First candle" c={first} />
        <CandleRow label="Last candle" c={last} />

        <div style={{ marginTop: 16, fontSize: 12, color: "#444" }}>
          Total candles: <strong style={{ color: "#666" }}>{candles.length}</strong>
        </div>
      </div>
    </div>
  );
}
