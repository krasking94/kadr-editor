// Файлы субтитров SRT и WebVTT: чтение и запись. Время — в секундах.

export interface SubItem {
  start: number;
  end: number;
  text: string;
}

function parseTime(s: string): number {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  const [, h, mi, se, ms] = m;
  return Number(h || 0) * 3600 + Number(mi) * 60 + Number(se) + Number(ms.padEnd(3, '0')) / 1000;
}

export function parseSrt(src: string): SubItem[] {
  const out: SubItem[] = [];
  const blocks = src.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTime(a), end = parseTime(b.trim().split(/\s+/)[0]);
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (isFinite(start) && isFinite(end) && end > start && text) out.push({ start, end, text });
  }
  return out.sort((x, y) => x.start - y.start);
}

function fmt(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (v: number, l = 2) => String(v).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export function toSrt(items: SubItem[]): string {
  return items.map((it, i) => `${i + 1}\n${fmt(it.start)} --> ${fmt(it.end)}\n${it.text}\n`).join('\n');
}
