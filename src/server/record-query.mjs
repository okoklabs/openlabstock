export const DEFAULT_RECORD_PAGE_SIZE = 60;
export const MAXIMUM_RECORD_PAGE_SIZE = 100;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function encodeRecordCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : '';
}

export function decodeRecordCursor(value) {
  if (!value) return null;
  if (String(value).length > 500) throw badRequest('记录分页游标无效，请重新打开记录页');
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const occurredAt = String(cursor.occurredAt ?? '');
    const id = String(cursor.id ?? '');
    const sourceOrder = Number(cursor.sourceOrder);
    if (!occurredAt || new Date(occurredAt).toISOString() !== occurredAt || ![1, 2].includes(sourceOrder) || !id || id.length > 200) {
      throw new Error('invalid');
    }
    return { occurredAt, sourceOrder, id };
  } catch {
    throw badRequest('记录分页游标无效，请重新打开记录页');
  }
}

export function recordPageOptions(url, { userId, canViewAll }) {
  const requestedPageSize = Number(url.searchParams.get('pageSize') ?? DEFAULT_RECORD_PAGE_SIZE);
  if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > MAXIMUM_RECORD_PAGE_SIZE) {
    throw badRequest(`每页记录数必须是 1-${MAXIMUM_RECORD_PAGE_SIZE} 的整数`);
  }
  const query = String(url.searchParams.get('q') ?? '').trim();
  if (query.length > 120) throw badRequest('记录搜索内容不能超过 120 个字符');
  const type = String(url.searchParams.get('type') ?? 'all');
  if (!['all', 'in', 'out', 'use', 'inventory_event'].includes(type)) throw badRequest('记录类型筛选无效');
  const scope = String(url.searchParams.get('scope') ?? 'all');
  if (!['all', 'mine'].includes(scope)) throw badRequest('记录范围筛选无效');
  const from = String(url.searchParams.get('from') ?? '');
  if (from) {
    try {
      if (new Date(from).toISOString() !== from) throw new Error('invalid');
    } catch {
      throw badRequest('记录时间范围无效');
    }
  }
  return {
    pageSize: requestedPageSize,
    query,
    type,
    from,
    userId: !canViewAll || scope === 'mine' ? userId : '',
    cursor: decodeRecordCursor(url.searchParams.get('cursor')),
  };
}
