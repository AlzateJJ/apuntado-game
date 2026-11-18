export const card = (rank: number, suit: 'C' | 'D' | 'H' | 'S', deck = 1) =>
  (deck - 1) * 52 + ['C', 'D', 'H', 'S'].indexOf(suit) * 13 + rank;
export const full433 = (deck = 1) =>
  [2, 3, 4, 5]
    .map((n) => card(n, 'H', deck))
    .concat([7, 9].flatMap((n) => (['C', 'D', 'S'] as const).map((s) => card(n, s, deck))));
export const full55 = (deck = 1) =>
  [2, 3, 4, 5, 6]
    .map((n) => card(n, 'H', deck))
    .concat([7, 8, 9, 10, 11].map((n) => card(n, 'D', deck)));
export const touch5 = (deck = 1) =>
  [7, 8, 9]
    .flatMap((n) => (['C', 'D', 'S'] as const).map((s) => card(n, s, deck)))
    .concat(card(5, 'H', deck));
export const suit10 = (deck = 1) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => card(n, 'H', deck));
// No three equal ranks or consecutive same-suit ranks: all 76 points remain.
export const loose = () => [
  card(1, 'C'),
  card(3, 'D'),
  card(5, 'S'),
  card(8, 'H'),
  card(10, 'C'),
  card(12, 'D'),
  card(2, 'S'),
  card(8, 'D'),
  card(11, 'C'),
  card(13, 'S'),
];
