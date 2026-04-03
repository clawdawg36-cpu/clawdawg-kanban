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

export function listDependencies(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/dependencies${query ? `?${query}` : ''}`);
}

export function getBlockers(taskId) {
  return request(`/api/tasks/${taskId}/blockers`);
}

export function addBlocker(taskId, data) {
  return request(`/api/tasks/${taskId}/blockers`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function removeBlocker(taskId, blockerId) {
  return request(`/api/tasks/${taskId}/blockers/${blockerId}`, {
    method: 'DELETE',
  });
}
