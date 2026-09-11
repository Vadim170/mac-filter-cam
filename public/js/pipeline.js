/**
 * Цикл кадра: камера → маски → дизеринг → канвас.
 *
 * Структура повторяет useReceiptCamera.ts из kiosk-mobile-photo: кадр сначала собирается
 * на рабочем канвасе вместе с масками и только потом бинаризуется — иначе маски были бы
 * гладкими картинками поверх дизеренного лица и выпадали бы из стиля.
 */
import { createDitherer } from './ditherer.js';
import { createFaceMaskPainter } from './maskPainter.js';

/**
 * requestVideoFrameCallback будит нас ровно на новый кадр камеры. requestAnimationFrame
 * так не умеет: он тикает по частоте экрана, и лишние проходы жгут батарею впустую.
 */
const supportsVideoFrameCallback =
	typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/** Сколько последних кадров держим для показа fps. */
const FPS_WINDOW = 60;

/** Размер точки дизеринга: кадр считается во столько раз меньше вывода и растягивается обратно. */
const processingSize = settings =>
	settings.dither
		? {
				width: Math.max(2, Math.round(settings.outputWidth / settings.dotSize)),
				height: Math.max(2, Math.round(settings.outputHeight / settings.dotSize)),
		  }
		: { width: settings.outputWidth, height: settings.outputHeight };

/** Центральный кроп видео под пропорции вывода: камера 4:3 не должна растягиваться в 16:9. */
const coverCrop = (video, width, height) => {
	const videoAspect = video.videoWidth / video.videoHeight;
	const targetAspect = width / height;
	const sourceWidth = videoAspect > targetAspect ? video.videoHeight * targetAspect : video.videoWidth;
	const sourceHeight = videoAspect > targetAspect ? video.videoHeight : video.videoWidth / targetAspect;

	return {
		sourceX: (video.videoWidth - sourceWidth) / 2,
		sourceY: (video.videoHeight - sourceHeight) / 2,
		sourceWidth,
		sourceHeight,
	};
};

const stopStream = stream => stream?.getTracks().forEach(track => track.stop());

const toCameraError = error => {
	if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
		return 'denied';
	}

	if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
		return 'notFound';
	}

	return 'unknown';
};

/**
 * Переводит название камеры в её deviceId в этом браузере.
 *
 * Названия одинаковы везде, а id у каждого браузера свой, поэтому в общем состоянии
 * лежит именно название. Камеры с таким названием может не быть (отключили, или это
 * выбор из другого браузера) — тогда берём камеру по умолчанию.
 */
const resolveDeviceId = async label => {
	if (!label || !navigator.mediaDevices?.enumerateDevices) {
		return null;
	}

	const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);

	return devices.find(device => device.kind === 'videoinput' && device.label === label)?.deviceId ?? null;
};

/**
 * @param {{ canvas: HTMLCanvasElement, detector: object, settings: object,
 *           onError?: (error: string | null) => void, onStats?: (stats: object) => void }} params
 */
