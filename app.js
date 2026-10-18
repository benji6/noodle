import { KEYS, SCALES, PRESETS, clamp, noteInfo, frequency, arpIndex, timedNote, validLoop } from './music.mjs';

const $ = id => document.getElementById(id);
const value = id => $(id).value;
const number = id => Number(value(id));
const status = message => {
  $('status').textContent = storageWarning && !message.includes('storage') ?
    `${message} Device storage is unavailable; changes may not survive closing noodle.` : message;
};
const fingers = new Map();
const latched = new Map();
const voices = [];
const pads = [];
const SETTINGS_KEY = 'noodle-settings-v2';
const LOOP_KEY = 'noodle-loop-v1';
const settingIds = ['preset', 'key', 'scale', 'slide', 'arp', 'attack', 'release', 'tone', 'space', 'tempo', 'bars', 'quantize', 'volume'];
let octave = 0, currentTempo = 96, hold = false, ctx, bus, master, wet, echo, delay, output, stream;
let loop = null, undo = null, playing = false, origin = 0, take = null;
let scheduler = null, idleTimer = null, nextClick = 0, nextArp = 0, arpStep = 0, lastTilt = 0;
let tiltEnabled = false, recorder = null, recordingChunks = [], downloadUrl;
let rectangles = [], storageWarning = false, voiceWarning = 0;
const scheduled = new Set();
const pendingCapture = new Map();

KEYS.forEach((key, i) => $('key').add(new Option(key, i, i === 9, i === 9)));

