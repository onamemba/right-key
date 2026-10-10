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
| **Play root / Play progression** | Plays back what the app thinks it heard, so you can check it by ear |

## How it works

1. **It listens.** The app reads the microphone and breaks the sound into the 12 notes of the scale.
2. **It ignores drum hits.** Short, sharp sounds are filtered out and the held notes are kept.
3. **It finds the chord.** It matches the notes against major, minor and seventh chords, and favours the chord that starts on the bass note.
4. **It learns the loop.** When the first chord of the song comes back, the app saves the chords before it as one loop.
5. **It finds the key.** It checks which key all the loop's chords belong to. For example, C, G, D and Em all fit **G major**, so the root is G and the loop is `4 1 5 6`.

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

## Tips for better results

- Start the app at the beginning of the song, so the first chord is the loop's start.
- Use **Reset** between songs.
- A line from the sound desk (aux out) is more accurate than a room microphone.
- Loud crowds, muddy rooms and jazzy chords make guessing harder.

## Limits

- It recognises major, minor and seventh chords. Suspended, diminished and extended chords are not shown yet.
- It is a guide for your ears, not a replacement for them. Always check against the song.
- The key can be wrong in the first few seconds of a song.
- The loop can end early on songs where the first chord comes back inside the pattern (such as C G C D).

## Privacy

Everything runs in your browser. No audio is recorded, saved or sent anywhere.

## Run it yourself

Right Key is a single file, `index.html`, with no build step.

- **On your computer:** open `index.html` in a browser (microphone access needs HTTPS or `localhost`).
- **On GitHub Pages:** upload the files to a repo, then Settings > Pages > deploy from the `main` branch, root folder.

## Editing the code

- `loop()` reads the microphone each frame and scores the chords.
- `findKey()` picks the key from the loop, the bass notes and the overall note mix.
- `draw()` updates the screen.
- The `<style>` block holds the iOS-style look (glass cards, light and dark modes).

## Ideas for later

- Home-screen icon and offline use
- An ear-training game (name the note, chord or progression)
- A neural chord model for better accuracy in full-band recordings
- A capo and transpose view

## Credits

Key detection uses the Krumhansl-Schmuckler key profiles. Built with the browser's Web Audio API.
