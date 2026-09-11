/**
 * Сборка страницы. Один и тот же код работает в двух ролях:
 *   ?mode=obs — источник для OBS: только канвас, управляется извне;
 *   без параметра — панель управления в браузере.
 *
 * Настройки и позиции барабанов общие (через сервер), локально у каждой страницы
 * остаётся только галка «превью здесь»: OBS не должен гаснуть от того, что в браузере
 * выключили предпросмотр.
 */
import { createFaceDetector } from './faceLandmarker.js';
import { loadMaskCatalog, sortForDrawing } from './maskCatalog.js';
import { preloadMaskImages } from './maskImages.js';
import { buildMaskReels, masksAtPositions } from './maskReels.js';
import { createFilterPipeline } from './pipeline.js';
import { createSlotMachine } from './slotMachine.js';
import { createSharedState } from './state.js';

const MODE = new URLSearchParams(location.search).get('mode') === 'obs' ? 'obs' : 'panel';
const PREVIEW_STORAGE_KEY = 'mac-filter-cam:preview';

const cameraErrors = {
	denied: 'Доступ к камере запрещён. Разрешите его и перезагрузите страницу.',
	notFound: 'Камера не найдена.',
	notSupported: 'Этот браузер не умеет работать с камерой.',
	unknown: 'Не получилось включить камеру.',
};

const element = id => document.getElementById(id);

const canvas = element('output');
const hint = element('hint');

document.body.dataset.mode = MODE;

const showHint = text => {
	hint.textContent = text ?? '';
	hint.hidden = !text;
};

const readPreviewPreference = () => {
	try {
		return localStorage.getItem(PREVIEW_STORAGE_KEY) !== '0';
	} catch {
		return true;
	}
};

const writePreviewPreference = isEnabled => {
	try {
		localStorage.setItem(PREVIEW_STORAGE_KEY, isEnabled ? '1' : '0');
	} catch {
		// Приватное окно: настройка просто не переживёт перезагрузку
	}
};

/**
 * OBS поднимает свои источники вместе с собой и вполне может открыть страницу раньше,
 * чем поднялся сервер. Один провалившийся запрос оставил бы фильтр без масок навсегда,
 * поэтому даём каталогу несколько попыток.
 */
const loadCatalogWithRetry = async (attempts = 5) => {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await loadMaskCatalog();
		} catch {
			if (attempt === attempts) {
				return [];
			}

			await new Promise(resolve => setTimeout(resolve, attempt * 1000));
		}
	}

	return [];
};

const catalog = await loadCatalogWithRetry();

preloadMaskImages(catalog.map(mask => mask.url));

const reels = buildMaskReels(catalog);

const detector = createFaceDetector({ onStatusChange: status => updateModelChip(status) });

let pipeline = null;
let slot = null;
let slotBox = null;
let isPreviewEnabled = MODE === 'obs' || readPreviewPreference();
let cameraError = null;

/** Панель показывает состояние модели, подключение OBS и fps — в режиме obs чипов нет. */
const updateModelChip = status => {
	const chip = element('chipModel');

	if (!chip) {
		return;
	}

	const texts = { loading: 'модель загружается…', ready: 'маски готовы', failed: 'маски недоступны' };
	const tones = { loading: '', ready: 'ok', failed: 'bad' };

	chip.textContent = texts[status];
	chip.dataset.tone = tones[status];

	if (status === 'failed') {
		showHint('Модель лица не загрузилась — маски недоступны, дизеринг работает.');
	}

	if (slotBox) {
		slotBox.dataset.disabled = String(status !== 'ready');
	}
};

const applyCameraError = error => {
	cameraError = error;

	if (!error) {
		showHint(null);

		return;
	}

	showHint(cameraErrors[error]);

	// Дописываем, что за камеры вообще видит эта страница: в источнике OBS выбирать
	// устройство негде, и без этого списка непонятно, куда смотреть
	void navigator.mediaDevices
		?.enumerateDevices()
		.then(devices => {
			const cameras = devices.filter(device => device.kind === 'videoinput');
			const names = cameras.map(camera => camera.label || 'без названия').join(', ');

			hint.textContent = cameras.length
				? `${hint.textContent} Видны камеры: ${names}.`
				: `${hint.textContent} Этой странице не видно ни одной камеры.`;
		})
		.catch(() => {});
};

