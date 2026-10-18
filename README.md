# Prism

A mobile-first, scale-locked instrument built with Web Audio. No build step or runtime dependencies.

Serve this directory over HTTPS (or localhost for development), then open `index.html`. For example, `python3 -m http.server 8000`. HTTPS is required for installed/offline use and motion permissions.

## Playing

- The 15 pads have **15 distinct pitches**, ordered left to right, then top to bottom. Root notes are highlighted. Rotation changes the grid shape, not its pitches.
- Choose Glass (bells), Ember (warm bass/lead), Drift (soft sustained tones), or Wire (bright plucks). Tone and Space shape the sound.
- Move upward within a pad for brightness. Stepped slides retrigger notes; continuous glide bends between them. Use octave buttons to shift the whole range.
- Hold latches notes after lifting your finger. Tap a latched pad to release it. Release all stops notes and loop playback.
- Settings contains key/scale, attack/release, slide mode, optional tilt, and an eighth-note arpeggiator. Tilt permission is requested only when selected.
- Keyboard users can focus a pad and hold Space or Enter.

## Phrases and recording

Choose tempo and a 1-, 2-, or 4-bar length, then Record loop. Recording starts immediately after a short audio-scheduling lead-in; there is no count-in. A metronome and sixteenth-note onset quantisation are optional. The phrase repeats automatically after its fixed length. Finish take ends capture early while preserving the full phrase length.

Overdub records one additional pass starting at the next loop boundary. Undo removes the last completed overdub; Clear removes the loop and can also be undone. Playback uses the phrase's original tempo, sound, pitch and recorded finger gestures, independent of subsequent key or preset changes. Clear the loop to change its tempo or length. There is a 512-note limit. Tone/Space knob automation and tilt are live-only, not recorded gestures.

Settings and the last completed loop are saved on this device. A reloaded loop waits for Play; it never autoplays. Switching apps, locking the phone, or losing focus releases notes and stops playback. A partially recorded take is preserved if it contains notes.

Record audio in Settings captures the instrument's stereo output, including effects, into a downloadable browser-supported format (usually WebM or M4A). It does not use the microphone. Stop recording to reveal Save recording. Export availability depends on the browser; phrase recording does not.

## Mobile and offline

The engine uses 16 pooled voices with shared reverb and delay. Loop and arpeggiator playback are scheduled against the audio clock with a short lookahead; no continuous visual animation loop runs when idle. After six idle seconds (allowing effects to decay), the audio context suspends until the next interaction. Under heavy polyphony, live touches can steal the oldest voice; background notes that exceed capacity are skipped with a visible warning.

After a first successful load, the service worker caches the application for offline use. Future releases must bump the `CACHE` version in `sw.js`. An available update is applied only after choosing the update button; old Prism caches are then removed.

## Checks

Run `node --test tests/*.test.mjs` and `node --check app.js`. No package installation is required for these checks.

The optional `node tests/browser.mjs` suite exercises mobile layouts, multitouch, audio, looping, export and offline launch in Chromium. It requires Playwright and its Chromium browser; `PLAYWRIGHT_MODULE` can point to an external installation's `index.mjs` so the app itself needs no dependencies.

Before a release, check real iPhone Safari and mid-range Android devices, both installed and in-browser: first-touch latency, ten-finger slides, overlapping touches on one pad, voice stealing, portrait/landscape rotation, lock/unlock, interrupted takes, offline launch/update, audio export, and heat/battery usage during sustained playback. Desktop browser checks cannot establish physical-device audio latency or battery performance.