function storageError(error) {
  console.error('noodle storage:', error);
  storageWarning = true;
  status('Device storage unavailable. Changes will only last for this session.');
}
function saveSettings() {
  const settings = Object.fromEntries(settingIds.map(id => [id, value(id)]));
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, octave })); }
  catch (error) { storageError(error); }
}
function restore() {
  try {
    const rawSettings = localStorage.getItem(SETTINGS_KEY);
    if (rawSettings) {
      const saved = JSON.parse(rawSettings);
      for (const id of settingIds) {
        const el = $(id), stored = saved[id];
        if (typeof stored !== 'string') continue;
        if (el.tagName === 'SELECT') {
          if ([...el.options].some(option => option.value === stored)) el.value = stored;
        } else if (stored.trim() && Number.isFinite(Number(stored)) &&
          Number(stored) >= Number(el.min) && Number(stored) <= Number(el.max)) el.value = stored;
      }
      if (Number.isInteger(saved.octave)) octave = clamp(saved.octave, -2, 2);
    }
    const rawLoop = localStorage.getItem(LOOP_KEY);
    if (rawLoop) {
      const saved = JSON.parse(rawLoop);
      if (!validLoop(saved)) throw new Error('Saved loop is invalid');
      loop = saved;
    }
  } catch (error) {
    storageError(error);
  }
}
function saveLoop() {
  try {
    if (loop) localStorage.setItem(LOOP_KEY, JSON.stringify(loop));
    else localStorage.removeItem(LOOP_KEY);
  } catch (error) { storageError(error); }
}
function info(index) { return noteInfo(index, number('key'), value('scale'), octave); }
function renderPads() {
  pads.forEach((pad, index) => {
    const note = info(index);
    pad.querySelector('.note').textContent = note.name;
    pad.querySelector('.oct').textContent = note.octave;
    pad.querySelector('.degree').textContent = note.root ? 'ROOT' : index % SCALES[value('scale')].length + 1;
    pad.classList.toggle('root', note.root);
    pad.setAttribute('aria-label', `${note.name}${note.octave}${note.root ? ', root' : ''}`);
  });
  $('register').textContent = `${info(0).name}${info(0).octave}–${info(14).name}${info(14).octave}`;
  $('octave-down').disabled = octave <= -2;
  $('octave-up').disabled = octave >= 2;
}
function paint() {
  const active = new Set([...fingers.values(), ...latched.values()].filter(t => t.voice || value('arp') !== 'off').map(t => t.index));
  pads.forEach((pad, i) => {
    pad.classList.toggle('active', active.has(i));
    pad.setAttribute('aria-pressed', String(active.has(i)));
  });
}
for (let i = 0; i < 15; i++) {
  const pad = document.createElement('button');
  pad.className = 'key';
  pad.dataset.index = i;
  pad.innerHTML = '<span class="note"></span><span class="oct"></span><span class="degree"></span>';
  $('grid').append(pad);
  pads.push(pad);
}
function measure() { rectangles = pads.map(pad => pad.getBoundingClientRect()); }
function position(event) {
  const index = rectangles.findIndex(r => event.clientX >= r.left && event.clientX <= r.right &&
    event.clientY >= r.top && event.clientY <= r.bottom);
  if (index < 0) return null;
  const r = rectangles[index];
  return { index, expression: clamp(1 - (event.clientY - r.top) / r.height, 0, 1) };
}
function sound() {
  return { preset: value('preset'), tone: number('tone'), space: number('space'), attack: number('attack'), release: number('release') };
}
function cancelAt(param, time) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(time);
  else {
    const current = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(current, time);
  }
}
function setSpace() {
  if (!ctx) return;
  // Per-voice sends preserve a recorded phrase's space setting during overdubs.
  delay.delayTime.setTargetAtTime(60 / (loop?.tempo || currentTempo) * .75, ctx.currentTime, .04);
}
function createAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('Web Audio is not supported in this browser');
  ctx = new Audio({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.gain.value = number('volume');
  bus = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 10;
  compressor.attack.value = .003;
  compressor.release.value = .15;
  bus.connect(master).connect(compressor);
  output = ctx.createGain();
  compressor.connect(output).connect(ctx.destination);
  if (ctx.createMediaStreamDestination) {
    stream = ctx.createMediaStreamDestination();
    output.connect(stream);
  }
  const convolver = ctx.createConvolver();
  const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.25), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
  }
  convolver.buffer = impulse;
  wet = ctx.createGain();
  echo = ctx.createGain();
  delay = ctx.createDelay(1);
  const feedback = ctx.createGain();
  feedback.gain.value = .28;
  wet.connect(convolver).connect(bus);
  echo.connect(delay).connect(bus);
  delay.connect(feedback).connect(delay);
  for (let i = 0; i < 16; i++) {
    const osc = ctx.createOscillator(), overtone = ctx.createOscillator();
    const mix = ctx.createGain(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    const send = ctx.createGain(), echoSend = ctx.createGain();
    filter.type = 'lowpass';
    filter.Q.value = .7;
    gain.gain.value = 0;
    osc.connect(filter);
    overtone.connect(mix).connect(filter);
    filter.connect(gain).connect(bus);
    gain.connect(send).connect(wet);
    gain.connect(echoSend).connect(echo);
    osc.start();
    overtone.start();
    voices.push({ osc, overtone, mix, filter, gain, send, echoSend, owner: null, available: 0, started: 0 });
  }
  setSpace();
  ctx.onstatechange = () => {
    if (ctx.state !== 'running' && (fingers.size || latched.size || playing || take)) {
      stopEverything();
      status('Audio paused. Touch a pad or Play to resume.');
    }
  };
}
async function ready() {
  try {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!ctx) createAudio();
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') throw new Error('Audio could not resume');
    return true;
  } catch (error) {
    console.error('noodle audio:', error);
    status('Audio unavailable. Try reopening noodle and touching a pad.');
    return false;
  }
}
function expression(voice, midi, amount, at, glide = .012) {
  const preset = PRESETS[voice.sound.preset];
  voice.osc.frequency.setTargetAtTime(frequency(midi), at, glide);
  voice.overtone.frequency.setTargetAtTime(frequency(midi) * preset.harmonic, at, glide);
  voice.filter.frequency.setTargetAtTime(clamp(180 * 2 ** (voice.sound.tone * 4 + amount * 2.5), 100, 16000), at, .02);
}
function releaseVoice(voice, at = ctx.currentTime, duration = voice.sound.release) {
  cancelAt(voice.gain.gain, at);
  voice.gain.gain.setTargetAtTime(0, at, duration / 5);
  voice.gain.gain.setValueAtTime(0, at + duration);
  voice.available = at + duration;
  voice.owner = null;
}
function startVoice(midi, amount, settings, at, owner = null, duration = null) {
  let voice = voices.find(v => v.available <= at);
  if (!voice && owner) {
    voice = voices.reduce((a, b) => a.started < b.started ? a : b);
    if (voice.owner) {
      endCapture(voice.owner, ctx.currentTime);
      voice.owner.voice = null;
    }
  }
  if (!voice) {
    if (performance.now() - voiceWarning > 2000) {
      status('Voice limit reached. Try fewer held notes or a shorter release.');
      voiceWarning = performance.now();
    }
    return null;
  }
  const preset = PRESETS[settings.preset];
  for (const param of voiceParams(voice)) {
    cancelAt(param, at);
  }
  voice.sound = settings;
  voice.osc.type = preset.wave;
  voice.overtone.type = 'sine';
  voice.mix.gain.setValueAtTime(preset.mix, at);
  voice.send.gain.setValueAtTime(settings.space * .65, at);
  voice.echoSend.gain.setValueAtTime(settings.space * .25, at);
  voice.gain.gain.setTargetAtTime(0, at, .002);
  const onset = at + .006;
  voice.gain.gain.setValueAtTime(0, onset);
  voice.gain.gain.linearRampToValueAtTime(.12, onset + settings.attack);
  voice.gain.gain.setTargetAtTime(.12 * preset.sustain, onset + settings.attack, preset.decay / 4);
  expression(voice, midi, amount, at, .003);
  voice.owner = owner;
  voice.started = at;
  voice.available = Infinity;
  if (duration !== null) releaseVoice(voice, at + duration, settings.release);
  return voice;
}
function voiceParams(voice) {
  return [voice.gain.gain, voice.osc.frequency, voice.overtone.frequency, voice.filter.frequency,
    voice.mix.gain, voice.send.gain, voice.echoSend.gain, voice.osc.detune, voice.overtone.detune];
}
function beginCapture(owner, at, midi = owner.midi, settings = sound()) {
  if (!take || at < take.start || at >= take.end || take.notes.length + pendingCapture.size >= 512) return;
  pendingCapture.set(owner, { start: at, midi, expression: owner.expression, sound: settings, moves: [] });
}
function endCapture(owner, at) {
  const captured = pendingCapture.get(owner);
  if (!captured || !take) return;
  pendingCapture.delete(owner);
  const end = Math.min(Math.max(at, captured.start + .02), take.end);
  if (end <= captured.start) return;
  const note = timedNote(captured, captured.start - take.start, end - take.start, take.duration,
    value('quantize') === 'on' ? 60 / take.tempo / 4 : 0);
  delete note.start;
  note.moves = note.moves.filter(move => move[0] <= note.duration);
  take.notes.push(note);
}
function startTouch(touch) {
  if (value('arp') !== 'off') { startScheduler(); paint(); return; }
  const settings = sound();
  touch.voice = startVoice(touch.midi, touch.expression, settings, ctx.currentTime, touch);
  if (touch.voice) beginCapture(touch, ctx.currentTime, touch.midi, settings);
  paint();
}
function stopTouch(touch) {
  endCapture(touch, ctx.currentTime);
  if (touch.voice?.owner === touch) releaseVoice(touch.voice, Math.max(ctx.currentTime, touch.voice.started + .02));
  touch.voice = null;
}
async function press(id, index, amount) {
  if (latched.has(index)) {
    stopTouch(latched.get(index));
    latched.delete(index);
    paint();
    return;
  }
  const touch = { index, midi: info(index).midi, expression: amount, voice: null, lastMove: 0 };
  fingers.set(id, touch);
  if (!await ready()) { fingers.delete(id); return; }
  if (fingers.get(id) !== touch) return;
  startTouch(touch);
}
function release(id, cancelled = false) {
  const touch = fingers.get(id);
  if (!touch) return;
  fingers.delete(id);
  if (hold && !cancelled && ctx?.state === 'running') {
    if (latched.has(touch.index)) stopTouch(latched.get(touch.index));
    latched.set(touch.index, touch);
  } else if (ctx) stopTouch(touch);
  paint();
  stopIdleScheduler();
}
$('grid').addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  measure();
  const p = position(event);
  if (!p) return;
  $('grid').setPointerCapture(event.pointerId);
  void press(event.pointerId, p.index, p.expression);
});
$('grid').addEventListener('pointermove', event => {
  const touch = fingers.get(event.pointerId), p = position(event);
  if (!touch || !p || !ctx || (!touch.voice && value('arp') === 'off')) return;
  if (p.index !== touch.index && value('slide') === 'steps') {
    stopTouch(touch);
    touch.index = p.index;
    touch.midi = info(p.index).midi;
    touch.expression = p.expression;
    startTouch(touch);
  } else {
    touch.index = p.index;
    let midi = info(p.index).midi;
    if (value('slide') === 'glide') {
      const rect = rectangles[p.index];
      const offset = (event.clientX - rect.left) / rect.width - .5;
      const neighbour = info(clamp(p.index + (offset < 0 ? -1 : 1), 0, 14)).midi;
      midi += Math.abs(offset) * (neighbour - midi);
    }
    touch.midi = midi;
    touch.expression = p.expression;
    if (touch.voice?.owner === touch) expression(touch.voice, midi, p.expression, ctx.currentTime, .025);
    const captured = pendingCapture.get(touch);
    if (captured && ctx.currentTime - touch.lastMove > .04 && captured.moves.length < 1000) {
      captured.moves.push([ctx.currentTime - captured.start, midi, p.expression]);
      touch.lastMove = ctx.currentTime;
    }
    paint();
  }
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('grid').addEventListener(type, event => release(event.pointerId, type !== 'pointerup'));
}
pads.forEach((pad, i) => {
  pad.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) void press(`key-${i}`, i, .6);
  });
  pad.addEventListener('keyup', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); release(`key-${i}`); }
  });
  pad.addEventListener('blur', () => release(`key-${i}`, true));
  pad.addEventListener('click', event => {
    if (event.detail === 0 && !fingers.has(`key-${i}`)) {
      void press(`assist-${i}`, i, .6).then(() => setTimeout(() => release(`assist-${i}`), 250));
    }
  });
});

