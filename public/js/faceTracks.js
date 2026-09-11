/**
 * Слежение за лицами между кадрами.
 *
 * Порт features/faceMasks/lib/faceTracks.ts из kiosk-mobile-photo. Отличие одно:
 * кадр больше не квадрат, поэтому поза читается из прямоугольной области видео.
 */

/** Индексы точек модели face_landmarker. */
const LANDMARK = {
	eyeRight: 33,
	eyeLeft: 263,
	cheekRight: 234,
	cheekLeft: 454,
	forehead: 10,
	chin: 152,
	noseBase: 2,
	lipTop: 13,
	lipBottom: 14,
	lipRight: 61,
	lipLeft: 291,
};

/**
 * Сглаживание подстраивается под скорость лица.
 *
 * Постоянный коэффициент тут не годится: сильный убирает дрожание, но маска висит
 * позади лица, слабый ловит движение, но маска трясётся на неподвижном лице.
 * Поэтому ниже CALM_SPEED считаем лицо неподвижным и сглаживаем сильно, выше
 * FAST_SPEED — не сглаживаем вовсе, маска повторяет замер точь-в-точь.
 * Скорость меряем в ширинах головы в секунду, чтобы порог не зависел от того,
 * далеко человек от камеры или близко.
 */
const CALM_SPEED = 0.15;
const FAST_SPEED = 1.2;
/** Доля нового замера, когда лицо стоит на месте. */
const CALM_SMOOTHING = 0.35;

/** Защита от деления на ноль и от скачка после долгой паузы между кадрами. */
const MIN_FRAME_SECONDS = 0.008;
const MAX_FRAME_SECONDS = 0.25;

/**
 * Считаем, что это то же лицо, если центр глаз сместился меньше чем на столько ширин
 * головы. Порог в долях головы, а не в пикселях: дальнее лицо и двигается по кадру меньше.
 */
const MATCH_RADIUS = 0.9;

/**
 * Сколько ещё держим маску на лице, которое детектор потерял. Один-два промаха подряд —
 * норма, и без этой отсрочки маска мигала бы.
 */
export const FACE_LOST_MS = 400;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const average = points => ({
	x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
	y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});

const lerp = (from, to, amount) => from + (to - from) * amount;

const lerpPoint = (from, to, amount) => ({
	x: lerp(from.x, to.x, amount),
	y: lerp(from.y, to.y, amount),
});

/** Углы сглаживаем по кратчайшей дуге, иначе на переходе через ±π маску кувыркает. */
const lerpAngle = (from, to, amount) => {
	const delta = ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

	return from + delta * amount;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Насколько доверяем свежему замеру: 1 — целиком, то есть маска без запаздывания. */
const smoothingFor = (previous, next, frameSeconds) => {
	const seconds = clamp(frameSeconds, MIN_FRAME_SECONDS, MAX_FRAME_SECONDS);
	const headWidths = distance(previous.eyes, next.eyes) / Math.max(next.headWidth, 1);
	const speed = headWidths / seconds;
	const haste = clamp((speed - CALM_SPEED) / (FAST_SPEED - CALM_SPEED), 0, 1);

	return CALM_SMOOTHING + (1 - CALM_SMOOTHING) * haste;
};

const smoothPose = (previous, next, frameSeconds) => {
	const amount = smoothingFor(previous, next, frameSeconds);

	return {
		eyes: lerpPoint(previous.eyes, next.eyes, amount),
		forehead: lerpPoint(previous.forehead, next.forehead, amount),
		noseBase: lerpPoint(previous.noseBase, next.noseBase, amount),
		mouth: lerpPoint(previous.mouth, next.mouth, amount),
		roll: lerpAngle(previous.roll, next.roll, amount),
		headWidth: lerp(previous.headWidth, next.headWidth, amount),
		faceHeight: lerp(previous.faceHeight, next.faceHeight, amount),
	};
};

/** Переводит точки лица из координат видео в координаты кадра на канвасе. */
export const readFacePose = (landmarks, frame) => {
	// Кроп по центру сохраняет пропорции, поэтому масштаб по обеим осям один и тот же
	const scale = frame.width / frame.sourceWidth;
	const point = index => {
		const landmark = landmarks[index];
		const x = (landmark.x * frame.video.videoWidth - frame.sourceX) * scale;
		const y = (landmark.y * frame.video.videoHeight - frame.sourceY) * scale;

		return { x: frame.isMirrored ? frame.width - x : x, y };
	};
	const eyeRight = point(LANDMARK.eyeRight);
	const eyeLeft = point(LANDMARK.eyeLeft);
	// В зеркальном кадре правый глаз оказывается справа, поэтому ось лица разворачивается
	const axisStart = frame.isMirrored ? eyeLeft : eyeRight;
	const axisEnd = frame.isMirrored ? eyeRight : eyeLeft;
	const forehead = point(LANDMARK.forehead);

	return {
		eyes: average([eyeRight, eyeLeft]),
		forehead,
		noseBase: point(LANDMARK.noseBase),
		mouth: average([
			point(LANDMARK.lipTop),
			point(LANDMARK.lipBottom),
			point(LANDMARK.lipRight),
			point(LANDMARK.lipLeft),
		]),
		roll: Math.atan2(axisEnd.y - axisStart.y, axisEnd.x - axisStart.x),
		headWidth: distance(point(LANDMARK.cheekRight), point(LANDMARK.cheekLeft)),
		faceHeight: distance(forehead, point(LANDMARK.chin)),
	};
};

/** Убирает лица, которые детектор давно не видит. */
export const dropLostFaces = (tracks, timeMs) => tracks.filter(track => timeMs - track.seenAt <= FACE_LOST_MS);

/**
 * Сшивает свежий замер с тем, что уже отслеживаем.
 *
 * Детектор не обещает, что лица придут в том же порядке, что и в прошлом кадре, поэтому
 * порядку доверять нельзя: сопоставляем жадно по близости центра глаз, начиная с самой
 * уверенной пары. Иначе при двух людях в кадре маски перескакивали бы с одного на другого.
 */
export const updateFaceTracks = (tracks, measured, timeMs) => {
	const candidates = [];

	tracks.forEach((track, trackIndex) => {
		measured.forEach((pose, poseIndex) => {
			const gap = distance(track.pose.eyes, pose.eyes);

			if (gap <= pose.headWidth * MATCH_RADIUS) {
				candidates.push({ trackIndex, poseIndex, gap });
			}
		});
	});
	candidates.sort((first, second) => first.gap - second.gap);

	const takenTracks = new Set();
	const takenPoses = new Set();
	const next = [];

	candidates.forEach(({ trackIndex, poseIndex }) => {
		if (takenTracks.has(trackIndex) || takenPoses.has(poseIndex)) {
			return;
		}

		takenTracks.add(trackIndex);
		takenPoses.add(poseIndex);

		const track = tracks[trackIndex];
		const frameSeconds = (timeMs - track.seenAt) / 1000;

		next.push({ pose: smoothPose(track.pose, measured[poseIndex], frameSeconds), seenAt: timeMs });
	});

	// Лица, которых раньше не было
	measured.forEach((pose, poseIndex) => {
		if (!takenPoses.has(poseIndex)) {
			next.push({ pose, seenAt: timeMs });
		}
	});

	// Лица, которые детектор потерял: даём им дожить, чтобы маска не мигала
	tracks.forEach((track, trackIndex) => {
		if (!takenTracks.has(trackIndex) && timeMs - track.seenAt <= FACE_LOST_MS) {
			next.push(track);
		}
	});

	return next;
};
