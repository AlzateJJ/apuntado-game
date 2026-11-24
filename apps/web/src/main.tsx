import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import App from './App';
import { store } from './store';
import { refreshSession } from './session';
import './styles.css';
import './game.css';
import './workspace.css';
import { SoundProvider } from './Sound';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <SoundProvider>
        <App />
      </SoundProvider>
    </Provider>
  </StrictMode>,
);
void refreshSession();
