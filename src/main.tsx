import { Component, StrictMode, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

// Карта грузится отдельным файлом: лаборатория перекрёстка не тянет MapLibre.
const MapApp = lazy(() => import('./map/MapApp'));
const SumoApp = lazy(() => import('./sumo/SumoApp'));
const CvApp = lazy(() => import('./cv/CvApp'));

/** Простая навигация по адресу: «#lab» — лаборатория перекрёстка, «#sumo» — эксперимент SUMO, «#cv» — компьютерное зрение, иначе — карта Бишкека. */
const currentView = () => (location.hash === '#lab' ? 'lab' : location.hash === '#sumo' ? 'sumo' : location.hash === '#cv' ? 'cv' : 'map');

function Root() {
  const [view, setView] = useState(currentView);
  useEffect(() => {
    const onHash = () => { setView(currentView()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (view === 'lab') return <App />;
  if (view === 'sumo')
    return (
      <Suspense fallback={<div className="boot">Загружаю эксперимент SUMO…</div>}>
        <SumoApp />
      </Suspense>
    );
  if (view === 'cv')
    return (
      <Suspense fallback={<div className="boot">Загружаю результаты компьютерного зрения…</div>}>
        <CvApp />
      </Suspense>
    );
  return (
    <Suspense fallback={<div className="boot">Загружаю карту Бишкека…</div>}>
      <MapApp />
    </Suspense>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error)
      return (
        <div className="fatal">
          <h1>Что-то пошло не так</h1>
          <p>{this.state.error.message}</p>
          <button className="btn primary" onClick={() => location.reload()}>Перезагрузить</button>
        </div>
      );
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary><Root /></ErrorBoundary>
  </StrictMode>,
);
