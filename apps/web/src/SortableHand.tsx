import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { PlayingCard } from '@apuntado/contracts';
import { insertCard, moveCard, reconcileOrder } from './hand-order';

type Insertion = {
  left: number | null;
  right: number | null;
  marker: number;
  edge: 'before' | 'after';
};

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
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: number;
    pointer: number;
    x: number;
    y: number;
    before: number | null;
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
  const commitOrder = (id: number, next: number[]) => {
    setOrder(next);
    setMessage(`Carta movida a la posición ${next.indexOf(id) + 1} de ${next.length}.`);
  };
  const clear = () => {
    const drag = gesture.current;
    gesture.current = null;
    if (drag) {
      if (drag.moved) suppressClick.current = true;
      const element = root.current?.querySelector<HTMLButtonElement>(`[data-card-no="${drag.id}"]`);
      if (element?.hasPointerCapture(drag.pointer)) element.releasePointerCapture(drag.pointer);
    }
    setDragging(null);
    setInsertion(null);
  };
  useEffect(() => {
    if (gesture.current) clear();
  }, [handSignature]);
  const down = (event: PointerEvent<HTMLButtonElement>, id: number) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      before: id,
      moved: false,
    };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true;
    setDragging(drag.id);
    const hand = root.current!;
    const rect = hand.getBoundingClientRect();
    const x = event.clientX - rect.left + hand.scrollLeft;
    const y = event.clientY - rect.top + hand.scrollTop;
    // Layout offsets ignore the preview transforms, so the insertion point does not oscillate.
    const positions = Array.from(hand.querySelectorAll<HTMLButtonElement>('[data-card-no]')).map(
      (element, index) => ({
        id: Number(element.dataset.cardNo),
        index,
        top: element.offsetTop,
        centerX: element.offsetLeft + element.offsetWidth / 2,
        centerY: element.offsetTop + element.offsetHeight / 2,
      }),
    );
    const target = [...positions].sort(
      (a, b) =>
        Math.abs(y - a.centerY) - Math.abs(y - b.centerY) ||
        Math.abs(x - a.centerX) - Math.abs(x - b.centerX),
    )[0];
    if (!target) return;
    const edge = x < target.centerX ? 'before' : 'after';
    const boundary = target.index + (edge === 'after' ? 1 : 0);
    const left = positions[boundary - 1];
    const right = positions[boundary];
    drag.before = right?.id ?? null;
    if (insertCard(ids, drag.id, drag.before) === ids) {
      setInsertion(null);
      return;
    }
    const sameRow = left && right && left.top === right.top;
    setInsertion({
      left: left?.top === target.top ? left.id : null,
      right: right?.top === target.top ? right.id : null,
      marker: sameRow ? right.id : target.id,
      edge: sameRow ? 'before' : edge,
    });
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (drag.moved) {
      suppressClick.current = true;
      commitOrder(drag.id, insertCard(ids, drag.id, drag.before));
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
        className={`hand sortable-hand ${dragging !== null ? 'is-dragging' : ''}`}
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
              className={`hand-card ${selected === id ? 'selected' : ''} ${dragging === id ? 'dragging' : ''} ${insertion?.left === id ? 'insertion-left' : ''} ${insertion?.right === id ? 'insertion-right' : ''}`}
              data-insertion-edge={insertion?.marker === id ? insertion.edge : undefined}
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
                  if (target !== undefined) commitOrder(id, moveCard(ids, id, target));
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
