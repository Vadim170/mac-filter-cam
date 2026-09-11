/**
 * Бинаризация кадра: grayscale → контраст → Флойд–Стайнберг.
 *
 * Порт shared/lib/photo/createReceiptDitherer.ts из kiosk-mobile-photo. Печатать тут
 * нечего, поэтому от трёх выходов остался один — ImageData для канваса. Всё остальное
 * как в оригинале: таблица контраста, порог по средней яркости кадра, постоянные буферы.
 * Кадр 1280×720 — это 921 600 пикселей, и на каждом кадре новый Float32Array такого
 * размера утащил бы сборщик мусора прямо в середину созвона.
 */

const MIDDLE_LUMINANCE = 128;

const ERROR_RIGHT = 7 / 16;
const ERROR_BOTTOM_LEFT = 3 / 16;
const ERROR_BOTTOM = 5 / 16;
const ERROR_BOTTOM_RIGHT = 1 / 16;

/** Порядок байтов важен: превью пишем одним 32-битным словом вместо четырёх байтов. */
const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const BLACK_PIXEL = isLittleEndian ? 0xff000000 : 0x000000ff;
const WHITE_PIXEL = 0xffffffff;

/** Таблица «яркость → яркость после контраста и осветления»: 256 значений вместо счёта на каждый пиксель. */
const createToneLut = (contrast, brightness) => {
	const lut = new Uint8ClampedArray(256);

	for (let value = 0; value < 256; value++) {
		lut[value] = contrast * (value - MIDDLE_LUMINANCE) + MIDDLE_LUMINANCE + brightness;
	}

	return lut;
};

/**
 * Создаёт дизерер под фиксированный размер кадра. Смена размера — это новый дизерер:
 * буферы под кадр выделяются здесь один раз.
 */
export const createDitherer = (width, height) => {
	const totalPixels = width * height;
	// Паддинг слева, справа и снизу: во внутреннем цикле не нужны проверки границ
	const stride = width + 2;
	const errors = new Float32Array(stride * (height + 1));
	const previewData = new Uint8ClampedArray(totalPixels * 4);
	const preview = new ImageData(previewData, width, height);
	const previewWords = new Uint32Array(previewData.buffer);

	let contrast = null;
	let brightness = null;
	let lut = null;

	/**
	 * @param {ImageData} frame — кадр с уже нарисованными масками
	 * @param {{ contrast: number, brightness: number }} options
	 * @returns {ImageData} чёрно-белый кадр; буфер переиспользуется до следующего вызова
	 */
	const run = (frame, options) => {
		if (contrast !== options.contrast || brightness !== options.brightness) {
			contrast = options.contrast;
			brightness = options.brightness;
			lut = createToneLut(contrast, brightness);
		}

		const source = frame.data;
		let luminanceSum = 0;

		// Проход 1: яркость с контрастом в буфер ошибки, попутно сумма для порога
		for (let y = 0; y < height; y++) {
			const rowStart = y * stride;
			let sourceIndex = y * width * 4;

			errors[rowStart] = 0;
			errors[rowStart + width + 1] = 0;

			for (let x = 0; x < width; x++) {
				const gray =
					(77 * source[sourceIndex] + 150 * source[sourceIndex + 1] + 29 * source[sourceIndex + 2] + 128) >>
					8;
				const value = lut[gray];

				errors[rowStart + x + 1] = value;
				luminanceSum += value;
				sourceIndex += 4;
			}
		}
		errors.fill(0, height * stride);

		// Порог — средняя яркость кадра: фильтр сам подстраивается под свет в комнате.
		//
		// Сдвигать этот порог настройкой бессмысленно: у Флойда–Стайнберга ошибка
		// растекается по соседям, и доля чёрных точек в итоге повторяет среднюю яркость
		// кадра, а не порог. Поэтому светлее и темнее картинку делает brightness выше
		// по таблице — она двигает саму яркость, и плотность точек идёт за ней.
		const threshold = luminanceSum / totalPixels;

		// Проход 2: Флойд–Стайнберг сразу в пиксели превью
		for (let y = 0; y < height; y++) {
			const rowStart = y * stride;
			const nextRowStart = rowStart + stride;
			let pixelIndex = y * width;

			for (let x = 0; x < width; x++) {
				const errorIndex = rowStart + x + 1;
				const oldValue = errors[errorIndex];
				const isBlack = oldValue < threshold;
				const error = isBlack ? oldValue : oldValue - 255;

				previewWords[pixelIndex] = isBlack ? BLACK_PIXEL : WHITE_PIXEL;

				errors[errorIndex + 1] += error * ERROR_RIGHT;
				errors[nextRowStart + x] += error * ERROR_BOTTOM_LEFT;
				errors[nextRowStart + x + 1] += error * ERROR_BOTTOM;
				errors[nextRowStart + x + 2] += error * ERROR_BOTTOM_RIGHT;

				pixelIndex++;
			}
		}

		return preview;
	};

	return { width, height, run };
};
