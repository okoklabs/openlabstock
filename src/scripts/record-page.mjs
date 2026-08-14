import { DEFAULT_RECORD_PAGE_SIZE } from './record-pagination.mjs';

export { DEFAULT_RECORD_PAGE_SIZE };

export function recordRangeStart(range, now = new Date()) {
  if (range === 'all') return '';
  const current = new Date(now);
  const start = new Date(current);
  if (range === '30' || range === '90') start.setDate(current.getDate() - Number(range));
  if (range === 'year') {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  return start.toISOString();
}

export function buildRecordPageUrl({
  cursor = '',
  pageSize = DEFAULT_RECORD_PAGE_SIZE,
  type = 'all',
  scope = 'all',
  query = '',
  from = '',
} = {}) {
  const parameters = new URLSearchParams({
    mode: 'page',
    pageSize: String(pageSize),
    type,
    scope,
  });
  if (query) parameters.set('q', query);
  if (from) parameters.set('from', from);
  if (cursor) parameters.set('cursor', cursor);
  return `/api/transactions?${parameters}`;
}

export function createRecordPageState({ pageSize = DEFAULT_RECORD_PAGE_SIZE, scope = 'all' } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const state = {
    pageSize,
    items: [],
    total: 0,
    hasMore: false,
    nextCursor: '',
    cursorHistory: [''],
    from: '',
    page: 1,
    scope,
    reset({ from = '', scope: nextScope = state.scope } = {}) {
      state.items = [];
      state.total = 0;
      state.hasMore = false;
      state.nextCursor = '';
      state.cursorHistory = [''];
      state.from = from;
      state.page = 1;
      state.scope = nextScope;
    },
    setScope(nextScope) {
      if (!['all', 'mine'].includes(nextScope)) throw new RangeError('scope must be all or mine');
      state.scope = nextScope;
    },
    applyResult(result) {
      state.items = result.items;
      state.total = result.total;
      state.hasMore = result.hasMore;
      state.nextCursor = result.nextCursor;
    },
    currentCursor() {
      return state.cursorHistory[state.page - 1] ?? '';
    },
    previous() {
      if (state.page <= 1) return false;
      state.page -= 1;
      return true;
    },
    next() {
      if (!state.hasMore || !state.nextCursor) return false;
      state.cursorHistory[state.page] = state.nextCursor;
      state.page += 1;
      return true;
    },
    summary() {
      const from = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
      const to = state.total ? from + state.items.length - 1 : 0;
      return {
        from,
        to,
        totalPages: Math.max(1, Math.ceil(state.total / state.pageSize)),
      };
    },
  };
  return state;
}
