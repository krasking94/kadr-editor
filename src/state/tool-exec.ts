// Выполнение команд ИИ. Каждая команда — обычное действие редактора, поэтому пользователь
// видит изменение сразу и может отменить его.
import { api } from '../api';
import type { MediaClip, TextAnim, TransitionType } from '../../shared/types';
import { clipDuration, findClip, FORMAT_PRESETS, projectDuration } from '../../shared/timeline';
import { TOOL_TITLES } from '../../shared/tools';
import * as A from './actions';
import { commit, get, redo, set, undo } from './store';
import { generate } from './generate';
import * as S from './smart';
import type { ShapeKind } from '../lib/stickers';

export interface ToolOutput { text: string; image?: string; isError?: boolean }

const r2 = (n: number) => Math.round(n * 100) / 100;

function projectSummary() {
  const s = get();
  const p = s.project!;
  return {
    name: p.name, width: p.width, height: p.height, fps: p.fps, background: p.background,
    duration: r2(projectDuration(p)), playhead: r2(s.playhead), selection: s.selection,
    media: p.media.map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: r2(m.duration), width: m.width, height: m.height, hasAudio: m.hasAudio, path: m.path, missing: !!m.missing })),
    tracks: p.tracks.map(t => ({
      id: t.id, kind: t.kind, name: t.name, muted: t.muted, locked: t.locked, hidden: t.hidden,
      clips: t.clips.map(c => c.type === 'text'
        ? { id: c.id, type: 'text', text: c.text, start: r2(c.start), end: r2(c.start + c.duration), style: c.style, anim_in: c.animIn, anim_out: c.animOut, subtitle: !!c.subtitle, ...(c.words?.length ? { word_highlight: c.highlight || true } : {}) }
        : {
          id: c.id, type: 'media', media_id: c.mediaId, media_name: p.media.find(m => m.id === c.mediaId)?.name,
          start: r2(c.start), end: r2(c.start + clipDuration(c)), in: r2(c.in), out: r2(c.out), speed: c.speed,
          volume: c.volume, muted: c.muted, fit: c.fit, transform: c.transform, animate: c.animate, ...(c.animate ? { transform_end: c.transformEnd } : {}),
          color: c.color, effects: c.effects, transition: c.transition, fade_in: c.fadeIn, fade_out: c.fadeOut, duck: c.duck,
          voice: c.voice, denoise: c.denoise, key: c.key, ...(c.path?.length ? { face_tracking: true } : {}), ...(c.origin ? { processed: c.origin.done } : {}),
        }),
    })),
    markers: p.markers.map(m => ({ time: r2(m.time), label: m.label })),
    formats: FORMAT_PRESETS.map(f => f.id),
  };
}

const ok = (text: string, extra?: unknown): ToolOutput => ({ text: extra === undefined ? text : text + '\n' + JSON.stringify(extra) });

