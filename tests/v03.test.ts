// Проверки версии 0.3: монтаж через текст, нарезка на короткие ролики, поиск долей в музыке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMediaClip, newProject, layoutProject, mainTrack } from '../shared/timeline';
import { evenShorts, findPauses, paragraphs, parseShorts, pauseCut, rangesForWords, sentences, snapShort, timelineWords, mediaNeedingTranscript } from '../shared/transcript';
import { punctuate } from '../shared/speech';
import { detectBeats, fitToBeats } from '../shared/beats';
import type { MediaItem, Word } from '../shared/types';

// Речь: каждые 0.5 с слово, фраза из 6 слов, между фразами пауза 1 с
function speech(sentencesCount: number): Word[] {
  const out: Word[] = [];
  let t = 0.5;
  for (let s = 0; s < sentencesCount; s++) {
    for (let i = 0; i < 6; i++) {
      out.push({ s: t, e: t + 0.4, w: i === 5 ? `слово${s}.${i}.` : `слово${s}.${i}` });
      t += 0.5;
    }
    t += 1;
  }
  return out;
}

function project(words: Word[]) {
  const p = newProject();
  const m: MediaItem = { id: 'm1', path: 'a.mp4', name: 'a.mp4', kind: 'video', duration: 600, width: 1920, height: 1080, hasAudio: true, fps: 30, size: 1, transcript: { words, at: 0 } };
  p.media.push(m);
  return { p, m };
}

test('слова раскладываются по клипам основной дорожки с учётом обрезки и скорости', () => {
  const { p, m } = project(speech(4));
  const main = mainTrack(p);
  main.clips.push(makeMediaClip(m, { in: 4, out: 8 }));
  main.clips.push(makeMediaClip(m, { in: 0.4, out: 2, speed: 2 }));
  layoutProject(p);
  const tw = timelineWords(p);
  // первый клип 4..8 с: вторая фраза начинается в 4.5 с исходника
  assert.equal(tw[0].w, 'слово1.0');
  assert.ok(Math.abs(tw[0].s - 0.5) < 1e-6);
  const second = tw.filter(w => w.clipId === main.clips[1].id);
  // второй клип идёт с 4 с таймлайна, в 2 раза быстрее
  assert.equal(second[0].w, 'слово0.0');
  assert.ok(Math.abs(second[0].s - (4 + (0.5 - 0.4) / 2)) < 1e-6);
  assert.deepEqual(tw.map(w => w.i), tw.map((_, i) => i));
  assert.equal(mediaNeedingTranscript(p).length, 0);
});

test('удаление слов: вырезается только сама фраза, паузы вокруг остаются', () => {
  const { p, m } = project(speech(2));
  mainTrack(p).clips.push(makeMediaClip(m, { in: 0, out: 10 }));
  layoutProject(p);
  const tw = timelineWords(p);
  const [r] = rangesForWords(tw, 1, 2);
  assert.ok(r.start >= tw[0].e && r.start <= tw[1].s);
  assert.ok(r.end <= tw[3].s && r.end >= tw[2].e);
  // паузы между фразами находятся, от паузы остаётся 0.3 с
  const pauses = findPauses(tw, 0.7);
  assert.equal(pauses.length, 1);
  const cut = pauseCut(pauses[0], 0.3)!;
  assert.ok(Math.abs((pauses[0].end - pauses[0].start) - (cut.end - cut.start) - 0.3) < 1e-6);
});

test('фразы и абзацы', () => {
  const { p, m } = project(speech(5));
  mainTrack(p).clips.push(makeMediaClip(m));
  layoutProject(p);
  const tw = timelineWords(p);
  const ss = sentences(tw);
  assert.equal(ss.length, 5);
  assert.equal(ss[0].to, 5);
  const ps = paragraphs(tw, 12);
  assert.equal(ps.length, 3);
});

test('знаки препинания переносятся из текста фразы на слова', () => {
  const w = punctuate([{ s: 0, e: 1, w: 'привет' }, { s: 1, e: 2, w: 'как' }, { s: 2, e: 3, w: 'дела' }], 'Привет, как дела?');
  assert.deepEqual(w.map(x => x.w), ['Привет,', 'как', 'дела?']);
});

test('моменты от нейросети выравниваются по фразам и не пересекаются', () => {
  const { p, m } = project(speech(20));
  mainTrack(p).clips.push(makeMediaClip(m));
  layoutProject(p);
  const tw = timelineWords(p);
  const reply = 'Вот: ```json\n[{"start": 4.2, "end": 15, "title": "Первый", "score": 9}, {"start": 5, "end": 16, "title": "Повтор"}, {"start": 40, "end": 52, "title": "Второй", "why": "смешно"}]\n```';
  const picks = parseShorts(reply, tw, 8, 30);
  assert.equal(picks.length, 2);
  for (const k of picks) {
    assert.ok(k.end - k.start >= 8 && k.end - k.start <= 30, `длина ${k.end - k.start}`);
    // начало совпадает с началом фразы
    assert.ok(sentences(tw).some(s => Math.abs(s.s - 0.15 - k.start) < 1e-6 || (s.s < 0.15 && k.start === 0)));
  }
  assert.equal(picks[1].why, 'смешно');
  assert.equal(snapShort(tw, { start: 1000, end: 1010 }), null);
  const even = evenShorts(tw, 20, 10, 30);
  assert.ok(even.length >= 3);
  assert.ok(even.every(e => e.end - e.start <= 30 && e.title));
});

test('доли в музыке: 120 ударов в минуту находятся точно', () => {
  const sr = 11025, len = 12;
  const x = new Float32Array(sr * len);
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.02;
  const clicks: number[] = [];
  for (let t = 0.25; t < len; t += 0.5) {
    clicks.push(t);
    const at = Math.round(t * sr);
    for (let i = 0; i < 600 && at + i < x.length; i++) x[at + i] += Math.sin(i * 0.9) * Math.exp(-i / 120) * 0.8;
  }
  const r = detectBeats(x, sr);
  assert.ok(Math.abs(r.bpm - 120) < 2, `темп ${r.bpm}`);
  const near = r.beats.filter(b => clicks.some(c => Math.abs(c - b) < 0.04));
  assert.ok(near.length >= r.beats.length * 0.9, `совпало ${near.length} из ${r.beats.length}`);
});

test('клипы подрезаются под доли', () => {
  const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
  const d = fitToBeats([1.8, 3, 0.2], beats, 1);
  assert.deepEqual(d, [1.5, 3, 0.2]);
  const d2 = fitToBeats([2.6, 2.6], beats, 2, 0);
  assert.deepEqual(d2, [2.5, 2]);
});
