/**
 * Детектор лица MediaPipe. Порт features/faceMasks/lib/useFaceLandmarker.ts без React.
 *
 * Wasm и модель лежат локально и отдаются нашим же сервером: OBS пересоздаёт страницу
 * при каждом перезапуске источника, и тянуть 4 мегабайта с CDN на каждый запуск — это
 * заметная пауза перед первой маской, а без интернета фильтр не заработал бы вовсе.
 */

const WASM_BASE_URL = '/vendor/tasks-vision/wasm';
const MODEL_URL = '/models/face_landmarker.task';
const BUNDLE_URL = '/vendor/tasks-vision/vision_bundle.mjs';

/** Видео готово к чтению кадров (HAVE_CURRENT_DATA). */
const HAVE_CURRENT_DATA = 2;

/** Сторона пустого кадра для прогрева модели. */
const WARM_UP_SIDE = 256;

/** Сколько лиц одеваем в маски одновременно. */
const MAX_FACES = 3;

/** Столько раз пробуем поднять модель, прежде чем признать маски недоступными. */
const MAX_INIT_ATTEMPTS = 3;

/**
 * Создаёт детектор. Пока он грузится, detectFaces возвращает null — кадр просто идёт
 * без масок, камера от этого не останавливается.
 */
export const createFaceDetector = ({ onStatusChange } = {}) => {
	let landmarker = null;
	let lastTime = 0;
	let status = 'loading';
	let delegate = null;

	const setStatus = next => {
		status = next;
		onStatusChange?.(status);
	};

	const init = async (attempt = 1) => {
		try {
			const { FaceLandmarker, FilesetResolver } = await import(BUNDLE_URL);
			const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
			const options = {
				baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numFaces: MAX_FACES,
			};

			delegate = 'GPU';

			try {
				landmarker = await FaceLandmarker.createFromOptions(fileset, options);
			} catch {
				// Внутри CEF у OBS WebGL-делегат доступен не всегда — считаем на процессоре
				delegate = 'CPU';
				landmarker = await FaceLandmarker.createFromOptions(fileset, {
					...options,
					baseOptions: { ...options.baseOptions, delegate: 'CPU' },
				});
			}

			// Первый прогон тянет за собой компиляцию шейдеров и раскладку графа — сотни
			// миллисекунд. Делаем его здесь, на пустом кадре, чтобы он не пришёлся на
			// момент, когда рулетка уже выдала маску и она должна появиться сразу.
			try {
				const warmUpFrame = document.createElement('canvas');

				warmUpFrame.width = WARM_UP_SIDE;
				warmUpFrame.height = WARM_UP_SIDE;
				lastTime = Math.max(lastTime + 1, performance.now());
				landmarker.detectForVideo(warmUpFrame, lastTime);
			} catch {
				// Прогрев необязателен: не вышел — просто первая маска появится чуть позже
			}

			setStatus('ready');
		} catch {
			// Модель лежит на нашем же сервере, и единственная реальная причина промаха —
			// страница открылась раньше, чем сервер поднялся. Пробуем ещё пару раз,
			// иначе источник в OBS остался бы без масок до ручного обновления.
			if (attempt < MAX_INIT_ATTEMPTS) {
				setTimeout(() => void init(attempt + 1), attempt * 2000);

				return;
			}

			// Без модели маски недоступны, но камера и дизеринг работают
			setStatus('failed');
		}
	};

	void init();

	/**
	 * Точки всех найденных лиц. Пустой массив — лиц в кадре нет, null — не считали:
	 * модель ещё не готова или кадр не готов. Детектор гоняем на каждом кадре: если
	 * рисовать маску по позе с прошлого кадра, она заметно тащится за лицом.
	 */
	const detectFaces = (video, timeMs) => {
		if (!landmarker || video.readyState < HAVE_CURRENT_DATA) {
			return null;
		}

		// detectForVideo падает, если время не растёт строго монотонно
		const time = Math.max(timeMs, lastTime + 1);

		lastTime = time;

		try {
			return landmarker.detectForVideo(video, time).faceLandmarks;
		} catch {
			return null;
		}
	};

	const close = () => {
		landmarker?.close();
		landmarker = null;
	};

	return {
		detectFaces,
		close,
		get status() {
			return status;
		},
		get delegate() {
			return delegate;
		},
	};
};
