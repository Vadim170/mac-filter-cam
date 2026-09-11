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
const CAMERA_FLAG = '--auto-accept-camera-and-microphone-capture';

export const openInBrowser = url => {
	spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
};

/**
 * @returns {Promise<'launched' | 'alreadyRunning' | 'missing'>}
 */
export const launchObs = async () => {
	try {
		await access(OBS_APP);
	} catch {
		return 'missing';
	}

	// Уже запущенному OBS флаг не передать: командную строку он читает только при старте
	const isRunning = await run('pgrep', ['-x', 'OBS']).then(
		() => true,
		() => false,
	);

	if (isRunning) {
		return 'alreadyRunning';
	}

	spawn('open', ['-a', OBS_APP, '--args', CAMERA_FLAG], { detached: true, stdio: 'ignore' }).unref();

	return 'launched';
};
