const BASE = '/api/notifications';

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export function listNotifications(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`${BASE}${query ? `?${query}` : ''}`);
}

export function markNotificationsRead() {
  return request(`${BASE}/read`, { method: 'POST' });
}

export function deleteNotification(id) {
  return request(`${BASE}/${id}`, { method: 'DELETE' });
}