/**
 * В режиме источника кадр всегда ровно по окну.
 *
 * Картинку снимают «Захватом окна», и любое несовпадение размеров дало бы чёрные поля
 * по краям — прямо в созвоне. Настройка разрешения в этом режиме задаёт не размер кадра,
 * а размер окна: под неё окно и подгоняется ниже.
 */
const outputSizeFor = state =>
	MODE === 'obs'
		? { outputWidth: Math.max(2, window.innerWidth), outputHeight: Math.max(2, window.innerHeight) }
		: { outputWidth: state.outputWidth, outputHeight: state.outputHeight };

const settingsOf = state => ({
	dither: state.dither,
	dotSize: state.dotSize,
	contrast: state.contrast,
	brightness: state.brightness,
	mirror: state.mirror,
	...outputSizeFor(state),
	cameraLabel: state.cameraLabel,
});

/**
 * Подгоняет окно так, чтобы его внутренняя область совпала с выбранным разрешением.
 * Работает только в отдельном окне (npm run cam); в обычной вкладке молча ничего не делает.
 */
const fitWindowToResolution = state => {
	if (MODE !== 'obs') {
		return;
	}

	try {
		const frameWidth = window.outerWidth - window.innerWidth;
		const frameHeight = window.outerHeight - window.innerHeight;

		if (window.innerWidth !== state.outputWidth || window.innerHeight !== state.outputHeight) {
			window.resizeTo(state.outputWidth + frameWidth, state.outputHeight + frameHeight);
		}
	} catch {
		// Обычная вкладка менять свой размер не вправе — кадр просто пойдёт по её размеру
	}
};

const applyMasks = state => {
	pipeline?.setMasks(sortForDrawing(masksAtPositions(reels, state.reelPositions)));
};

const shared = createSharedState({
	role: MODE,
	onChange: state => {
		if (!pipeline) {
			pipeline = createFilterPipeline({
				canvas,
				detector,
				settings: settingsOf(state),
				onError: applyCameraError,
				onStats: updateStats,
			});

			if (isPreviewEnabled) {
				void pipeline.start();
			} else {
				showHint('Превью выключено. Картинка идёт в OBS.');
			}
		} else {
			pipeline.setSettings(settingsOf(state));
		}

		fitWindowToResolution(state);
		applyMasks(state);
		renderPanel(state);
	},
	onRoles: roles => {
		const chip = element('chipObs');

		if (!chip) {
			return;
		}

		chip.textContent = roles.obs ? `OBS подключён (${roles.obs})` : 'OBS не подключён';
		chip.dataset.tone = roles.obs ? 'ok' : '';
	},
});

let lastStatsAt = 0;

function updateStats(stats) {
	const chip = element('chipFps');

	// Обновляем раз в полсекунды: перерисовывать чип 30 раз в секунду незачем
	if (!chip || performance.now() - lastStatsAt < 500) {
		return;
	}

	lastStatsAt = performance.now();
	chip.textContent = `${stats.fps} fps · ${stats.width}×${stats.height}`;
}

/* Панель управления. В режиме obs ничего этого на странице нет. */

let isPanelReady = false;

