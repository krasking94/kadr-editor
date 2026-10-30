// Знак программы: кинохлопушка с кнопкой «play»
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <div className="logo-mark" style={{ width: size, height: size, borderRadius: size * 0.28 }}>
      <svg width={size * 0.68} height={size * 0.68} viewBox="0 0 24 24" fill="none">
        <rect x="3" y="10.6" width="18" height="10.4" rx="2.2" fill="#fff"/><path d="M10.4 13.1v5.4l4.6-2.7z" fill="#8a5cf0"/><rect x="3" y="7.6" width="18" height="2.5" rx="0.8" fill="#fff"/><path d="M5.2 10.10h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M8.8 10.10h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M12.4 10.10h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M16.0 10.10h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><g transform="rotate(-17 3.4 7.2)"><rect x="3" y="4.3" width="18" height="2.5" rx="0.8" fill="#fff"/><path d="M5.2 6.80h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M8.8 6.80h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M12.4 6.80h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/><path d="M16.0 6.80h1.7l1.9-2.50h-1.7z" fill="#8a5cf0"/></g>
      </svg>
    </div>
  );
}
