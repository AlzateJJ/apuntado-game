import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { GameAudio } from './audio';

const preference = 'apuntado:sound-muted';
function readMuted() {
  try {
    return localStorage.getItem(preference) === 'true';
  } catch {
    return false;
  }
}
const SoundContext = createContext<{
  muted: boolean;
  toggle: () => void;
  engine: GameAudio;
} | null>(null);
export function SoundProvider({ children }: { children: ReactNode }) {
  const [muted, setMuted] = useState(readMuted);
  const [engine] = useState(() => new GameAudio());
  useEffect(() => {
    engine.setHidden(document.hidden);
    const unlock = () => engine.unlock();
    const visibility = () => engine.setHidden(document.hidden);
    const storage = (event: StorageEvent) => {
      if (event.key === preference) setMuted(event.newValue === 'true');
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storage);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', storage);
      engine.dispose();
    };
  }, [engine]);
  useEffect(() => {
    engine.setMuted(muted);
  }, [engine, muted]);
  const toggle = () => {
    const next = !muted;
    engine.setMuted(next);
    if (!next) engine.unlock();
    setMuted(next);
    try {
      localStorage.setItem(preference, String(next));
    } catch {
      /* Session preference still works. */
    }
  };
  return (
    <SoundContext.Provider value={{ muted, toggle, engine }}>{children}</SoundContext.Provider>
  );
}
export function SoundButton({ label = false }: { label?: boolean }) {
  const sound = useContext(SoundContext)!;
  return (
    <button
      type="button"
      className="sound-button"
      onClick={sound.toggle}
      aria-label={sound.muted ? 'Activar sonido' : 'Silenciar sonido'}
      aria-pressed={!sound.muted}
      title={sound.muted ? 'Activar música y avisos' : 'Silenciar música y avisos'}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="M11 4 6 8H3v8h3l5 4V4Z" />
        {sound.muted ? (
          <path d="m16 9 5 6m0-6-5 6" />
        ) : (
          <>
            <path d="M15 8a6 6 0 0 1 0 8" />
            <path d="M18 5a10 10 0 0 1 0 14" />
          </>
        )}
      </svg>
      {label && <span>{sound.muted ? 'Sonido desactivado' : 'Sonido activado'}</span>}
    </button>
  );
}
export function useTurnWarning(turn: string, remaining: number, active: boolean) {
  const { engine, muted } = useContext(SoundContext)!;
  const played = useRef('');
  useEffect(() => {
    const urgent = active && remaining > 0 && remaining <= 7;
    engine.setUrgent(urgent && !muted);
    const key = `${turn}:${remaining}`;
    if (urgent && !muted && played.current !== key) {
      played.current = key;
      engine.tick(remaining);
    }
    return () => engine.setUrgent(false);
  }, [engine, turn, remaining, active, muted]);
}
