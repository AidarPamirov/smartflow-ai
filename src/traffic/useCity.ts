import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { TrafficController, type TrafficState } from './controller';

const NETWORK_URL = `${import.meta.env.BASE_URL}data/bishkek-roads.json`;
const SIGNALS_URL = `${import.meta.env.BASE_URL}data/bishkek-signals-osm.json`;

/**
 * Городская модель для карты: один контроллер (трафик + светофоры) на все панели.
 * Подключается после загрузки стиля карты (mapReady).
 */
export function useCity(map: MlMap | null, mapReady: boolean): { ctrl: TrafficController | null; st: TrafficState | null } {
  const ctrl = useRef<TrafficController | null>(null);
  const [st, setSt] = useState<TrafficState | null>(null);
  useEffect(() => {
    if (!map || !mapReady) return;
    const c = new TrafficController(map, NETWORK_URL, setSt, SIGNALS_URL);
    ctrl.current = c;
    void c.init();
    return () => { c.destroy(); ctrl.current = null; };
  }, [map, mapReady]);
  return { ctrl: ctrl.current, st };
}
