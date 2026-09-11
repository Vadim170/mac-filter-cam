import { getMasksByCategory } from './maskCatalog.js';

/**
 * Три барабана рулетки: очки, головные уборы, усы вперемешку со ртами.
 * null — грань «без маски», чтобы категорию можно было отключить.
 */
export const buildMaskReels = masks => [
	{ id: 'glasses', label: 'Очки', items: [null, ...getMasksByCategory(masks, 'glasses')] },
	{ id: 'headwear', label: 'Головные уборы', items: [null, ...getMasksByCategory(masks, 'headwear')] },
	{
		id: 'extra',
		label: 'Усы и рты',
		items: [null, ...getMasksByCategory(masks, 'mustaches'), ...getMasksByCategory(masks, 'mouths')],
	},
];

/** Маски, на которых барабаны стоят сейчас. Позиция сквозная, поэтому берём по модулю. */
export const masksAtPositions = (reels, positions) =>
	reels
		.map((reel, index) => reel.items[((positions[index] ?? 0) % reel.items.length + reel.items.length) % reel.items.length])
		.filter(mask => mask !== null && mask !== undefined);
