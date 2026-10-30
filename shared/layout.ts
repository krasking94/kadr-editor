// Свободные окна: где пристыкована каждая панель и какие плавают поверх.
import type { FloatRect, Layout, PaneId } from './settings';

export const PANES: PaneId[] = ['files', 'inspector', 'assistant'];
export const PANE_TITLES: Record<PaneId, string> = { files: 'Файлы и заготовки', inspector: 'Настройки', assistant: 'ИИ-помощник' };
// какая ширина в раскладке отвечает за панель
export const PANE_WIDTH: Record<PaneId, 'side' | 'right' | 'assistant'> = { files: 'side', inspector: 'right', assistant: 'assistant' };

export interface Docks {
  left: PaneId[];
  right: PaneId[];
  float: Partial<Record<PaneId, FloatRect>>;
  rail: 'left' | 'right';
}

/** Раскладка панелей; старые настройки (только «поменять стороны») переводятся в новый вид */
export function docksOf(L: Layout): Docks {
  const base = L.swap
    ? { left: ['assistant', 'inspector'] as PaneId[], right: ['files'] as PaneId[] }
    : { left: ['files'] as PaneId[], right: ['inspector', 'assistant'] as PaneId[] };
  const custom = !!(L.dockLeft || L.dockRight || L.float);
  const float = { ...(custom ? L.float : {}) };
  const seen = new Set<PaneId>();
  const clean = (a: PaneId[] | undefined) => (a || []).filter(p => PANES.includes(p) && !seen.has(p) && !float[p] && seen.add(p));
  const left = clean(custom ? L.dockLeft : base.left);
  const right = clean(custom ? L.dockRight : base.right);
  // панель потерялась (например, настройки правили руками) — возвращаем её на обычное место
  for (const p of PANES) if (!seen.has(p) && !float[p]) (p === 'files' ? left : right).push(p);
  const rail = left.includes('files') ? 'left' : right.includes('files') ? 'right' : L.rail || (L.swap ? 'right' : 'left');
  return { left, right, float, rail };
}

export type DockTarget = { side: 'left' | 'right'; index: number } | { float: FloatRect };

/** Переносит панель: пристыковать на сторону в позицию index или оставить плавать в рамке */
export function movePane(L: Layout, id: PaneId, to: DockTarget): Partial<Layout> {
  const d = docksOf(L);
  const left = d.left.slice(), right = d.right.slice();
  const float = { ...d.float };
  let rail = d.rail;
  // позиция считается в исходном списке, поэтому сначала запоминаем, откуда панель уходит
  const fromSide = left.includes(id) ? 'left' : right.includes(id) ? 'right' : null;
  const fromIndex = fromSide === 'left' ? left.indexOf(id) : fromSide === 'right' ? right.indexOf(id) : -1;
  if (fromSide === 'left') left.splice(fromIndex, 1);
  if (fromSide === 'right') right.splice(fromIndex, 1);
  delete float[id];
  if ('float' in to) {
    float[id] = to.float;
  } else {
    const list = to.side === 'left' ? left : right;
    let i = to.index;
    if (fromSide === to.side && fromIndex < i) i--;
    list.splice(Math.max(0, Math.min(list.length, i)), 0, id);
    if (id === 'files') rail = to.side;
  }
  return { dockLeft: left, dockRight: right, float, rail, swap: rail === 'right' };
}

/** Вернуть панель на её обычное место */
export function homeTarget(L: Layout, id: PaneId): DockTarget {
  const d = docksOf(L);
  if (id === 'files') return d.rail === 'right' ? { side: 'right', index: d.right.length } : { side: 'left', index: 0 };
  // инструменты — на сторону, где нет медиатеки
  const side = d.rail === 'right' ? 'left' : 'right';
  const list = side === 'left' ? d.left : d.right;
  const other = id === 'inspector' ? 'assistant' : 'inspector';
  const j = list.indexOf(other);
  // настройки ближе к центру, помощник — к краю окна
  const towardsCenter = id === 'inspector';
  if (j < 0) return { side, index: side === 'left' ? (towardsCenter ? list.length : 0) : (towardsCenter ? 0 : list.length) };
  const before = side === 'left' ? !towardsCenter : towardsCenter;
  return { side, index: before ? j : j + 1 };
}

/** Поменять стороны местами (зеркально) */
export function mirror(L: Layout): Partial<Layout> {
  const d = docksOf(L);
  const left = d.right.slice().reverse(), right = d.left.slice().reverse();
  return { dockLeft: left, dockRight: right, float: d.float, rail: d.rail === 'left' ? 'right' : 'left', swap: !L.swap };
}

/** Плавающее окно не должно уезжать за пределы программы */
export function clampRect(r: FloatRect, W: number, H: number): FloatRect {
  const w = Math.max(260, Math.min(r.w, W - 16)), h = Math.max(200, Math.min(r.h, H - 16));
  return { w, h, x: Math.max(8 - w + 120, Math.min(W - 120, r.x)), y: Math.max(0, Math.min(H - 40, r.y)) };
}
