const BASE = '/api/templates';

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

export function listTemplates() {
  return request(BASE);
}

export function createTemplate(data) {
  return request(BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function updateTemplate(id, data) {
  return request(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTemplate(id) {
  return request(`${BASE}/${id}`, { method: 'DELETE' });
}
