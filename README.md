# Right Key

**Hear the key. See the chords. Play along.**

Right Key is a free web app that listens to live music through your phone's microphone and tells you the key, the root note and the chord progression, as it happens. It was built for musicians who play by ear: worship teams, wedding bands, church musicians and anyone who needs to find the key fast.

## What it does

| Feature | What you see |
|---|---|
| **Root note** | The key's root note in large type, with major or minor |
| **Chord now** | The chord being played, as a number (like `6m`) and a name (like `Em`) |
| **Chord progression** | The song's chord loop as numbers, like `4 1 5 6`, plus the chord names |
| **Bass note** | The lowest note, which the app uses to help pick the chord |
| **Voice note** | The pitch of a singer or lead instrument, with how sharp or flat it is |
| **Virtual piano** | A two-octave piano you can play. Tap a chord and its notes light up on the keys |
| **Play root / Play progression** | Plays back what the app thinks it heard, so you can check it by ear |

## How it works

1. **It listens.** The app reads the microphone and breaks the sound into the 12 notes of the scale.
2. **It ignores drum hits.** Short, sharp sounds are filtered out and the held notes are kept.
3. **It finds the chord.** It matches the notes against major, minor and seventh chords, and favours the chord that starts on the bass note.
4. **It learns the loop.** It writes down each chord change and looks for the pattern that repeats. The song can start on any chord (C Em D, C Em D...). That repeating pattern is the loop.
5. **It finds the key.** It checks which key all the loop's chords belong to, without assuming the first chord is the root. For example, C, G, D and Em all fit **G major**, so the root is G and the loop is `4 1 5 6`.

Numbers count from the key's major scale. In a minor key, `1` is the relative major.

## How to use it

1. Open the app on your phone or laptop and tap **Start**. Allow the microphone.
2. Put the device near the keys, guitar or amp. Closer to the band works better than near the crowd.
3. Wait for the first chords. The key shows as an early guess, then gets surer as the loop repeats.
4. When **Loop captured** appears, tap **Play progression** to check it against the song.
5. Tap **Play root** to hear the root note and find it on your instrument.

**Other buttons**
- **Lock key**: stops the key changing once it looks right.
- **Set key**: pick the key yourself if you already know it. The numbers follow your choice.
- **Reset**: clears everything for the next song.

## Privacy

Everything runs in your browser. No audio is recorded, saved or sent anywhere.

## Credits

Key detection uses the Krumhansl-Schmuckler key profiles. Built with the browser's Web Audio API.
