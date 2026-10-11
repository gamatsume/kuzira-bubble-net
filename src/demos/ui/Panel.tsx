/**
 * 依存なしの調整パネル。H キーで表示／非表示。項目のダブルクリックで初期値に戻す。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { Group, Values } from "./panelTypes";

const text = "rgba(255,255,255,0.86)";
const dim = "rgba(255,255,255,0.45)";
const panelButton: CSSProperties = {
  flex: 1, padding: "7px 0", background: "rgba(255,255,255,0.08)", color: text,
  border: "1px solid rgba(255,255,255,0.14)", borderRadius: 6, font: "inherit", cursor: "pointer",
};

/** ボタンを押してもキーボードのフォーカスを奪わない（H / Space を効かせ続ける） */
export function PanelButton({ children, onClick, style }: { children: ReactNode; onClick: () => void; style?: CSSProperties }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={{ ...panelButton, ...style }}>
      {children}
    </button>
  );
}

export function Panel({ title, groups, values, onChange, children }: {
  title: string;
  groups: Group[];
  values: Values;
  onChange: (patch: Values) => void;
  /** パネル上部（プリセットなど）と下部（操作ボタン）に差し込む要素 */
  children?: { top?: ReactNode; bottom?: ReactNode };
}) {
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== "range" && e.target.type !== "checkbox") return;
      if (e.key === "h" || e.key === "H") setHidden((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (hidden) return null;

  return (
    <div
      style={{
        position: "absolute", top: 16, right: 16, width: 264, maxHeight: "calc(100% - 32px)",
        overflowY: "auto", padding: open ? "12px 14px 14px" : "10px 14px",
        background: "rgba(12,12,12,0.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: text,
        font: "500 11px/1.4 system-ui, sans-serif", letterSpacing: "0.02em", userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ letterSpacing: "0.2em", color: dim }}>{title}</span>
        <PanelButton onClick={() => setOpen((v) => !v)} style={{ flex: "none", padding: "2px 8px" }}>
          {open ? "閉じる" : "開く"}
        </PanelButton>
      </div>
      {open && (
        <>
          {children?.top}
          {groups.map((g) => (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div style={{ color: dim, marginBottom: 6 }}>{g.title}</div>
              {g.items.map((it) =>
                "toggle" in it ? (
                  <label key={it.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span>{it.label}</span>
                    <input
                      type="checkbox" checked={Boolean(values[it.key])}
                      onChange={(e) => onChange({ [it.key]: e.target.checked })}
                      style={{ accentColor: "#fff" }}
                    />
                  </label>
                ) : (
                  <label
                    key={it.key}
                    onDoubleClick={() => onChange({ [it.key]: it.def })}
                    title="ダブルクリックで初期値に戻す"
                    style={{ display: "block", marginBottom: 6 }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>{it.label}</span>
                      <span style={{ color: values[it.key] === it.def ? dim : text, fontVariantNumeric: "tabular-nums" }}>
                        {(values[it.key] as number).toFixed(it.step >= 1 ? 0 : it.step < 0.01 ? 3 : 2)}
                      </span>
                    </div>
                    <input
                      type="range" min={it.min} max={it.max} step={it.step} value={values[it.key] as number}
                      onChange={(e) => onChange({ [it.key]: Number(e.target.value) })}
                      style={{ width: "100%", margin: "2px 0 0", accentColor: "#fff" }}
                    />
                  </label>
                ),
              )}
            </div>
          ))}
          {children?.bottom}
          <div style={{ color: dim, marginTop: 10, lineHeight: 1.6 }}>
            H: パネルを隠す ／ Space: 一時停止<br />項目をダブルクリックで初期値に戻す
          </div>
        </>
      )}
    </div>
  );
}
