// Знак программы: рамка кадра с кнопкой «play» внутри
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <div className="logo-mark" style={{ width: size, height: size, borderRadius: size * 0.28 }}>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M10 8.5v7l6-3.5-6-3.5Z" fill="#fff" />
      </svg>
    </div>
  );
}