const bindControls = state => {
	slotBox = element('slot');

	slot = createSlotMachine({
		container: slotBox,
		reels,
		positions: state.reelPositions,
		onSettle: positions => shared.patch({ reelPositions: positions }),
	});
	updateModelChip(detector.status);

	element('resetMasks').addEventListener('click', () => slot.reset());

	// Пробел — рычаг. Но не тогда, когда фокус в ползунке или поле: там у пробела своя работа
	window.addEventListener('keydown', event => {
		const isTypingTarget = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;

		if (event.code === 'Space' && !isTypingTarget) {
			event.preventDefault();
			slot.spinAll();
		}
	});

	const bindNumber = (id, key, transform = Number) => {
		element(id).addEventListener('input', event => shared.patch({ [key]: transform(event.target.value) }));
	};

	const bindFlag = (id, key) => {
		element(id).addEventListener('change', event => shared.patch({ [key]: event.target.checked }));
	};

	bindFlag('dither', 'dither');
	bindFlag('mirror', 'mirror');
	bindNumber('dotSize', 'dotSize');
	bindNumber('contrast', 'contrast');
	bindNumber('brightness', 'brightness');

	element('resolution').addEventListener('change', event => {
		const [outputWidth, outputHeight] = event.target.value.split('x').map(Number);

		shared.patch({ outputWidth, outputHeight });
	});

	// Значение опции — название камеры: его понимает и панель, и источник в OBS,
	// а deviceId у каждого браузера свой и на другой стороне ничего не значит
	element('device').addEventListener('change', event => shared.patch({ cameraLabel: event.target.value || null }));

	element('preview').addEventListener('change', event => {
		isPreviewEnabled = event.target.checked;
		writePreviewPreference(isPreviewEnabled);

		if (isPreviewEnabled) {
			void pipeline.start();
			showHint(cameraError ? cameraErrors[cameraError] : null);
		} else {
			pipeline.stop();
			canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
			showHint('Превью выключено. Картинка идёт в OBS.');
		}
	});

	const obsUrl = element('obsUrl');

	obsUrl.value = `${location.origin}/?mode=obs`;
	element('copyUrl').addEventListener('click', async () => {
		const button = element('copyUrl');

		try {
			await navigator.clipboard.writeText(obsUrl.value);
		} catch {
			// Буфер недоступен без жеста или по политике — выделяем, скопирует руками
			obsUrl.select();
		}

		button.textContent = 'Скопировано';
		setTimeout(() => {
			button.textContent = 'Копировать';
		}, 1200);
	});

	void fillDevices();
};

/**
 * Список камер приходит без названий, пока нет разрешения на камеру, поэтому
 * заполняем его после старта потока и обновляем, если камеру воткнули позже.
 */
const fillDevices = async () => {
	const select = element('device');

	if (!select || !navigator.mediaDevices?.enumerateDevices) {
		return;
	}

	const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
	// Пока камеру ни разу не разрешили, названия пустые — выбирать по ним нечего
	const cameras = devices.filter(device => device.kind === 'videoinput' && device.label);
	const selected = shared.current?.cameraLabel ?? '';

	select.innerHTML = '';
	select.appendChild(new Option('По умолчанию', ''));
	cameras.forEach(camera => {
		select.appendChild(new Option(camera.label, camera.label));
	});
	select.value = cameras.some(camera => camera.label === selected) ? selected : '';
};

const renderPanel = state => {
	if (MODE === 'obs') {
		return;
	}

	if (!isPanelReady) {
		isPanelReady = true;
		bindControls(state);
	}

	element('dither').checked = state.dither;
	element('mirror').checked = state.mirror;
	element('preview').checked = isPreviewEnabled;
	element('dotSize').value = String(state.dotSize);
	element('contrast').value = String(state.contrast);
	element('brightness').value = String(state.brightness);
	element('resolution').value = `${state.outputWidth}x${state.outputHeight}`;
	element('dotSizeValue').textContent = `${state.dotSize} px`;
	element('contrastValue').textContent = state.contrast.toFixed(2);
	element('brightnessValue').textContent = state.brightness > 0 ? `+${state.brightness}` : String(state.brightness);

	// Пока барабан крутится, состояние ещё держит старые позиции — дёргать его назад нельзя
	const isSameSpin = slot.settledPositions.every((position, index) => position === state.reelPositions[index]);

	if (!isSameSpin) {
		slot.jumpTo(state.reelPositions);
	}
};

if (navigator.mediaDevices?.addEventListener) {
	navigator.mediaDevices.addEventListener('devicechange', () => void fillDevices());
}

// Камера отдаёт названия устройств только после первого разрешения — обновляем список,
// когда поток уже поднялся
setTimeout(() => void fillDevices(), 1500);

// Окно фильтра можно тянуть мышью: кадр должен идти следом, иначе появятся чёрные поля
if (MODE === 'obs') {
	window.addEventListener('resize', () => {
		if (shared.current) {
			pipeline?.setSettings(settingsOf(shared.current));
		}
	});
}
