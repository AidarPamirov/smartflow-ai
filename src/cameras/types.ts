/**
 * Виртуальные камеры SmartFlow AI. Это элементы модели, а не камеры Бишкека: в проекте нет подключений
 * к реальным камерам и видеопотокам. Режим данных каждой камеры показывается в интерфейсе.
 */
export type CameraType = 'flow' | 'speed' | 'seatbelt' | 'line';

/**
 * Режим данных:
 *  mock — только визуальный макет (нет источника данных);
 *  synthetic — метрики считаются по синтетическому трафику модели;
 *  test_video — обработка записанного тестового видео (модуль CV, вне браузера);
 *  real — реальный источник. В проекте НЕ используется.
 */
export type DataMode = 'mock' | 'synthetic' | 'test_video' | 'real';
export type ConnStatus = 'online' | 'offline' | 'no_data';

export const TYPE_LABEL: Record<CameraType, string> = {
  flow: 'Камера потока',
  speed: 'Камера скорости',
  seatbelt: 'Камера ремня безопасности',
  line: 'Камера сплошной линии',
};
export const MODE_LABEL: Record<DataMode, string> = {
  mock: 'визуальный макет',
  synthetic: 'синтетические данные',
  test_video: 'тестовое видео',
  real: 'реальный источник',
};
export const CONN_LABEL: Record<ConnStatus, string> = { online: 'на связи', offline: 'нет источника', no_data: 'нет данных' };

export interface CameraSettings {
  enabled: boolean;
  /**
   * Чувствительность, смысл зависит от типа:
   *  flow — порог «затора» по средней скорости, км/ч; speed — допуск над ограничением, км/ч;
   *  line — минимальная глубина заезда за линию, м; seatbelt — не используется (модели нет).
   */
  sensitivity: number;
  /** Порог уверенности 0…1: событие ниже порога помечается «недостаточно данных» и нарушением не считается. */
  confidenceThreshold: number;
}

export interface Camera {
  id: string;
  type: CameraType;
  lon: number;
  lat: number;
  /** Направление обзора, градусы от севера (вдоль движения на контролируемом участке). */
  heading: number;
  /** Контролируемый участок: направленное ребро графа и отметки на нём, м от начала по ходу движения. */
  edge: number;
  forward: boolean;
  /** flow: отметка линии подсчёта; speed: две отметки; line: начало и конец линии. */
  marks: number[];
  street: string;
  /** Светофор, к въезду которого относится камера (для очереди); -1 — нет. */
  signal: number;
  /** Демонстрационное ограничение скорости (камера скорости), км/ч. */
  limitKmh: number;
  dataMode: DataMode;
  settings: CameraSettings;
}

export type EventKind = 'congestion' | 'congestion_end' | 'speeding' | 'line_crossing' | 'insufficient_data';

export interface CameraEvent {
  /** Время модели, с. */
  t: number;
  kind: EventKind;
  /** Анонимный идентификатор машины в пределах сеанса (не номер, не лицо). */
  vehicle: string | null;
  /** Значение события: скорость км/ч, глубина заезда м, средняя скорость км/ч и т. п. */
  value: number | null;
  confidence: number;
  text: string;
}

/** Все события — предварительные: это результат модели, а не юридическое заключение. */
export const EVENT_NOTE = 'Предварительное событие модели, не юридическое заключение.';
