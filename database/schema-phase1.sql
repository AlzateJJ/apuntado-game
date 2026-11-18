-- Product additions. The original academic profiles remain unchanged.
ALTER TABLE player ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE player ADD CONSTRAINT player_name_length CHECK (length(btrim(display_name)) BETWEEN 2 AND 60);

CREATE TABLE account (
  account_id uuid PRIMARY KEY,
  player_id uuid NOT NULL UNIQUE REFERENCES player,
  email_normalized varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalized = lower(btrim(email_normalized)))
);
CREATE TABLE auth_session (
  session_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES player,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  previous_token_hash char(64),
  rotated_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_session_player_active ON auth_session(player_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_session_expiry ON auth_session(expires_at);

ALTER TABLE rule_profile ADD COLUMN turn_seconds smallint CHECK (turn_seconds BETWEEN 10 AND 120);
ALTER TABLE rule_profile ADD COLUMN combination_reward smallint CHECK (combination_reward >= 0);
ALTER TABLE rule_profile ADD COLUMN suit_reward smallint CHECK (suit_reward >= 0);
ALTER TABLE rule_profile ADD COLUMN touch_max smallint CHECK (touch_max >= 0);
ALTER TABLE rule_profile ADD COLUMN elimination_score integer;
ALTER TABLE rule_profile ADD COLUMN victory_score integer;
CREATE TRIGGER immutable_profile_delete BEFORE DELETE ON rule_profile FOR EACH ROW EXECUTE FUNCTION freeze_profile();
INSERT INTO rule_profile (profile_id,mode,version,deck_count,hand_size,max_players,turn_seconds,combination_reward,suit_reward,touch_max,elimination_score,victory_score)
VALUES ('classic-v2','classic',2,2,10,6,30,0,0,NULL,NULL,NULL),
       ('apuntado-v2','apuntado',2,2,10,6,30,10,25,5,-101,51);

ALTER TABLE game ADD COLUMN name varchar(80) NOT NULL DEFAULT 'Mesa de Apuntado';
ALTER TABLE game ADD COLUMN join_code varchar(12) UNIQUE;
ALTER TABLE game ADD COLUMN host_player_id uuid REFERENCES player;
ALTER TABLE game ADD COLUMN capacity smallint NOT NULL DEFAULT 6 CHECK (capacity BETWEEN 2 AND 6);
ALTER TABLE game ADD COLUMN started_at timestamptz;
ALTER TABLE game ADD COLUMN finished_at timestamptz;
ALTER TABLE game ADD COLUMN pause_reason text;
ALTER TABLE game DROP CONSTRAINT game_status_check;
ALTER TABLE game ADD CONSTRAINT game_status_check CHECK (status IN ('waiting','active','paused','finished','cancelled'));
ALTER TABLE participation ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE participation ADD COLUMN left_at timestamptz;
ALTER TABLE participation ADD COLUMN ready boolean NOT NULL DEFAULT false;
ALTER TABLE participation DROP CONSTRAINT participation_game_id_seat_key;
CREATE UNIQUE INDEX participation_current_seat ON participation(game_id,seat) WHERE left_at IS NULL;

ALTER TABLE round ADD COLUMN turn_no integer NOT NULL DEFAULT 1 CHECK (turn_no > 0);
ALTER TABLE round ADD COLUMN turn_started_at timestamptz;
ALTER TABLE round ADD COLUMN turn_deadline_at timestamptz;
ALTER TABLE round ADD CONSTRAINT turn_dates CHECK (
  (turn_started_at IS NULL AND turn_deadline_at IS NULL) OR
  (turn_started_at IS NOT NULL AND turn_deadline_at IS NOT NULL AND turn_deadline_at > turn_started_at)
);
CREATE INDEX round_deadline ON round(turn_deadline_at) WHERE status='open';
CREATE TABLE round_participation (
  game_id uuid NOT NULL, round_no integer NOT NULL, player_id uuid NOT NULL,
  PRIMARY KEY(game_id,round_no,player_id),
  FOREIGN KEY(game_id,round_no) REFERENCES round,
  FOREIGN KEY(game_id,player_id) REFERENCES participation
);
ALTER TABLE round ADD CONSTRAINT round_turn_member FOREIGN KEY(game_id,round_no,turn_player_id)
  REFERENCES round_participation DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE card_position ADD CONSTRAINT card_hand_member FOREIGN KEY(game_id,round_no,owner_id)
  REFERENCES round_participation;
ALTER TABLE card_position ADD CONSTRAINT card_position_owner_key UNIQUE(game_id,round_no,card_no,owner_id);
ALTER TABLE score_movement ADD CONSTRAINT score_round_member FOREIGN KEY(game_id,round_no,player_id) REFERENCES round_participation;

CREATE TABLE hand_evaluation (
  game_id uuid NOT NULL, round_no integer NOT NULL, player_id uuid NOT NULL,
  penalty smallint NOT NULL CHECK (penalty BETWEEN 0 AND 100),
  explanation_code text NOT NULL, evaluator_version integer NOT NULL CHECK(evaluator_version > 0),
  PRIMARY KEY(game_id,round_no,player_id),
  FOREIGN KEY(game_id,round_no) REFERENCES round_result,
  FOREIGN KEY(game_id,round_no,player_id) REFERENCES round_participation
);
CREATE TABLE evaluation_card (
  game_id uuid NOT NULL, round_no integer NOT NULL, card_no smallint NOT NULL, player_id uuid NOT NULL,
  group_no smallint CHECK(group_no > 0),
  group_kind text CHECK(group_kind IN ('group','run','suit')),
  position_in_group smallint CHECK(position_in_group BETWEEN 0 AND 9),
  PRIMARY KEY(game_id,round_no,card_no),
  FOREIGN KEY(game_id,round_no,player_id) REFERENCES hand_evaluation,
  FOREIGN KEY(game_id,round_no,card_no,player_id) REFERENCES card_position(game_id,round_no,card_no,owner_id),
  CHECK ((group_no IS NULL AND group_kind IS NULL AND position_in_group IS NULL) OR
         (group_no IS NOT NULL AND group_kind IS NOT NULL AND position_in_group IS NOT NULL)),
  UNIQUE(game_id,round_no,player_id,group_no,position_in_group)
);
ALTER TABLE processed_operation ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE processed_operation ADD COLUMN actor_kind text NOT NULL DEFAULT 'player' CHECK(actor_kind IN ('player','system'));
ALTER TABLE processed_operation ADD COLUMN on_behalf_of_player_id uuid;
ALTER TABLE processed_operation ADD FOREIGN KEY(game_id,on_behalf_of_player_id) REFERENCES participation;
ALTER TABLE processed_operation ADD COLUMN command_type text NOT NULL DEFAULT 'round:close';
ALTER TABLE processed_operation ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE processed_operation ADD CONSTRAINT operation_actor CHECK (
  (actor_kind='player' AND actor_id IS NOT NULL AND on_behalf_of_player_id IS NULL) OR
  (actor_kind='system' AND actor_id IS NULL AND on_behalf_of_player_id IS NOT NULL)
);
ALTER TABLE outbox RENAME COLUMN delivered_at TO published_at;
ALTER TABLE outbox ADD COLUMN round_no integer;
ALTER TABLE outbox ADD COLUMN turn_no integer;
ALTER TABLE outbox ADD FOREIGN KEY(game_id,round_no) REFERENCES round;
ALTER TABLE outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0);
ALTER TABLE outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox ADD COLUMN last_error text;
ALTER TABLE outbox DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_event_type_check CHECK(event_type IN ('RoomChanged','GameStarted','TurnChanged','CardDrawn','CardDiscarded','RoundClosed','RoundStarted','GameFinished','GamePaused'));
CREATE INDEX outbox_pending ON outbox(next_attempt_at,created_at) WHERE published_at IS NULL;
