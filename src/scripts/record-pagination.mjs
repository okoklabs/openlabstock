export const DEFAULT_RECORD_PAGE_SIZE = 60;

export function paginateRecords(records, requestedPage, pageSize = DEFAULT_RECORD_PAGE_SIZE) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer');
  }

  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const numericPage = Number(requestedPage);
  const page = Math.min(
    totalPages,
    Math.max(1, Number.isFinite(numericPage) ? Math.trunc(numericPage) : 1),
  );
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(total, startIndex + pageSize);

  return {
    records: records.slice(startIndex, endIndex),
    page,
    pageSize,
    total,
    totalPages,
    from: total ? startIndex + 1 : 0,
    to: endIndex,
  };
}
