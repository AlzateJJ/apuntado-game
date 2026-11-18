import type { Closure, PlayingCard } from '@apuntado/contracts';
import { RuleError } from '../domain.js';
import {
  bestEvaluation,
  complete,
  handFromIds,
  sameSuit,
  suitEvaluation,
  type Evaluation,
} from './evaluation.js';
import type { RuleProfile, SettlementPlayer, Variant } from './model.js';
interface Accepted {
  evaluation: Evaluation;
  delta: number;
  explanation: SettlementPlayer['explanation'];
}
function touch(
  hand: PlayingCard[],
  score: number,
  profile: RuleProfile,
  pattern: Evaluation | null,
): Accepted {
  if (pattern || sameSuit(hand))
    throw new RuleError(
      'INVALID_CLOSE',
      'Tu mano ya está completa; debes cerrar por combinaciones o pintas, no tocar.',
    );
  const accepted = bestEvaluation(hand, profile.touch_max!);
  if (!accepted) {
    const best = bestEvaluation(hand)!;
    throw new RuleError(
      'INVALID_TOUCH',
      `Tu mejor organización deja ${best.leftovers.length} sobrantes que suman ${best.penalty} puntos. Para tocar deben ser una o dos y sumar hasta ${profile.touch_max}.`,
    );
  }
  if (score - accepted.penalty <= profile.elimination_score!)
    throw new RuleError(
      'INVALID_TOUCH',
      `El toque descontaría ${accepted.penalty} puntos y quedarías en ${score - accepted.penalty}. No puedes autoeliminarte en −101 o menos.`,
    );
  return { evaluation: accepted, delta: -accepted.penalty, explanation: 'touch' };
}
function accept(
  hand: PlayingCard[],
  score: number,
  closure: Closure,
  profile: RuleProfile,
): Accepted {
  const pattern = complete(hand, [
    [4, 3, 3],
    [5, 5],
  ]);
  if (closure === 'toque') return touch(hand, score, profile, pattern);
  if (closure === 'pintas') {
    if (!sameSuit(hand))
      throw new RuleError(
        'INVALID_CLOSE',
        'Para cerrar por pintas, tus diez cartas deben ser del mismo palo.',
      );
    return { evaluation: suitEvaluation(hand), delta: profile.suit_reward, explanation: 'suit' };
  }
  if (!pattern)
    throw new RuleError(
      'INVALID_CLOSE',
      'Tus diez cartas no forman combinaciones de 4-3-3 ni de 5-5 sin reutilizar una carta.',
    );
  return { evaluation: pattern, delta: profile.combination_reward, explanation: 'combinations' };
}
function winner(players: SettlementPlayer[], victory: number): string | null {
  const active = players.filter((player) => !player.eliminated);
  const winning =
    players.find((player) => player.after! >= victory) ??
    (active.length === 1 ? active[0] : undefined);
  return winning?.id ?? null;
}
export const apuntado: Variant = (players, actorId, closure, profile) => {
  const { elimination_score: elimination, victory_score: victory, touch_max: touchMax } = profile;
  if (elimination === null || victory === null || touchMax === null)
    throw new Error('Incomplete Apuntado profile');
  const evaluated = players.map((player) => ({ ...player, cards: handFromIds(player.hand) }));
  const actor = evaluated.find((player) => player.id === actorId);
  if (!actor || evaluated.some((player) => player.score <= elimination))
    throw new RuleError(
      'INACTIVE_PLAYER',
      'Solo los jugadores activos pueden participar en la ronda.',
    );
  const accepted = accept(actor.cards, actor.score, closure, profile);
  const result: SettlementPlayer[] = evaluated.map((player) => {
    // Preserve the exact covering/penalty that authorized the touch.
    const analysis = player.id === actorId ? accepted.evaluation : bestEvaluation(player.cards)!;
    const change =
      player.id === actorId ? accepted.delta : analysis.penalty === 0 ? 0 : -analysis.penalty;
    const after = player.score + change;
    return {
      ...analysis,
      id: player.id,
      before: player.score,
      delta: change,
      after,
      eliminated: after <= elimination,
      explanation: player.id === actorId ? accepted.explanation : 'minimum-penalty',
    };
  });
  return { players: result, winnerId: winner(result, victory) };
};
