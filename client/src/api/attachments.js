async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export function listAttachments(taskId) {
  return request(`/api/tasks/${taskId}/attachments`);
}

export function uploadAttachment(taskId, file) {
  const formData = new FormData();
  formData.append('file', file);
  return request(`/api/tasks/${taskId}/attachments`, {
    method: 'POST',
    body: formData,
  });
}

export function deleteAttachment(id) {
  return request(`/api/attachments/${id}`, { method: 'DELETE' });
}