export async function execTool(name: string, a: any, source: string): Promise<ToolOutput> {
  const s = get();
  if (!s.project) return { text: 'Сейчас не открыт ни один проект. Попросите пользователя создать или открыть проект.', isError: true };
  set({ lastAction: { label: TOOL_TITLES[name] || name, source, at: Date.now() } });
  switch (name) {
    case 'get_project':
      return ok(JSON.stringify(projectSummary()));
    case 'get_frame': {
      const t = Math.max(0, Math.min(Number(a.time) || 0, Math.max(0, projectDuration(s.project) - 0.01)));
      set({ playhead: t });
      const image = await A.renderFrame(t, 960);
      return { text: `Frame at ${r2(t)}s`, image };
    }
    case 'import_media': {
      const added = await A.importFiles(a.paths || [], { source });
      return ok('Imported', added.map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: r2(m.duration) })));
    }
    case 'add_to_timeline': {
      const id = A.addToTimeline(a.media_id, a.track || 'main', { index: a.index, start: a.start, in: a.in, out: a.out, source });
      return ok('Added clip', { clip_id: id });
    }
    case 'split_clip':
      return ok('Split', { new_clip_ids: A.splitAt(Number(a.time), a.clip_id, source) });
    case 'trim_clip':
      A.trimClip(a.clip_id, { in: a.in, out: a.out, start: a.start, duration: a.duration }, { source });
      return ok('Trimmed');
    case 'move_clip':
      A.moveClip(a.clip_id, { index: a.index, start: a.start }, source);
      return ok('Moved');
    case 'delete_clips':
      A.deleteClips(a.clip_ids || [], source);
      return ok('Deleted');
    case 'update_clip': {
      const f = findClip(s.project, a.clip_id);
      if (!f) return { text: 'No such clip', isError: true };
      if (f.clip.type !== 'media') return { text: 'This is a text clip, use update_text', isError: true };
      const patch: A.MediaClipPatch = {};
      const map: Record<string, keyof MediaClip> = { speed: 'speed', volume: 'volume', muted: 'muted', fade_in: 'fadeIn', fade_out: 'fadeOut', audio_fade_in: 'audioFadeIn', audio_fade_out: 'audioFadeOut', fit: 'fit', animate: 'animate', duck: 'duck', voice: 'voice', denoise: 'denoise' };
      for (const [k, v] of Object.entries(map)) if (a[k] !== undefined) (patch as any)[v] = a[k];
      if (a.transform) patch.transform = a.transform;
      if (a.transform_end) patch.transformEnd = a.transform_end;
      if (a.color) patch.color = { ...a.color, ...(a.color.lut === '' ? { lut: undefined } : {}) };
      if (a.key !== undefined) patch.key = a.key ? { color: a.key.color || '#00ff00', similarity: a.key.similarity ?? 0.3, blend: a.key.blend ?? 0.1 } : undefined;
      if (a.effects) patch.effects = a.effects;
      A.updateMediaClip(a.clip_id, patch, 'Настройки клипа изменены', { source, coalesce: '' });
      return ok('Updated');
    }
    case 'set_transition':
      A.setTransition(a.clip_id, a.type as TransitionType | 'none', a.duration ?? 0.6, source);
      return ok('Transition set');
    case 'add_text': {
      const id = A.addText(String(a.text), a.start, a.duration ?? 3, a.style || {}, { in: a.anim_in as TextAnim, out: a.anim_out as TextAnim }, source);
      return ok('Text added', { clip_id: id });
    }
    case 'update_text': {
      const patch: A.TextClipPatch = {};
      if (a.text !== undefined) patch.text = String(a.text);
      if (a.start !== undefined) patch.start = a.start;
      if (a.duration !== undefined) patch.duration = a.duration;
      if (a.style) patch.style = a.style;
      if (a.anim_in) patch.animIn = a.anim_in;
      if (a.anim_out) patch.animOut = a.anim_out;
      A.updateTextClip(a.clip_id, patch, 'Текст изменён', { source, coalesce: '' });
      return ok('Text updated');
    }
    case 'generate_image': {
      const r = await generate({ kind: 'image', prompt: String(a.prompt || ''), aspect: a.aspect, place: a.place || 'main', index: a.index, start: a.start, duration: a.duration, animate: a.animate }, source);
      return ok('Image created and imported', { media_id: r.media.id, clip_id: r.clipId, duration: r2(r.duration), file: r.path });
    }
    case 'list_voices': {
      const voices = await api.genVoices();
      return ok('Voices (default: ' + (get().settings.gen.voiceName || 'first in list') + ')', voices);
    }
    case 'generate_speech': {
      const r = await generate({ kind: 'speech', prompt: String(a.text || ''), voiceId: a.voice_id, start: a.start, place: a.place === false ? 'none' : 'audio' }, source);
      return ok('Speech created', { media_id: r.media.id, clip_id: r.clipId, duration: r2(r.duration) });
    }
    case 'generate_sound_effect': {
      const r = await generate({ kind: 'sfx', prompt: String(a.prompt || ''), duration: a.duration, start: a.start, place: a.place === false ? 'none' : 'audio' }, source);
      return ok('Sound effect created', { media_id: r.media.id, clip_id: r.clipId, duration: r2(r.duration) });
    }
    case 'generate_music': {
      const r = await generate({ kind: 'music', prompt: String(a.prompt || ''), duration: a.duration, vocals: !!a.vocals, start: a.start, volume: a.volume, place: a.place === false ? 'none' : 'audio' }, source);
      return ok('Music created (ducks under speech automatically)', { media_id: r.media.id, clip_id: r.clipId, duration: r2(r.duration) });
    }
    case 'add_subtitles':
      A.addSubtitles(a.items || [], !!a.replace, a.style || {}, source);
      return ok(`Added ${(a.items || []).length} subtitle lines`);
    case 'transcribe': {
      const segs = await A.transcribeProject({ clipId: a.clip_id, addSubs: !!a.add_subtitles, language: a.language, source });
      return ok('Transcript', segs.map(x => ({ start: r2(x.start), end: r2(x.end), text: x.text })));
    }
    case 'remove_silence': {
      const n = await A.removeSilence({ db: a.threshold_db, min: a.min_duration, clipId: a.clip_id, source });
      return ok(`Removed ${n} pauses. New duration ${r2(projectDuration(get().project!))}s`);
    }
    case 'detect_scenes': {
      const times = await A.detectScenes(a.clip_id, a.split !== false, a.sensitivity ?? 0.4, source);
      return ok('Scene changes (timeline seconds)', times.map(r2));
    }
    case 'stabilize_clip':
    case 'reverse_clip':
      await S.processClip(a.clip_id, name === 'stabilize_clip' ? 'stabilize' : 'reverse', source);
      return ok(name === 'stabilize_clip' ? 'Stabilized' : 'Reversed');
    case 'auto_reframe': {
      const r = await S.autoReframe({ width: a.width, height: a.height, source });
      return ok(`Reframed ${r.clips} clips, face found in ${r.faces}`);
    }
    case 'remove_fillers': {
      const r = await S.removeFillers({ fillers: a.words, confirm: false, source });
      return ok(`Removed ${r.count} filler words (${r2(r.seconds)}s)`, r.words.slice(0, 50));
    }
    case 'make_subtitles': {
      const n = await S.makeSubtitles({ style: a.style, words: a.words, highlight: a.highlight, language: a.language, source });
      return ok(`Created ${n} subtitle clips`);
    }
    case 'translate_subtitles':
      return ok(`Translated ${await S.translateSubtitles(String(a.language), source)} subtitle clips`);
    case 'export_subtitles': {
      const path = await S.exportSubtitles(a.path || `${get().info?.videosDir || ''}/${s.project.name.replace(/[\\/:*?"<>|]+/g, '_')}.srt`);
      return path ? ok('Saved', { path }) : { text: 'No subtitles to save', isError: true };
    }
    case 'add_sticker': {
      if (a.time !== undefined) set({ playhead: Math.max(0, Number(a.time)) });
      const id = a.shape ? await S.addShape(a.shape as ShapeKind, a.color || '#ff3b5c', source) : S.addEmoji(String(a.emoji || '🔥'), source);
      return id ? ok('Sticker added', { clip_id: id }) : { text: 'Could not add sticker', isError: true };
    }
    case 'studio_voice':
      return ok(`Studio voice ${a.on === false ? 'off' : 'on'} for ${S.studioVoiceAll(a.on !== false, source)} clips`);
    case 'analyze_audio': {
      const r = await S.analyzeLoudness();
      return ok('Loudness', { lufs: r2(r.lufs), true_peak_db: r2(r.peak), range_lu: r2(r.lra), verdict_ru: S.loudnessVerdict(r.lufs), export_target_lufs: get().settings.loudness || null });
    }
    case 'set_project': {
      commit('Настройки проекта изменены', p => {
        const preset = FORMAT_PRESETS.find(f => f.id === a.preset);
        if (preset) { p.width = preset.width; p.height = preset.height; }
        if (a.width) p.width = Math.round(a.width / 2) * 2;
        if (a.height) p.height = Math.round(a.height / 2) * 2;
        if (a.fps) p.fps = Math.max(1, Math.min(120, a.fps));
        if (a.background) p.background = a.background;
        if (a.name) p.name = a.name;
      }, { source });
      return ok('Project updated');
    }
    case 'add_marker':
      A.addMarker(Number(a.time), a.label, source);
      return ok('Marker added');
    case 'playback':
      if (a.action === 'seek') set({ playhead: Math.max(0, Number(a.time) || 0), playing: false });
      else set({ playing: a.action === 'play' });
      return ok('OK');
    case 'select_clips':
      set({ selection: a.clip_ids || [] });
      return ok('Selected');
    case 'undo':
      undo();
      return ok('Undone');
    case 'redo':
      redo();
      return ok('Redone');
    case 'export_video': {
      const p = get().project!;
      const format = a.format || 'mp4';
      const info = get().info;
      const path = a.path || `${info?.videosDir || ''}/${p.name.replace(/[\\/:*?"<>|]+/g, '_')} ${new Date().toLocaleTimeString('ru').replace(/:/g, '-')}.${format}`;
      const res = await A.exportVideo({ outPath: path, format, width: p.width, height: p.height, fps: p.fps, quality: a.quality || 'good', encoder: 'auto', rangeStart: a.range_start, rangeEnd: a.range_end, loudness: get().settings.loudness || undefined }, source);
      return res.ok ? ok('Saved', { path: res.outPath, seconds: res.seconds }) : { text: res.error || 'Export failed', isError: true };
    }
    default:
      return { text: 'Unknown tool ' + name, isError: true };
  }
}

// Подписка: команды приходят из главного процесса (помощник или внешний ИИ по MCP)
export function listenToolCalls() {
  return api.onToolCall(async (req: { id: number; name: string; args: any; source: string }) => {
    let out: ToolOutput;
    try {
      out = await execTool(req.name, req.args || {}, req.source);
    } catch (e) {
      out = { text: String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), isError: true };
    }
    api.toolResult(req.id, out);
  });
}
