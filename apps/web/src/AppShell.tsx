import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from './store';
import { logout, reconnect } from './session';
import GameHub from './GameHub';
import { RoundHistory } from './RoundResults';
import { SoundButton } from './Sound';
import { AccountChevron, AccountIdentity, AccountMenu, AccountPage } from './AccountMenu';

type Section = 'table' | 'history' | 'rules' | 'account';
const sections: { id: Section; label: string; symbol: string }[] = [
  { id: 'table', label: 'Mi mesa', symbol: '♠' },
  { id: 'history', label: 'Rondas anteriores', symbol: '≡' },
  { id: 'rules', label: 'Cómo jugar', symbol: '?' },
];
function Rules() {
  return (
    <section className="help-page">
      <div className="eyebrow">UN LUGAR PARA APRENDER</div>
      <h1>Cómo jugar.</h1>
      <article>
        <h2>Tu turno, a tu ritmo</h2>
        <p>
          Tienes 30 segundos para robar y descartar. Al descartar, el turno pasa automáticamente
          después de dos segundos. Para cerrar o tocar, elige esa opción antes de descartar. Puedes
          organizar tus cartas arrastrándolas en cualquier momento, también con el dedo. Con
          teclado, usa Alt + flechas sobre una carta.
        </p>
      </article>
      <article>
        <h2>Clásica y Apuntado</h2>
        <p>
          En Clásica, gana quien cierre con combinaciones de 4, 3 y 3 cartas; no se acumulan puntos.
          En Apuntado, un cierre de 4-3-3 o 5-5 suma 10 puntos, y diez cartas del mismo palo suman
          25. El toque requiere una o dos sobrantes que sumen hasta 5, sin premio ni
          autoeliminación. Ganas al alcanzar +51 o quedar como único jugador no eliminado; con −101
          o menos quedas fuera de la partida.
        </p>
      </article>
      <article>
        <h2>Si se acaba el tiempo</h2>
        <p>
          El servidor roba y descarta al azar lo que falte de tu turno. Tres turnos propios
          consecutivos completados automáticamente te hacen perder esa ronda. Un descarte manual
          válido reinicia el contador; el avance normal de dos segundos no cuenta como inactividad.
        </p>
        <p>
          Los demás siguen jugando. Si queda uno, gana la ronda por inactividad. En Apuntado se
          descuentan las cartas sin combinación de quien perdió la ronda y no se entrega un premio
          de cierre por inactividad. Puedes volver en la siguiente ronda si tu puntaje no te
          eliminó. El contador empieza de cero con cada reparto.
        </p>
      </article>
      <article>
        <h2>Tu asiento sigue siendo tuyo</h2>
        <p>
          Cerrar el navegador no libera tu asiento ni detiene el reloj. Con una cuenta puedes entrar
          desde otro dispositivo y recuperar la misma partida; como invitado necesitas volver en el
          mismo navegador con sus datos de sesión. Usar el mismo nombre no recupera un invitado.
        </p>
        <p>
          Una partida iniciada no admite jugadores nuevos, aunque alguien se desconecte. El código
          solo se muestra mientras la sala espera. Si el anfitrión pierde la ronda por inactividad,
          otro jugador recibe el control para que la mesa pueda continuar.
        </p>
      </article>
      <article>
        <h2>Sonido a tu gusto</h2>
        <p>
          El botón del altavoz silencia la música y el reloj. Tu preferencia se guarda en este
          navegador. El tic-tac solo avisa durante los últimos siete segundos de tu propio turno;
          aumenta gradualmente y la música baja para que lo escuches.
        </p>
      </article>
    </section>
  );
}
export default function AppShell() {
  const { session, connection, notice } = useSelector((state: RootState) => state.auth);
  const game = useSelector((state: RootState) => state.game);
  const [section, setSection] = useState<Section>('table');
  const [menu, setMenu] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 900px)').matches);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const query = matchMedia('(max-width: 900px)');
    const change = () => {
      setMobile(query.matches);
      setMenu(false);
      setAccountOpen(false);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (menu && mobile) dialog.current?.showModal();
    else dialog.current?.close();
    if (!menu || !mobile) return;
    document.body.classList.add('drawer-open');
    return () => document.body.classList.remove('drawer-open');
  }, [menu, mobile]);
  useEffect(() => {
    if (section === 'account') main.current?.querySelector<HTMLElement>('h1[tabindex]')?.focus();
  }, [section]);
  const choose = (next: Section) => {
    setSection(next);
    setMenu(false);
    setAccountOpen(false);
  };
  const exit = async () => {
    setLeaving(true);
    setError('');
    try {
      await logout();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos cerrar sesión.');
    } finally {
      setLeaving(false);
    }
  };
  const accountControl = (
    <AccountMenu
      session={session!}
      mobile={mobile}
      open={accountOpen}
      onOpenChange={setAccountOpen}
      onAccount={() => choose('account')}
      onLogout={() => void exit()}
      leaving={leaving}
      error={error}
    />
  );
  const brand = (
    <button className="brand" onClick={() => choose('table')} aria-label="Apuntado, inicio">
      <span aria-hidden="true">♠</span> apuntado<span className="brand-period">.</span>
    </button>
  );
  const navigation = (
    <>
      <div className="sidebar-brand">
        {brand}
        {mobile && (
          <button className="icon-button" onClick={() => setMenu(false)} aria-label="Cerrar menú">
            ×
          </button>
        )}
      </div>
      <div className="sidebar-content">
        <span className="eyebrow">ENTRE CARTAS Y AMIGOS</span>
        <nav aria-label="Navegación principal">
          {sections.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? 'current' : ''}`}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => choose(item.id)}
            >
              <span aria-hidden="true">{item.symbol}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <SoundButton label />
          {mobile ? (
            <div className="account-area">
              <button
                className="account-toggle"
                aria-label="Abrir cuenta de usuario"
                aria-haspopup="dialog"
                onClick={() => {
                  setMenu(false);
                  setAccountOpen(true);
                }}
              >
                <AccountIdentity session={session!} />
                <AccountChevron />
              </button>
            </div>
          ) : (
            accountControl
          )}
        </div>
      </div>
    </>
  );
  return (
    <div className="workspace">
      {mobile ? (
        <dialog
          ref={dialog}
          className="mobile-drawer"
          aria-label="Menú de Apuntado"
          onClose={() => setMenu(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setMenu(false);
          }}
        >
          {navigation}
        </dialog>
      ) : (
        <aside className="app-sidebar">{navigation}</aside>
      )}
      <div className="workspace-body">
        <header className="workspace-header">
          {mobile ? (
            <>
              <button
                className="icon-button"
                onClick={() => {
                  setAccountOpen(false);
                  setMenu(true);
                }}
                aria-label="Abrir menú"
                aria-expanded={menu}
                aria-haspopup="dialog"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              {brand}
            </>
          ) : (
            <span className="eyebrow">TU LUGAR EN LA MESA</span>
          )}
          <div className={`workspace-connection ${connection}`} role="status">
            <span className="status-dot" />
            <span>
              {connection === 'online'
                ? 'Conexión activa'
                : connection === 'connecting'
                  ? 'Conectando…'
                  : 'Sin conexión'}
            </span>
          </div>
          {mobile && accountControl}
        </header>
        <main className="workspace-main" ref={main}>
          {notice && (
            <p className="error-banner" role="alert">
              {notice}
            </p>
          )}
          {connection === 'offline' && (
            <div className="connection-alert" role="alert">
              Intentaremos reconectarte. El reloj de la partida sigue avanzando.
              <button className="text-button" onClick={reconnect}>
                Reintentar conexión
              </button>
            </div>
          )}
          <div hidden={section !== 'table'}>
            <GameHub />
          </div>
          {section === 'history' && (
            <section className="history-page">
              <div className="eyebrow">CADA MANO CUENTA</div>
              <h1>Rondas anteriores.</h1>
              {game.room?.history.length ? (
                <RoundHistory
                  key={game.room.id}
                  room={game.room}
                  disabled={connection !== 'online'}
                />
              ) : (
                <p className="muted">
                  Aquí aparecerán las actas de tu partida cuando termine la primera ronda.
                </p>
              )}
            </section>
          )}
          {section === 'rules' && <Rules />}
          {section === 'account' && (
            <AccountPage session={session!} onTable={() => choose('table')} />
          )}
        </main>
      </div>
    </div>
  );
}
