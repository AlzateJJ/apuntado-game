import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cards,
  deal,
  draw,
  discard,
  pass,
  expire,
  assertTable,
} from '../apps/server/src/game/domain.js';

const last = (max: number) => max - 1;
test('two physical decks contain 104 distinct cards and deal ten each to 2–6 players', () => {
  assert.equal(cards().length, 104);
  assert.equal(new Set(cards().map((c) => `${c.deck}:${c.suit}:${c.rank}`)).size, 104);
  for (let size = 2; size <= 6; size++) {
    const ids = Array.from({ length: size }, (_, index) => `p${index}`);
    const state = deal(ids, 1000, 30, last);
    assert.equal(state.stock.length, 104 - size * 10 - 1);
    assert.equal(state.discard.length, 1);
    assert.equal(state.deadlineAt, 31000);
    assert.equal(state.turnPlayerId, ids.at(-1));
    assertTable(state);
  }
});
test('manual draw/discard preserve the shared deadline and advance through 10 → 11 → 10', () => {
  const state = deal(['a', 'b'], 1000, 30, last);
  const actor = state.turnPlayerId;
  draw(state, 'stock', last);
  assert.equal(state.hands[actor]!.length, 11);
  assert.equal(state.deadlineAt, 31000);
  assert.throws(() => draw(state, 'stock', last), { code: 'INVALID_PHASE' });
  assert.throws(() => discard(state, state.hands.a![0]!), { code: 'CARD_NOT_OWNED' });
  discard(state, state.hands[actor]![0]!);
  assert.equal(state.hands[actor]!.length, 10);
  assert.equal(state.deadlineAt, 31000);
  pass(state, 10000, 30);
  assert.equal(state.turnPlayerId, 'a');
  assert.equal(state.deadlineAt, 40000);
  assertTable(state);
});
test('timeout handles all three phases, includes the drawn card and fires at exactly the deadline', () => {
  for (const phase of ['draw', 'discard', 'decision']) {
    const state = deal(['a', 'b'], 1000, 30, last);
    const actor = state.turnPlayerId;
    if (phase !== 'draw') draw(state, 'stock', last);
    if (phase === 'decision') discard(state, state.hands[actor]![0]!);
    const originalDiscard = state.discard.at(-1);
    const expected = phase === 'draw' ? state.stock.at(-1) : state.hands[actor]!.at(-1);
    const before = structuredClone(state);
    assert.equal(expire(state, 30999, 30, last), false);
    assert.deepEqual(state, before);
    assert.equal(expire(state, 31000, 30, last), true);
    assert.equal(state.turnNo, 2);
    assert.equal(state.turnPlayerId, 'a');
    assert.equal(state.hands[actor]!.length, 10);
    assert.equal(state.deadlineAt, 61000);
    assert.equal(state.discard.at(-1), phase === 'decision' ? originalDiscard : expected);
    assert.equal(expire(state, 31000, 30, last), false);
    assertTable(state);
  }
});
test('an empty stock recycles discards while retaining the exposed top card', () => {
  const state = deal(['a', 'b'], 0, 30, last);
  const top = state.discard.at(-1);
  state.discard.unshift(...state.stock.splice(0));
  draw(state, 'stock', last);
  assert.equal(state.discard.at(-1), top);
  assert.equal(state.discard.length, 1);
  assertTable(state);
});
test('hundreds of legal turns conserve all 104 cards across repeated recycling', () => {
  const state = deal(['a', 'b', 'c', 'd', 'e', 'f'], 0, 30, last);
  for (let turn = 0; turn < 400; turn++) {
    draw(state, turn % 4 === 0 ? 'discard' : 'stock', last);
    discard(state, state.hands[state.turnPlayerId]![0]!);
    pass(state, 1000 * (turn + 1), 30);
    assertTable(state);
  }
  assert.equal(state.turnNo, 401);
});
