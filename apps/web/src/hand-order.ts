export function reconcileOrder(order: number[], cards: number[]) {
  return [...new Set([...order.filter((id) => cards.includes(id)), ...cards])];
}
export function moveCard(order: number[], card: number, target: number) {
  const from = order.indexOf(card),
    to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const result = [...order];
  result.splice(from, 1);
  result.splice(to, 0, card);
  return result;
}
export function insertCard(order: number[], card: number, before: number | null) {
  if (!order.includes(card) || before === card || (before !== null && !order.includes(before)))
    return order;
  const result = order.filter((id) => id !== card);
  result.splice(before === null ? result.length : result.indexOf(before), 0, card);
  return result.every((id, index) => id === order[index]) ? order : result;
}
