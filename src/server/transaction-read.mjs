import { encodeRecordCursor, recordPageOptions } from './record-query.mjs';

function response(statusCode, body) {
  return { statusCode, body };
}

export function readTransactionsResponse({
  url,
  session,
  view,
  canViewAllTransactions,
  formatExportSnapshot,
}) {
  if (url.searchParams.get('mode') === 'export') {
    const { store, exportedAt } = view.readStoreSnapshot();
    const user = store.users.find((candidate) => candidate.id === session.userId && candidate.active);
    if (!user) return response(401, { error: '账号已停用' });
    return response(200, formatExportSnapshot(store, user, exportedAt));
  }

  const user = view.readActiveUser(session.userId);
  if (!user) return response(401, { error: '账号已停用' });

  if (url.searchParams.get('mode') === 'page') {
    const page = view.queryRecordPage(recordPageOptions(url, {
      userId: user.id,
      canViewAll: canViewAllTransactions(user),
    }));
    return response(200, {
      items: page.items,
      total: page.total,
      hasMore: page.hasMore,
      nextCursor: encodeRecordCursor(page.nextCursor),
    });
  }

  const query = canViewAllTransactions(user) ? {} : { userId: user.id };
  const transactions = view.queryTransactions(query);
  const body = { transactions, total: transactions.length };
  if (url.searchParams.get('includeInventoryEvents') === '1') {
    body.inventoryEvents = view.queryInventoryEvents(query);
    body.eventTotal = body.inventoryEvents.length;
  }
  return response(200, body);
}
