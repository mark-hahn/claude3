// One context for the page: browsers cap how many a page may open.
let audio: AudioContext | undefined;

// A short tone. Plays only once the page has had a click (autoplay rules), which the
// notification permission already needed.
export function beep(): void {
  audio ??= new AudioContext();
  void audio.resume();
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.frequency.value = 880;
  gain.gain.value = 0.2;
  tone.connect(gain).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 0.15);
}
