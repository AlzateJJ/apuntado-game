import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool, PoolClient } from 'pg';
import type {
  GuestInput,
  LoginInput,
  PlayerIdentity,
  RegisterInput,
  SessionResponse,
} from '@apuntado/contracts';
import type { Config } from '../config.js';
import { AppError, sessionError } from '../errors.js';

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type IdentityRow = { player_id: string; display_name: string; kind: 'account' | 'guest' };
type SessionRow = IdentityRow & {
  email_normalized: string | null;
  session_id: string;
  refresh_token_hash: string;
  previous_token_hash: string | null;
  rotated_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
};
const identity = (row: IdentityRow): PlayerIdentity => ({
  id: row.player_id,
  displayName: row.display_name,
  kind: row.kind,
});
const sessionSelect = `SELECT s.*, p.display_name, a.email_normalized, CASE WHEN a.account_id IS NULL THEN 'guest' ELSE 'account' END AS kind
  FROM auth_session s JOIN player p USING(player_id) LEFT JOIN account a USING(player_id)`;
export interface Authenticated {
  player: PlayerIdentity;
  sessionId: string;
  expiresAt: number;
}
export interface IssuedSession {
  body: SessionResponse;
  refreshToken: string;
  sessionExpiresAt: Date;
}

export class AuthService {
  private readonly key: Uint8Array;
  private readonly dummyPassword = argon2.hash(randomBytes(32), passwordOptions);
  onRevoke: (sessionId: string) => void = () => {};
  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
  ) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async issue(
    player: PlayerIdentity,
    sessionId: string,
    refreshToken: string,
    sessionExpiresAt: Date,
    email: string | null,
  ): Promise<IssuedSession> {
    const expiresAt = Math.min(
      Math.floor(Date.now() / 1000) + this.config.ACCESS_TOKEN_SECONDS,
      Math.floor(sessionExpiresAt.getTime() / 1000),
    );
    const accessToken = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(player.id)
      .setIssuedAt()
      .setIssuer('apuntado')
      .setAudience('apuntado-web')
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return {
      body: {
        player,
        account: email === null ? null : { email },
        accessToken,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      },
      refreshToken,
      sessionExpiresAt,
    };
  }

  private async newSession(
    client: PoolClient,
    player: PlayerIdentity,
    email: string | null = null,
  ) {
    const sessionId = randomUUID();
    const refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + this.config.SESSION_DAYS * 86400000);
    await client.query(
      'INSERT INTO auth_session(session_id,player_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4)',
      [sessionId, player.id, hash(refreshToken), expiresAt],
    );
    return this.issue(player, sessionId, refreshToken, expiresAt, email);
  }

  async guest(input: GuestInput) {
    return this.transaction(async (client) => {
      const player: PlayerIdentity = {
        id: randomUUID(),
        displayName: input.displayName,
        kind: 'guest',
      };
      await client.query('INSERT INTO player(player_id,display_name) VALUES($1,$2)', [
        player.id,
        player.displayName,
      ]);
      return this.newSession(client, player);
    });
  }

  async register(input: RegisterInput) {
    const passwordHash = await argon2.hash(input.password, passwordOptions);
    try {
      return await this.transaction(async (client) => {
        const player: PlayerIdentity = {
          id: randomUUID(),
          displayName: input.displayName,
          kind: 'account',
        };
        await client.query('INSERT INTO player(player_id,display_name) VALUES($1,$2)', [
          player.id,
          player.displayName,
        ]);
        await client.query(
          'INSERT INTO account(account_id,player_id,email_normalized,password_hash) VALUES($1,$2,$3,$4)',
          [randomUUID(), player.id, input.email, passwordHash],
        );
        return this.newSession(client, player, input.email);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(409, 'EMAIL_TAKEN', 'Ese correo ya tiene una cuenta. Inicia sesión.');
      throw error;
    }
  }

  async login(input: LoginInput) {
    const result = await this.pool.query<
      IdentityRow & { password_hash: string; email_normalized: string }
    >(
      `SELECT p.*, a.password_hash, a.email_normalized, 'account' AS kind FROM account a JOIN player p USING(player_id) WHERE email_normalized=$1`,
      [input.email],
    );
    const row = result.rows[0];
    const valid = await argon2.verify(
      row?.password_hash ?? (await this.dummyPassword),
      input.password,
    );
    if (!row || !valid)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'El correo o la contraseña no coinciden.');
    return this.transaction((client) =>
      this.newSession(client, identity(row), row.email_normalized),
    );
  }

  private sessionId(token: unknown): string {
    if (
      typeof token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(
        token,
      )
    )
      throw sessionError();
    return token.slice(0, 36);
  }

  async refresh(token: unknown): Promise<IssuedSession> {
    const sessionId = this.sessionId(token);
    const fingerprint = hash(token as string);
    const outcome = await this.transaction(async (client) => {
      const row = (
        await client.query<SessionRow>(`${sessionSelect} WHERE s.session_id=$1 FOR UPDATE OF s`, [
          sessionId,
        ])
      ).rows[0];
      if (!row || row.revoked_at || row.expires_at.getTime() <= Date.now())
        return { error: sessionError() };
      if (!equal(row.refresh_token_hash, fingerprint)) {
        if (row.previous_token_hash && equal(row.previous_token_hash, fingerprint)) {
          // Parallel requests must not revoke a legitimate session during rotation.
          if (row.rotated_at && Date.now() - row.rotated_at.getTime() < 10000)
            return {
              error: new AppError(
                409,
                'REFRESH_CONFLICT',
                'La sesión se está actualizando. Intenta de nuevo.',
              ),
            };
          await client.query('UPDATE auth_session SET revoked_at=now() WHERE session_id=$1', [
            sessionId,
          ]);
          return { error: sessionError(), revoked: true };
        }
        return { error: sessionError() };
      }
      const refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
      await client.query(
        'UPDATE auth_session SET previous_token_hash=refresh_token_hash,refresh_token_hash=$2,rotated_at=now() WHERE session_id=$1',
        [sessionId, hash(refreshToken)],
      );
      return {
        issued: await this.issue(
          identity(row),
          sessionId,
          refreshToken,
          row.expires_at,
          row.email_normalized,
        ),
      };
    });
    if ('revoked' in outcome && outcome.revoked) this.onRevoke(sessionId);
    if (outcome.error) throw outcome.error;
    return outcome.issued!;
  }

  async logout(token: unknown) {
    let sessionId: string;
    try {
      sessionId = this.sessionId(token);
    } catch {
      return;
    }
    const fingerprint = hash(token as string);
    const result = await this.pool.query(
      `UPDATE auth_session SET revoked_at=COALESCE(revoked_at,now())
      WHERE session_id=$1 AND (refresh_token_hash=$2 OR previous_token_hash=$2) RETURNING session_id`,
      [sessionId, fingerprint],
    );
    if (result.rowCount) this.onRevoke(sessionId);
  }

  async authenticate(token: string): Promise<Authenticated> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: 'apuntado',
        audience: 'apuntado-web',
        requiredClaims: ['sub', 'sid', 'exp', 'iat'],
      }));
    } catch {
      throw sessionError();
    }
    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string' || !payload.exp)
      throw sessionError();
    const row = (
      await this.pool.query<SessionRow>(
        `${sessionSelect} WHERE s.session_id=$1 AND s.player_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
        [payload.sid, payload.sub],
      )
    ).rows[0];
    if (!row) throw sessionError();
    return { player: identity(row), sessionId: row.session_id, expiresAt: payload.exp * 1000 };
  }
}
