/**
 * Запуск соседних приложений: панель в браузере и OBS.
 *
 * Живёт отдельно от сервера, потому что этим пользуются двое: сервер при старте
 * (`npm start` поднимает всё разом) и отдельная команда `npm run obs`.
 */
import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const OBS_APP = '/Applications/OBS.app';

/**
 * Без этого флага встроенный браузер OBS отказывает странице в доступе к камере:
 * устройства он видит, но подтвердить запрос разрешения внутри источника некому.
 * Свои аргументы OBS передаёт в CEF, поэтому флаг доезжает куда надо. Действует
 * только на источники «Браузер» и только на камеру с микрофоном — захват экрана нет.
 */
export const CAMERA_FLAG = '--auto-accept-camera-and-microphone-capture';

export const openInBrowser = url => {
	spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
};

/**
 * Что сейчас с OBS.
 *
 * Отличать «запущен» от «запущен с доступом к камере» обязательно: OBS, открытый
 * двойным кликом по иконке, выглядит рабочим, но в источнике вместо картинки будет
 * «Доступ к камере запрещён». Флаг виден в аргументах процесса — по нему и проверяем.
 *
 * @returns {Promise<'missing' | 'stopped' | 'ready' | 'noCameraAccess'>}
 */
export const obsState = async () => {
	try {
		await access(OBS_APP);
	} catch {
		return 'missing';
	}

	const pids = await run('pgrep', ['-x', 'OBS']).then(
		result => result.stdout.trim().split('\n').filter(Boolean),
		() => [],
	);

	if (!pids.length) {
		return 'stopped';
	}

	const command = await run('ps', ['-o', 'command=', '-p', pids.join(',')]).then(
		result => result.stdout,
		() => '',
	);

	return command.includes(CAMERA_FLAG) ? 'ready' : 'noCameraAccess';
};

const quitObs = async () => {
	await run('osascript', ['-e', 'tell application "OBS" to quit']).catch(() => {});

	// Ждём, пока процесс действительно уйдёт: запустить второй OBS поверх первого нельзя
	for (let attempt = 0; attempt < 20; attempt++) {
		const isRunning = await run('pgrep', ['-x', 'OBS']).then(
			() => true,
			() => false,
		);

		if (!isRunning) {
			return true;
		}

		await new Promise(resolve => setTimeout(resolve, 500));
	}

	return false;
};

/**
 * Поднимает OBS с доступом к камере.
 *
 * `restart` нужен, когда OBS уже запущен без флага: командную строку он читает только
 * при старте, поэтому иначе никак. Сам по себе, без явной просьбы, чужой OBS не трогаем —
 * вдруг там идёт эфир.
 *
 * @returns {Promise<'missing' | 'launched' | 'relaunched' | 'ready' | 'noCameraAccess' | 'quitFailed'>}
 */
export const launchObs = async ({ restart = false } = {}) => {
	const state = await obsState();

	if (state === 'missing' || state === 'ready') {
		return state;
	}

	if (state === 'noCameraAccess') {
		if (!restart) {
			return 'noCameraAccess';
		}

		if (!(await quitObs())) {
			return 'quitFailed';
		}
	}

	spawn('open', ['-a', OBS_APP, '--args', CAMERA_FLAG], { detached: true, stdio: 'ignore' }).unref();

	return state === 'noCameraAccess' ? 'relaunched' : 'launched';
};
