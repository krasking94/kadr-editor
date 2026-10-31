// Справка: поиск находит нужную статью по разговорным словам, а кнопки ведут в места, которые есть в программе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HELP, searchHelp } from '../src/lib/help';

test('справка: поиск по разговорным словам', () => {
  const first = (q: string) => searchHelp(q)[0]?.id;
  assert.equal(first('убрать музыку'), 'separate');
  assert.equal(first('как сохранить видео'), 'export');
  assert.equal(first('субтитры'), 'subtitles');
  assert.equal(first('паузы'), 'pauses');
  assert.equal(first('мультикамера'), 'multicam');
  assert.equal(first('Ножницы'), 'cut');
  assert.equal(first('ЁЛКИ-ПАЛКИ ничего такого нет'), undefined);
  assert.equal(searchHelp('  ').length, HELP.length, 'пустой запрос — все статьи');
});

test('справка: статьи целые, кнопки ведут в существующие места', () => {
  const ids = new Set<string>();
  const settings = readFileSync('src/components/SettingsDialog.tsx', 'utf8');
  const rail = readFileSync('src/components/SidePanel.tsx', 'utf8');
  const app = readFileSync('src/App.tsx', 'utf8');
  for (const a of HELP) {
    assert.ok(!ids.has(a.id), 'повтор ' + a.id);
    ids.add(a.id);
    assert.ok(a.title && a.group && a.body.length, a.id);
    const steps = a.body.map(b => /^(\d+)\.\s/.exec(b)?.[1]).filter(Boolean).map(Number);
    steps.forEach((n, i) => assert.equal(n, i + 1, `${a.id}: шаги по порядку`));
    const act = a.action;
    if (!act) continue;
    if (act.kind === 'settings') assert.ok(settings.includes(`{ id: '${act.tab}'`), `${a.id}: нет вкладки настроек ${act.tab}`);
    if (act.kind === 'rail') assert.ok(rail.includes(`{ id: '${act.tab}'`), `${a.id}: нет вкладки ${act.tab}`);
    if (act.kind === 'dialog') assert.ok(app.includes(`dialog === '${act.dialog}'`), `${a.id}: нет окна ${act.dialog}`);
  }
});
