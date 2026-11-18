import { RuleError } from '../domain.js';
import { bestEvaluation, complete, handFromIds } from './evaluation.js';
import type { Variant } from './model.js';
export const classic: Variant = (players, actorId, closure) => {
  const evaluated = players.map((player) => ({ ...player, cards: handFromIds(player.hand) }));
  const actor = evaluated.find((player) => player.id === actorId);
  const winning = actor && closure === 'combinaciones' ? complete(actor.cards, [[4, 3, 3]]) : null;
  if (!winning)
    throw new RuleError('INVALID_CLOSE', 'En Clásica necesitas combinaciones de 4, 3 y 3 cartas.');
  return {
    winnerId: actorId,
    players: evaluated.map((player) => ({
      id: player.id,
      ...(player.id === actorId ? winning : bestEvaluation(player.cards)!),
      explanation: player.id === actorId ? 'classic-close' : 'minimum-penalty',
      before: null,
      delta: null,
      after: null,
      eliminated: false,
    })),
  };
};
