/**
 * Кладёт модель face_landmarker рядом со страницей, чтобы в рантайме не ходить в сеть.
 *
 * OBS открывает страницу в своём CEF, и каждый перезапуск источника — это новая загрузка.
 * С моделью на диске первый кадр с маской появляется сразу, а фильтр работает и без интернета.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modelPath = path.join(projectDir, 'public', 'models', 'face_landmarker.task');

/** Один и тот же файл у Google лежит по двум адресам: часть сетей режет только один из них. */
const SOURCES = [
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
	'https://storage.googleapis.com/mediapipe-assets/face_landmarker.task',
];

/** Модель весит около 3,7 МБ: файл меньше мегабайта — точно обрезок или страница ошибки. */
const MIN_MODEL_BYTES = 1_000_000;

const alreadyDownloaded = async () => {
	try {
		return (await stat(modelPath)).size >= MIN_MODEL_BYTES;
	} catch {
		return false;
	}
};

const download = async (url) => {
	const response = await fetch(url, { redirect: 'follow' });

	if (!response.ok || !response.body) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	// Пишем во временный файл: оборванная закачка не должна оставить битую модель под нужным именем
	const tempPath = `${modelPath}.part`;

	await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));

	if ((await stat(tempPath)).size < MIN_MODEL_BYTES) {
		await unlink(tempPath);
		throw new Error('файл подозрительно мал');
	}

	await rename(tempPath, modelPath);
};

// Скрипт висит на prestart и выполняется перед каждым запуском: когда качать нечего,
// молчим, чтобы не засорять вывод
if (await alreadyDownloaded()) {
	process.exit(0);
}

await mkdir(path.dirname(modelPath), { recursive: true });

for (const [index, url] of SOURCES.entries()) {
	try {
		console.log('Качаю модель:', url);
		await download(url);
		console.log('Готово:', path.relative(projectDir, modelPath));
		process.exit(0);
	} catch (error) {
		console.warn(`Не вышло (${error.message})`);

		if (index === SOURCES.length - 1) {
			console.error('\nНи один адрес не ответил. Положите face_landmarker.task в public/models вручную.');
			process.exit(1);
		}
	}
}
