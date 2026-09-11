/**
 * Локальный сервер фильтра: раздаёт страницу и держит общее состояние между вкладками.
 *
 * Панель управления и источник в OBS — это две разные страницы одного приложения:
 * крутить рулетку в окне Interact внутри OBS неудобно, поэтому рулетка живёт в браузере,
 * а OBS получает готовую картинку. Связывает их этот сервер: панель шлёт патч состояния,
 * сервер рассылает его всем подписчикам по SSE.
 */
import express from 'express';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchObs, openInBrowser } from './lib/launch.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, 'public');
const masksDir = path.join(publicDir, 'masks');
const tasksVisionDir = path.join(projectDir, 'node_modules', '@mediapipe', 'tasks-vision');

const PORT = Number(process.env.PORT) || 8787;

/** Категории масок = имена папок. Всё, что вне списка, страница рисовать не умеет. */
const MASK_CATEGORIES = ['glasses', 'headwear', 'mustaches', 'mouths'];

/**
 * Состояние живёт в памяти сервера, а не в localStorage страниц: у OBS свой профиль CEF,
 * и с localStorage панель и источник никогда бы не увидели настройки друг друга.
 */
const state = {
	/** Позиции барабанов рулетки: индекс грани, на которой барабан стоит. */
	reelPositions: [0, 0, 0],
	dither: true,
	/** Сторона точки дизеринга в пикселях вывода: кадр считается в этом масштабе. */
	dotSize: 1,
	contrast: 1.35,
	/** Осветление кадра перед бинаризацией: им и регулируется плотность чёрных точек. */
	brightness: 0,
	mirror: false,
	outputWidth: 1280,
	outputHeight: 720,
	/**
	 * Камеру храним названием, а не deviceId. Идентификатор устройства браузер солит
	 * профилем и origin-ом, поэтому id, выбранный в Chrome, в другом браузере (например
	 * во встроенном браузере OBS) не существует вовсе — и запрос камеры падает с
	 * OverconstrainedError. Название же одинаковое везде.
	 */
	cameraLabel: null,
};

/** Открытые SSE-подписчики. Роль нужна только для индикатора «OBS подключён» в панели. */
const subscribers = new Set();

const app = express();

app.use(express.json({ limit: '64kb' }));

const broadcast = (event, payload) => {
	const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

	subscribers.forEach(subscriber => subscriber.response.write(message));
};

const broadcastRoles = () => {
	const roles = { panel: 0, obs: 0 };

	subscribers.forEach(subscriber => {
		roles[subscriber.role] = (roles[subscriber.role] ?? 0) + 1;
	});

	broadcast('roles', roles);
};

app.get('/api/state', (request, response) => {
	response.json(state);
});

app.post('/api/state', (request, response) => {
	const patch = request.body ?? {};

	// Ключи фиксированы схемой выше: чужие поля молча игнорируем, чтобы опечатка в панели
	// не засоряла состояние и не уезжала в OBS
	Object.keys(patch).forEach(key => {
		if (key in state) {
			state[key] = patch[key];
		}
	});

	// Отправителя в рассылку включаем тоже: сервер — единственный источник правды,
	// и эхо собственного патча страница отсекает по clientId
	broadcast('state', { state, from: request.get('X-Client-Id') ?? null });
	response.json(state);
});

app.get('/api/events', (request, response) => {
	response.set({
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		// Nginx тут не стоит, но CEF тоже любит буферизовать — просим не копить
		'X-Accel-Buffering': 'no',
	});
	response.flushHeaders();

	const subscriber = { response, role: request.query.role === 'obs' ? 'obs' : 'panel' };

	subscribers.add(subscriber);
	response.write(`event: state\ndata: ${JSON.stringify({ state, from: null })}\n\n`);
	broadcastRoles();

	// Прокси и сон макбука рвут молчащее соединение — держим его комментарием раз в 20 секунд
	const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);

	request.on('close', () => {
		clearInterval(keepAlive);
		subscribers.delete(subscriber);
		broadcastRoles();
	});
});

/**
 * Каталог масок собирается из файлов, а не из списка в коде: добавить маску =
 * положить png в public/masks/<категория> и перезагрузить страницу.
 */
app.get('/api/masks', async (request, response) => {
	try {
		const categories = await Promise.all(
			MASK_CATEGORIES.map(async category => {
				const files = await readdir(path.join(masksDir, category)).catch(() => []);

				return files
					.filter(file => file.toLowerCase().endsWith('.png'))
					.sort()
					.map(file => ({
						id: file.replace(/\.png$/i, ''),
						category,
						url: `/masks/${category}/${encodeURIComponent(file)}`,
					}));
			}),
		);

		response.json(categories.flat());
	} catch {
		response.status(500).json({ error: 'не получилось прочитать папку масок' });
	}
});

// wasm и обёртку MediaPipe отдаём прямо из node_modules: копия в public была бы
// 34 мегабайтами дубликата, которые ещё и разъезжаются с package.json при обновлении
app.use('/vendor/tasks-vision', express.static(tasksVisionDir, { immutable: true, maxAge: '1h' }));

// Модель кешировать надолго можно: файл неизменяемый, а весит почти 4 мегабайта
app.use('/models', express.static(path.join(publicDir, 'models'), { immutable: true, maxAge: '1d' }));

// Остальное — код страницы: во время правок кеш только мешает
app.use(express.static(publicDir, { etag: true, maxAge: 0 }));

const PANEL_URL = `http://localhost:${PORT}/`;
const SOURCE_URL = `http://localhost:${PORT}/?mode=obs`;

/** `npm run serve` поднимает только сервер: иногда панель и OBS открывать не надо. */
const shouldLaunchApps = process.env.NO_LAUNCH !== '1';

app.listen(PORT, '127.0.0.1', async () => {
	console.log('');
	console.log('  Фильтр запущен.');
	console.log('');
	console.log(`  Панель управления:  ${PANEL_URL}`);
	console.log(`  URL для OBS:        ${SOURCE_URL}`);
	console.log('');

	if (!shouldLaunchApps) {
		return;
	}

	openInBrowser(PANEL_URL);

	const obs = await launchObs();

	if (obs === 'missing') {
		console.log('  OBS не найден. Поставьте его: brew install --cask obs');
		console.log('');

		return;
	}

	if (obs === 'alreadyRunning') {
		console.log('  OBS уже запущен — но доступ к камере он получает только флагом при старте.');
		console.log('  Если в источнике «Доступ к камере запрещён»: закройте OBS и запустите npm start заново.');
		console.log('');

		return;
	}

	console.log('  OBS запущен с доступом к камере. Осталось добавить источник:');
	console.log(`    Источники → + → Браузер → URL ${SOURCE_URL}, размер 1280×720`);
	console.log('  Потом «Запустить виртуальную камеру» и выбрать OBS Virtual Camera в Zoom.');
	console.log('');
});
