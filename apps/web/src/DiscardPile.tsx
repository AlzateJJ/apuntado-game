import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlayingCard } from '@apuntado/contracts';

export function DiscardPile({
  cards,
  canDraw,
  draw,
  face,
  name,
}: {
  cards: PlayingCard[];
  canDraw: boolean;
  draw: () => void;
  face: (card: PlayingCard) => ReactNode;
  name: (card: PlayingCard) => string;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
    if (!open) return;
    document.body.classList.add('discard-view-open');
    return () => document.body.classList.remove('discard-view-open');
  }, [open]);
  return (
    <div className="pile">
      <button
        className="discard-card discard-stack"
        aria-label="Ver cartas descartadas"
        onClick={() => setOpen(true)}
      >
        {cards.length ? (
          cards.slice(-3).map((card) => (
            <span className="stack-layer" key={card.cardNo}>
              {face(card)}
            </span>
          ))
        ) : (
          <span className="empty-card">Vacío</span>
        )}
      </button>
      <strong>Descarte</strong>
      <span>
        {cards.length} {cards.length === 1 ? 'carta' : 'cartas'}
      </span>
      <button className="pile-draw-button" disabled={!canDraw || !cards.length} onClick={draw}>
        Robar del descarte
      </button>
      <dialog
        ref={dialog}
        className="discard-dialog"
        aria-labelledby="discard-title"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            setOpen(false);
        }}
      >
        <header>
          <div>
            <span className="eyebrow">CARTAS SOBRE LA MESA</span>
            <h2 id="discard-title">Pila de descarte</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Cerrar descarte"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>
        <p>
          De la más reciente a la más antigua. Esta vista es solo de consulta; el reloj continúa.
        </p>
        <div className="discard-gallery" role="list" aria-label="Cartas del descarte">
          {[...cards].reverse().map((card, index) => (
            <div
              role="listitem"
              key={card.cardNo}
              aria-label={`${name(card)}${index === 0 ? ', carta superior' : ''}`}
            >
              {face(card)}
              {index === 0 && <small>Superior</small>}
            </div>
          ))}
        </div>
        {!cards.length && <p>No hay cartas en el descarte.</p>}
        <p className="discard-note">
          Las cartas robadas dejan esta pila. Si se recicla el descarte para formar un mazo nuevo,
          aquí queda solo la carta superior.
        </p>
        <button className="secondary-button" onClick={() => setOpen(false)}>
          Volver a la mesa
        </button>
      </dialog>
    </div>
  );
}
