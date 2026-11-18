import type { GameService } from './service.js';

export function gameWorker(games: GameService, onError: () => void) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const cycle = async () => {
    try {
      await games.expireDue();
    } catch {
      onError();
    }
    try {
      await games.flushEvents();
    } catch {
      onError();
    }
    if (running) {
      timer = setTimeout(() => {
        inFlight = cycle();
      }, 250);
      timer.unref();
    }
  };
  return {
    start() {
      if (running) return;
      running = true;
      inFlight = cycle();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
