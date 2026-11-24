import { useEffect, useId, useRef } from 'react';
import type { SessionResponse } from '@apuntado/contracts';
import { SoundButton } from './Sound';

export function AccountIdentity({
  session,
  compact = false,
}: {
  session: SessionResponse;
  compact?: boolean;
}) {
  const { player, account } = session;
  const initials = player.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return (
    <>
      <span className="player-avatar" aria-hidden="true">
        {initials}
      </span>
      {!compact && (
        <span className="account-identity">
          <strong>{player.displayName}</strong>
          <small title={account?.email}>
            {account?.email ??
              (player.kind === 'guest' ? 'Invitado · este navegador' : 'Cuenta de Apuntado')}
          </small>
        </span>
      )}
    </>
  );
}

export function AccountChevron() {
  return (
    <svg
      className="account-chevron"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function AccountIcon({ logout = false }: { logout?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {logout ? (
        <path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4" />
      ) : (
        <>
          <path d="m9 3-.6 2.4-2.1 1.2L4 6l-2 3 1.7 1.8v2.4L2 15l2 3 2.3-.6 2.1 1.2L9 21h4l.6-2.4 2.1-1.2 2.3.6 2-3-1.7-1.8v-2.4L20 9l-2-3-2.3.6-2.1-1.2L13 3Z" />
          <circle cx="11" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export function AccountMenu({
  session,
  mobile,
  open,
  onOpenChange,
  onAccount,
  onLogout,
  leaving,
  error,
}: {
  session: SessionResponse;
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccount: () => void;
  onLogout: () => void;
  leaving: boolean;
  error: string;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open || mobile) return;
    firstAction.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, mobile, onOpenChange]);
  useEffect(() => {
    if (!mobile || !open) return;
    const element = sheet.current!;
    element.showModal();
    document.body.classList.add('account-sheet-open');
    return () => {
      element.close();
      document.body.classList.remove('account-sheet-open');
    };
  }, [mobile, open]);
  const actions = (
    <div className="account-actions">
      <button ref={firstAction} type="button" onClick={onAccount}>
        <AccountIcon />
        <span>Mi cuenta{mobile && <small>Datos y preferencias</small>}</span>
      </button>
      <button type="button" className="account-logout" onClick={onLogout} disabled={leaving}>
        <AccountIcon logout />
        {leaving ? 'Cerrando sesión…' : 'Cerrar sesión'}
      </button>
      {session.player.kind === 'guest' && (
        <p className="guest-reminder">Al cerrar sesión termina el acceso de este invitado.</p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </div>
  );
  return (
    <div
      ref={container}
      className={mobile ? 'mobile-account' : 'account-area'}
      onBlur={(event) => {
        if (
          !mobile &&
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          onOpenChange(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="account-toggle"
        aria-label="Abrir cuenta de usuario"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup={mobile ? 'dialog' : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <AccountIdentity session={session} compact={mobile} />
        <AccountChevron />
      </button>
      {mobile ? (
        <dialog
          ref={sheet}
          id={id}
          className="account-sheet"
          aria-labelledby={`${id}-title`}
          onClose={() => onOpenChange(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) onOpenChange(false);
          }}
        >
          <div className="account-sheet-content">
            <span className="sheet-handle" aria-hidden="true" />
            <header>
              <h2 id={`${id}-title`}>Tu cuenta</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Cerrar tu cuenta"
                onClick={() => onOpenChange(false)}
              >
                ×
              </button>
            </header>
            <div className="sheet-profile">
              <AccountIdentity session={session} />
            </div>
            {actions}
          </div>
        </dialog>
      ) : (
        open && (
          <div id={id} className="account-popover" role="group" aria-label="Opciones de cuenta">
            {actions}
          </div>
        )
      )}
    </div>
  );
}

export function AccountPage({
  session,
  onTable,
}: {
  session: SessionResponse;
  onTable: () => void;
}) {
  const guest = session.player.kind === 'guest';
  return (
    <section className="account-page">
      <div className="eyebrow">TU ESPACIO PERSONAL</div>
      <h1 tabIndex={-1}>Mi cuenta.</h1>
      <p className="account-intro">Tu lugar en Apuntado, a tu manera.</p>
      <article className="account-panel">
        <div className="profile-heading">
          <AccountIdentity session={session} />
        </div>
        <dl>
          <div>
            <dt>Nombre en la mesa</dt>
            <dd>{session.player.displayName}</dd>
          </div>
          {!guest && (
            <div>
              <dt>Correo electrónico</dt>
              <dd>{session.account?.email ?? 'Correo no disponible'}</dd>
            </div>
          )}
          <div>
            <dt>Tipo de acceso</dt>
            <dd>{guest ? 'Invitado' : 'Cuenta registrada'}</dd>
          </div>
        </dl>
        <p>
          {guest
            ? 'Tu acceso de invitado pertenece a este navegador. Al cerrar sesión, pierdes el acceso a este jugador y a su asiento.'
            : 'Puedes iniciar sesión con este correo en otro dispositivo y recuperar tu asiento en la partida.'}
        </p>
      </article>
      <article className="account-panel account-preferences">
        <h2>Sonido de la mesa</h2>
        <p>
          Música de fondo y aviso de los últimos siete segundos de tu turno. Tu preferencia se
          guarda en este navegador.
        </p>
        <SoundButton label />
      </article>
      <button className="text-button account-back" onClick={onTable}>
        Volver a mi mesa <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
