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

export function getActivity(taskId) {
  return request(`/api/tasks/${taskId}/activity`);
}

export function addComment(taskId, data) {
  return request(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteActivity(activityId) {
  return request(`/api/activity/${activityId}`, { method: 'DELETE' });
}