export const createFilterPipeline = ({ canvas, detector, settings, onError, onStats }) => {
	const video = document.createElement('video');

	video.autoplay = true;
	video.muted = true;
	video.playsInline = true;

	const painter = createFaceMaskPainter();
	const outCtx = canvas.getContext('2d');

	/**
	 * Рабочий канвас отдельный и с willReadFrequently: getImageData на общем канвасе
	 * заставляет браузер каждый кадр стаскивать текстуру с видеопамяти, а с этим флагом
	 * канвас изначально живёт в обычной памяти.
	 */
	const workCanvas = document.createElement('canvas');
	const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

	let current = { ...settings };
	let masks = [];
	let stream = null;
	let ditherer = null;
	let frameHandle = null;
	let isRunning = false;
	let streamToken = 0;
	const frameTimes = [];

	const applySize = () => {
		const { width, height } = processingSize(current);

		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}

		if (workCanvas.width !== width || workCanvas.height !== height) {
			workCanvas.width = width;
			workCanvas.height = height;
			ditherer = null;
		}

		if (current.dither && !ditherer) {
			ditherer = createDitherer(width, height);
		}
	};

	const reportStats = () => {
		if (!onStats) {
			return;
		}

		const now = performance.now();

		frameTimes.push(now);

		if (frameTimes.length > FPS_WINDOW) {
			frameTimes.shift();
		}

		const span = frameTimes[frameTimes.length - 1] - frameTimes[0];

		onStats({
			fps: span > 0 ? Math.round(((frameTimes.length - 1) / span) * 1000) : 0,
			width: canvas.width,
			height: canvas.height,
			videoWidth: video.videoWidth,
			videoHeight: video.videoHeight,
		});
	};

	const scheduleNextFrame = () => {
		if (!isRunning) {
			return;
		}

		frameHandle = supportsVideoFrameCallback
			? video.requestVideoFrameCallback(processFrame)
			: requestAnimationFrame(processFrame);
	};

	const cancelFrame = () => {
		if (frameHandle === null) {
			return;
		}

		if (supportsVideoFrameCallback) {
			video.cancelVideoFrameCallback(frameHandle);
		} else {
			cancelAnimationFrame(frameHandle);
		}

		frameHandle = null;
	};

	function processFrame(timeMs = performance.now()) {
		frameHandle = null;

		if (!isRunning || !outCtx || !workCtx) {
			return;
		}

		if (!video.videoWidth || !video.videoHeight || video.paused || video.ended) {
			scheduleNextFrame();

			return;
		}

		applySize();

		const { width, height } = canvas;
		// Маски рисуются до бинаризации, поэтому при включённом дизеринге весь кадр
		// собирается на рабочем канвасе, а на видимый уходит уже результат
		const ctx = current.dither ? workCtx : outCtx;
		const crop = coverCrop(video, width, height);

		ctx.save();
		if (current.mirror) {
			ctx.setTransform(-1, 0, 0, 1, width, 0);
		}
		ctx.drawImage(video, crop.sourceX, crop.sourceY, crop.sourceWidth, crop.sourceHeight, 0, 0, width, height);
		ctx.restore();

		if (masks.length) {
			const frame = {
				ctx,
				video,
				...crop,
				width,
				height,
				isMirrored: current.mirror,
				timeMs,
			};

			painter.paint(frame, detector.detectFaces(video, timeMs), masks);
		}

		if (current.dither && ditherer) {
			outCtx.putImageData(ditherer.run(ctx.getImageData(0, 0, width, height), current), 0, 0);
		}

		reportStats();
		scheduleNextFrame();
	}

	const requestStream = deviceId =>
		navigator.mediaDevices.getUserMedia({
			video: {
				width: { ideal: current.outputWidth },
				height: { ideal: current.outputHeight },
				frameRate: { ideal: 30 },
				...(deviceId ? { deviceId: { exact: deviceId } } : {}),
			},
			audio: false,
		});

	const startStream = async () => {
		const token = ++streamToken;

		stopStream(stream);
		stream = null;

		try {
			const deviceId = await resolveDeviceId(current.cameraLabel);
			let nextStream;

			try {
				nextStream = await requestStream(deviceId);
			} catch (error) {
				// Выбранная камера могла исчезнуть между enumerateDevices и запросом.
				// Остаться совсем без картинки хуже, чем снимать не на ту камеру.
				if (!deviceId) {
					throw error;
				}

				nextStream = await requestStream(null);
			}

			// Пока ждали разрешение, настройки могли смениться ещё раз — этот поток уже не нужен
			if (token !== streamToken) {
				stopStream(nextStream);

				return;
			}

			stream = nextStream;
			video.srcObject = stream;
			await video.play();
			onError?.(null);

			// До первого разрешения браузер не отдаёт названий устройств, поэтому выбранную
			// камеру было не найти и мы взяли камеру по умолчанию. Теперь названия есть —
			// если нужная камера всё-таки нашлась, пересаживаемся на неё.
			if (current.cameraLabel && !deviceId && (await resolveDeviceId(current.cameraLabel))) {
				void startStream();
			}
		} catch (error) {
			if (token === streamToken) {
				onError?.(toCameraError(error));
			}
		}
	};

	const start = async () => {
		if (isRunning) {
			return;
		}

		if (!navigator.mediaDevices?.getUserMedia) {
			onError?.('notSupported');

			return;
		}

		isRunning = true;
		applySize();
		await startStream();
		scheduleNextFrame();
	};

	const stop = () => {
		isRunning = false;
		cancelFrame();
		streamToken++;
		stopStream(stream);
		stream = null;
		video.srcObject = null;
		painter.reset();
		frameTimes.length = 0;
	};

	/** Настройки приезжают из общего состояния; поток перезапускаем только когда он и правда меняется. */
	const setSettings = next => {
		const needsRestart =
			next.cameraLabel !== current.cameraLabel ||
			next.outputWidth !== current.outputWidth ||
			next.outputHeight !== current.outputHeight;

		current = { ...next };
		applySize();

		if (isRunning && needsRestart) {
			void startStream();
		}
	};

	const setMasks = next => {
		masks = next;
	};

	return { start, stop, setSettings, setMasks, video };
};
