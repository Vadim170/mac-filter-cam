/**
 * Картинки масок для отрисовки на канвасе. Барабаны рулетки показывают те же файлы
 * через <img>, поэтому кеш браузера общий.
 *
 * Держим именно ImageBitmap, а не <img>: у элемента изображения браузер под нехваткой
 * памяти выбрасывает декодированные пиксели и раскодирует их заново — это происходит
 * прямо в кадре и даёт рывок. У ImageBitmap пиксели закреплены.
 */

const decoded = new Map();
const pending = new Set();

const load = async url => {
	try {
		const response = await fetch(url);

		decoded.set(url, await createImageBitmap(await response.blob()));
	} catch {
		// Редкий случай: нет createImageBitmap или файл не отдался — берём обычной картинкой
		await new Promise(resolve => {
			const image = new Image();

			image.onload = () => {
				decoded.set(url, image);
				resolve();
			};
			image.onerror = () => resolve();
			image.src = url;
		});
	} finally {
		pending.delete(url);
	}
};

const ensure = url => {
	const ready = decoded.get(url);

	if (ready) {
		return ready;
	}

	if (!pending.has(url)) {
		pending.add(url);
		void load(url);
	}

	return null;
};

/** Отдаёт готовую картинку, либо null — тогда кадр просто рисуется без этой маски. */
export const getMaskImage = url => ensure(url);

/**
 * Тянем и распаковываем все маски заранее, пока человек настраивает камеру.
 * Иначе первая же выпавшая маска ждёт загрузку и декодирование прямо в кадре.
 */
export const preloadMaskImages = urls => {
	urls.forEach(url => {
		ensure(url);
	});
};
