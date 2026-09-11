/**
 * Каталог масок. Файлы лежат в public/masks/<категория>/<номер>_<имя>.png, список
 * отдаёт сервер: добавить маску = положить файл в нужную папку.
 *
 * Посадка описывается тремя числами и точкой привязки — этого хватает, потому что
 * PNG обрезаны по содержимому (прозрачных полей почти нет). Числа — из
 * features/faceMasks/model/maskCatalog.ts kiosk-mobile-photo, там они откалиброваны.
 */

/** Порядок отрисовки: что ниже в списке, то поверх. */
export const MASK_DRAW_ORDER = ['mouths', 'mustaches', 'glasses', 'headwear'];

const placementByCategory = {
	/** Очки садятся центром на линию глаз и по ширине совпадают с головой. */
	glasses: { anchor: 'eyes', widthRatio: 1.02, originY: 0.5, offsetY: 0 },
	/** Головные уборы ставим нижним краем на лоб — так работает и кепка, и высокая антенна. */
	headwear: { anchor: 'forehead', widthRatio: 1.32, originY: 1, offsetY: 0.06 },
	/** Усы — верхним краем под нос. */
	mustaches: { anchor: 'noseBase', widthRatio: 0.62, originY: 0, offsetY: 0.01 },
	/** Рты — центром на середину губ. */
	mouths: { anchor: 'mouth', widthRatio: 0.54, originY: 0.5, offsetY: 0 },
};

/**
 * Точечные поправки для картинок, которые выбиваются из пропорций своей категории.
 * Правится по месту одним числом, если маска сидит не так.
 */
const placementOverrides = {
	'01_dodo_hat': { widthRatio: 1.5, originY: 0.86 },
	'05_tv_antenna_headband': { widthRatio: 1.16 },
	'06_books_apple_hat': { widthRatio: 1.1 },
	'18_dodo_beak': { widthRatio: 0.56, originY: 0.28 },
	'26_pizza_in_mouth': { widthRatio: 0.62, originY: 0.42 },
};

/** Читает список файлов с сервера и достраивает его посадкой. */
export const loadMaskCatalog = async () => {
	const response = await fetch('/api/masks');

	if (!response.ok) {
		throw new Error('не получилось прочитать каталог масок');
	}

	const files = await response.json();

	return files
		.filter(file => placementByCategory[file.category])
		.map(file => ({ ...file, ...placementByCategory[file.category], ...placementOverrides[file.id] }));
};

export const getMasksByCategory = (masks, category) => masks.filter(mask => mask.category === category);

/** Сортирует выбранные маски так, чтобы шляпа легла поверх очков, а не наоборот. */
export const sortForDrawing = masks =>
	[...masks].sort(
		(first, second) => MASK_DRAW_ORDER.indexOf(first.category) - MASK_DRAW_ORDER.indexOf(second.category),
	);
