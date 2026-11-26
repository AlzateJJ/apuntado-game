exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE participation ADD COLUMN surrendered_at timestamptz;
  ALTER TABLE participation ADD CONSTRAINT surrender_requires_departure CHECK(surrendered_at IS NULL OR left_at IS NOT NULL);
  ALTER TABLE round_participation ADD COLUMN withdrawn boolean NOT NULL DEFAULT false;
  ALTER TABLE game ADD COLUMN winner_player_id uuid;
  ALTER TABLE game ADD COLUMN finish_reason text CHECK(finish_reason IN ('round','abandonment'));
  ALTER TABLE game ADD CONSTRAINT game_winner_member FOREIGN KEY(game_id,winner_player_id) REFERENCES participation(game_id,player_id);
  UPDATE game g SET winner_player_id=r.winner_id,finish_reason='round'
    FROM round_result r WHERE g.game_id=r.game_id AND g.status='finished' AND r.winner_id IS NOT NULL;
  ALTER TABLE round_result DROP CONSTRAINT round_result_closure_check;
  ALTER TABLE round_result ADD CONSTRAINT round_result_closure_check CHECK(closure IN ('combinaciones','pintas','toque','inactivity','abandonment'));
  ALTER TABLE round_result DROP CONSTRAINT round_result_check;
  ALTER TABLE round_result ADD CONSTRAINT round_result_check CHECK(
    (winner_id IS NOT NULL) = (next_action='home') OR (winner_id IS NULL AND next_action='home' AND closure IN ('abandonment','inactivity')));
`);
exports.down = () => {
  throw new Error('Withdrawals are durable; restore a backup to downgrade.');
};
