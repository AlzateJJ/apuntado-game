import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  gameCommandSchema,
  roundReportSchema,
  type CommandReceipt,
  type GameCommand,
  type GameChanged,
  type RoomSnapshot,
} from '@apuntado/contracts';
import { AppError } from '../errors.js';
import {
  cards,
  deal,
  draw,
  discard,
  pass,
  expire,
  RuleError,
  type RandomIndex,
  type TableState,
} from './domain.js';
import {
  gameSelect,
  loadTable,
  members,
  saveTable,
  snapshot,
  type GameRow,
  type MemberRow,
} from './store.js';
import { variantCatalog } from './rules/catalog.js';
import type { VariantCatalog } from './rules/model.js';
import { readReport, saveSettlement } from './settlement-store.js';

type Create = Extract<GameCommand, { type: 'room:create' }>;
type Join = Extract<GameCommand, { type: 'room:join' }>;
type Existing = Exclude<GameCommand, Create | Join>;
type TurnCommand = Extract<GameCommand, { roundNo: number }>;
const fail = (code: string, message: string): never => {
  throw new AppError(409, code, message);
};
const fingerprint = (command: GameCommand) =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
export interface GameOptions {
  now?: () => number;
  random?: RandomIndex;
  variants?: VariantCatalog;
  onCommitted?: (receipt: CommandReceipt, observedAt: number) => void;
}
export class GameService {
  readonly now: () => number;
  private readonly random: RandomIndex;
  private readonly variants: VariantCatalog;
  private readonly onCommitted: NonNullable<GameOptions['onCommitted']>;
  publish: (event: GameChanged, recipients: string[]) => Promise<void> = async () => {};
  constructor(
    private readonly pool: Pool,
    options: GameOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomInt;
    this.variants = options.variants ?? variantCatalog;
    this.onCommitted = options.onCommitted ?? (() => {});
  }
  private async transaction<T>(
    run: (client: PoolClient) => Promise<T>,
    readOnly = false,
    committed?: (result: T) => void,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      // Instrumentation must never turn an already committed command into a failed response.
      try {
        committed?.(result);
      } catch {
        /* Noncritical observer. */
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async current(playerId: string): Promise<RoomSnapshot | null> {
    return this.transaction(async (client) => {
      const game = (
        await client.query<GameRow>(
          `${gameSelect} JOIN participation p USING(game_id)
        WHERE p.player_id=$1 AND p.left_at IS NULL AND g.status IN ('waiting','active','paused','between-rounds','finished') ORDER BY g.created_at DESC LIMIT 1`,
          [playerId],
        )
      ).rows[0];
      return game ? snapshot(client, game, playerId, this.now()) : null;
    }, true);
  }
  async report(playerId: string, input: unknown) {
    const request = roundReportSchema.parse(input);
    return this.transaction(async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM participation WHERE game_id=$1 AND player_id=$2`,
        [request.gameId, playerId],
      );
      if (!membership.rowCount)
        throw new AppError(403, 'NOT_A_MEMBER', 'No perteneces a esta partida.');
      const eligible = await client.query(
        `SELECT 1 FROM round_result rr WHERE game_id=$1 AND round_no=$2
        AND EXISTS(SELECT 1 FROM round_participation rp WHERE rp.game_id=rr.game_id AND rp.player_id=$3)`,
        [request.gameId, request.roundNo, playerId],
      );
      if (!eligible.rowCount)
        throw new AppError(
          404,
          'REPORT_NOT_AVAILABLE',
          'El acta solo está disponible para los participantes después del cierre.',
        );
      return readReport(client, request.gameId, request.roundNo);
    }, true);
  }
  async execute(playerId: string, input: unknown): Promise<CommandReceipt> {
    const command = gameCommandSchema.parse(input);
    try {
      return await this.transaction(
        async (client) => {
          // Serializes this player's room selection as well as concurrent create/join requests.
          if (
            !(
              await client.query('SELECT player_id FROM player WHERE player_id=$1 FOR UPDATE', [
                playerId,
              ])
            ).rowCount
          )
            throw new AppError(401, 'SESSION_INVALID', 'Tu identidad ya no está disponible.');
          const previous = (
            await client.query(
              `SELECT fingerprint,response FROM processed_operation WHERE actor_id=$1 AND operation_id=$2`,
              [playerId, command.operationId],
            )
          ).rows[0];
          if (previous) {
            if (previous.fingerprint !== fingerprint(command))
              fail('OPERATION_REUSED', 'Ese identificador ya se usó para otra solicitud.');
            // A receipt is private to its actor and contains no cards. Recover before checking a new turn/version.
            return previous.response as CommandReceipt;
          }
          if (command.type === 'room:create') return this.create(client, playerId, command);
          if (command.type === 'room:join') return this.join(client, playerId, command);
          return this.change(client, playerId, command);
        },
        false,
        (receipt) => this.onCommitted(receipt, performance.now()),
      );
    } catch (error) {
      if (error instanceof RuleError) throw new AppError(409, error.code, error.message);
      throw error;
    }
  }
  private async available(client: PoolClient, playerId: string, allowedGame?: string) {
    const current = (
      await client.query(
        `SELECT g.game_id FROM participation p JOIN game g USING(game_id)
      WHERE p.player_id=$1 AND p.left_at IS NULL AND g.status IN ('waiting','active','paused','between-rounds','finished')`,
        [playerId],
      )
    ).rows[0];
    if (current && current.game_id !== allowedGame)
      fail('ALREADY_IN_ROOM', 'Ya estás en otra sala. Sal de ella antes de entrar a una nueva.');
  }
  private async record(
    client: PoolClient,
    playerId: string,
    command: GameCommand,
    receipt: CommandReceipt,
  ) {
    await client.query(
      `INSERT INTO processed_operation(game_id,operation_id,actor_id,fingerprint,response,command_type)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [
        receipt.gameId,
        command.operationId,
        playerId,
        fingerprint(command),
        JSON.stringify(receipt),
        command.type,
      ],
    );
    return receipt;
  }
  private async event(
    client: PoolClient,
    gameId: string,
    version: number,
    type: string,
    roundNo: number | null = null,
    turnNo: number | null = null,
  ) {
    await client.query(
      `INSERT INTO outbox(event_id,game_id,version,event_type,round_no,turn_no) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), gameId, version, type, roundNo, turnNo],
    );
  }
  private async finish(
    client: PoolClient,
    gameId: string,
    actorId: string,
    command: GameCommand,
    event: string,
    roundNo?: number,
    turnNo?: number,
  ) {
    const action = {
      type: command.type,
      playerId: actorId,
      automatic: false,
      at: new Date(this.now()).toISOString(),
    };
    const version = (
      await client.query(
        'UPDATE game SET version=version+1,last_action=$2 WHERE game_id=$1 RETURNING version',
        [gameId, JSON.stringify(action)],
      )
    ).rows[0].version as number;
    const receipt = await this.record(client, actorId, command, {
      operationId: command.operationId,
      gameId,
      version,
    });
    await this.event(client, gameId, version, event, roundNo, turnNo);
    return receipt;
  }
  private async create(client: PoolClient, playerId: string, command: Create) {
    await this.available(client, playerId);
    const gameId = randomUUID();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      created = !!(
        await client.query(
          `INSERT INTO game(game_id,profile_id,status,name,join_code,host_player_id,capacity)
        VALUES($1,$2,'waiting',$3,$4,$5,$6) ON CONFLICT(join_code) DO NOTHING RETURNING game_id`,
          [gameId, `${command.mode}-v2`, command.name, code, playerId, command.capacity],
        )
      ).rowCount;
    }
    if (!created) throw new Error('Room code allocation failed');
    await client.query('INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,1)', [
      gameId,
      playerId,
    ]);
    return this.finish(client, gameId, playerId, command, 'RoomChanged');
  }
  private async join(client: PoolClient, playerId: string, command: Join) {
    const game = (
      await client.query<GameRow>(`${gameSelect} WHERE g.join_code=$1 FOR UPDATE OF g`, [
        command.code,
      ])
    ).rows[0];
    if (!game) throw new AppError(404, 'ROOM_NOT_FOUND', 'No encontramos una sala con ese código.');
    await this.available(client, playerId, game.game_id);
    const roster = (await members(client, game.game_id)).filter((row) => !row.left_at);
    if (roster.some((row) => row.player_id === playerId))
      return this.record(client, playerId, command, {
        operationId: command.operationId,
        gameId: game.game_id,
        version: game.version,
      });
    if (game.status !== 'waiting')
      fail('ROOM_STARTED', 'La partida ya comenzó o la sala está cerrada.');
    if (roster.length >= game.capacity) fail('ROOM_FULL', 'La sala está llena.');
    const seat = Array.from({ length: game.capacity }, (_, index) => index + 1).find(
      (value) => !roster.some((row) => row.seat === value),
    )!;
    await client.query(
      `INSERT INTO participation(game_id,player_id,seat) VALUES($1,$2,$3)
      ON CONFLICT(game_id,player_id) DO UPDATE SET seat=EXCLUDED.seat,left_at=NULL,joined_at=now(),ready=false`,
      [game.game_id, playerId, seat],
    );
    return this.finish(client, game.game_id, playerId, command, 'RoomChanged');
  }
  private async change(client: PoolClient, playerId: string, command: Existing) {
    const game = (
      await client.query<GameRow>(`${gameSelect} WHERE g.game_id=$1 FOR UPDATE OF g`, [
        command.gameId,
      ])
    ).rows[0];
    if (!game) throw new AppError(404, 'ROOM_NOT_FOUND', 'No encontramos esa sala.');
    const roster = (await members(client, game.game_id)).filter((row) => !row.left_at);
    if (!roster.some((row) => row.player_id === playerId))
      throw new AppError(403, 'NOT_A_MEMBER', 'No perteneces a esta sala.');
    // Returning home changes membership, never the immutable final result.
    if (command.type === 'room:leave' && game.status === 'finished')
      return this.leave(client, game, roster, playerId, command);
    if (game.version !== command.expectedVersion)
      fail('VERSION_CONFLICT', 'La mesa cambió. Actualizamos tu vista; intenta de nuevo.');
    if (command.type === 'room:leave') return this.leave(client, game, roster, playerId, command);
    if (command.type === 'room:start') return this.start(client, game, roster, playerId, command);
    if (command.type === 'round:next')
      return this.nextRound(client, game, roster, playerId, command);
    return this.playTurn(client, game, roster, playerId, command);
  }
  private async leave(
    client: PoolClient,
    game: GameRow,
    roster: MemberRow[],
    playerId: string,
    command: Extract<GameCommand, { type: 'room:leave' }>,
  ) {
    if (game.status !== 'waiting' && game.status !== 'finished')
      fail('GAME_IN_PROGRESS', 'La partida ya comenzó. Una desconexión no elimina tu asiento.');
    await client.query('UPDATE participation SET left_at=now() WHERE game_id=$1 AND player_id=$2', [
      game.game_id,
      playerId,
    ]);
    if (game.status === 'finished')
      return this.finish(client, game.game_id, playerId, command, 'RoomChanged');
    const remaining = roster.filter((row) => row.player_id !== playerId);
    if (!remaining.length)
      await client.query("UPDATE game SET status='cancelled' WHERE game_id=$1", [game.game_id]);
    else if (game.host_player_id === playerId)
      await client.query('UPDATE game SET host_player_id=$2 WHERE game_id=$1', [
        game.game_id,
        remaining[0]!.player_id,
      ]);
    return this.finish(client, game.game_id, playerId, command, 'RoomChanged');
  }
  private async start(
    client: PoolClient,
    game: GameRow,
    roster: MemberRow[],
    playerId: string,
    command: Extract<GameCommand, { type: 'room:start' }>,
  ) {
    if (game.host_player_id !== playerId)
      throw new AppError(403, 'HOST_ONLY', 'Solo el anfitrión puede iniciar la partida.');
    if (game.status !== 'waiting') fail('ROOM_STARTED', 'Esta partida ya comenzó.');
    const state = deal(
      roster.map((row) => row.player_id),
      this.now(),
      game.turn_seconds,
      this.random,
    );
    await client.query(
      `INSERT INTO card_copy(game_id,card_no,deck,suit,rank)
        SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) AS x(card_no smallint,deck smallint,suit char(1),rank smallint)`,
      [
        game.game_id,
        JSON.stringify(
          cards().map((card) => ({
            card_no: card.cardNo,
            deck: card.deck,
            suit: card.suit,
            rank: card.rank,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO round(game_id,round_no,status,phase,turn_player_id,initial_player_id) VALUES($1,1,'open','draw',$2,$2)`,
      [game.game_id, state.turnPlayerId],
    );
    await client.query(
      `INSERT INTO round_participation(game_id,round_no,player_id) SELECT $1,1,unnest($2::uuid[])`,
      [game.game_id, state.players],
    );
    await saveTable(client, game.game_id, 1, state);
    await client.query("UPDATE game SET status='active',started_at=$2 WHERE game_id=$1", [
      game.game_id,
      new Date(state.startedAt),
    ]);
    return this.finish(client, game.game_id, playerId, command, 'GameStarted', 1, state.turnNo);
  }
  private async nextRound(
    client: PoolClient,
    game: GameRow,
    roster: MemberRow[],
    playerId: string,
    command: Extract<GameCommand, { type: 'round:next' }>,
  ) {
    if (game.host_player_id !== playerId)
      throw new AppError(403, 'HOST_ONLY', 'Solo el anfitrión puede repartir la siguiente ronda.');
    if (game.status !== 'between-rounds')
      fail('ROUND_NOT_FINISHED', 'No hay una siguiente ronda pendiente.');
    const previous = (
      await client.query(
        `SELECT r.round_no,r.initial_player_id,p.seat FROM round r
        JOIN participation p ON p.game_id=r.game_id AND p.player_id=r.initial_player_id
        WHERE r.game_id=$1 ORDER BY round_no DESC LIMIT 1`,
        [game.game_id],
      )
    ).rows[0];
    const active = roster.filter((row) => row.eliminated_at_round === null);
    const state = deal(
      active.map((row) => row.player_id),
      this.now(),
      game.turn_seconds,
      this.random,
    );
    state.turnPlayerId = (active.find((row) => row.seat > previous.seat) ?? active[0])!.player_id;
    const number = previous.round_no + 1;
    await client.query(
      `INSERT INTO round(game_id,round_no,status,phase,turn_player_id,initial_player_id) VALUES($1,$2,'open','draw',$3,$3)`,
      [game.game_id, number, state.turnPlayerId],
    );
    await client.query(
      `INSERT INTO round_participation(game_id,round_no,player_id) SELECT $1,$2,unnest($3::uuid[])`,
      [game.game_id, number, state.players],
    );
    await saveTable(client, game.game_id, number, state);
    await client.query(`UPDATE game SET status='active' WHERE game_id=$1`, [game.game_id]);
    return this.finish(
      client,
      game.game_id,
      playerId,
      command,
      'RoundStarted',
      number,
      state.turnNo,
    );
  }
  private async playTurn(
    client: PoolClient,
    game: GameRow,
    roster: MemberRow[],
    playerId: string,
    command: TurnCommand,
  ) {
    if (game.status !== 'active') fail('GAME_NOT_ACTIVE', 'La partida no está en curso.');
    const { roundNo, state } = await loadTable(client, game.game_id);
    if (roundNo !== command.roundNo || state.turnNo !== command.turnNo)
      fail('TURN_CHANGED', 'Ese turno ya terminó.');
    if (state.turnPlayerId !== playerId)
      throw new AppError(403, 'NOT_YOUR_TURN', 'Espera a que llegue tu turno.');
    const now = this.now();
    if (now >= state.deadlineAt)
      fail('TURN_EXPIRED', 'Se acabó el tiempo. El servidor completará el turno.');
    if (command.type === 'round:close')
      return this.closeRound(client, game, roster, playerId, command, roundNo, state, now);
    if (command.type === 'turn:draw') draw(state, command.source, this.random);
    else if (command.type === 'turn:discard') discard(state, command.cardNo);
    else pass(state, now, game.turn_seconds);
    await saveTable(client, game.game_id, roundNo, state);
    const event = {
      'turn:draw': 'CardDrawn',
      'turn:discard': 'CardDiscarded',
      'turn:pass': 'TurnChanged',
    }[command.type];
    return this.finish(client, game.game_id, playerId, command, event, roundNo, state.turnNo);
  }
  private async closeRound(
    client: PoolClient,
    game: GameRow,
    roster: MemberRow[],
    playerId: string,
    command: Extract<GameCommand, { type: 'round:close' }>,
    roundNo: number,
    state: TableState,
    now: number,
  ) {
    if (state.phase !== 'decision')
      fail('WRONG_PHASE', 'Primero roba y descarta; solo puedes cerrar con diez cartas.');
    const players = state.players.map((id) => ({
      id,
      hand: state.hands[id]!,
      score: roster.find((row) => row.player_id === id)!.score,
    }));
    const settled = this.variants(game.profile_id)(players, playerId, command.closure, game);
    await saveSettlement(
      client,
      game.game_id,
      roundNo,
      playerId,
      command.closure,
      game.version + 1,
      settled,
      now,
    );
    const receipt = await this.finish(
      client,
      game.game_id,
      playerId,
      command,
      'RoundClosed',
      roundNo,
      state.turnNo,
    );
    if (settled.winnerId)
      await this.event(
        client,
        game.game_id,
        receipt.version,
        'GameFinished',
        roundNo,
        state.turnNo,
      );
    return receipt;
  }
  async expireGame(gameId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const game = (
        await client.query<GameRow>(`${gameSelect} WHERE g.game_id=$1 FOR UPDATE OF g`, [gameId])
      ).rows[0];
      if (!game || game.status !== 'active') return false;
      const { roundNo, state } = await loadTable(client, gameId);
      const oldTurn = state.turnNo,
        actorId = state.turnPlayerId,
        now = this.now();
      if (!expire(state, now, game.turn_seconds, this.random)) return false;
      await saveTable(client, gameId, roundNo, state);
      const action = {
        type: 'turn:timeout',
        playerId: actorId,
        automatic: true,
        at: new Date(now).toISOString(),
      };
      const version = (
        await client.query(
          'UPDATE game SET version=version+1,last_action=$2 WHERE game_id=$1 RETURNING version',
          [gameId, JSON.stringify(action)],
        )
      ).rows[0].version;
      const operationId = `timeout:${roundNo}:${oldTurn}`;
      await client.query(
        `INSERT INTO processed_operation(game_id,operation_id,actor_kind,on_behalf_of_player_id,fingerprint,response,command_type)
        VALUES($1,$2::text,'system',$3,$2::text,$4,'turn:timeout')`,
        [gameId, operationId, actorId, JSON.stringify({ operationId, gameId, version })],
      );
      await this.event(client, gameId, version, 'TurnChanged', roundNo, state.turnNo);
      return true;
    });
  }
  async expireDue() {
    const due = (
      await this.pool.query<{ game_id: string }>(
        `SELECT r.game_id FROM round r JOIN game g USING(game_id)
      WHERE r.status='open' AND g.status='active' AND r.turn_deadline_at<=$1 ORDER BY r.turn_deadline_at LIMIT 100`,
        [new Date(this.now())],
      )
    ).rows;
    const failures: unknown[] = [];
    for (const row of due) {
      try {
        await this.expireGame(row.game_id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Some overdue games could not advance');
  }
  async flushEvents() {
    // This worker can retry after a crash; notifications contain no private state.
    await this.transaction(async (client) => {
      const pending = (
        await client.query(`SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now()
        ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`)
      ).rows;
      for (const event of pending) {
        const recipients = (
          await client.query<{ player_id: string }>(
            'SELECT player_id FROM participation WHERE game_id=$1',
            [event.game_id],
          )
        ).rows.map((row) => row.player_id);
        try {
          await this.publish(
            { eventId: event.event_id, gameId: event.game_id, version: event.version },
            recipients,
          );
          await client.query(
            'UPDATE outbox SET published_at=now(),attempts=attempts+1,last_error=NULL WHERE event_id=$1',
            [event.event_id],
          );
        } catch {
          await client.query(
            `UPDATE outbox SET attempts=attempts+1,last_error='PUBLISH_FAILED',next_attempt_at=now()+interval '1 second' WHERE event_id=$1`,
            [event.event_id],
          );
        }
      }
    });
  }
}
