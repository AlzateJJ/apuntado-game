exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE round_participation
    ADD COLUMN timeout_streak smallint NOT NULL DEFAULT 0 CHECK(timeout_streak BETWEEN 0 AND 3),
    ADD COLUMN forfeited boolean NOT NULL DEFAULT false;
  ALTER TABLE round_participation ADD CONSTRAINT forfeit_requires_timeouts CHECK(NOT forfeited OR timeout_streak=3);
  ALTER TABLE round_result DROP CONSTRAINT round_result_closure_check;
  ALTER TABLE round_result ADD CONSTRAINT round_result_closure_check CHECK(closure IN ('combinaciones','pintas','toque','inactivity'));
  ALTER TABLE round_result ADD COLUMN round_winner_id uuid;
  ALTER TABLE round_result ADD CONSTRAINT round_winner_member FOREIGN KEY(game_id,round_no,round_winner_id) REFERENCES round_participation;
  UPDATE round_result SET round_winner_id=actor_id WHERE closure<>'toque';
`);
exports.down = () => {
  throw new Error('Round forfeits are durable; restore a backup to downgrade.');
};
