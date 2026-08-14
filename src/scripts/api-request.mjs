export function serializeJsonRequestBody(body) {
  if (body === undefined || body === null || typeof body === 'string') return body;
  return JSON.stringify(body);
}