function updateTransport() {
  $('record').textContent = take ? (ctx && ctx.currentTime < take.start ?
    (take.overdub ? 'Overdub armed' : 'Starting…') : 'Finish take') : loop ? 'Overdub' : 'Record loop';
  $('record').classList.toggle('recording', Boolean(take));
  $('play').textContent = playing ? 'Stop' : 'Play';
  $('play').disabled = !loop || Boolean(take);
  $('undo').disabled = !undo || Boolean(take);
  $('clear').disabled = !loop && !take;
  if (loop) {
    currentTempo = loop.tempo;
    $('tempo').value = loop.tempo;
    $('bars').value = loop.bars;
  }
  $('tempo').disabled = Boolean(loop || take);
  $('bars').disabled = Boolean(loop || take);
  $('tempo').title = $('bars').title = loop ? 'Clear the loop to change its tempo or length.' : '';
}
function startScheduler() {
  if (scheduler === null) scheduler = setInterval(tick, 25);
}
function stopIdleScheduler() {
  if (scheduler !== null && !playing && !take && !(value('arp') !== 'off' && (fingers.size || latched.size))) {
    clearInterval(scheduler);
    scheduler = null;
  }
  const idle = !playing && !take && !fingers.size && !latched.size && recorder?.state !== 'recording';
  if (ctx?.state === 'running' && idle && idleTimer === null) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!playing && !take && !fingers.size && !latched.size && recorder?.state !== 'recording') {
        ctx.suspend().catch(error => {
          console.error('noodle audio suspension:', error);
          status('Could not pause idle audio. Close noodle to stop audio processing.');
        });
      }
    }, 6000);
  } else if (!idle) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
