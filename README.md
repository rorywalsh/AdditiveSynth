# Additive Synth Lab

A small Web MIDI additive synthesizer for the classroom. Each partial is
one sine oscillator with its own amplitude, frequency multiple and ADSR
envelope. A plain canvas draws the sum of all partials.

## Run it

Web MIDI needs a secure origin, so serve the folder rather than opening
`index.html` directly:

```bash
cd AdditiveSynth
python -m http.server 8000
```

Then open <http://localhost:8000> in Chrome or Edge. Click **Enable
sound**, play a MIDI keyboard, and the device is picked up automatically
(MIDI devices can also be plugged in after the page loads).

No MIDI keyboard? Use the computer keys:

- `A W S E D F T G Y H U J K` play a chromatic octave
- `Z` / `X` shift the octave down / up
- `Esc` releases all notes

## What students can explore

- **Add partials** with the `+ Add partial` button. Each partial has:
  - an **amplitude** slider
  - a **frequency multiple** text box (×1 = fundamental, ×2 = octave,
    ×3 = twelfth, ×1.5 = perfect fifth above the fundamental, etc.)
  - an **ADSR envelope** with Attack, Decay, Sustain and Release
  - an **Exponential envelope** switch for curved segments
- Play a note and add a partial while it sounds: the new sine fades in.
- Move an amplitude or frequency multiple while holding a chord to hear
  the timbre change instantly. Envelope edits apply from the next note.
- Set sustain to 0% to make a percussive, plucked sound; set a long
  attack and release to make a pad.
- The scope shows the waveform at the sustain level when idle, and the
  live envelope while notes are held. It is drawn with the Canvas 2D API.

## Saving and loading patches

Use **Download JSON** in the Partials panel to save the current sound, and
**Load JSON** to restore it later. A patch stores every partial's
amplitude, frequency multiple, ADSR and exponential flag, plus the master
volume:

```json
{
  "format": "additive-synth-patch",
  "version": 1,
  "masterVolume": 0.7,
  "partials": [
    { "amp": 0.8, "ratio": 1, "a": 0.01, "d": 0.25, "s": 0.65, "r": 0.45, "exp": false }
  ]
}
```

Envelope times are in seconds. Loading a patch stops any sounding notes and
replaces the whole patch; files with more than 16 partials are shortened to
the first 16.

## Files

| File         | Purpose                                                       |
| ------------ | ------------------------------------------------------------- |
| `index.html` | Page structure, waveform canvas and the partial-card template |
| `style.css`  | Dark, responsive interface styling                            |
| `synth.js`   | Web Audio engine: oscillators, envelopes, voices, master bus  |
| `ui.js`      | Builds the partial control cards and wires their inputs       |
| `sketch.js`  | Canvas waveform, Web MIDI, computer keyboard, status UI       |

There are no runtime libraries or build steps: the audio engine uses the
Web Audio API directly, and the scope uses the Canvas 2D API. This keeps
per-partial envelopes, polyphony and exponential segments straightforward.

## How it works, briefly

- A note-on creates a **voice**: one sine oscillator per partial, each
  at `baseFrequency × ratio`.
- Every oscillator has its own `GainNode`; the ADSR is scheduled with
  `setValueAtTime`, `linearRampToValueAtTime` or
  `exponentialRampToValueAtTime`.
- Exponential ramps use a small minimum gain (0.0001) because Web Audio
  cannot ramp exponentially to zero.
- Up to 10 voices are kept; older voices are quickly released when the
  limit is reached. A compressor on the master bus catches the peaks
  when many partials line up.
- The canvas draws two cycles of the summed partial waveform using each
  partial's live envelope level (or its sustain level when idle).

## Notes

- Browsers require a click or key press before audio can start; that is
  what the **Enable sound** button is for.
- The MIDI status pill is clickable — it retries MIDI access. If it says
  **use localhost**, serve the page as shown above rather than opening
  `index.html` directly or using a network IP over plain HTTP. If it says
  **MIDI blocked**, allow MIDI for the site in the address-bar permissions,
  then reload. If it says **use Chrome or Edge**, the browser does not
  provide the Web MIDI API (Safari does not support it; Firefox may need
  Web MIDI enabled).
- A connected keyboard cannot be detected until the browser grants the
  page MIDI access; the status is about the API, not the device.
- Up to 16 partials are allowed.
