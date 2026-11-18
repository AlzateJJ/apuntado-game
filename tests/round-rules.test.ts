import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cards } from '../apps/server/src/game/domain.js';
import {
  bestEvaluation,
  complete,
  handFromIds,
  meldKind,
  points,
} from '../apps/server/src/game/rules/evaluation.js';
import { variantCatalog } from '../apps/server/src/game/rules/catalog.js';
import type { RuleProfile } from '../apps/server/src/game/rules/model.js';
import { card, full433, full55, touch5, suit10 } from './helpers/rules-fixtures.js';
const profile: RuleProfile = {
  profile_id: 'apuntado-v2',
  mode: 'apuntado',
  combination_reward: 10,
  suit_reward: 25,
  touch_max: 5,
  elimination_score: -101,
  victory_score: 51,
};
const classic = variantCatalog('classic-v2'),
  apuntado = variantCatalog('apuntado-v2');
const roster = (hand = full433(), score = 0, other = full433(2), otherScore = 0) => [
  { id: 'a', hand, score },
  { id: 'b', hand: other, score: otherScore },
];
const values = (ids: number[]) => ids.map((id) => cards()[id - 1]!);
test('E2: aces cost ten, A23 and QKA runs work, KA2 and repeated ranks in runs do not', () => {
  assert.equal(points(values([card(1, 'H')])[0]!), 10);
  assert.equal(points(values([card(11, 'H')])[0]!), 10);
  for (const ranks of [
    [1, 2, 3],
    [12, 13, 1],
  ])
    assert.equal(meldKind(values(ranks.map((n) => card(n, 'H')))), 'run');
  assert.equal(meldKind(values([13, 1, 2].map((n) => card(n, 'H')))), null);
  assert.equal(meldKind(values([card(1, 'H'), card(1, 'H', 2), card(2, 'H')])), null);
});
test('E2: two copies of a rank can form a group; a physical card cannot be counted twice', () => {
  assert.equal(meldKind(values([card(1, 'C'), card(1, 'C', 2), card(1, 'H')])), 'group');
  const invalid = full433();
  invalid[0] = invalid[1]!;
  assert.throws(() => handFromIds(invalid), { code: 'INVALID_HAND' });
  assert.throws(() => handFromIds(full433().slice(1)), { code: 'INVALID_HAND' });
  assert.throws(() => handFromIds([...full433().slice(1), 105]), { code: 'INVALID_HAND' });
});
test('E2: exact 4-3-3 and 5-5 coverings are independent of visual order', () => {
  assert.deepEqual(
    complete(handFromIds(full433().reverse()), [[4, 3, 3]])?.groups.map((g) => g.cards.length),
    [4, 3, 3],
  );
  assert.ok(complete(handFromIds(full55()), [[5, 5]]));
  assert.equal(complete(handFromIds(full55()), [[4, 3, 3]]), null);
});
test('E2: Clásica accepts only 4-3-3 and finishes with no cumulative scoring', () => {
  const result = classic(roster(), 'a', 'combinaciones', { ...profile, mode: 'classic' });
  assert.equal(result.winnerId, 'a');
  assert.ok(result.players.every((p) => p.delta === null && !p.eliminated));
  assert.throws(() => classic(roster(full55()), 'a', 'combinaciones', profile), {
    code: 'INVALID_CLOSE',
  });
  for (const closure of ['pintas', 'toque'] as const)
    assert.throws(() => classic(roster(), 'a', closure, profile), { code: 'INVALID_CLOSE' });
});
test('E2: Apuntado gives +10 or +25, never stacks both rewards', () => {
  assert.equal(apuntado(roster(full55()), 'a', 'combinaciones', profile).players[0]!.delta, 10);
  const suited = roster(suit10());
  assert.equal(apuntado(suited, 'a', 'pintas', profile).players[0]!.delta, 25);
  assert.equal(apuntado(suited, 'a', 'combinaciones', profile).players[0]!.delta, 10);
});
test('E2: touch at five is inclusive; -95 reaches -100, -96 cannot self-eliminate', () => {
  const result = apuntado(roster(touch5(), -95), 'a', 'toque', profile);
  assert.equal(result.players[0]!.delta, -5);
  assert.equal(result.players[0]!.after, -100);
  assert.equal(result.players[0]!.penalty, 5);
  assert.equal(result.winnerId, null);
  assert.throws(() => apuntado(roster(touch5(), -96), 'a', 'toque', profile), {
    code: 'INVALID_TOUCH',
  });
});
test('E2: touch accepts 2+2 and 2+3, rejects 3+3', () => {
  const eight = [7, 9].flatMap((n) => (['C', 'D', 'H', 'S'] as const).map((s) => card(n, s)));
  for (const [tail, expected] of [
    [[card(2, 'H'), card(2, 'H', 2)], 4],
    [[card(2, 'H'), card(3, 'H')], 5],
  ] as const) {
    const result = apuntado(roster([...eight, ...tail]), 'a', 'toque', profile);
    assert.equal(result.players[0]!.delta, -expected);
  }
  assert.throws(
    () => apuntado(roster([...eight, card(3, 'H'), card(3, 'H', 2)]), 'a', 'toque', profile),
    { code: 'INVALID_TOUCH' },
  );
});
test('E2: nine same-suit cards allow a touch; eight alone do not', () => {
  const nine = [1, 2, 4, 5, 7, 8, 10, 11, 13].map((n) => card(n, 'H'));
  const result = apuntado(roster([...nine, card(5, 'S')]), 'a', 'toque', profile);
  assert.equal(result.players[0]!.delta, -5);
  assert.equal(result.players[0]!.groups[0]!.kind, 'suit');
  const sparse = [1, 3, 5, 7, 9, 11, 13]
    .map((n) => card(n, 'H'))
    .concat(card(1, 'H', 2), card(2, 'D'), card(2, 'S'));
  assert.throws(() => apuntado(roster(sparse), 'a', 'toque', profile), { code: 'INVALID_TOUCH' });
});
test('E2: complete patterns and ten suits cannot touch', () => {
  for (const hand of [full433(), full55(), suit10()])
    assert.throws(() => apuntado(roster(hand), 'a', 'toque', profile), { code: 'INVALID_CLOSE' });
});
test('E2: nonclosers use minimum ungrouped points, including zero without negative zero', () => {
  const result = apuntado(roster(full433(), 0, touch5(2)), 'a', 'combinaciones', profile);
  assert.equal(result.players[1]!.delta, -5);
  const zero = apuntado(roster(), 'a', 'combinaciones', profile);
  assert.equal(zero.players[1]!.delta, 0);
  assert.deepEqual(zero, JSON.parse(JSON.stringify(zero)));
});
test('E2: exactly +51 wins, +50 continues; exactly -101 eliminates, -100 remains', () => {
  assert.equal(apuntado(roster(full433(), 41), 'a', 'combinaciones', profile).winnerId, 'a');
  assert.equal(apuntado(roster(full433(), 40), 'a', 'combinaciones', profile).winnerId, null);
  const sole = apuntado(roster(full433(), 0, touch5(2), -96), 'a', 'combinaciones', profile);
  assert.equal(sole.players[1]!.after, -101);
  assert.equal(sole.players[1]!.eliminated, true);
  assert.equal(sole.winnerId, 'a');
  assert.equal(
    apuntado(roster(full433(), 0, touch5(2), -95), 'a', 'combinaciones', profile).winnerId,
    null,
  );
});
test('evaluations partition every physical card exactly once and minimize overlapping melds', () => {
  // Greedily selecting C2-C3-C4-C5 loses the alternative group of fives.
  const hand = [
    card(2, 'C'),
    card(3, 'C'),
    card(4, 'C'),
    card(5, 'C'),
    card(5, 'D'),
    card(5, 'H'),
    card(7, 'D'),
    card(8, 'D'),
    card(9, 'D'),
    card(2, 'S'),
  ];
  const evaluation = bestEvaluation(handFromIds(hand))!;
  assert.equal(evaluation.penalty, 2);
  assert.deepEqual(
    [...evaluation.groups.flatMap((g) => g.cards), ...evaluation.leftovers]
      .map((c) => c.cardNo)
      .sort((a, b) => a - b),
    [...hand].sort((a, b) => a - b),
  );
  assert.throws(() => variantCatalog('apuntado-v99'), /Unsupported rule profile/);
});
