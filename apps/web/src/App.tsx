import { useState } from 'react';
import { useSelector } from 'react-redux';
import { useForm } from 'react-hook-form';
import { guestSchema, loginSchema, registerSchema } from '@apuntado/contracts';
import type { RootState } from './store';
import { ApiFailure, enter, logout, reconnect } from './session';
import GameHub from './GameHub';

type Mode = 'login' | 'register' | 'guest';
type FormFields = { displayName: string; email: string; password: string };
function Cards() {
  return (
    <div className="cards" aria-hidden="true">
      <div className="card card-back" />
      <div className="card card-red">
        <b>
          Q<small>♥</small>
        </b>
        <span>♥</span>
        <b>
          Q<small>♥</small>
        </b>
      </div>
      <div className="card card-front">
        <b>
          A<small>♠</small>
        </b>
        <span>♠</span>
        <b>
          A<small>♠</small>
        </b>
      </div>
    </div>
  );
}
function AccessForm() {
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<FormFields>();
  const choose = (value: Mode) => {
    setMode(value);
    reset();
    setError(null);
  };
  const submit = handleSubmit(async (values) => {
    setError(null);
    const input =
      mode === 'guest'
        ? { displayName: values.displayName }
        : mode === 'login'
          ? { email: values.email, password: values.password }
          : values;
    const parsed = (
      mode === 'guest' ? guestSchema : mode === 'login' ? loginSchema : registerSchema
    ).safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        setFieldError(issue.path[0] as keyof FormFields, { message: issue.message });
      return;
    }
    try {
      await enter(mode, parsed.data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No pudimos entrar. Intenta otra vez.');
      if (failure instanceof ApiFailure && failure.fields)
        for (const [key, messages] of Object.entries(failure.fields))
          if (['displayName', 'email', 'password'].includes(key))
            setFieldError(key as keyof FormFields, { message: messages[0] });
    }
  });
  return (
    <section className="access-panel" aria-labelledby="access-title">
      <div className="eyebrow">LA MESA TE ESPERA</div>
      <h2 id="access-title">
        {mode === 'guest'
          ? 'Pasa, estás en casa.'
          : mode === 'register'
            ? 'Hagamos espacio para ti.'
            : 'Qué bueno verte.'}
      </h2>
      <p className="muted">
        {mode === 'guest'
          ? 'Solo necesitas un nombre para entrar.'
          : mode === 'register'
            ? 'Crea tu cuenta y conserva tu identidad al volver.'
            : 'Entra con tu cuenta o ven como invitado.'}
      </p>
      <div className="mode-switch" aria-label="Forma de acceso">
        <button
          type="button"
          aria-pressed={mode === 'login'}
          onClick={() => choose('login')}
          disabled={isSubmitting}
        >
          Ingresar
        </button>
        <button
          type="button"
          aria-pressed={mode === 'register'}
          onClick={() => choose('register')}
          disabled={isSubmitting}
        >
          Crear cuenta
        </button>
        <button
          type="button"
          aria-pressed={mode === 'guest'}
          onClick={() => choose('guest')}
          disabled={isSubmitting}
        >
          Invitado
        </button>
      </div>
      <form onSubmit={submit} noValidate>
        {mode !== 'login' && (
          <div className="field">
            <label htmlFor="displayName">Tu nombre en la mesa</label>
            <input
              id="displayName"
              autoComplete="nickname"
              placeholder="¿Cómo te llamamos?"
              maxLength={60}
              {...register('displayName')}
              aria-invalid={!!errors.displayName}
              aria-describedby={errors.displayName ? 'name-error' : undefined}
            />
            {errors.displayName && (
              <span id="name-error" className="field-error">
                {errors.displayName.message}
              </span>
            )}
          </div>
        )}
        {mode !== 'guest' && (
          <>
            <div className="field">
              <label htmlFor="email">Correo electrónico</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="tu@correo.com"
                maxLength={254}
                {...register('email')}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
              />
              {errors.email && (
                <span id="email-error" className="field-error">
                  {errors.email.message}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="password">Contraseña</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                maxLength={128}
                {...register('password')}
                aria-invalid={!!errors.password}
                aria-describedby="password-hint"
              />
              <span id="password-hint" className={errors.password ? 'field-error' : 'field-hint'}>
                {errors.password?.message ??
                  (mode === 'register'
                    ? 'Al menos 12 caracteres. Puedes usar una frase.'
                    : 'Tu contraseña distingue mayúsculas y minúsculas.')}
              </span>
            </div>
          </>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Entrando…'
            : mode === 'register'
              ? 'Crear mi cuenta'
              : mode === 'guest'
                ? 'Entrar como invitado'
                : 'Entrar a Apuntado'}
          <span aria-hidden="true">↗</span>
        </button>
      </form>
      <p className="access-note">
        {mode === 'guest'
          ? 'Tu acceso se conserva en este navegador durante 14 días. Si borras sus datos o cierras sesión, necesitarás crear otro invitado.'
          : 'Una cuenta, tu nombre y muchas manos por compartir.'}
      </p>
    </section>
  );
}
function Welcome() {
  const { session, connection } = useSelector((state: RootState) => state.auth);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  const exit = async () => {
    setLeaving(true);
    setError(null);
    try {
      await logout();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No pudimos cerrar la sesión.');
    } finally {
      setLeaving(false);
    }
  };
  return (
    <section className="player-bar" aria-labelledby="welcome-title">
      <div className="player-greeting">
        <span className="avatar" aria-hidden="true">
          {session.player.displayName.slice(0, 1).toLocaleUpperCase()}
        </span>
        <div className="eyebrow">
          {session.player.kind === 'guest' ? 'ACCESO COMO INVITADO' : 'TU CUENTA DE APUNTADO'}
        </div>
        <h2 id="welcome-title">Hola, {session.player.displayName}.</h2>
      </div>
      <div className="session-controls">
        <div className={`connection-box ${connection}`} role="status">
          <span className="status-dot" />
          <div>
            <strong>
              {connection === 'online'
                ? 'Conexión activa'
                : connection === 'connecting'
                  ? 'Conectando…'
                  : 'Conexión interrumpida'}
            </strong>
            <p>
              {connection === 'online'
                ? 'Ya estás conectado a Apuntado.'
                : connection === 'connecting'
                  ? 'Estamos preparando tu conexión.'
                  : 'Intentaremos reconectarte automáticamente.'}
            </p>
          </div>
        </div>
        {connection === 'offline' && (
          <button className="text-button" onClick={reconnect}>
            Reintentar conexión
          </button>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <button className="secondary-button" onClick={() => void exit()} disabled={leaving}>
          {leaving ? 'Saliendo…' : 'Cerrar sesión'}
        </button>
        {session.player.kind === 'guest' && (
          <p className="access-note">Al salir, termina el acceso de este invitado.</p>
        )}
      </div>
    </section>
  );
}
export default function App() {
  const { status, notice } = useSelector((state: RootState) => state.auth);
  return (
    <div className="page">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Apuntado, inicio">
          <span aria-hidden="true">♠</span> apuntado<span className="brand-period">.</span>
        </a>
        <span className="header-caption">ENTRE CARTAS Y AMIGOS</span>
      </header>
      <main className={status === 'authenticated' ? 'play-main' : undefined}>
        {status === 'authenticated' ? (
          <>
            <Welcome />
            {notice && (
              <p className="error-banner" role="alert">
                {notice}
              </p>
            )}
            <GameHub />
          </>
        ) : (
          <>
            <section className="story">
              <div className="eyebrow">
                <span className="tiny-line" /> EL PLAN ES JUNTARNOS
              </div>
              <h1>
                Un lugar
                <br />
                en la <em>mesa.</em>
              </h1>
              <p className="story-description">
                Las cartas de siempre.
                <br />
                La emoción de una buena mano.
                <br />Y tus amigos, donde estén.
              </p>
              <Cards />
              <div className="game-details">
                <span>
                  <b>2–6</b> jugadores
                </span>
                <span>
                  <b>2</b> modalidades
                </span>
                <span>
                  <b>30 s</b> por turno
                </span>
              </div>
            </section>
            <div className="access-wrap">
              {notice && (
                <p className="error-banner" role="alert">
                  {notice}
                </p>
              )}
              {status === 'checking' ? (
                <section className="access-panel loading" role="status">
                  Preparando tu lugar…
                </section>
              ) : (
                <AccessForm />
              )}
            </div>
          </>
        )}
      </main>
      <footer>
        <span>Hecho para compartir una buena partida.</span>
        <span className="footer-suits" aria-hidden="true">
          ♠ <i>♥</i> ♣ <i>♦</i>
        </span>
      </footer>
    </div>
  );
}
