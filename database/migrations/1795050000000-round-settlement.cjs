exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE game DROP CONSTRAINT game_status_check;
  ALTER TABLE game ADD CONSTRAINT game_status_check CHECK(status IN ('waiting','active','paused','between-rounds','finished','cancelled'));
  ALTER TABLE round ADD COLUMN initial_player_id uuid;
  -- Phase-two rounds did not record their first player. Infer it from the turn and seat order.
  UPDATE round r SET initial_player_id=(
    SELECT rp.player_id FROM round_participation rp JOIN participation p USING(game_id,player_id)
    WHERE rp.game_id=r.game_id AND rp.round_no=r.round_no ORDER BY p.seat
    OFFSET ((SELECT count(*) FROM round_participation rp JOIN participation p USING(game_id,player_id)
      WHERE rp.game_id=r.game_id AND rp.round_no=r.round_no AND p.seat <
        (SELECT seat FROM participation WHERE game_id=r.game_id AND player_id=r.turn_player_id))
      - ((r.turn_no-1) % (SELECT count(*) FROM round_participation WHERE game_id=r.game_id AND round_no=r.round_no))
      + (SELECT count(*) FROM round_participation WHERE game_id=r.game_id AND round_no=r.round_no))
      % (SELECT count(*) FROM round_participation WHERE game_id=r.game_id AND round_no=r.round_no)
    LIMIT 1
  );
  ALTER TABLE round ALTER COLUMN initial_player_id SET NOT NULL;
  ALTER TABLE round ADD CONSTRAINT round_initial_member FOREIGN KEY(game_id,round_no,initial_player_id)
    REFERENCES round_participation DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE round_result ADD COLUMN closed_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE participation ADD COLUMN eliminated_at_round integer;
  ALTER TABLE participation ADD CONSTRAINT elimination_round FOREIGN KEY(game_id,eliminated_at_round) REFERENCES round_result;
`);
exports.down = () => {
  throw new Error('Round history is durable; restore a backup to downgrade.');
};