function stopPlayback() {
  playing = false;
  scheduled.clear();
  if (ctx) {
    for (const voice of voices) {
      if (!voice.owner && voice.available > ctx.currentTime) {
        for (const param of voiceParams(voice)) cancelAt(param, ctx.currentTime);
        releaseVoice(voice, ctx.currentTime, .04);
      }
    }
  }
  $('progress').value = 0;
  updateTransport();
  stopIdleScheduler();
}
function finishTake() {
  if (!take) return;
  for (const owner of [...pendingCapture.keys()]) endCapture(owner, Math.min(ctx.currentTime, take.end));
  const finished = take;
  take = null;
  pendingCapture.clear();
  if (!finished.notes.length) {
    status('No notes recorded. Touch some pads during the next take.');
    if (!loop) stopPlayback();
    updateTransport();
    stopIdleScheduler();
    return;
  }
  undo = loop ? structuredClone(loop) : null;
  loop = {
    version: 1, tempo: finished.tempo, bars: finished.bars, duration: finished.duration,
    notes: [...(loop?.notes || []), ...finished.notes].slice(0, 512),
  };
  if (!playing) { origin = Math.max(ctx.currentTime + .06, finished.end); playing = true; }
  if (!finished.overdub) scheduled.clear();
  saveLoop();
  setSpace();
  status(loop.notes.length >= 512 ? 'Loop full (512 notes). Undo or clear to make room.' : 'Loop playing. Add another layer with Overdub.');
  updateTransport();
  startScheduler();
}
async function recordLoop() {
  if (take) {
    if (ctx.currentTime < take.start) {
      take = null;
      status('Overdub cancelled.');
      updateTransport();
      return;
    }
    finishTake();
    return;
  }
  if (!await ready()) return;
  if (loop?.notes.length >= 512) { status('Loop full. Undo or clear before recording another layer.'); return; }
  const tempo = loop?.tempo || currentTempo, bars = loop?.bars || number('bars');
  const duration = bars * 240 / tempo;
  if (loop && !playing) {
    origin = ctx.currentTime + .1;
    playing = true;
    scheduled.clear();
  }
  const start = loop ? origin + Math.max(0, Math.ceil((ctx.currentTime + .08 - origin) / duration)) * duration : ctx.currentTime + .08;
  take = { start, end: start + duration, tempo, bars, duration, notes: [], overdub: Boolean(loop), started: false };
  nextClick = start;
  status(loop ? 'Overdub starts at the next loop boundary.' : `Recording ${bars} bar${bars > 1 ? 's' : ''}. Play a phrase.`);
  updateTransport();
  startScheduler();
}
function click(at, accent) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = accent ? 1300 : 900;
  gain.gain.setValueAtTime(.045, at);
  gain.gain.exponentialRampToValueAtTime(.0001, at + .035);
  osc.connect(gain).connect(bus);
  osc.start(at);
  osc.stop(at + .04);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
