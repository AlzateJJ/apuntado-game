import type { CardGroup, PlayingCard } from '@apuntado/contracts';
import { cards, RuleError } from '../domain.js';

export interface Evaluation {
  groups: CardGroup[];
  leftovers: PlayingCard[];
  penalty: number;
}
const catalog = new Map(cards().map((card) => [card.cardNo, card]));
const FULL = (1 << 10) - 1;
export const points = (card: PlayingCard) => (card.rank === 1 || card.rank > 10 ? 10 : card.rank);
export const total = (hand: PlayingCard[]) => hand.reduce((sum, card) => sum + points(card), 0);
export const sameSuit = (hand: PlayingCard[]) =>
  hand.length > 0 && hand.every((card) => card.suit === hand[0]!.suit);
export function handFromIds(ids: number[]): PlayingCard[] {
  if (ids.length !== 10 || new Set(ids).size !== 10 || ids.some((id) => !catalog.has(id)))
    throw new RuleError('INVALID_HAND', 'El cierre requiere diez cartas físicas distintas.');
  return [...ids].sort((a, b) => a - b).map((id) => catalog.get(id)!);
}
const consecutive = (ranks: number[]) =>
  ranks.sort((a, b) => a - b).every((rank, i, all) => i === 0 || rank === all[i - 1]! + 1);
export function meldKind(hand: PlayingCard[]): CardGroup['kind'] | null {
  if (hand.length < 3) return null;
  if (hand.every((card) => card.rank === hand[0]!.rank)) return 'group';
  if (
    sameSuit(hand) &&
    (consecutive(hand.map((card) => card.rank)) ||
      consecutive(hand.map((card) => (card.rank === 1 ? 14 : card.rank))))
  )
    return 'run';
  return null;
}
type Meld = { mask: number; kind: CardGroup['kind']; cards: PlayingCard[] };
const subset = (hand: PlayingCard[], mask: number) => hand.filter((_, i) => mask & (1 << i));
function melds(hand: PlayingCard[]): Meld[] {
  const result: Meld[] = [];
  for (let mask = 1; mask <= FULL; mask++) {
    const selected = subset(hand, mask),
      kind = meldKind(selected);
    if (kind) result.push({ mask, kind, cards: selected });
  }
  return result;
}
function evaluation(hand: PlayingCard[], groups: Meld[]): Evaluation {
  const used = groups.reduce((mask, group) => mask | group.mask, 0);
  const leftovers = subset(hand, FULL ^ used);
  return {
    groups: groups.map(({ kind, cards }) => ({ kind, cards })),
    leftovers,
    penalty: total(leftovers),
  };
}
export function complete(hand: PlayingCard[], patterns: number[][]): Evaluation | null {
  const available = melds(hand);
  const search = (sizes: number[], used: number, selected: Meld[]): Meld[] | null => {
    if (!sizes.length) return used === FULL ? selected : null;
    for (const group of available) {
      if (group.cards.length !== sizes[0] || group.mask & used) continue;
      const found = search(sizes.slice(1), used | group.mask, [...selected, group]);
      if (found) return found;
    }
    return null;
  };
  for (const sizes of patterns) {
    const found = search(sizes, 0, []);
    if (found) return evaluation(hand, found);
  }
  return null;
}
export function suitEvaluation(hand: PlayingCard[]): Evaluation {
  return { groups: [{ kind: 'suit', cards: hand }], leftovers: [], penalty: 0 };
}
// Enumerate disjoint coverings, retaining one reproducible explanation per physical-card mask.
// The nine/ten-suit exception is a whole covering, never an eight-suit shortcut.
function disjointCoverings(hand: PlayingCard[]) {
  const available = melds(hand);
  const coverings = new Map<number, Meld[]>([[0, []]]);
  for (let used = 0; used <= FULL; used++) {
    const groups = coverings.get(used);
    if (!groups) continue;
    for (const group of available) {
      const combined = used | group.mask;
      if (!(used & group.mask) && !coverings.has(combined))
        coverings.set(combined, [...groups, group]);
    }
  }
  return coverings;
}
function addSuitCoverings(hand: PlayingCard[], coverings: Map<number, Meld[]>) {
  for (let omitted = -1; omitted < 10; omitted++) {
    const mask = omitted < 0 ? FULL : FULL ^ (1 << omitted);
    const selected = subset(hand, mask);
    if (sameSuit(selected)) coverings.set(mask, [{ mask, kind: 'suit', cards: selected }]);
  }
}
export function bestEvaluation(hand: PlayingCard[], touchMax?: number): Evaluation | null {
  const coverings = disjointCoverings(hand);
  addSuitCoverings(hand, coverings);
  let best: Evaluation | null = null;
  for (const groups of coverings.values()) {
    const candidate = evaluation(hand, groups);
    if (
      touchMax !== undefined &&
      (candidate.leftovers.length < 1 ||
        candidate.leftovers.length > 2 ||
        candidate.penalty > touchMax)
    )
      continue;
    if (!best || candidate.penalty < best.penalty) best = candidate;
  }
  return best;
}
