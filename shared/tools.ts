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
    description: 'Change settings of a media clip: speed (0.1..8), volume (0..2), mute, fades, fit mode, position/scale/rotation/opacity (transform), Ken Burns style animation (animate + transform_end), keyframes (any number of position/scale/rotation/opacity states at given moments, smoothly interpolated), color correction, effects, music ducking. If the clip has keyframes, `transform` edits the keyframe at the playhead.',
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
      keyframes: {
        type: 'array',
        description: 'Replace all keyframes. Each: time in seconds from the clip start on the timeline, plus any of x, y, scale, rotation, opacity (missing values are taken from the clip transform). ease: smooth (default, eases in/out) or linear, applies to the move towards the next keyframe. Empty array removes keyframes.',
        items: obj({ time: num('Seconds from clip start'), x: num('0..1'), y: num('0..1'), scale: num('1 = fit'), rotation: num('Degrees'), opacity: num('0..1'), ease: str('Motion to next key', ['smooth', 'linear']) }, ['time']),
      },
      color: obj({
        preset: str('Look', ['none', 'bw', 'sepia', 'vintage', 'warm', 'cold', 'cinema', 'vivid', 'fade', 'cross']),
        brightness: num('-1..1, 0 = unchanged'), contrast: num('0..2, 1 = unchanged'),
        saturation: num('0..3, 1 = unchanged'), gamma: num('0.1..3, 1 = unchanged'),
        temperature: num('-1 cold .. 1 warm'),
        lut: str('Absolute path to a .cube LUT file (film look); empty string removes it'),
      }),
      effects: obj({
        blur: num('0..1'), vignette: num('0..1'), sharpen: num('0..1'), grain: num('0..1'),
        flipH: bool('Mirror horizontally'), flipV: bool('Flip vertically'),
      }),
      duck: bool('For music on the audio track: lower it automatically under speech'),
      voice: bool('Studio voice: clean EQ and compression for speech'),
      denoise: num('Noise reduction 0..1 (0 = off, 0.5 = typical)'),
      key: { anyOf: [obj({
        color: str('Background color to remove, #rrggbb (green #00ff00, blue #0000ff)'),
        similarity: num('0..1, how close a color must be to be removed, default 0.3'),
        blend: num('0..1, edge softness, default 0.1'),
      }), { type: 'null' }], description: 'Chroma key (green screen). null removes it. Put the keyed clip on an overlay track above a background.' },
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
    name: 'stabilize_clip', title: 'Убираю тряску',
    description: 'Stabilize a shaky media clip (two-pass vid.stab). Creates a processed copy and switches the clip to it; the original can be restored by the user. Takes about real-time.',
    inputSchema: obj({ clip_id: str('Media clip id') }, ['clip_id']),
  },
  {
    name: 'reverse_clip', title: 'Разворачиваю клип',
    description: 'Make a media clip play backwards (video and audio). Creates a processed copy and switches the clip to it.',
    inputSchema: obj({ clip_id: str('Media clip id') }, ['clip_id']),
  },
  {
    name: 'remove_background', title: 'Убираю фон',
    description: 'Remove the background behind people in a video clip without a green screen (offline person segmentation). Creates a copy with a transparent background and switches the clip to it; whatever is on lower tracks shows through. Best on the overlay (video) track above a new background.',
    inputSchema: obj({ clip_id: str('Media clip id') }, ['clip_id']),
  },
  {
    name: 'auto_reframe', title: 'Делаю вертикальное видео',
    description: 'Switch the project to vertical 9:16 (or the given size) and make every main-track video follow the speaker face with a smooth virtual camera (offline face detection). Use for Reels, Shorts, TikTok.',
    inputSchema: obj({ width: num('Default 1080'), height: num('Default 1920') }),
  },
  {
    name: 'remove_fillers', title: 'Убираю слова-паразиты',
    description: 'Transcribe the speech with word timestamps and cut filler words ("эээ", "ммм", "ну", "как бы", "короче", "типа", "um", "uh"...) out of the main track. Needs a speech-recognition key. Returns how many were removed.',
    inputSchema: obj({ words: { type: 'array', items: { type: 'string' }, description: 'Optional custom filler list (lowercase); default is a built-in Russian+English list' } }),
  },
  {
    name: 'make_subtitles', title: 'Делаю субтитры',
    description: 'Recognize speech and create subtitles. style "blogger" = big bold uppercase 1–3 words per screen with the spoken word highlighted (karaoke, like Reels/Shorts); "classic" = normal lines at the bottom. Replaces existing subtitles.',
    inputSchema: obj({
      style: str('Subtitle style', ['classic', 'blogger']),
      words: num('Words per screen for blogger style, default 3'),
      highlight: str('Highlight color for the current word, #rrggbb (blogger style)'),
      language: str('Speech language code, e.g. ru, en (optional)'),
    }),
  },
  {
    name: 'translate_subtitles', title: 'Перевожу субтитры',
    description: 'Translate all existing subtitle clips to another language with the configured AI, keeping the timing.',
    inputSchema: obj({ language: str('Target language name in English, e.g. English, Spanish, German, Russian') }, ['language']),
  },
  {
    name: 'export_subtitles', title: 'Сохраняю субтитры',
    description: 'Save subtitles as an .srt file (for YouTube upload). Returns the file path.',
    inputSchema: obj({ path: str('Absolute .srt path; default next to the videos folder') }),
  },
  {
    name: 'add_sticker', title: 'Добавляю стикер',
    description: 'Put an emoji sticker or a drawn shape (arrow, circle to highlight something, frame, underline, marker, star, check, cross, speech bubble) over the video at the playhead. Use update_clip/update_text afterwards to move or resize it.',
    inputSchema: obj({
      emoji: str('An emoji character, e.g. 🔥'),
      shape: str('Shape kind', ['arrow', 'pointer', 'circle', 'rect', 'underline', 'marker', 'star', 'check', 'cross', 'bubble']),
      color: str('Shape color #rrggbb, default #ff3b5c'),
      time: num('Timeline time, default playhead'),
    }),
  },
  {
    name: 'studio_voice', title: 'Делаю студийный звук',
    description: 'Turn studio voice processing (noise reduction + speech EQ and compression) on or off for every clip with audio.',
    inputSchema: obj({ on: bool('Default true') }),
  },
  {
    name: 'analyze_audio', title: 'Измеряю громкость',
    description: 'Measure integrated loudness (LUFS), true peak and loudness range of the whole mix. YouTube/VK/Telegram target is about -14 LUFS; export normalizes to the target from settings automatically.',
    inputSchema: obj({}),
  },
  {
    name: 'get_transcript', title: 'Читаю текст ролика',
    description: 'Text-based editing: get the spoken text of the main track as sentences with word numbers (from_word..to_word) and timeline times. Recognizes speech first if needed (needs a speech-recognition key). Use with cut_transcript to remove phrases like in a document.',
    inputSchema: obj({ force: bool('Recognize speech again even if a transcript exists') }),
  },
  {
    name: 'cut_transcript', title: 'Вырезаю фразы по тексту',
    description: 'Cut spoken words out of the video (and audio) like deleting text in a document. Give word ranges from get_transcript (from_word/to_word, inclusive) and/or an exact phrase to remove everywhere it is said. All cuts are one undo step. Subtitles move with the speech.',
    inputSchema: obj({
      ranges: { type: 'array', items: obj({ from_word: num('First word number'), to_word: num('Last word number, inclusive') }, ['from_word', 'to_word']), description: 'Word ranges to remove' },
      phrase: str('Remove every occurrence of this phrase (case and punctuation ignored)'),
    }),
  },
  {
    name: 'shorten_pauses', title: 'Укорачиваю паузы',
    description: 'Using the transcript, shorten every silence between words longer than min_gap seconds down to keep seconds. More precise than remove_silence for speech.',
    inputSchema: obj({ min_gap: num('Default 0.7'), keep: num('Default 0.3') }),
  },
  {
    name: 'find_shorts', title: 'Ищу моменты для коротких роликов',
    description: 'Find the best self-contained moments of a long video for vertical shorts (Reels/Shorts/TikTok) by the transcript with the configured AI (or split evenly by sentences when even=true). Returns ids, times, titles. Then call make_shorts.',
    inputSchema: obj({ count: num('How many, default 5'), min: num('Min length, s, default 20'), max: num('Max length, s, default 60'), even: bool('Split evenly by sentences without AI') }),
  },
  {
    name: 'make_shorts', title: 'Делаю короткие ролики',
    description: 'Render moments from find_shorts as separate vertical 1080x1920 videos with face tracking, big word-by-word subtitles and a title, queued for export to the Videos folder. Returns output paths.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'Short ids; default: the checked ones' }, subtitles: bool('Default true'), title: bool('Default true'), face_tracking: bool('Default true') }),
  },
  {
    name: 'beat_sync', title: 'Монтирую под ритм',
    description: 'Detect beats in the music clip (selected audio clip or the first one on audio tracks). mode "cut" trims main-track clips so every cut lands on a beat; mode "markers" only adds markers on beats. every: 1 = each beat, 2 = every other, 4 = each bar.',
    inputSchema: obj({ mode: str('What to do', ['cut', 'markers']), every: num('1, 2 or 4; default 2') }),
  },
  {
    name: 'export_formats', title: 'Сохраняю в других форматах',
    description: 'Queue copies of the project in other aspect ratios at once (vertical 9:16, square 1:1, wide 16:9, post 4:5) with face tracking; the project itself is not changed.',
    inputSchema: obj({ formats: { type: 'array', items: { type: 'string', enum: ['vertical', 'square', 'wide', 'post'] } }, path: str('Base output path .mp4; size is added to the name') }, ['formats']),
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
    name: 'generate_image', title: 'Рисую картинку',
    description: 'Generate an image with the image AI configured in Hlopushka settings (OpenAI GPT Image, Google Nano Banana or FLUX), save it to the user Documents/Хлопушка/Сгенерировано folder, import it and place it on the timeline. Write a detailed visual prompt (subject, style, lighting, composition); English or Russian both work. place: "main" appends to the main track (or at index), "overlay" puts it over the video at start (picture-in-picture), "none" only imports to the media library. aspect defaults to the project format. Returns media_id and clip_id.',
    inputSchema: obj({
      prompt: str('What to draw'),
      aspect: str('Aspect ratio', ['16:9', '9:16', '1:1', '4:3', '3:4']),
      place: str('Where to put it', ['main', 'overlay', 'none']),
      index: num('Position on the main track (0 = first). Default: end'),
      start: num('Overlay start time, seconds. Default: playhead'),
      duration: num('How long the image stays on screen, seconds. Default 4'),
      animate: bool('Slow zoom-in (Ken Burns), default true on the main track'),
    }, ['prompt']),
  },
  {
    name: 'list_voices', title: 'Смотрю голоса',
    description: 'List ElevenLabs voices available to the user (id, name, description). The voice chosen in settings is used by default.',
    inputSchema: obj({}),
  },
  {
    name: 'generate_speech', title: 'Озвучиваю текст',
    description: 'Voice-over: turn text into natural speech with ElevenLabs and place it on an audio track at start. Music on tracks with ducking automatically gets quieter under it. Write the text exactly as it should be spoken; numbers and abbreviations in words. Returns media_id, clip_id and the clip duration.',
    inputSchema: obj({
      text: str('Text to speak'),
      voice_id: str('Optional ElevenLabs voice id from list_voices'),
      start: num('Timeline start, seconds. Default: playhead'),
      place: bool('Put on the timeline (default true)'),
    }, ['text']),
  },
  {
    name: 'generate_sound_effect', title: 'Создаю звук',
    description: 'Generate a sound effect with ElevenLabs from a description (e.g. "whoosh transition", "crowd applause", "door creak") and place it on an audio track at start.',
    inputSchema: obj({
      prompt: str('Describe the sound, English works best'),
      duration: num('Length in seconds 0.5..30. Default: automatic'),
      start: num('Timeline start, seconds. Default: playhead'),
      place: bool('Put on the timeline (default true)'),
    }, ['prompt']),
  },
  {
    name: 'generate_music', title: 'Пишу музыку',
    description: 'Compose background music with ElevenLabs Music from a description (genre, mood, tempo, instruments) and place it on an audio track at start with auto-ducking under speech. Takes up to a minute.',
    inputSchema: obj({
      prompt: str('Describe the music'),
      duration: num('Length in seconds 3..300. Default: project length (at least 10s)'),
      vocals: bool('Allow singing (default false: instrumental)'),
      start: num('Timeline start, seconds. Default 0'),
      volume: num('Volume 0..2, default 0.35'),
      place: bool('Put on the timeline (default true)'),
    }, ['prompt']),
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

export const MCP_INSTRUCTIONS = 'Hlopushka is a video editor. Call get_project first to see the timeline, then edit with the other tools. Every change appears live in the editor and can be undone by the user.';

export const TOOL_TITLES: Record<string, string> = Object.fromEntries(TOOLS.map(t => [t.name, t.title]));

export const SYSTEM_PROMPT = `You are the built-in assistant of «Хлопушка» (Hlopushka), a video editor. You edit the user's project by calling tools.
Rules:
- Always answer the user in the language they write in (usually Russian), briefly and in plain words. The user is not a professional editor.
- Before editing, call get_project to see ids and times. Times are in seconds.
- The main track is magnetic: clips play back-to-back. Overlay/text/audio tracks use absolute start times.
- Every change is visible to the user and can be undone, so act confidently, then say in one or two sentences what you did.
- Use get_frame to check how the result looks when visual quality matters.
- Never invent file paths; ask the user or use media already in the library.
- For Reels/Shorts/TikTok prefer auto_reframe (keeps the face in frame) and make_subtitles with style "blogger".
- For bad sound use studio_voice; for "эээ" and filler words use remove_fillers; for shaky video use stabilize_clip; to cut a person out of the background without a green screen use remove_background (chroma key via update_clip.key only for real green/blue screens).
- When asked for chapters, a description or hashtags, base them on the transcript (transcribe) and answer in text; add markers only if the user asks.
- To remove specific phrases, repeats, mistakes or off-topic talk, use get_transcript then cut_transcript (text-based editing).
- To turn a long video into Reels/Shorts use find_shorts then make_shorts. For music videos use beat_sync.`;
