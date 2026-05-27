import { Modal } from "./Modal";

const VERSION = "0.2.0";

interface Props {
  onClose: () => void;
}

export function AboutDialog({ onClose }: Props) {
  return (
    <Modal title="О программе" onClose={onClose} width={400}>
      <div className="about-content">
        <div className="about-name">Trading App</div>
        <div className="about-version">v{VERSION}</div>
        <div className="about-desc">
          Криптовалютный торговый терминал — собственная реализация,
          ориентированная на Bybit. Real-time данные, бумажная торговля, ботовая автоматизация.
        </div>
        <div className="about-repo">Репозиторий: github.com/your-org/trading-app</div>
        <div className="about-stack-title">Технологии</div>
        <ul className="about-stack">
          <li>Electron</li>
          <li>Vite + React + TypeScript</li>
          <li>lightweight-charts</li>
          <li>Zustand</li>
          <li>Bybit V5 API</li>
        </ul>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}
