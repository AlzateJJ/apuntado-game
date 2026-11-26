import { bestEvaluation, handFromIds } from './evaluation.js';
import type { RulePlayer, RuleProfile, Settlement, SettlementPlayer } from './model.js';

// A forfeited hand stays frozen and private until settlement. It can never earn a closure reward.
export function settleInactivity(
  players: RulePlayer[],
  survivorId: string | null,
  profile: RuleProfile,
): Settlement {
  const evaluated: SettlementPlayer[] = players.map((player) => {
    const analysis = bestEvaluation(handFromIds(player.hand))!;
    const survivor = player.id === survivorId;
    const scored = profile.mode === 'apuntado';
    const delta = survivor || analysis.penalty === 0 ? 0 : -analysis.penalty;
    const after = player.score + delta;
    return {
      ...analysis,
      id: player.id,
      before: scored ? player.score : null,
      delta: scored ? delta : null,
      after: scored ? after : null,
      eliminated: scored && after <= profile.elimination_score!,
      explanation: survivor ? 'last-in-round' : 'inactivity',
    };
  });
  const active = evaluated.filter((player) => !player.eliminated);
  const winnerId = profile.mode === 'classic' || active.length === 1 ? survivorId : null;
  return { players: evaluated, winnerId, roundWinnerId: survivorId };
}
