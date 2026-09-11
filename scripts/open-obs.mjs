/**
 * Поднимает OBS с доступом к камере для браузерных источников.
 *
 * Если OBS уже запущен без доступа (например открыт двойным кликом по иконке) —
 * перезапускает его: командную строку OBS читает только при старте. Команду запускают
 * руками и ровно за этим, так что перезапуск здесь ожидаем. Подробности — в lib/launch.mjs.
 */
import { launchObs } from '../lib/launch.mjs';

const status = await launchObs({ restart: true });

if (status === 'missing') {
	console.error('OBS не найден в /Applications. Поставьте его: brew install --cask obs');
	process.exit(1);
}

if (status === 'quitFailed') {
	console.error('');
	console.error('  OBS не закрылся сам — возможно, спрашивает про несохранённое.');
	console.error('  Закройте его вручную и запустите команду снова.');
	console.error('');
	process.exit(1);
}

const messages = {
	ready: 'OBS уже запущен с доступом к камере — всё в порядке.',
	launched: 'OBS запущен, его браузерным источникам разрешена камера.',
	relaunched: 'OBS был запущен без доступа к камере — перезапустил с доступом.',
};

console.log('');
console.log(`  ${messages[status]}`);
console.log('');