function tick() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime, horizon = now + .1;
  if (take && !take.started && now >= take.start) {
    take.started = true;
    if (value('arp') === 'off') {
      for (const touch of [...fingers.values(), ...latched.values()]) {
        if (touch.voice?.owner === touch && !pendingCapture.has(touch)) beginCapture(touch, take.start, touch.midi, touch.voice.sound);
      }
    }
    updateTransport();
  }
  if (take && now >= take.end) finishTake();
  if (playing && loop) {
    const first = Math.max(0, Math.floor((now - origin) / loop.duration));
    const last = Math.max(0, Math.floor((horizon - origin) / loop.duration));
    for (let cycle = first; cycle <= last; cycle++) {
      loop.notes.forEach((note, i) => {
        const intended = origin + cycle * loop.duration + note.offset, key = `${cycle}:${i}`;
        if (intended < now - .03 || intended >= horizon || scheduled.has(key)) return;
        const at = Math.max(intended, now + .003);
        scheduled.add(key);
        const voice = startVoice(note.midi, note.expression, note.sound, at, null, note.duration);
        if (voice) {
          for (const [offset, midi, amount] of note.moves) expression(voice, midi, amount, at + offset, .025);
        }
      });
    }
    for (const key of scheduled) if (Number(key.split(':')[0]) < first) scheduled.delete(key);
    $('progress').value = now < origin ? 0 : ((now - origin) % loop.duration) / loop.duration;
  } else if (take) $('progress').value = clamp((now - take.start) / take.duration, 0, 1);
  const tempo = loop?.tempo || take?.tempo || currentTempo, beat = 60 / tempo;
  if ($('metronome').checked && (playing || take)) {
    const base = playing ? origin : take.start;
    if (nextClick < now) nextClick = base + Math.ceil((now - base) / beat) * beat;
    while (nextClick < horizon) {
      if (nextClick >= base) click(nextClick, Math.round((nextClick - base) / beat) % 4 === 0);
      nextClick += beat;
    }
  }
  if (value('arp') !== 'off') {
    const notes = [...new Map([...fingers.values(), ...latched.values()].map(t => [t.midi, t])).values()].sort((a, b) => a.midi - b.midi);
    if (notes.length) {
      if (nextArp < now) {
        const base = playing ? origin : take?.start ?? now;
        nextArp = base + Math.max(0, Math.ceil((now - base) / (beat / 2))) * beat / 2;
      }
      while (nextArp < horizon) {
        const touch = notes[arpIndex(arpStep++, notes.length, value('arp'))];
        const settings = sound(), length = beat * .4;
        const voice = startVoice(touch.midi, touch.expression, settings, nextArp, null, length);
        if (voice && take && nextArp >= take.start && nextArp < take.end) {
          const token = {};
          beginCapture(token, nextArp, touch.midi, settings);
          const captured = pendingCapture.get(token);
          if (captured) captured.expression = touch.expression;
          endCapture(token, nextArp + length);
        }
        nextArp += beat / 2;
      }
    }
  }
  stopIdleScheduler();
}
function stopEverything() {
  if (ctx && take) {
    if (ctx.currentTime >= take.start) finishTake();
    else { take = null; pendingCapture.clear(); }
  }
  if (ctx) {
    for (const touch of [...fingers.values(), ...latched.values()]) stopTouch(touch);
  }
  fingers.clear();
  latched.clear();
  stopPlayback();
  paint();
  stopIdleScheduler();
}
$('record').onclick = () => { void recordLoop(); };
$('play').onclick = async () => {
  if (playing) { stopPlayback(); status('Loop stopped.'); return; }
  if (!loop || !await ready()) return;
  origin = ctx.currentTime + .1;
  nextClick = origin;
  scheduled.clear();
  playing = true;
  setSpace();
  startScheduler();
  updateTransport();
  status(`Playing your ${loop.bars}-bar phrase at ${loop.tempo} BPM.`);
};
$('undo').onclick = () => {
  stopEverything();
  loop = undo;
  undo = null;
  saveLoop();
  updateTransport();
  status('Last overdub removed. Press Play to hear the previous take.');
};
$('clear').onclick = () => {
  stopEverything();
  undo = loop;
  loop = null;
  saveLoop();
  updateTransport();
  status('Loop cleared. Undo restores it.');
};
$('hold').onclick = () => {
  hold = !hold;
  $('hold').setAttribute('aria-pressed', String(hold));
  if (!hold && ctx) {
    latched.forEach(stopTouch);
    latched.clear();
    paint();
    stopIdleScheduler();
  }
  status(hold ? 'Hold on. Tap a held pad again to release it.' : 'Hold off.');
};
$('panic').onclick = () => { stopEverything(); status('All notes released.'); };
for (const direction of ['down', 'up']) {
  $(`octave-${direction}`).onclick = () => {
    stopEverything();
    octave = clamp(octave + (direction === 'up' ? 1 : -1), -2, 2);
    renderPads();
    saveSettings();
  };
}
$('settings').onclick = () => { $('panel').showModal(); };
$('close').onclick = () => { $('panel').close(); };
function choosePreset() {
  const preset = PRESETS[value('preset')];
  for (const id of ['attack', 'release', 'tone', 'space']) $(id).value = preset[id];
  status(`${value('preset')[0].toUpperCase() + value('preset').slice(1)}. Slide up for brightness; sideways to explore notes.`);
}
$('preset').addEventListener('input', choosePreset);
$('surprise').onclick = () => {
  const names = Object.keys(PRESETS);
  $('preset').value = names[Math.floor(Math.random() * names.length)];
  choosePreset();
  $('tone').value = .2 + Math.random() * .6;
  $('space').value = .1 + Math.random() * .6;
  saveSettings();
  status('A new sound, with your key and volume unchanged.');
};
for (const id of ['key', 'scale']) $(id).addEventListener('input', () => { stopEverything(); renderPads(); });
$('arp').addEventListener('input', () => {
  stopEverything();
  nextArp = 0;
  arpStep = 0;
  status(value('arp') === 'off' ? 'Arpeggiator off.' : 'Arpeggiator ready. Hold a chord to make a pattern.');
});
for (const id of ['tone', 'space']) $(id).addEventListener('input', () => {
  if (!ctx) return;
  for (const touch of [...fingers.values(), ...latched.values()]) {
    if (touch.voice?.owner !== touch) continue;
    touch.voice.sound = { ...touch.voice.sound, [id]: number(id) };
    if (id === 'tone') expression(touch.voice, touch.midi, touch.expression, ctx.currentTime);
    else {
      touch.voice.send.gain.setTargetAtTime(number('space') * .65, ctx.currentTime, .03);
      touch.voice.echoSend.gain.setTargetAtTime(number('space') * .25, ctx.currentTime, .03);
    }
  }
});
$('volume').addEventListener('input', () => {
  if (ctx) master.gain.setTargetAtTime(number('volume'), ctx.currentTime, .02);
});
for (const id of settingIds) $(id).addEventListener('change', () => {
  const el = $(id);
  if (el.type === 'number') {
    if (!el.value.trim() || !el.checkValidity()) {
      status('Tempo must be a whole number from 50 to 180 BPM.');
      el.value = loop?.tempo || 96;
    }
      currentTempo = Number(el.value);
    setSpace();
  }
  saveSettings();
});

