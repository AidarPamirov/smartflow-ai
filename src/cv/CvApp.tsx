import { useEffect, useState, type ReactNode } from 'react';
import { parseCv, STATUS_LABEL, type CvResults, type CvRow, type Stat } from './cvResults';
import '../sumo/sumo.css';
import './cv.css';

const BASE = `${import.meta.env.BASE_URL}data/cv/`;
const nf = (x: number | null | undefined, d = 1) => (x == null ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const st = (s: Stat, d = 1, unit = '') => (s[0] == null ? <span className="cv-na">нет данных</span> : `${nf(s[0], d)}${s[1] ? ` ± ${nf(s[1], d)}` : ''}${unit}`);
const frac = (a: number | null, b: number | null) => (a == null || b == null ? <span className="cv-na">нет данных</span> : `${a} из ${b}`);

type Status = { kind: 'loading' } | { kind: 'error'; msg: string } | { kind: 'ready'; data: CvResults };

/** Страница модуля компьютерного зрения: что проверено, на каких данных и с какой точностью. Видео в браузере не обрабатывается. */
export default function CvApp() {
  const [s, setS] = useState<Status>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setS({ kind: 'loading' });
    fetch(BASE + 'cv-results.json')
      .then(async (r) => {
        if (!r.ok) throw new Error(`файл cv-results.json не найден (HTTP ${r.status})`);
        return parseCv(await r.json());
      })
      .then((data) => { if (alive) setS({ kind: 'ready', data }); })
      .catch((e: Error) => { if (alive) setS({ kind: 'error', msg: e.message }); });
    return () => { alive = false; };
  }, [attempt]);
  return (
    <div className="app sumo cv">
      <header className="top">
        <div>
          <h1>SmartFlow AI <span className="ver">компьютерное зрение</span></h1>
          <p className="sub">Модули анализа видео: проверка на синтетической сцене с известной «правдой»</p>
        </div>
        <nav className="sumo-nav">
          <a className="top-link" href="#">← Карта Бишкека</a>
          <a className="top-link" href="#sumo">Эксперимент SUMO</a>
        </nav>
      </header>
      {s.kind === 'loading' && <div className="panel empty">Загружаю результаты проверки…</div>}
      {s.kind === 'error' && (
        <div className="banner error" role="alert">
          Результаты не загрузились: {s.msg}. <button className="btn small" onClick={() => setAttempt((x) => x + 1)}>Повторить</button>
        </div>
      )}
      {s.kind === 'ready' && <Report data={s.data} />}
    </div>
  );
}

