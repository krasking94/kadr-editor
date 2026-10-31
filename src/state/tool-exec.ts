// Выполнение команд ИИ. Каждая команда — обычное действие редактора, поэтому пользователь
// видит изменение сразу и может отменить его.
import { api } from '../api';
import type { Keyframe, MediaClip, TextAnim, TransitionType } from '../../shared/types';
import { clipDuration, findClip, FORMAT_PRESETS, projectDuration } from '../../shared/timeline';
import { TOOL_TITLES } from '../../shared/tools';
import * as A from './actions';
import { commit, get, redo, set, undo } from './store';
import { generate, videoSourceImage } from './generate';
import { makeCover } from '../lib/cover';
import { musicClip } from './media-tools';
import * as S from './smart';
import * as SC from './script';
import * as MT from './media-tools';
import { timelineWords } from '../../shared/transcript';
import type { ShapeKind } from '../lib/stickers';
import { RAMP_PRESETS } from '../../shared/ramp';
import { applyRamp, clearRamp } from './ramp';
import { groupClips, ungroupClip } from './group';
import { createMulticam, switchCamera } from './multicam';
import { addTextOnObject, attachToObject, blurObject, trackClip } from './track';
import { fixIssue, runPreflight } from './preflight';
import { runDraft } from './draft';
import { usePublish } from './publish';

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
      id: t.id, kind: t.kind, name: t.name, muted: t.muted, locked: t.locked, hidden: t.hidden, ...(t.volume !== undefined ? { volume: t.volume } : {}),
      clips: t.clips.map(c => c.type === 'text'
        ? { id: c.id, type: 'text', text: c.text, start: r2(c.start), end: r2(c.start + c.duration), style: c.style, anim_in: c.animIn, anim_out: c.animOut, subtitle: !!c.subtitle, ...(c.words?.length ? { word_highlight: c.highlight || true } : {}), ...(c.follow ? { follows_object_of: c.follow.clipId } : {}) }
        : {
          id: c.id, type: 'media', media_id: c.mediaId, media_name: p.media.find(m => m.id === c.mediaId)?.name,
          start: r2(c.start), end: r2(c.start + clipDuration(c)), in: r2(c.in), out: r2(c.out), speed: c.speed,
          volume: c.volume, muted: c.muted, fit: c.fit, transform: c.transform, animate: c.animate, ...(c.animate ? { transform_end: c.transformEnd } : {}),
          color: c.color, effects: c.effects, transition: c.transition, fade_in: c.fadeIn, fade_out: c.fadeOut, duck: c.duck,
          voice: c.voice, denoise: c.denoise, key: c.key, ...(c.path?.length ? { face_tracking: true } : {}), ...(c.origin ? { processed: c.origin.done } : {}),
          ...(c.adjust ? { adjustment_layer: true } : {}), ...(c.blend ? { blend: c.blend } : {}), ...(c.crop ? { crop: c.crop } : {}), ...(c.mask ? { mask: c.mask } : {}),
          ...(c.smooth ? { smooth: true } : {}), ...(c.eq ? { eq: c.eq } : {}), ...(c.faces ? { faces_blurred: c.faces.samples.some(x => x.boxes.length), blur_strength: c.faces.strength } : {}),
          ...(c.origin?.ramp ? { speed_ramp: c.origin.ramp.points } : {}), ...(c.group ? { nested_clips: c.group.main.length } : {}),
          ...(c.cam ? { multicam: c.cam.group, camera: c.cam.angle } : {}), ...(c.track ? { tracked_object: c.track.label || true } : {}),
          ...(c.follow ? { follows_object_of: c.follow.clipId } : {}),
        }),
    })),
    markers: p.markers.map(m => ({ time: r2(m.time), label: m.label })),
    ...(p.multicam?.length ? { multicam: p.multicam.map(g => ({ id: g.id, name: g.name, cameras: g.angles.map(a => ({ media_id: a.mediaId, offset: a.offset })), audio: g.audio })) } : {}),
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
      if (Array.isArray(a.keyframes)) {
        const b = (f.clip as MediaClip).transform;
        patch.keys = a.keyframes.map((k: any) => ({
          t: Math.max(0, Number(k.time) || 0), x: k.x ?? b.x, y: k.y ?? b.y, scale: k.scale ?? b.scale, rotation: k.rotation ?? b.rotation, opacity: k.opacity ?? b.opacity,
          ...(k.ease === 'linear' ? { ease: 'linear' as const } : {}),
        })).sort((p: Keyframe, q: Keyframe) => p.t - q.t);
        if (patch.keys!.length) patch.animate = false;
      }
      if (a.color) patch.color = { ...a.color, ...(a.color.lut === '' ? { lut: undefined } : {}) };
      if (a.key !== undefined) patch.key = a.key ? { color: a.key.color || '#00ff00', similarity: a.key.similarity ?? 0.3, blend: a.key.blend ?? 0.1 } : undefined;
      if (a.effects) patch.effects = a.effects;
      if (a.color && a.color.wheels !== undefined) {
        const w = a.color.wheels;
        const one = (x: any) => ({ hue: Number(x?.hue) || 0, amount: Math.max(0, Math.min(1, Number(x?.amount) || 0)) });
        patch.color = { ...patch.color, wheels: w ? { shadows: one(w.shadows), midtones: one(w.midtones), highlights: one(w.highlights) } : undefined };
      }
      if (a.blend !== undefined) patch.blend = a.blend === 'normal' ? undefined : a.blend;
      if (a.crop !== undefined) patch.crop = a.crop ? { l: a.crop.l || 0, r: a.crop.r || 0, t: a.crop.t || 0, b: a.crop.b || 0 } : undefined;
      if (a.mask !== undefined) patch.mask = a.mask === 'none' ? undefined : a.mask;
      if (a.smooth !== undefined) patch.smooth = !!a.smooth;
      if (a.eq !== undefined) patch.eq = a.eq ? { low: a.eq.low || 0, mid: a.eq.mid || 0, high: a.eq.high || 0, comp: a.eq.comp || 0 } : undefined;
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
    case 'remove_background':
      await S.removeBackground(a.clip_id, source);
      return ok('Background removed');
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
    case 'get_transcript': {
      if (!(await SC.ensureTranscripts({ force: !!a.force, source }))) return { text: 'No speech found (or no speech-recognition key in Settings → AI)', isError: true };
      return ok('Transcript of the main track', SC.transcriptForTool());
    }
    case 'cut_transcript': {
      const words = timelineWords(get().project!);
      if (!words.length) return { text: 'No transcript yet: call get_transcript first', isError: true };
      const spans: [number, number][] = (a.ranges || []).map((r: any) => [Number(r.from_word), Number(r.to_word)]);
      if (a.phrase) spans.push(...SC.findPhrase(words, String(a.phrase)));
      if (!spans.length) return { text: 'Nothing to cut: phrase not found', isError: true };
      const sec = SC.cutWordSpans(spans, `Вырезано по тексту: ${spans.length}`, source);
      return ok(`Cut ${spans.length} pieces, ${r2(sec)} s removed. Word numbers changed: call get_transcript again before the next cut.`);
    }
    case 'shorten_pauses': {
      if (!(await SC.ensureTranscripts({ source }))) return { text: 'No speech found', isError: true };
      const r = SC.shortenPauses(a.min_gap ?? 0.7, a.keep ?? 0.3, source);
      return ok(`Shortened ${r.count} pauses, ${r2(r.seconds)} s removed`);
    }
    case 'find_shorts': {
      const items = await SC.findShorts({ count: a.count, min: a.min, max: a.max, even: !!a.even, source });
      return ok(`Found ${items.length} moments`, items.map(i => ({ id: i.id, start: r2(i.start), end: r2(i.end), title: i.title, why: i.why, score: i.score, checked: i.checked })));
    }
    case 'make_shorts': {
      const paths = await SC.makeShorts(a.ids, { subtitles: a.subtitles !== false, title: a.title !== false, faces: a.face_tracking !== false, ask: false, source });
      return paths.length ? ok('Queued for export', paths) : { text: 'No shorts to make: call find_shorts first', isError: true };
    }
    case 'beat_sync': {
      const every = [1, 2, 4].includes(Number(a.every)) ? Number(a.every) : 2;
      const n = a.mode === 'markers' ? await MT.beatMarkers(every, source) : await MT.cutToBeats(every, source);
      return ok(a.mode === 'markers' ? `Added ${n} beat markers` : `Trimmed ${n} clips to the beat`);
    }
    case 'export_formats': {
      const p = get().project!;
      const info = get().info;
      const base = a.path || `${get().settings.exportDir || info?.videosDir || ''}/${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.mp4`;
      const n = await SC.queueFormats(a.formats || [], { outPath: base, format: 'mp4', width: p.width, height: p.height, fps: p.fps, quality: 'good', encoder: 'auto', loudness: get().settings.loudness || undefined });
      return ok(`Queued ${n} formats`);
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
    case 'add_adjustment_layer': {
      const id = await S.addAdjustLayer({ start: a.start, duration: a.duration, source });
      return ok('Adjustment layer added; change its look with update_clip (color, effects)', { clip_id: id });
    }
    case 'auto_color':
      return ok('Color fixed', await S.autoColor(a.clip_id, source));
    case 'blur_faces':
      return ok('Faces blurred', await S.blurFaces(a.clip_id, { strength: a.strength, source }));
    case 'fit_music': {
      const c = a.clip_id || musicClip()?.id;
      if (!c) return { text: 'No music clip on audio tracks', isError: true };
      const r = await S.fitMusic(c, { source });
      return ok('Music fitted', { ends_at: r2(r.end), loops: r.copies });
    }
    case 'add_title_template':
      return ok('Title added', { clip_ids: S.addTitleTemplate(a.template, { texts: a.texts, start: a.start, source }) });
    case 'apply_brand': {
      const out: Record<string, unknown> = {};
      if (a.logo) out.logo_clip = await S.addBrandLogo({ source });
      if (a.texts) out.texts_restyled = S.applyBrandToTexts({ source });
      return ok('Brand applied', out);
    }
    case 'set_track': {
      const t = s.project.tracks.find(x => x.id === a.track_id);
      if (!t) return { text: 'No such track', isError: true };
      const patch: Partial<typeof t> = {};
      if (a.volume !== undefined) patch.volume = Math.max(0, Math.min(2, Number(a.volume)));
      for (const k of ['muted', 'hidden', 'locked'] as const) if (a[k] !== undefined) patch[k] = !!a[k];
      if (a.name) patch.name = String(a.name);
      A.updateTrack(t.id, patch, `Дорожка «${t.name}» изменена`);
      return ok('Track updated');
    }
    case 'make_cover': {
      const path = await makeCover({ time: a.time, title: String(a.title || ''), sub: a.subtitle, layout: a.layout, color: a.color });
      return ok('Cover saved', { path });
    }
    case 'generate_video': {
      let image: string | undefined;
      if (a.image_media_id) image = s.project.media.find(m => m.id === a.image_media_id && m.kind === 'image')?.path;
      else if (a.animate_frame) image = (await videoSourceImage())?.path;
      const r = await generate({ kind: 'video', prompt: String(a.prompt || ''), image, duration: a.duration, place: a.place || 'main', index: a.index, start: a.start }, source);
      return ok('Video created', { media_id: r.media.id, clip_id: r.clipId, duration: r2(r.duration), file: r.path });
    }
    case 'speed_ramp': {
      if (a.clear) { clearRamp(String(a.clip_id), source); return ok('Normal speed restored'); }
      const pts = Array.isArray(a.points) && a.points.length >= 2 ? a.points : RAMP_PRESETS.find(r => r.id === a.preset)?.points || RAMP_PRESETS[0].points;
      await applyRamp(String(a.clip_id), pts, source);
      const c = findClip(get().project!, String(a.clip_id))?.clip;
      return ok('Speed ramp applied', c ? { duration: r2(clipDuration(c)) } : undefined);
    }
    case 'group_clips': {
      const id = await groupClips((a.clip_ids || []).map(String), { name: a.name, source });
      return ok('Grouped into one clip', { clip_id: id });
    }
    case 'ungroup_clip':
      return ok('Ungrouped', { clip_ids: ungroupClip(String(a.clip_id), source) });
    case 'create_multicam': {
      const id = await createMulticam((a.media_ids || []).map(String), { audio: a.audio, source });
      return ok('Multicam created', { group_id: id, clip_id: get().selection[0] });
    }
    case 'switch_camera': {
      const done = switchCamera(Math.round(Number(a.angle) || 0), { time: a.time, clipId: a.clip_id, whole: !!a.whole, source });
      return done ? ok(`Camera ${Number(a.angle) + 1}`) : { text: 'No multicam clip there', isError: true };
    }
    case 'track_object': {
      const r = await trackClip(String(a.clip_id), { x: Number(a.x), y: Number(a.y), w: Number(a.w), h: Number(a.h) }, { time: a.time, source, label: a.label });
      return ok('Object tracked', { samples: r.samples, lost: r.lost });
    }
    case 'attach_to_object': {
      if (a.text) return ok('Label follows the object', { clip_id: addTextOnObject(String(a.object_clip_id), String(a.text), source) });
      attachToObject(String(a.target_id), a.object_clip_id ? String(a.object_clip_id) : null, source);
      return ok(a.object_clip_id ? 'Layer follows the object' : 'Layer stays in place');
    }
    case 'blur_object':
      blurObject(String(a.clip_id), a.strength ?? 0.75, source);
      return ok('Object blurred');
    case 'preflight_check': {
      let issues = await runPreflight({ deep: a.deep !== false });
      if (a.fix) {
        for (const i of issues) if (i.fix) await fixIssue(i).catch(() => undefined);
        issues = await runPreflight({ deep: false });
      }
      return ok(issues.length ? `${issues.length} issue(s)` : 'All good', issues.map(i => ({ level: i.level, title: i.title, detail: i.detail, time: i.time, clip_id: i.clipId, fix: i.fix?.label })));
    }
    case 'auto_draft': {
      const p = get().project!;
      const ids = Array.isArray(a.media_ids) && a.media_ids.length ? a.media_ids.map(String) : p.media.filter(m => m.kind !== 'audio').map(m => m.id);
      const plan = await runDraft({ mediaIds: ids, request: String(a.request || ''), target: Number(a.target) || 60, format: a.format || 'project', subtitles: a.subtitles !== false, title: a.title !== false, musicId: a.music_id, replace: a.replace ?? false, source });
      return plan ? ok('Draft built', { title: plan.title, pieces: plan.pieces.length, duration: r2(projectDuration(get().project!)) }) : { text: 'Could not build a draft', isError: true };
    }
    case 'open_publish': {
      set({ dialog: 'publish' });
      usePublish.setState({ suggest: { title: a.title, description: a.description, tags: a.tags } });
      return ok('Publish window opened. The user will choose platforms and press Publish.');
    }
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
