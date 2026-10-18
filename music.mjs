export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  minor: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
export const PRESETS = {
  glass: { wave: 'sine', harmonic: 2.001, mix: .28, attack: .008, release: .65, decay: .8, sustain: .12, tone: .65, space: .4 },
  ember: { wave: 'sawtooth', harmonic: .5, mix: .2, attack: .025, release: .3, decay: .3, sustain: .7, tone: .3, space: .15 },
  drift: { wave: 'triangle', harmonic: 1.004, mix: .4, attack: .35, release: 1.4, decay: 1, sustain: .85, tone: .45, space: .65 },
  wire: { wave: 'sawtooth', harmonic: 2, mix: .12, attack: .005, release: .2, decay: .22, sustain: .07, tone: .75, space: .2 },
};
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function noteInfo(index, key, scale, octave) {
  const tones = SCALES[scale];
  const midi = 48 + key + 12 * octave + tones[index % tones.length] + 12 * Math.floor(index / tones.length);
  return { midi, name: KEYS[midi % 12], octave: Math.floor(midi / 12) - 1, root: index % tones.length === 0 };
}
export const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
export function arpIndex(step, count, pattern) {
  if (count < 2) return 0;
  if (pattern === 'down') return count - 1 - step % count;
  if (pattern === 'bounce') {
    const phase = step % (count * 2 - 2);
    return phase < count ? phase : count * 2 - 2 - phase;
  }
  return step % count;
}
export function timedNote(note, start, end, loopDuration, snap) {
  const duration = clamp(end - start, .02, loopDuration);
  let offset = clamp(start, 0, loopDuration - .001);
  if (snap) offset = Math.min(loopDuration - snap, Math.round(offset / snap) * snap);
  return { ...note, offset, duration: Math.min(duration, loopDuration - offset) };
}
const finite = (n, low, high) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
export function validSound(sound) {
  return sound && Object.hasOwn(PRESETS, sound.preset) && finite(sound.tone, 0, 1) &&
    finite(sound.space, 0, 1) && finite(sound.attack, .005, .8) && finite(sound.release, .04, 2);
}
export function validLoop(loop) {
  return loop && loop.version === 1 && finite(loop.tempo, 50, 180) &&
    [1, 2, 4].includes(loop.bars) && finite(loop.duration, 1, 20) &&
    Math.abs(loop.duration - loop.bars * 240 / loop.tempo) < .001 &&
    Array.isArray(loop.notes) && loop.notes.length <= 512 &&
    loop.notes.every(n => finite(n.midi, 0, 127) && finite(n.offset, 0, loop.duration) &&
      finite(n.duration, .001, loop.duration) && n.offset + n.duration <= loop.duration + .001 &&
      finite(n.expression, 0, 1) && validSound(n.sound) &&
      Array.isArray(n.moves) && n.moves.length <= 1000 && n.moves.every(m =>
        Array.isArray(m) && m.length === 3 && finite(m[0], 0, n.duration + .001) &&
        finite(m[1], 0, 127) && finite(m[2], 0, 1)));
}
