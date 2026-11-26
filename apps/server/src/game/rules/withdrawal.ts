import type { RuleProfile, Settlement } from './model.js';

// The hand still contributes evidence and penalties, but a departed player cannot win.
export function excludeWithdrawn(settled: Settlement, withdrawn: string[], profile: RuleProfile) {
  for (const player of settled.players)
    if (withdrawn.includes(player.id)) player.explanation = 'withdrawal';
  const active = settled.players.filter(
    (player) => !player.eliminated && !withdrawn.includes(player.id),
  );
  if (profile.mode === 'apuntado') {
    settled.winnerId =
      active.find((player) => player.after! >= profile.victory_score!)?.id ??
      (active.length === 1 ? active[0]!.id : null);
  }
  settled.finished = profile.mode === 'classic' || active.length <= 1 || settled.winnerId !== null;
  return settled;
}
