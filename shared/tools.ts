// Инструменты, которыми ИИ (встроенный помощник или внешний клиент по MCP) управляет редактором.
// Описания на английском: так их лучше понимает любая модель. Подписи title — для интерфейса.

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const num = (description: string) => ({ type: 'number', description });
const str = (description: string, e?: string[]) => (e ? { type: 'string', description, enum: e } : { type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });

const transformSchema = obj({
  x: num('Center X as fraction of frame width (0..1, 0.5 = center)'),
  y: num('Center Y as fraction of frame height (0..1, 0.5 = center)'),
  scale: num('1 = fit/fill the frame, 0.5 = half size'),
  rotation: num('Degrees'),
  opacity: num('0..1'),
});

const textStyleSchema = obj({
  font: str('Font family, e.g. Onest, Montserrat, Rubik, Unbounded, "PT Serif", Caveat, Oswald, "Press Start 2P"'),
  size: num('Font size in thousandths of frame height (70 = 7% of height)'),
  color: str('CSS color like #ffffff'),
  bold: bool('Bold'),
  italic: bool('Italic'),
  align: str('Alignment', ['left', 'center', 'right']),
  strokeWidth: num('Outline width in px at 1080p (0 = none)'),
  strokeColor: str('Outline color'),
  shadow: bool('Drop shadow'),
  background: bool('Box behind text'),
  backgroundColor: str('Box color'),
  backgroundOpacity: num('0..1'),
  uppercase: bool('Uppercase'),
  x: num('Center X fraction 0..1'),
  y: num('Center Y fraction 0..1 (0.85 = bottom area for subtitles)'),
  maxWidth: num('Max width as fraction of frame width'),
});

