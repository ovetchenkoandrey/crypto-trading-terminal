import { useEffect, useRef } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  testId?: string;
}

export function Modal({ title, onClose, children, width = 480, testId }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      data-testid={testId ? `${testId}-backdrop` : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" ref={cardRef} style={{ width }} data-testid={testId}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button
            className="modal-close"
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={onClose}
          >✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
