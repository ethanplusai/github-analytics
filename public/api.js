// public/api.js
//
// Typed fetch wrappers around the same-origin JSON API (see src/api.js on
// the server). Every non-2xx response — and every network failure — comes
// out the other end as an `ApiError`, so callers never have to branch on
// `res.ok` themselves.

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch {
    throw new ApiError('Cannot reach the GitHub Analytics server.', { status: 0, code: 'offline' });
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(body?.error?.message || res.statusText, {
      status: res.status,
      code: body?.error?.code,
    });
  }

  return body;
}

function postJson(path, payload) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function getStatus() {
  return request('/api/status');
}

export function getRepos(range, { signal } = {}) {
  const qs = range ? `?range=${encodeURIComponent(range)}` : '';
  return request(`/api/repos${qs}`, { signal });
}

export function getRepo(owner, name, range) {
  const qs = range ? `?range=${encodeURIComponent(range)}` : '';
  return request(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${qs}`);
}

export function addRepo(fullName) {
  return postJson('/api/repos', { full_name: fullName });
}

export function removeRepo(owner, name) {
  return request(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function getAvailableRepos() {
  return request('/api/available-repos');
}

export function triggerPoll() {
  return postJson('/api/poll', {});
}

export function seedRepos() {
  return postJson('/api/seed', {});
}