const anim = str('Text animation', ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom']);

export const TOOLS: ToolDef[] = [
  {
    name: 'get_project', title: 'Смотрю проект',
    description: 'Get the current project: format, duration, playhead, selection, media library, tracks with all clips (ids, times, settings) and markers. Call this first to understand the timeline. Times are in seconds.',
    inputSchema: obj({}),
  },
  {
    name: 'get_frame', title: 'Смотрю кадр',
    description: 'Render the final composed frame at a time (with all effects, texts and overlays) and return it as an image so you can see the result.',
    inputSchema: obj({ time: num('Timeline time in seconds') }, ['time']),
  },
  {
    name: 'import_media', title: 'Добавляю файлы',
    description: 'Import media files (video, image, audio) from absolute paths on the user computer into the media library. Returns new media ids.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' } }, ['paths']),
  },
  {
    name: 'add_to_timeline', title: 'Ставлю клип на таймлайн',
    description: 'Place a media item on the timeline. track "main" is the magnetic main video track (clips play back-to-back, use index to insert at position); "overlay" is picture-in-picture/images over video (needs start); "audio" is music/voice (needs start). in/out trim the source in seconds.',
    inputSchema: obj({
      media_id: str('Media id from the library'),
      track: str('Target track', ['main', 'overlay', 'audio']),
      index: num('For main track: insert position (0 = first). Default: end'),
      start: num('For overlay/audio: timeline start in seconds. Default: playhead'),
      in: num('Source in point, seconds'),
      out: num('Source out point, seconds (for images: duration)'),
    }, ['media_id']),
  },
  {
    name: 'split_clip', title: 'Разрезаю клип',
    description: 'Split a clip into two at a timeline time. Without clip_id splits every clip under that time on unlocked tracks.',
    inputSchema: obj({ time: num('Timeline time in seconds'), clip_id: str('Optional clip id') }, ['time']),
  },
  {
    name: 'trim_clip', title: 'Подрезаю клип',
    description: 'Change source in/out points of a media clip, or start/duration of a text clip.',
    inputSchema: obj({
      clip_id: str('Clip id'), in: num('New source in (media clips)'), out: num('New source out (media clips)'),
      start: num('New timeline start (overlay/audio/text clips)'), duration: num('New duration (text clips)'),
    }, ['clip_id']),
  },
  {
    name: 'move_clip', title: 'Перемещаю клип',
    description: 'Move a clip. On the main track use index (new order position); on other tracks use start (seconds).',
    inputSchema: obj({ clip_id: str('Clip id'), index: num('New position on main track'), start: num('New start time') }, ['clip_id']),
  },
  {
    name: 'delete_clips', title: 'Удаляю клипы',
    description: 'Delete clips. The main track closes gaps automatically.',
    inputSchema: obj({ clip_ids: { type: 'array', items: { type: 'string' } } }, ['clip_ids']),
  },
  {
    name: 'update_clip', title: 'Меняю настройки клипа',
    description: 'Change settings of a media clip: speed (0.1..8), volume (0..2), mute, fades, fit mode, position/scale/rotation/opacity (transform), Ken Burns style animation (animate + transform_end), color correction, effects, music ducking.',
    inputSchema: obj({
      clip_id: str('Clip id'),
      speed: num('Playback speed, 1 = normal'),
      volume: num('0..2'),
      muted: bool('Mute audio'),
      fade_in: num('Video fade-in seconds'), fade_out: num('Video fade-out seconds'),
      audio_fade_in: num('Audio fade-in seconds'), audio_fade_out: num('Audio fade-out seconds'),
      fit: str('fit = whole picture visible, fill = cover frame', ['fit', 'fill']),
      transform: transformSchema,
      animate: bool('Animate from transform to transform_end over the clip'),
      transform_end: transformSchema,
      color: obj({
        preset: str('Look', ['none', 'bw', 'sepia', 'vintage', 'warm', 'cold', 'cinema', 'vivid', 'fade', 'cross']),
        brightness: num('-1..1, 0 = unchanged'), contrast: num('0..2, 1 = unchanged'),
        saturation: num('0..3, 1 = unchanged'), gamma: num('0.1..3, 1 = unchanged'),
        temperature: num('-1 cold .. 1 warm'),
      }),
      effects: obj({
        blur: num('0..1'), vignette: num('0..1'), sharpen: num('0..1'), grain: num('0..1'),
        flipH: bool('Mirror horizontally'), flipV: bool('Flip vertically'),
      }),
      duck: bool('For music on the audio track: lower it automatically under speech'),
    }, ['clip_id']),
  },
  {
    name: 'set_transition', title: 'Ставлю переход',
    description: 'Set or remove the transition INTO a main-track clip from the previous clip.',
    inputSchema: obj({
      clip_id: str('Main-track clip id (not the first one)'),
      type: str('Transition type or "none"', ['none', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose', 'radial', 'zoomin', 'pixelize', 'smoothleft', 'smoothright']),
      duration: num('Seconds, default 0.6'),
    }, ['clip_id', 'type']),
  },
  {
    name: 'add_text', title: 'Добавляю текст',
    description: 'Add a text/title clip on the text track.',
    inputSchema: obj({
      text: str('Text, may contain line breaks'), start: num('Start seconds'), duration: num('Duration seconds'),
      style: textStyleSchema, anim_in: anim, anim_out: anim,
    }, ['text', 'start']),
  },
  {
    name: 'update_text', title: 'Меняю текст',
    description: 'Change a text clip: text, style, animations, timing.',
    inputSchema: obj({
      clip_id: str('Text clip id'), text: str('New text'), start: num('Start'), duration: num('Duration'),
      style: textStyleSchema, anim_in: anim, anim_out: anim,
    }, ['clip_id']),
  },
  {
    name: 'add_subtitles', title: 'Добавляю субтитры',
    description: 'Add many subtitle lines at once (replaces existing subtitles if replace=true). Use after transcribing or when you already know the spoken text.',
    inputSchema: obj({
      items: { type: 'array', items: obj({ start: num('Start'), end: num('End'), text: str('Line') }, ['start', 'end', 'text']) },
      replace: bool('Remove old subtitles first'),
      style: textStyleSchema,
    }, ['items']),
  },
  {
    name: 'transcribe', title: 'Распознаю речь',
    description: 'Transcribe speech of the whole project (or one clip) with the configured speech-to-text service. Returns timed segments. Set add_subtitles=true to put them on the timeline.',
    inputSchema: obj({ clip_id: str('Optional clip id'), add_subtitles: bool('Add as subtitles'), language: str('Language code, e.g. ru, en') }),
  },
  {
    name: 'remove_silence', title: 'Убираю паузы',
    description: 'Detect silent parts in main-track clips and cut them out (jump cut).',
    inputSchema: obj({ threshold_db: num('Silence level, default -35'), min_duration: num('Minimal pause length to cut, default 0.6s'), clip_id: str('Optional single clip') }),
  },
  {
    name: 'detect_scenes', title: 'Ищу смену сцен',
    description: 'Find scene cuts in a main-track clip; with split=true cut the clip at each scene change.',
    inputSchema: obj({ clip_id: str('Main-track clip id'), split: bool('Split at the cuts'), sensitivity: num('0..1, default 0.4') }, ['clip_id']),
  },
  {
    name: 'set_project', title: 'Меняю формат проекта',
    description: 'Change project settings: name, resolution, fps, background color.',
    inputSchema: obj({
      name: str('Project name'), width: num('Width px'), height: num('Height px'), fps: num('Frames per second'),
      background: str('Background color #rrggbb'),
      preset: str('Format preset', ['youtube', 'reels', 'square', 'post', '4k', 'cinema']),
    }),
  },
  {
    name: 'add_marker', title: 'Ставлю метку',
    description: 'Add a marker (chapter) at a time.',
    inputSchema: obj({ time: num('Seconds'), label: str('Label') }, ['time']),
  },
  {
    name: 'playback', title: 'Управляю просмотром',
    description: 'Control the preview player: seek to a time, play or pause.',
    inputSchema: obj({ action: str('Action', ['seek', 'play', 'pause']), time: num('Seconds for seek') }, ['action']),
  },
  {
    name: 'select_clips', title: 'Выделяю клипы',
    description: 'Select clips in the editor so the user sees them highlighted.',
    inputSchema: obj({ clip_ids: { type: 'array', items: { type: 'string' } } }, ['clip_ids']),
  },
  {
    name: 'undo', title: 'Отменяю', description: 'Undo the last change.', inputSchema: obj({}),
  },
  {
    name: 'redo', title: 'Возвращаю', description: 'Redo the last undone change.', inputSchema: obj({}),
  },
  {
    name: 'export_video', title: 'Сохраняю видео',
    description: 'Render the project to a file. Without path saves next to the project / in Videos folder. Returns the output path when finished.',
    inputSchema: obj({
      path: str('Absolute output path'),
      format: str('Container', ['mp4', 'webm', 'mov', 'gif', 'mp3', 'wav']),
      quality: str('Quality', ['draft', 'good', 'best']),
      range_start: num('Optional start seconds'), range_end: num('Optional end seconds'),
    }),
  },
];

export const MCP_INSTRUCTIONS = 'Kadr is a video editor. Call get_project first to see the timeline, then edit with the other tools. Every change appears live in the editor and can be undone by the user.';

export const TOOL_TITLES: Record<string, string> = Object.fromEntries(TOOLS.map(t => [t.name, t.title]));

export const SYSTEM_PROMPT = `You are the built-in assistant of «Кадр» (Kadr), a video editor. You edit the user's project by calling tools.
Rules:
- Always answer the user in the language they write in (usually Russian), briefly and in plain words. The user is not a professional editor.
- Before editing, call get_project to see ids and times. Times are in seconds.
- The main track is magnetic: clips play back-to-back. Overlay/text/audio tracks use absolute start times.
- Every change is visible to the user and can be undone, so act confidently, then say in one or two sentences what you did.
- Use get_frame to check how the result looks when visual quality matters.
- Never invent file paths; ask the user or use media already in the library.`;
