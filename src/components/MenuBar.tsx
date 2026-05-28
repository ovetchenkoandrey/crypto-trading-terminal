import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import type { PanelKey, LayoutKey } from "../lib/store";
import { AboutDialog } from "./AboutDialog";
import { SettingsDialog } from "./SettingsDialog";

type OpenMenu = string | null;

interface MenuItem {
  label: string;
  action?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

export function MenuBar() {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const panels       = useStore((s) => s.panels);
  const togglePanel  = useStore((s) => s.togglePanel);
  const theme        = useStore((s) => s.theme);
  const setTheme     = useStore((s) => s.setTheme);
  const layout       = useStore((s) => s.layout);
  const setLayout    = useStore((s) => s.setLayout);

  // Close on outside click
  useEffect(() => {
    if (open === null) return;
    const onDocClick = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const PANEL_ITEMS: { key: PanelKey; label: string }[] = [
    { key: "orderBook", label: "Стакан (Ctrl+D)"    },
    { key: "navigator", label: "Навигатор (Ctrl+N)" },
    { key: "terminal",  label: "Терминал (Ctrl+T)"  },
  ];

  const LAYOUT_ITEMS: { key: LayoutKey; label: string }[] = [
    { key: "1", label: "Раскладка 1×1" },
    { key: "2", label: "Раскладка 1×2" },
    { key: "4", label: "Раскладка 2×2" },
  ];

  const menus: { id: string; label: string; items: MenuItem[] }[] = [
    { id: "file",    label: "Файл",    items: [
      { label: "Выход", action: () => window.close() },
    ]},
    { id: "view",    label: "Вид",     items: [
      ...PANEL_ITEMS.map((p) => ({
        label: p.label,
        checked: panels[p.key],
        action: () => togglePanel(p.key),
      })),
      { label: "---", separator: true },
      { label: "Тёмная тема",   checked: theme === "dark",  action: () => setTheme("dark")  },
      { label: "Светлая тема",  checked: theme === "light", action: () => setTheme("light") },
    ]},
    { id: "insert",  label: "Вставка", items: [{ label: "Скоро…", disabled: true }] },
    { id: "charts",  label: "Графики", items: LAYOUT_ITEMS.map((l) => ({
      label: l.label, checked: layout === l.key, action: () => setLayout(l.key),
    }))},
    { id: "service", label: "Сервис",  items: [
      { label: "Настройки…", action: () => { setOpen(null); setShowSettings(true); } },
    ]},
    { id: "window",  label: "Окно",    items: [{ label: "Скоро…", disabled: true }] },
    { id: "help",    label: "Справка", items: [
      { label: "О программе…", action: () => { setOpen(null); setShowAbout(true); } },
    ]},
  ];

  return (
    <>
      <div className="menu-bar" ref={barRef}>
        {menus.map((menu) => {
          const isOpen = open === menu.id;
          return (
            <div
              key={menu.id}
              className={"menu-item-wrap" + (isOpen ? " open" : "")}
            >
              <span
                className={"mi" + (isOpen ? " active" : "")}
                onClick={() => setOpen(isOpen ? null : menu.id)}
                onMouseEnter={() => { if (open !== null) setOpen(menu.id); }}
              >
                {menu.label}
              </span>
              {isOpen && (
                <div className="menu-dropdown">
                  {menu.items.map((item, idx) => {
                    if (item.separator) return <div key={idx} className="menu-sep" />;
                    return (
                      <div
                        key={idx}
                        className={"menu-dd-item" + (item.disabled ? " disabled" : "")}
                        onClick={() => {
                          if (item.disabled) return;
                          item.action?.();
                          setOpen(null);
                        }}
                      >
                        <span className="menu-dd-check">{item.checked ? "✓" : ""}</span>
                        <span className="menu-dd-label">{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAbout    && <AboutDialog    onClose={() => setShowAbout(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </>
  );
}
