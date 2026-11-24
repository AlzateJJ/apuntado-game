import type { PlayingCard, TurnPhase } from '@apuntado/contracts';

// Pure game operations: no clock, database, transport or random source is read here.
export type RandomIndex = (exclusiveMax: number) => number;
export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface TableState {
  players: string[];
  forfeited: string[];
  hands: Record<string, number[]>;
  stock: number[];
  discard: number[];
  turnPlayerId: string;
  turnNo: number;
  phase: TurnPhase;
  startedAt: number;
  deadlineAt: number;
}
export function cards(): PlayingCard[] {
  return Array.from({ length: 104 }, (_, index) => ({
    cardNo: index + 1,
    deck: (Math.floor(index / 52) + 1) as 1 | 2,
    suit: (['C', 'D', 'H', 'S'] as const)[Math.floor((index % 52) / 13)]!,
    rank: (index % 13) + 1,
  }));
}
export function shuffle<T>(input: readonly T[], random: RandomIndex): T[] {
  const result = [...input];
  for (let index = result.length - 1; index > 0; index--) {
    const other = random(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}
export function deal(
  players: string[],
  now: number,
  turnSeconds: number,
  random: RandomIndex,
): TableState {
  if (players.length < 2 || players.length > 6 || new Set(players).size !== players.length)
    throw new RuleError('PLAYER_COUNT', 'Se necesitan entre 2 y 6 jugadores distintos.');
  const deck = shuffle(
    cards().map((card) => card.cardNo),
    random,
  );
  const hands: Record<string, number[]> = Object.fromEntries(players.map((id) => [id, []]));
  for (let index = 0; index < 10; index++)
    for (const player of players) hands[player]!.push(deck.pop()!);
  const state: TableState = {
    players: [...players],
    forfeited: [],
    hands,
    stock: deck,
    discard: [deck.pop()!],
    turnPlayerId: players[random(players.length)]!,
    turnNo: 1,
    phase: 'draw',
    startedAt: now,
    deadlineAt: now + turnSeconds * 1000,
  };
  assertTable(state);
  return state;
}
export function draw(state: TableState, source: 'stock' | 'discard', random: RandomIndex) {
  if (state.phase !== 'draw') throw new RuleError('INVALID_PHASE', 'Ya robaste en este turno.');
  if (source === 'stock' && state.stock.length === 0) {
    const top = state.discard.pop();
    state.stock = shuffle(state.discard, random);
    state.discard = top === undefined ? [] : [top];
  }
  const card = (source === 'stock' ? state.stock : state.discard).pop();
  if (card === undefined)
    throw new RuleError('EMPTY_PILE', 'Ese montón no tiene cartas disponibles.');
  state.hands[state.turnPlayerId]!.push(card);
  state.phase = 'discard';
}
export function discard(state: TableState, cardNo: number) {
  if (state.phase !== 'discard')
    throw new RuleError('INVALID_PHASE', 'Primero debes robar una carta.');
  const hand = state.hands[state.turnPlayerId]!;
  const index = hand.indexOf(cardNo);
  if (index === -1)
    throw new RuleError('CARD_NOT_OWNED', 'Solo puedes descartar una carta de tu mano.');
  hand.splice(index, 1);
  state.discard.push(cardNo);
  state.phase = 'decision';
}
export function pass(state: TableState, now: number, turnSeconds: number) {
  if (state.phase !== 'decision')
    throw new RuleError('INVALID_PHASE', 'Debes robar y descartar antes de pasar.');
  const eligible = state.players.filter((id) => !state.forfeited.includes(id));
  state.turnPlayerId = eligible[(eligible.indexOf(state.turnPlayerId) + 1) % eligible.length]!;
  state.turnNo++;
  state.phase = 'draw';
  state.startedAt = now;
  state.deadlineAt = now + turnSeconds * 1000;
}
export function expire(state: TableState, now: number, turnSeconds: number, random: RandomIndex) {
  if (now < state.deadlineAt) return false;
  if (state.phase === 'draw') draw(state, 'stock', random);
  if (state.phase === 'discard') {
    const hand = state.hands[state.turnPlayerId]!;
    discard(state, hand[random(hand.length)]!);
  }
  pass(state, now, turnSeconds);
  assertTable(state);
  return true;
}
export function assertTable(state: TableState) {
  assertConservation(state);
  assertTurn(state);
  for (const id of state.players) {
    const expected = id === state.turnPlayerId && state.phase === 'discard' ? 11 : 10;
    if (state.hands[id]?.length !== expected) throw new Error('Hand size invariant violated');
  }
}
function assertConservation(state: TableState) {
  const values = [...state.stock, ...state.discard, ...Object.values(state.hands).flat()];
  if (
    values.length !== 104 ||
    new Set(values).size !== 104 ||
    values.some((value) => value < 1 || value > 104 || !Number.isInteger(value))
  )
    throw new Error('Card conservation invariant violated');
}
function assertTurn(state: TableState) {
  if (state.forfeited.includes(state.turnPlayerId)) throw new Error('Forfeited player has a turn');
  if (
    !state.players.includes(state.turnPlayerId) ||
    state.players.length < 2 ||
    state.players.length > 6 ||
    Object.keys(state.hands).length !== state.players.length ||
    state.deadlineAt <= state.startedAt
  )
    throw new Error('Turn invariant violated');
}
