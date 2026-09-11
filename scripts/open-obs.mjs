/** Поднимает OBS с доступом к камере для браузерных источников. Подробности — в lib/launch.mjs. */
import { launchObs } from '../lib/launch.mjs';

const status = await launchObs();

if (status === 'missing') {
	console.error('OBS не найден в /Applications. Поставьте его: brew install --cask obs');
	process.exit(1);
}

if (status === 'alreadyRunning') {
	console.error('');
	console.error('  OBS уже запущен, а флаг доступа к камере читается только при старте.');
	console.error('  Закройте OBS и запустите команду снова.');
	console.error('');
	process.exit(1);
}

console.log('');
console.log('  OBS запущен, его браузерным источникам разрешена камера.');
console.log('');
