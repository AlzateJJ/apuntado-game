// A small original, pentatonic loop. No downloads or third-party audio assets.
export const warningVolume = (seconds: number) => 0.035 + (7 - seconds) * 0.017;
const melody = [72, 76, 79, 76, 74, 0, 72, 0, 69, 72, 76, 72, 67, 0, 69, 0];
const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private step = 0;
  private nextBeat = 0;
  private muted = false;
  private hidden = false;
  private urgent = false;
  private nodes = new Set<OscillatorNode>();
  private warningNodes = new Set<OscillatorNode>();

  unlock() {
    if (this.muted || this.hidden) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.65;
        this.master.connect(this.context.destination);
      }
      void this.context
        .resume()
        .then(() => this.startLoop())
        .catch(() => {});
    } catch {
      // Audio is optional; a browser without it must still be able to play.
    }
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.pause();
    else if (this.context) this.unlock();
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) this.pause();
    else if (this.context) this.unlock();
  }
  setUrgent(urgent: boolean) {
    this.urgent = urgent;
    if (!urgent) {
      for (const oscillator of this.warningNodes) oscillator.stop();
      this.warningNodes.clear();
    }
  }
  private pause() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const oscillator of this.nodes) oscillator.stop();
    this.nodes.clear();
    this.warningNodes.clear();
    if (this.context && this.master) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(0, this.context.currentTime);
      void this.context.suspend().catch(() => {});
    }
  }
  private startLoop() {
    if (this.muted || this.hidden || !this.context || !this.master || this.timer) return;
    this.master.gain.setValueAtTime(0.65, this.context.currentTime);
    this.nextBeat = this.context.currentTime + 0.03;
    const schedule = () => {
      const context = this.context!;
      if (context.state !== 'running') return;
      // Never replay a backlog after an inactive/background tab.
      if (this.nextBeat < context.currentTime) this.nextBeat = context.currentTime + 0.03;
      while (this.nextBeat < context.currentTime + 0.15) {
        const note = melody[this.step % melody.length]!;
        const volume = this.urgent ? 0.006 : 0.019;
        if (note) this.tone(frequency(note), this.nextBeat, 0.4, volume, 'sine');
        if (this.step % 4 === 0)
          this.tone(
            frequency(this.step % 16 < 8 ? 48 : 45),
            this.nextBeat,
            0.65,
            volume * 0.8,
            'triangle',
          );
        this.step++;
        this.nextBeat += 0.38;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 80);
  }
  tick(seconds: number) {
    if (
      this.muted ||
      this.hidden ||
      this.context?.state !== 'running' ||
      seconds < 1 ||
      seconds > 7
    )
      return;
    const now = this.context.currentTime;
    this.tone(seconds % 2 ? 1250 : 950, now, 0.055, warningVolume(seconds), 'triangle', true);
    this.tone(
      seconds % 2 ? 950 : 1250,
      now + 0.46,
      0.045,
      warningVolume(seconds) * 0.7,
      'triangle',
      true,
    );
  }
  private tone(
    hz: number,
    when: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    warning = false,
  ) {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(hz, when);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(volume, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(gain);
    gain.connect(this.master!);
    this.nodes.add(oscillator);
    if (warning) this.warningNodes.add(oscillator);
    oscillator.onended = () => {
      this.nodes.delete(oscillator);
      this.warningNodes.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(when);
    oscillator.stop(when + duration + 0.01);
  }
  dispose() {
    this.pause();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.master = null;
  }
}
