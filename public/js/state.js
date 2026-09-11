/**
 * Общее состояние панели и источника в OBS.
 *
 * У OBS свой профиль CEF, поэтому localStorage и BroadcastChannel между ним и браузером
 * не работают: единственная общая точка — наш сервер. Патчи уходят POST-ом, обратно
 * всё прилетает по SSE.
 */

const CLIENT_ID = crypto.randomUUID();

export const createSharedState = ({ role, onChange, onRoles }) => {
	let state = null;

	const source = new EventSource(`/api/events?role=${encodeURIComponent(role)}`);

	source.addEventListener('state', event => {
		const payload = JSON.parse(event.data);

		// Свой же патч прилетает обратно рассылкой, а он уже применён — иначе ползунок
		// дёргался бы назад на каждый чужой кадр сети
		if (payload.from === CLIENT_ID) {
			return;
		}

		state = payload.state;
		onChange(state);
	});

	source.addEventListener('roles', event => onRoles?.(JSON.parse(event.data)));

	/** Применяем сразу, на сервер отправляем следом: интерфейс не должен ждать сеть. */
	const patch = partial => {
		state = { ...state, ...partial };
		onChange(state);

		void fetch('/api/state', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
			body: JSON.stringify(partial),
		}).catch(() => {
			// Сервер перезапускают во время правок — следующий патч догонит состояние
		});
	};

	return {
		patch,
		get current() {
			return state;
		},
	};
};
