import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { PlayingCard } from '@apuntado/contracts';
import { moveCard, reconcileOrder } from './hand-order';

function savedOrder(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}
export function SortableHand({
  cards,
  storageKey,
  selected,
  select,
  cardName,
  face,
}: {
  cards: PlayingCard[];
  storageKey: string;
  selected: number | null;
  select: (id: number) => void;
  cardName: (card: PlayingCard) => string;
  face: (card: PlayingCard) => ReactNode;
}) {
  const [order, setOrder] = useState(() => savedOrder(storageKey));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: number;
    pointer: number;
    x: number;
    y: number;
    target: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const cardIds = cards.map((card) => card.cardNo);
  const handSignature = cardIds.join(',');
  const ids = reconcileOrder(order, cardIds);
  const signature = ids.join(',');
  useEffect(() => {
    // Forget removed identifiers, so drawing the same physical card later adds it at the end.
    setOrder((previous) => {
      const next = reconcileOrder(previous, cardIds);
      return next.join(',') === previous.join(',') ? previous : next;
    });
  }, [handSignature]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      /* Keep ordering in memory. */
    }
  }, [storageKey, signature]);
  const reorder = (id: number, target: number) => {
    const next = moveCard(ids, id, target);
    setOrder(next);
    setMessage(`Carta movida a la posición ${next.indexOf(id) + 1} de ${next.length}.`);
  };
  const clear = () => {
    gesture.current = null;
    setDragging(null);
    setOver(null);
  };
  useEffect(() => {
    if (gesture.current && !cards.some((card) => card.cardNo === gesture.current!.id)) clear();
  }, [cards]);
  const down = (event: PointerEvent<HTMLButtonElement>, id: number) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target: id,
      moved: false,
    };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true;
    setDragging(drag.id);
    const target = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[data-card-no]'))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .sort(
        (a, b) =>
          Math.hypot(
            event.clientX - a.rect.x - a.rect.width / 2,
            event.clientY - a.rect.y - a.rect.height / 2,
          ) -
          Math.hypot(
            event.clientX - b.rect.x - b.rect.width / 2,
            event.clientY - b.rect.y - b.rect.height / 2,
          ),
      )[0];
    if (target) {
      drag.target = Number(target.element.dataset.cardNo);
      setOver(drag.target);
    }
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (drag.moved) {
      suppressClick.current = true;
      reorder(drag.id, drag.target);
    }
    clear();
  };
  return (
    <>
      <div className="hand-tools">
        <p className="muted" id="hand-order-help">
          Arrastra las cartas para ordenarlas, incluso fuera de tu turno. Con teclado: Alt +
          flechas.
        </p>
        <button
          className="text-button"
          onClick={() =>
            setOrder(
              [...cards]
                .sort((a, b) => a.suit.localeCompare(b.suit) || a.rank - b.rank || a.deck - b.deck)
                .map((card) => card.cardNo),
            )
          }
        >
          Ordenar por palo
        </button>
        <button
          className="text-button"
          onClick={() =>
            setOrder(
              [...cards]
                .sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit) || a.deck - b.deck)
                .map((card) => card.cardNo),
            )
          }
        >
          Ordenar de menor a mayor
        </button>
      </div>
      <div
        ref={root}
        className="hand sortable-hand"
        role="group"
        aria-label="Tu mano"
        aria-describedby="hand-order-help"
      >
        {ids.map((id) => {
          const card = cards.find((value) => value.cardNo === id)!;
          return (
            <button
              type="button"
              key={id}
              data-card-no={id}
              className={`hand-card ${selected === id ? 'selected' : ''} ${dragging === id ? 'dragging' : ''} ${over === id && dragging !== id ? 'drop-target' : ''}`}
              aria-label={`Seleccionar ${cardName(card)}`}
              aria-pressed={selected === id}
              onPointerDown={(event) => down(event, id)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={clear}
              onLostPointerCapture={clear}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                select(id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  clear();
                  return;
                }
                if (
                  event.altKey &&
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
                ) {
                  event.preventDefault();
                  const offset = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
                  const target = ids[ids.indexOf(id) + offset];
                  if (target !== undefined) reorder(id, target);
                }
              }}
            >
              {face(card)}
            </button>
          );
        })}
      </div>
      <p className="sr-only" role="status">
        {message}
      </p>
    </>
  );
}
