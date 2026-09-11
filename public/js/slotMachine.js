/**
 * Рулетка масок: три барабана и рычаг. Порт MaskSlotMachine.tsx без React и без звука.
 *
 * Барабан — настоящий цилиндр на CSS-трансформах, а не список: грани разложены по кругу
 * и повёрнуты вместе с ним, поэтому прокрутка выглядит как автомат, а не как карусель.
 */

/** Сколько граней барабан гарантированно прокрутит от рычага. */
const MIN_SPIN_FACES = 8;
const SPIN_DURATION_MS = 900;
/** Барабаны останавливаются по очереди, как в настоящем автомате. */
const SPIN_STAGGER_MS = 280;
const TAP_DURATION_MS = 320;

/** Высота грани: по ней же считается радиус цилиндра, чтобы грани встали встык. */
const FACE_HEIGHT = 62;

const createElement = (tag, className, parent) => {
	const element = document.createElement(tag);

	element.className = className;
	parent?.appendChild(element);

	return element;
};

/**
 * @param {{ container: HTMLElement, reels: object[], positions: number[],
 *           onSettle: (positions: number[]) => void }} params
 */
export const createSlotMachine = ({ container, reels, positions, onSettle }) => {
	const current = [...positions];
	const settled = [...positions];
	const drums = [];

	container.innerHTML = '';

	const reelsBox = createElement('div', 'slot__reels', container);

	const render = (index, duration) => {
		const drum = drums[index];
		const stepDeg = 360 / reels[index].items.length;

		drum.style.setProperty('--duration', `${duration}ms`);
		drum.style.setProperty('--angle', `${current[index] * stepDeg}deg`);
	};

	const reportSettled = index => {
		settled[index] = current[index];
		onSettle([...settled]);
	};

	reels.forEach((reel, index) => {
		const faceCount = reel.items.length;
		const stepDeg = 360 / faceCount;
		// Радиус цилиндра, при котором грани встают встык. Единственная грань — это
		// пустой каталог: цилиндра нет, плоской грани хватит
		const radiusPx = faceCount > 1 ? FACE_HEIGHT / 2 / Math.tan(Math.PI / faceCount) : 0;

		const reelButton = createElement('button', 'reel', reelsBox);

		reelButton.type = 'button';
		reelButton.title = `${reel.label}: следующая`;
		reelButton.setAttribute('aria-label', `${reel.label}: следующая маска`);
		reelButton.style.setProperty('--radius', `${radiusPx}px`);

		const drum = createElement('div', 'drum', reelButton);

		drums[index] = drum;

		reel.items.forEach((item, itemIndex) => {
			const face = createElement('div', 'face', drum);

			face.style.setProperty('--face-angle', `${itemIndex * stepDeg}deg`);

			if (item) {
				const image = createElement('img', 'face__image', face);

				image.src = item.url;
				image.alt = '';
				image.loading = 'eager';
			} else {
				createElement('span', 'face__empty', face).textContent = '—';
			}
		});

		// Три барабана — три перехода, и каждый заканчивается в своё время: это и есть
		// поочерёдная остановка. Маски пересобираем на каждой остановке.
		drum.addEventListener('transitionend', () => reportSettled(index));

		reelButton.addEventListener('click', () => {
			current[index] += 1;
			render(index, TAP_DURATION_MS);
		});

		render(index, 0);
	});

	const lever = createElement('button', 'lever', container);

	lever.type = 'button';
	lever.title = 'Крутить барабаны (пробел)';
	lever.setAttribute('aria-label', 'Крутить барабаны');
	createElement('div', 'lever__base', lever);
	createElement('div', 'lever__knob', createElement('div', 'lever__arm', lever));

	const spinAll = () => {
		reels.forEach((reel, index) => {
			current[index] += MIN_SPIN_FACES + Math.floor(Math.random() * reel.items.length);
			render(index, SPIN_DURATION_MS + index * SPIN_STAGGER_MS);
		});
	};

	const releaseLever = () => lever.removeAttribute('data-pulled');

	lever.addEventListener('pointerdown', event => {
		lever.setPointerCapture(event.pointerId);
		lever.dataset.pulled = 'true';
		spinAll();
	});
	lever.addEventListener('pointerup', releaseLever);
	lever.addEventListener('pointercancel', releaseLever);

	/** Ставит барабаны в заданные позиции без анимации: так приезжают чужие изменения. */
	const jumpTo = next => {
		next.forEach((position, index) => {
			if (current[index] === position) {
				return;
			}

			current[index] = position;
			settled[index] = position;
			render(index, 0);
		});
	};

	const reset = () => {
		reels.forEach((reel, index) => {
			// Идём вперёд до ближайшей пустой грани, чтобы барабан не откручивало назад
			const faceCount = reel.items.length;

			current[index] += (faceCount - (current[index] % faceCount)) % faceCount;
			render(index, TAP_DURATION_MS);
		});
	};

	return {
		spinAll,
		jumpTo,
		reset,
		/** Позиции, на которых барабаны уже остановились: по ним сверяют чужие изменения. */
		get settledPositions() {
			return [...settled];
		},
	};
};
