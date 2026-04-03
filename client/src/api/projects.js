const BASE = '/api/projects';

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

export function listProjects() {
  return request(BASE);
}

export function getProject(id) {
  return request(`${BASE}/${id}`);
}

export function createProject(data) {
  return request(BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function updateProject(id, data) {
  return request(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteProject(id) {
  return request(`${BASE}/${id}`, { method: 'DELETE' });
}

export function exportProject(id) {
  return request(`${BASE}/${id}/export`);
}

export function importProject(id, data) {
  return request(`${BASE}/${id}/import`, { method: 'POST', body: JSON.stringify(data) });
}

export function getProjectHandoffs(id) {
  return request(`${BASE}/${id}/handoffs`);
}

export function getProjectTimeline(id) {
  return request(`${BASE}/${id}/timeline`);
}
