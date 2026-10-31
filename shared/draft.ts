// «Собери ролик сам»: человек кидает сырые записи и пишет, что хочет получить,
// а нейросеть выбирает лучшие куски и порядок. Здесь — текст для нейросети и разбор её ответа.
import type { MediaItem, Word } from './types';

export interface DraftSource {
  media: MediaItem;
  words?: Word[]; // речь файла (время от начала файла)
  shots?: number[]; // смены сцен (секунды), если речи нет
}

export interface DraftPiece { file: number; start: number; end: number; why?: string; caption?: string }
export interface DraftPlan { title: string; pieces: DraftPiece[]; hook?: string }

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Речь файла по фразам: [начало-конец] текст */
function phrases(words: Word[], maxLen = 14): { s: number; e: number; text: string }[] {
  const out: { s: number; e: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map(w => w.w).join(' ') }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length && (w.s - cur[cur.length - 1].e > 0.7 || cur.length >= maxLen || /[.!?…]$/.test(cur[cur.length - 1].w))) flush();
    cur.push(w);
  }
  flush();
  return out;
}

export const DRAFT_SYSTEM = (target: number, vertical: boolean) => `You are a professional video editor. The user gives you raw footage files and a request.
Each file is listed with its kind, length and either its speech (one phrase per line: [start-end] text) or its shot changes.
Build the best ${vertical ? 'vertical short-form (Reels/Shorts/TikTok)' : 'video'} edit about ${target} seconds long that fulfils the request:
- start with the strongest hook (a striking moment, question or result) in the first 3 seconds;
- keep pieces self-contained: cut on phrase boundaries, never in the middle of a word;
- remove mistakes, repeats, long pauses, greetings and off-topic talk;
- mix in footage without speech (b-roll) between talking pieces when it illustrates the words, 2-5 seconds each;
- photos are shown for 2-4 seconds (use start 0, end = seconds to show);
- the total length of all pieces should be close to ${target} seconds;
- pieces play in the order you list them.
Reply with ONLY JSON: {"title": "short catchy title in the language of the footage, max 50 chars", "pieces": [{"file": number, "start": number, "end": number, "why": "few words in Russian"}]}`;

/** Описание всех файлов для нейросети */
export function draftInput(request: string, sources: DraftSource[]): string {
  const lines = [`Request: ${request || 'Make an engaging video from this footage.'}`, ''];
  sources.forEach((src, i) => {
    const m = src.media;
    const kind = m.kind === 'image' ? 'photo' : m.kind === 'audio' ? 'audio' : 'video';
    lines.push(`File ${i + 1}: "${m.name}" (${kind}${m.kind === 'image' ? '' : `, ${r1(m.duration)} s`})`);
    if (src.words?.length) {
      for (const ph of phrases(src.words)) lines.push(`[${r1(ph.s)}-${r1(ph.e)}] ${ph.text}`);
    } else if (m.kind === 'video') {
      const cuts = [0, ...(src.shots || []).filter(t => t > 0.2 && t < m.duration - 0.2), m.duration];
      lines.push(`No speech. Shots: ${cuts.slice(0, -1).map((t, k) => `[${r1(t)}-${r1(cuts[k + 1])}]`).join(' ')}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

/** Достать план из ответа нейросети и проверить куски: в пределах файла, не короче 0.5 с */
export function parseDraft(reply: string, sources: DraftSource[]): DraftPlan {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Нейросеть ответила не в том формате');
  let raw: { title?: string; pieces?: { file?: number; start?: number; end?: number; why?: string }[] };
  try { raw = JSON.parse(m[0]); } catch { throw new Error('Нейросеть ответила не в том формате'); }
  const pieces: DraftPiece[] = [];
  for (const p of raw.pieces || []) {
    const i = Math.round(Number(p.file)) - 1;
    const src = sources[i];
    if (!src) continue;
    const len = src.media.kind === 'image' ? 30 : src.media.duration;
    let start = Math.max(0, Number(p.start) || 0), end = Math.min(len, Number(p.end) || 0);
    if (src.media.kind === 'image') { start = 0; end = Math.max(1.5, Math.min(6, end || 3)); }
    if (src.words?.length) ({ start, end } = snapToWords(src.words, start, end));
    if (end - start < 0.5) continue;
    pieces.push({ file: i, start, end, why: p.why });
  }
  if (!pieces.length) throw new Error('Нейросеть не выбрала ни одного куска');
  return { title: String(raw.title || '').slice(0, 80), pieces };
}

/** Края куска двигаем к краям слов, чтобы не резать слово пополам */
export function snapToWords(words: Word[], start: number, end: number): { start: number; end: number } {
  let s = start, e = end;
  const inside = words.find(w => w.s < s && w.e > s);
  if (inside) s = inside.s;
  const cut = words.find(w => w.s < e && w.e > e);
  if (cut) e = cut.e;
  // небольшой запас, чтобы первый звук не «съедался»
  return { start: Math.max(0, s - 0.08), end: e + 0.12 };
}

/**
 * Если нейросеть не подключена: берём из каждого файла начало (по фразам или сценам)
 * так, чтобы общая длина была близка к нужной.
 */
export function fallbackDraft(sources: DraftSource[], target: number): DraftPlan {
  const pieces: DraftPiece[] = [];
  const videos = sources.map((s, i) => ({ s, i })).filter(x => x.s.media.kind !== 'audio');
  if (!videos.length) return { title: '', pieces };
  const share = Math.max(2, target / videos.length);
  for (const { s, i } of videos) {
    const m = s.media;
    if (m.kind === 'image') { pieces.push({ file: i, start: 0, end: Math.min(4, Math.max(2, share)) }); continue; }
    let end = Math.min(m.duration, share);
    if (s.words?.length) {
      const ph = phrases(s.words);
      let acc = ph[0]?.s ?? 0;
      const start = Math.max(0, acc - 0.08);
      for (const p of ph) { if (p.e - start > share && acc > start) break; acc = p.e; }
      end = Math.min(m.duration, acc + 0.12);
      pieces.push({ file: i, start, end: Math.max(start + 1, end) });
    } else {
      // без речи — кусок из середины, там обычно самое интересное
      const mid = Math.max(0, m.duration / 2 - end / 2);
      pieces.push({ file: i, start: mid, end: Math.min(m.duration, mid + end) });
    }
  }
  return { title: '', pieces };
}

export const draftLength = (plan: DraftPlan) => plan.pieces.reduce((s, p) => s + (p.end - p.start), 0);
