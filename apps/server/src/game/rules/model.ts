import type { Closure, GameMode, RoundReport } from '@apuntado/contracts';
import type { Evaluation } from './evaluation.js';
export interface RuleProfile {
  profile_id: string;
  mode: GameMode;
  combination_reward: number;
  suit_reward: number;
  touch_max: number | null;
  elimination_score: number | null;
  victory_score: number | null;
}
export interface RulePlayer {
  id: string;
  hand: number[];
  score: number;
}
export interface SettlementPlayer extends Evaluation {
  id: string;
  before: number | null;
  delta: number | null;
  after: number | null;
  eliminated: boolean;
  explanation: RoundReport['players'][number]['explanation'];
}
export interface Settlement {
  players: SettlementPlayer[];
  winnerId: string | null;
  roundWinnerId?: string;
}
export type Variant = (
  players: RulePlayer[],
  actorId: string,
  closure: Closure,
  profile: RuleProfile,
) => Settlement;
export type VariantCatalog = (profileId: string) => Variant;
