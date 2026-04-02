const BASE = '/api/tasks';

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

export function listTasks(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`${BASE}${query ? `?${query}` : ''}`);
}

export function getTask(id) {
  return request(`${BASE}/${id}`);
}

export function createTask(data) {
  return request(BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function updateTask(id, data) {
  return request(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function patchTask(id, data) {
  return request(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteTask(id) {
  return request(`${BASE}/${id}`, { method: 'DELETE' });
}

export function claimTask(id, data) {
  return request(`${BASE}/${id}/claim`, { method: 'POST', body: JSON.stringify(data) });
}

export function claimNextTask(data) {
  return request(`${BASE}/claim-next`, { method: 'POST', body: JSON.stringify(data) });
}

export function releaseTask(id) {
  return request(`${BASE}/${id}/release`, { method: 'POST' });
}

export function completeTask(id, data) {
  return request(`${BASE}/${id}/complete`, { method: 'POST', body: JSON.stringify(data) });
}

export function archiveTask(id) {
  return request(`${BASE}/${id}/archive`, { method: 'POST' });
}

export function unarchiveTask(id) {
  return request(`${BASE}/${id}/unarchive`, { method: 'POST' });
}

export function archiveDoneTasks(data) {
  return request(`${BASE}/archive-done`, { method: 'POST', body: JSON.stringify(data) });
}

export function getTaskStats(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`${BASE}/stats${query ? `?${query}` : ''}`);
}

export function spawnTask(id, data) {
  return request(`${BASE}/${id}/spawn`, { method: 'POST', body: JSON.stringify(data) });
}

export function getAgentProcess(id) {
  return request(`${BASE}/${id}/agent-process`);
}

export function deleteAgentProcess(id) {
  return request(`${BASE}/${id}/agent-process`, { method: 'DELETE' });
}

export function getHandoff(id) {
  return request(`${BASE}/${id}/handoff`);
}

export function createHandoff(id, data) {
  return request(`${BASE}/${id}/handoff`, { method: 'POST', body: JSON.stringify(data) });
}

export function createTaskLog(id, data) {
  return request(`${BASE}/${id}/logs`, { method: 'POST', body: JSON.stringify(data) });
}

export function getTaskLogs(id) {
  return request(`${BASE}/${id}/logs`);
}
