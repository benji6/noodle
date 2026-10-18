import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALES, PRESETS, noteInfo, frequency, arpIndex, timedNote, validLoop } from '../music.mjs';

test('every scale, key and register exposes 15 unique ascending pitches', () => {
  for (const scale of Object.keys(SCALES)) {
    for (let key = 0; key < 12; key++) {
      for (let octave = -2; octave <= 2; octave++) {
        const notes = Array.from({ length: 15 }, (_, i) => noteInfo(i, key, scale, octave));
        assert.equal(new Set(notes.map(n => n.midi)).size, 15);
        notes.forEach((note, i) => {
          assert.ok(note.midi >= 0 && note.midi <= 127);
          if (i) assert.ok(note.midi > notes[i - 1].midi);
          assert.equal(note.root, i % SCALES[scale].length === 0);
        });
      }
    }
  }
});
test('concert A and octave shifts are accurate', () => {
  assert.equal(frequency(69), 440);
  const low = noteInfo(4, 9, 'minor', 0);
  assert.equal(noteInfo(4, 9, 'minor', 1).midi, low.midi + 12);
});
test('arpeggiator patterns do not repeat bounce endpoints', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => arpIndex(i, 3, 'bounce')), [0, 1, 2, 1, 0, 1, 2, 1]);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => arpIndex(i, 3, 'down')), [2, 1, 0, 2]);
  assert.equal(arpIndex(12, 1, 'bounce'), 0);
});
const sound = { preset: 'glass', tone: .5, space: .4, attack: .008, release: .65 };
const note = { midi: 60, expression: .5, sound, moves: [] };
const loop = { version: 1, tempo: 120, bars: 1, duration: 2, notes: [{ ...note, offset: 0, duration: .5 }] };
test('quantisation and note lengths stay inside the phrase', () => {
  assert.deepEqual(timedNote(note, .14, .5, 2, .125), { ...note, offset: .125, duration: .36 });
  const last = timedNote(note, 1.99, 3, 2, .125);
  assert.equal(last.offset, 1.875);
  assert.equal(last.duration, .125);
});
test('saved loops accept all presets and reject unsafe or inconsistent data', () => {
  assert.equal(validLoop(loop), true);
  for (const preset of Object.keys(PRESETS)) {
    assert.equal(validLoop({ ...loop, notes: [{ ...loop.notes[0], sound: { ...sound, preset } }] }), true);
  }
  assert.equal(Boolean(validLoop({ ...loop, duration: 3 })), false);
  assert.equal(Boolean(validLoop({ ...loop, notes: [{ ...loop.notes[0], midi: NaN }] })), false);
  assert.equal(Boolean(validLoop({ ...loop, notes: [{ ...loop.notes[0], sound: { ...sound, preset: 'unknown' } }] })), false);
  assert.equal(Boolean(validLoop({ ...loop, notes: [{ ...loop.notes[0], moves: [[8, 60, .5]] }] })), false);
  assert.equal(Boolean(validLoop({ ...loop, notes: Array(513).fill(loop.notes[0]) })), false);
});
