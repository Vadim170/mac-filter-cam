/**
 * Рисует маски поверх кадра. Порт features/faceMasks/lib/createFaceMaskPainter.ts.
 */
import { dropLostFaces, readFacePose, updateFaceTracks } from './faceTracks.js';
import { getMaskImage } from './maskImages.js';

export const createFaceMaskPainter = () => {
	let tracks = [];

	const drawMask = (ctx, pose, mask) => {
		const image = getMaskImage(mask.url);

		if (!image) {
			return;
		}

		const sourceWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
		const sourceHeight = 'naturalHeight' in image ? image.naturalHeight : image.height;
		const width = pose.headWidth * mask.widthRatio;
		const height = (width * sourceHeight) / sourceWidth;
		const anchor = pose[mask.anchor];
		// Сдвиг считаем вдоль наклонённой оси лица, иначе маска уезжает вбок при наклоне головы
		const shift = mask.offsetY * pose.faceHeight;

		ctx.save();
		ctx.translate(anchor.x - Math.sin(pose.roll) * shift, anchor.y + Math.cos(pose.roll) * shift);
		ctx.rotate(pose.roll);
		ctx.drawImage(image, -width / 2, -height * mask.originY, width, height);
		ctx.restore();
	};

	/**
	 * Рисует выбранные маски на всех лицах кадра. Маски ожидаются в порядке отрисовки.
	 * `faces === null` — в этом кадре детектор не запускался: рисуем по прошлым позам.
	 */
	const paint = (frame, faces, masks) => {
		tracks = faces
			? updateFaceTracks(tracks, faces.map(landmarks => readFacePose(landmarks, frame)), frame.timeMs)
			: dropLostFaces(tracks, frame.timeMs);

		if (!tracks.length || !masks.length) {
			return;
		}

		// masks приходят уже в порядке отрисовки: сортировать их на каждом кадре незачем
		tracks.forEach(track => masks.forEach(mask => drawMask(frame.ctx, track.pose, mask)));
	};

	const reset = () => {
		tracks = [];
	};

	return { paint, reset };
};
