exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE game ADD COLUMN last_action jsonb;
  CREATE INDEX participation_player_current ON participation(player_id) WHERE left_at IS NULL;
  CREATE UNIQUE INDEX processed_player_operation ON processed_operation(actor_id,operation_id) WHERE actor_id IS NOT NULL;
`);
exports.down = (pgm) =>
  pgm.sql(`
  DROP INDEX processed_player_operation;
  DROP INDEX participation_player_current;
  ALTER TABLE game DROP COLUMN last_action;
`);