function resetTilt() {
  if (!ctx) return;
  for (const voice of voices) {
    voice.osc.detune.setTargetAtTime(0, ctx.currentTime, .05);
    voice.overtone.detune.setTargetAtTime(0, ctx.currentTime, .05);
    if (voice.owner) expression(voice, voice.owner.midi, voice.owner.expression, ctx.currentTime);
  }
}
function onTilt(event) {
  if (!ctx || ctx.state !== 'running' || document.hidden || value('tilt') === 'off' || performance.now() - lastTilt < 50) return;
  lastTilt = performance.now();
  if (event.beta === null || event.gamma === null) return;
  for (const voice of voices) {
    if (!voice.owner) continue;
    if (value('tilt') === 'detune') {
      const cents = clamp(event.gamma, -45, 45);
      voice.osc.detune.setTargetAtTime(cents, ctx.currentTime, .05);
      voice.overtone.detune.setTargetAtTime(cents, ctx.currentTime, .05);
    } else {
      expression(voice, voice.owner.midi, clamp((event.beta + 30) / 90, 0, 1), ctx.currentTime);
    }
  }
}
$('tilt').onchange = async () => {
  resetTilt();
  window.removeEventListener('deviceorientation', onTilt);
  if (value('tilt') === 'off') return;
  try {
    if (!window.DeviceOrientationEvent) throw new Error('Device orientation is not supported');
    if (!tiltEnabled && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('Motion permission denied');
    }
    tiltEnabled = true;
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    status('Tilt enabled. Return Tilt to Off to reset the sound.');
  } catch (error) {
    console.error('noodle tilt:', error);
    $('tilt').value = 'off';
    status('Tilt unavailable or permission denied. Finger expression still works.');
  }
};
$('capture').onclick = async () => {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  if (!await ready()) return;
  if (!window.MediaRecorder || !stream) {
    status('Audio recording is not supported in this browser. Your phrase loop still saves locally.');
    return;
  }
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream.stream, mimeType ? { mimeType } : undefined);
    recordingChunks = [];
    recorder.ondataavailable = event => { if (event.data.size) recordingChunks.push(event.data); };
    recorder.onerror = event => {
      console.error('noodle recording:', event.error);
      status('Audio recording failed. Your loop is still saved locally.');
      $('capture').textContent = 'Record audio';
    };
    recorder.onstop = () => {
      $('capture').textContent = 'Record audio';
      if (!recordingChunks.length) { status('No audio was captured.'); return; }
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      const type = recorder.mimeType;
      downloadUrl = URL.createObjectURL(new Blob(recordingChunks, { type }));
      $('download').href = downloadUrl;
      $('download').download = `noodle-${new Date().toISOString().slice(0, 10)}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`;
      $('download').hidden = false;
      status('Recording ready. Open Settings and choose Save recording.');
      stopIdleScheduler();
    };
    recorder.start(1000);
    $('capture').textContent = 'Stop audio recording';
    status('Recording audio. Close Settings and play; reopen to stop and save.');
  } catch (error) {
    console.error('noodle recording:', error);
    status('Could not start audio recording in this browser.');
  }
};
function interrupt() {
  stopEverything();
  if (recorder?.state === 'recording') recorder.stop();
  resetTilt();
}
window.addEventListener('blur', interrupt);
document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt(); });
window.addEventListener('pagehide', interrupt);
window.addEventListener('resize', () => {
  if (ctx) {
    for (const id of [...fingers.keys()]) release(id, true);
    latched.forEach(stopTouch);
    latched.clear();
    paint();
    stopIdleScheduler();
  }
  measure();
});
$('grid').addEventListener('contextmenu', event => event.preventDefault());
restore();
currentTempo = number('tempo');
renderPads();
measure();
updateTransport();
if (loop && !storageWarning) status('Your last loop is ready. Press Play, or touch to explore.');
if (!window.MediaRecorder) $('capture').textContent = 'Audio export unavailable';
