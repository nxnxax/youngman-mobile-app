import { API_BASE_URL } from '../../config/env';
import { getAccessToken } from '../auth/session';
import { logError } from '../logger/errorLog';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ServerError {
  status?: 'error';
  code?: string;
  message?: string;
}

async function parseJsonSafe<T>(res: Response): Promise<T | ServerError> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as ServerError;
  }
}

function requireToken(): string {
  const token = getAccessToken();
  if (!token) {
    throw new ApiError('unauthorized', 401, '로그인이 필요합니다.');
  }
  return token;
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = requireToken();
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] GET',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    logError('api', apiError, { path, status: res.status });
    throw apiError;
  }
  return parsed;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = requireToken();
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] POST',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    logError('api', apiError, { path, status: res.status });
    throw apiError;
  }
  return parsed;
}

export async function apiPostMultipart<T>(
  path: string,
  form: FormData,
): Promise<T> {
  const token = requireToken();
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    // Do NOT set Content-Type — fetch must set it with the multipart boundary.
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] POST multipart',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    logError('api', apiError, { path, status: res.status });
    throw apiError;
  }
  return parsed;
}
