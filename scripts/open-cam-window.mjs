/**
 * Открывает окно фильтра, которое снимает OBS.
 *
 * Почему отдельное окно, а не источник «Браузер» внутри OBS: helper-процессы OBS
 * (`OBS Helper*.app`) подписаны без com.apple.security.device.camera, поэтому их
 * встроенный Chromium не видит ни одной камеры macOS — сколько прав ни давай самому OBS.
 * Проверяется так:
 *   codesign -d --entitlements - "/Applications/OBS.app/Contents/Frameworks/OBS Helper.app"
 *
 * Поэтому кадр рисует настоящий Chrome, а OBS снимает его окно.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PORT = Number(process.env.PORT) || 8787;
const URL_TO_OPEN = `http://localhost:${PORT}/?mode=obs`;

/** Окно делаем чуть выше запрошенного кадра: страница сама подгонит его под себя. */
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 760;

const BROWSERS = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const findBrowser = async () => {
	for (const candidate of BROWSERS) {
		try {
			await access(candidate);

			return candidate;
		} catch {
			// Следующий кандидат
		}
	}

	return null;
};

const serverIsUp = async () => {
	try {
		const response = await fetch(`http://localhost:${PORT}/api/state`, { signal: AbortSignal.timeout(2000) });

		return response.ok;
	} catch {
		return false;
	}
};

if (!(await serverIsUp())) {
	console.error(`Сервер на ${PORT} не отвечает. Сначала запустите его: npm start`);
	process.exit(1);
}

const browser = await findBrowser();

if (!browser) {
	console.error('Не нашёл Chrome. Откройте вручную в отдельном окне:');
	console.error(`  ${URL_TO_OPEN}`);
	process.exit(1);
}

const args = [
	// Окно без вкладок и адресной строки: в кадр попадает только картинка
	`--app=${URL_TO_OPEN}`,
	// Свой профиль обязателен. Уже запущенный Chrome просто открыл бы ещё одну вкладку
	// в существующем процессе, и все флаги ниже были бы проигнорированы.
	`--user-data-dir=${path.join(projectDir, '.chrome-cam')}`,
	`--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
	// Chrome замораживает отрисовку в перекрытых и фоновых окнах. Для превью это разумно,
	// а здесь окно — источник кадров для созвона, и замирать ему нельзя.
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--disable-background-timer-throttling',
	'--autoplay-policy=no-user-gesture-required',
	'--no-first-run',
	'--no-default-browser-check',
];

const child = spawn(browser, args, { detached: true, stdio: 'ignore' });

child.unref();

console.log('');
console.log('  Окно фильтра открыто.');
console.log('');
console.log('  Первый раз браузер спросит доступ к камере — разрешите, профиль это запомнит.');
console.log('');
console.log('  Дальше в OBS: Источники → + → Захват окна → это окно, затем');
console.log('  «Запустить виртуальную камеру». В Zoom выбрать OBS Virtual Camera.');
console.log('');
console.log('  Окно можно перекрывать другими, но не сворачивать: свёрнутое окно не снимается.');
console.log('');