function Report({ data }: { data: CvResults }) {
  const rows = data.summary;
  const runs = rows.reduce((a, r) => a + r.seeds.length, 0);
  return (
    <main className="sumo-grid">
      <section className="panel sumo-note">
        <h2>Что это и чего здесь нет</h2>
        <p>
          Модули компьютерного зрения работают отдельно от сайта, на Python и OpenCV {data.opencv}: браузер видео не обрабатывает.
          Реальных камер Бишкека проект не подключает и записей с улиц не использует.
        </p>
        <p>
          Проверка — на <b>синтетической сцене</b>, где для каждого кадра известны точные рамки машин, их скорость и все перестроения.
          Так можно честно измерить ошибки. Цифры ниже относятся только к этой сцене и не переносятся на реальные камеры автоматически.
        </p>
        <p className="hint">{data.scene.note}</p>
      </section>

      <section className="panel">
        <h2>Модули</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Модуль</th><th>Как устроен</th><th>Проверен на</th></tr></thead>
            <tbody>
              {data.modules.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.title}</b><div className="mono muted small">{m.id}</div></td>
                  <td>{m.impl}{m.alt && <div className="muted small">{m.alt}</div>}</td>
                  <td>{m.verified ? <span className="cv-ok">{m.verified}</span> : <span className="cv-na">не проверен — модели нет</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Каждый модуль включается и выключается отдельно. Без калибровки камеры скорость и пересечение линии не считаются — модуль сообщает «нет калибровки», а не число.</p>
      </section>

      <section className="panel">
        <h2>Точность по условиям съёмки</h2>
        <p className="hint">
          {Object.keys(data.conditions).length} условий × {rows[0]?.seeds.length} seed по {data.scene.duration_s} с, {data.scene.fps} кадров/с, всего {runs} прогонов.
          Машина должна быть найдена, если она в {data.scene.eval_zone_x_m[0]}–{data.scene.eval_zone_x_m[1]} м от камеры и видна хотя бы на 60 %.
          Совпадение рамок — IoU ≥ 0,5. Среднее ± разброс между seed.
        </p>
        <div className="table-wrap">
          <table className="cv-table">
            <thead><tr><th>Показатель</th>{rows.map((r) => <th key={r.condition}>{r.title}</th>)}</tr></thead>
            <tbody>
              <Group title="Детекция и сопровождение" />
              <Row rows={rows} label="Точность детекции" f={(r) => st(r.detection_precision_pct, 1, ' %')} />
              <Row rows={rows} label="Полнота: все машины" f={(r) => st(r.detection_recall_pct, 1, ' %')} />
              <Row rows={rows} label="…машина видна отдельно" f={(r) => st(r.detection_recall_isolated_pct, 1, ' %')} />
              <Row rows={rows} label="…перекрыта другой машиной" f={(r) => st(r.detection_recall_overlapping_pct, 1, ' %')} />
              <Row rows={rows} label="Доля перекрытых случаев" f={(r) => st(r.overlapping_share_pct, 0, ' %')} />
              <Row rows={rows} label="Смен номера трека на машину" f={(r) => st(r.id_switches_per_vehicle, 2)} />
              <Group title="Скорость (по калибровке и времени, не по размеру в кадре)" />
              <Row rows={rows} label="Есть оценка скорости" f={(r) => st(r.speed_coverage_pct, 0, ' %')} />
              <Row rows={rows} label="Средняя ошибка" f={(r) => st(r.speed_mae_kmh, 1, ' км/ч')} />
              <Row rows={rows} label="95 % ошибок не больше" f={(r) => st(r.speed_p95_abs_err_kmh, 1, ' км/ч')} />
              <Row rows={rows} label="Ошибка ≤ 5 км/ч" f={(r) => st(r.speed_within_5kmh_pct, 0, ' %')} />
              <Row rows={rows} label={`Превышения (> ${data.scene.speed_limit_kmh} + ${data.scene.speed_tolerance_kmh} км/ч): найдено из настоящих`} f={(r) => frac(r.speeding_true, r.speeding_gt)} />
              <Row rows={rows} label="…ложных событий" f={(r) => (r.speeding_false == null ? <span className="cv-na">нет данных</span> : r.speeding_false)} />
              <Group title="Сплошная линия" />
              <Row rows={rows} label="Пересечений найдено из настоящих" f={(r) => frac(r.solid_true, r.solid_gt)} />
              <Row rows={rows} label="Событий всего (из них верных)" f={(r) => (r.solid_events == null ? <span className="cv-na">нет данных</span> : `${r.solid_events} (${r.solid_true})`)} />
              <Row rows={rows} label="«Недостаточно данных»" f={(r) => r.solid_insufficient ?? '—'} />
              <Group title="Поток и очередь" />
              <Row rows={rows} label="Подсчёт машин: модуль / правда" f={(r) => (r.count_est == null ? <span className="cv-na">нет калибровки</span> : `${r.count_est} / ${r.count_gt}`)} />
              <Row rows={rows} label="Ошибка числа машин в зоне" f={(r) => st(r.density_count_mae, 2)} />
              <Row rows={rows} label="Ошибка длины очереди" f={(r) => st(r.queue_mae_m, 1, ' м')} />
              <Group title="Работа" />
              <Row rows={rows} label="Кадров без изображения" f={(r) => r.missing_frames ?? '—'} />
              <Row rows={rows} label="Время на кадр (CPU)" f={(r) => st(r.ms_per_frame, 0, ' мс')} />
              <Row rows={rows} label="Статус модуля скорости" f={(r) => STATUS_LABEL[r.module_status.speed_estimation] ?? r.module_status.speed_estimation} />
              <Row rows={rows} label="Статус модуля ремня" f={(r) => STATUS_LABEL[r.module_status.seatbelt_assessment] ?? r.module_status.seatbelt_assessment} />
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Кадры синтетической сцены с разметкой модулей</h2>
        <p className="hint">Зелёные рамки — подтверждённые треки с анонимным номером и скоростью, серые — сырые детекции, оранжевая линия — сплошная (задана в метрах на дороге).</p>
        <div className="cv-shots">
          {data.images.map((im) => (
            <figure key={im.file}>
              <img src={BASE + im.file} alt={`Синтетический кадр, ${data.conditions[im.condition]}, t = ${im.t} с`} loading="lazy" />
              <figcaption className="muted small">{data.conditions[im.condition]} · t = {im.t} с</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="panel sumo-params">
        <h2>Ограничения и как запустить</h2>
        <ul className="sumo-list">
          <li>Детектор классический (вычитание фона): машины, видимые отдельно, находятся надёжно; в плотном потоке и очереди перекрывающиеся машины сливаются в одно пятно. Из-за этого теряются треки и часть перестроений.</li>
          <li>Адаптер нейросетевого детектора YOLO есть, но пакет и веса не установлены и на этой сцене он не проверялся.</li>
          <li>Модели ремня безопасности нет: модуль всегда отвечает «невозможно определить». Интерфейс для специализированной модели и проверка качества кадра (разрешение, резкость, блики) готовы и покрыты тестами.</li>
          <li>Синтетика проще реальности: нет теней, дождя, ночи, бликов, грузовиков и дрожания камеры. Перед использованием на реальном видео модули нужно проверить на размеченных реальных записях.</li>
          <li>Все события — предварительные, анонимные (номер трека), без кадров, лиц и номеров.</li>
        </ul>
        <pre className="sumo-code">{`cd vision
python -m unittest discover -s tests -t .
python -m smartflow_cv.evaluate --out ../public/data/cv
python -m smartflow_cv.run --video clip.mp4 --calibration calib.json --config camera.json`}</pre>
        <p className="hint">Сгенерировано {new Date(data.generated).toLocaleString('ru-RU')}, расчёт занял {nf(data.elapsed_s / 60, 1)} мин.</p>
      </section>
    </main>
  );
}

function Group({ title }: { title: string }) {
  return <tr className="cv-group"><td colSpan={99}>{title}</td></tr>;
}

function Row({ rows, label, f }: { rows: CvRow[]; label: string; f: (r: CvRow) => ReactNode }) {
  return (
    <tr>
      <td>{label}</td>
      {rows.map((r) => <td key={r.condition} className="mono">{f(r)}</td>)}
    </tr>
  );
}
