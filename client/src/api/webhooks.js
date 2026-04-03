const BASE = '/api/webhooks';

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

export function listWebhooks() {
  return request(BASE);
}

export function getWebhook(id) {
  return request(`${BASE}/${id}`);
}

export function createWebhook(data) {
  return request(BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function deleteWebhook(id) {
  return request(`${BASE}/${id}`, { method: 'DELETE' });
}

export function rotateWebhookSecret(id) {
  return request(`${BASE}/${id}/rotate-secret`, { method: 'POST' });
}
