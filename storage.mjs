import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATABASE_FILE = 'labstock.sqlite';
const LEGACY_FILE = 'store.json';
export const CURRENT_SCHEMA_VERSION = 16;
const REQUIRED_TABLES = ['metadata', 'settings', 'groups', 'users', 'materials', 'transactions', 'sessions'];
const ENHANCED_INVENTORY_TABLES = ['inventory_statuses', 'inventory_units', 'inventory_unit_balances', 'inventory_events'];

const quoteSqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

function configure(database, busyTimeoutMs) {
  database.exec(`
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
  `);
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      app_name TEXT NOT NULL,
      lab_name TEXT NOT NULL,
      brand_icon TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      is_default INTEGER NOT NULL CHECK (is_default IN (0, 1))
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS one_default_group
      ON groups(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('admin', 'inventory', 'member')),
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      last_login_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      category TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity >= 0),
      safety_stock REAL NOT NULL CHECK (safety_stock >= 0),
      unit TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      expiry_warning_days INTEGER NOT NULL DEFAULT 30 CHECK (expiry_warning_days >= 0),
      tracking_mode TEXT NOT NULL DEFAULT 'quantity' CHECK (tracking_mode IN ('quantity', 'stateful', 'tracked')),
      position_code_help TEXT NOT NULL DEFAULT '',
      usage_context_help TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS inventory_statuses (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      usable INTEGER NOT NULL CHECK (usable IN (0, 1)),
      terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(material_id, code),
      UNIQUE(material_id, name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS inventory_units (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      unit_type TEXT NOT NULL CHECK (unit_type IN ('aggregate', 'lot', 'container', 'position')),
      label TEXT NOT NULL DEFAULT '',
      position_code TEXT NOT NULL DEFAULT '',
      capacity REAL NOT NULL DEFAULT 0 CHECK (capacity >= 0),
      expiry_date TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(material_id, label, position_code)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS inventory_unit_balances (
      inventory_unit_id TEXT NOT NULL REFERENCES inventory_units(id) ON DELETE CASCADE,
      status_id TEXT NOT NULL REFERENCES inventory_statuses(id) ON DELETE RESTRICT,
      access_scope TEXT NOT NULL CHECK (access_scope IN ('shared', 'user')),
      owner_user_id TEXT NOT NULL DEFAULT '',
      position_code TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (inventory_unit_id, status_id, access_scope, owner_user_id, position_code),
      CHECK ((access_scope = 'shared' AND owner_user_id = '') OR (access_scope = 'user' AND owner_user_id <> ''))
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS inventory_events (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      material_name TEXT NOT NULL,
      inventory_unit_id TEXT NOT NULL,
      inventory_unit_label TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL CHECK (quantity > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('use', 'use_correction', 'state_change', 'access_change', 'transfer', 'dispose', 'adjustment')),
      from_status_id TEXT NOT NULL DEFAULT '',
      from_status_name TEXT NOT NULL DEFAULT '',
      to_status_id TEXT NOT NULL DEFAULT '',
      to_status_name TEXT NOT NULL DEFAULT '',
      from_access_scope TEXT NOT NULL DEFAULT '',
      from_owner_user_id TEXT NOT NULL DEFAULT '',
      from_owner_name TEXT NOT NULL DEFAULT '',
      from_position_code TEXT NOT NULL DEFAULT '',
      to_access_scope TEXT NOT NULL DEFAULT '',
      to_owner_user_id TEXT NOT NULL DEFAULT '',
      to_owner_name TEXT NOT NULL DEFAULT '',
      to_position_code TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      group_id TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      counterparty TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      correction_of_id TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('in', 'out')),
      material_id TEXT NOT NULL,
      material_name TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      group_id TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'inventory_adjustment')),
      counterparty TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'stock' CHECK (operation IN ('stock', 'dispose')),
      inventory_unit_id TEXT NOT NULL DEFAULT '',
      inventory_unit_label TEXT NOT NULL DEFAULT '',
      status_id TEXT NOT NULL DEFAULT '',
      status_name TEXT NOT NULL DEFAULT '',
      access_scope TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT NOT NULL DEFAULT '',
      owner_name TEXT NOT NULL DEFAULT '',
      position_code TEXT NOT NULL DEFAULT '',
      correction_of_id TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE INDEX IF NOT EXISTS transactions_occurred_at
      ON transactions(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS transactions_material_id
      ON transactions(material_id);
    CREATE INDEX IF NOT EXISTS transactions_user_id
      ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS inventory_statuses_material_id
      ON inventory_statuses(material_id, sort_order, name);
    CREATE INDEX IF NOT EXISTS inventory_units_material_id
      ON inventory_units(material_id, active, label, position_code);
    CREATE INDEX IF NOT EXISTS inventory_unit_balances_status_id
      ON inventory_unit_balances(status_id);
    CREATE INDEX IF NOT EXISTS inventory_events_occurred_at
      ON inventory_events(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS inventory_events_material_id
      ON inventory_events(material_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'admin', 'inventory', 'member', 'system')),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS audit_logs_occurred_at
      ON audit_logs(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_actor
      ON audit_logs(actor_user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_target
      ON audit_logs(target_type, target_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS stocktakes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_by_user_id TEXT NOT NULL DEFAULT '',
      completed_by_name TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      cancelled_by_user_id TEXT NOT NULL DEFAULT '',
      cancelled_by_name TEXT NOT NULL DEFAULT '',
      cancelled_at TEXT NOT NULL DEFAULT '',
      cancellation_reason TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE TABLE IF NOT EXISTS stocktake_items (
      id TEXT PRIMARY KEY,
      stocktake_id TEXT NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('material', 'inventory_unit')),
      material_id TEXT NOT NULL,
      material_name TEXT NOT NULL,
      material_unit TEXT NOT NULL,
      tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('quantity', 'stateful', 'tracked')),
      inventory_unit_id TEXT NOT NULL DEFAULT '',
      inventory_unit_label TEXT NOT NULL DEFAULT '',
      expected_quantity REAL NOT NULL CHECK (expected_quantity >= 0),
      counted_quantity REAL CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
      reason TEXT NOT NULL DEFAULT '',
      resolution_note TEXT NOT NULL DEFAULT '',
      counted_by_user_id TEXT NOT NULL DEFAULT '',
      counted_by_name TEXT NOT NULL DEFAULT '',
      counted_at TEXT NOT NULL DEFAULT '',
      adjustment_transaction_id TEXT NOT NULL DEFAULT '',
      resolved_at TEXT NOT NULL DEFAULT '',
      UNIQUE(stocktake_id, scope_type, material_id, inventory_unit_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS stocktakes_created_at
      ON stocktakes(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS stocktake_items_stocktake
      ON stocktake_items(stocktake_id, material_name, inventory_unit_label);
    CREATE TABLE IF NOT EXISTS user_tags (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, tag_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS user_tags_tag_id ON user_tags(tag_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  `);
}

function migrateSchema(database) {
  const previousSchemaVersion = Number(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value ?? 0);
  const usersSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql ?? '';
  if (!usersSql.includes("'inventory'")) {
    database.exec(`
      CREATE TABLE users_v2 (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'inventory', 'member')),
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        last_login_at TEXT
      ) STRICT;

      INSERT INTO users_v2 (id, username, name, role, group_id, active, salt, password_hash, last_login_at)
        SELECT id, username, name, role, group_id, active, salt, password_hash, last_login_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
    `);
  }
  const userColumns = database.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'note')) {
    database.exec("ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }
  const materialColumns = database.prepare('PRAGMA table_info(materials)').all();
  if (!materialColumns.some((column) => column.name === 'tracking_mode')) {
    database.exec("ALTER TABLE materials ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'quantity' CHECK (tracking_mode IN ('quantity', 'stateful', 'tracked'))");
  }
  if (!materialColumns.some((column) => column.name === 'active')) {
    database.exec('ALTER TABLE materials ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))');
  }
  if (!materialColumns.some((column) => column.name === 'position_code_help')) {
    database.exec("ALTER TABLE materials ADD COLUMN position_code_help TEXT NOT NULL DEFAULT ''");
  }
  if (!materialColumns.some((column) => column.name === 'usage_context_help')) {
    database.exec("ALTER TABLE materials ADD COLUMN usage_context_help TEXT NOT NULL DEFAULT ''");
  }
  if (!materialColumns.some((column) => column.name === 'expiry_warning_days')) {
    database.exec("ALTER TABLE materials ADD COLUMN expiry_warning_days INTEGER NOT NULL DEFAULT 30 CHECK (expiry_warning_days >= 0)");
  }
  database.exec('UPDATE materials SET expiry_warning_days = 30 WHERE expiry_warning_days IS NULL OR expiry_warning_days < 0');
  const inventoryUnitColumns = database.prepare('PRAGMA table_info(inventory_units)').all();
  if (inventoryUnitColumns.length && !inventoryUnitColumns.some((column) => column.name === 'expiry_date')) {
    database.exec("ALTER TABLE inventory_units ADD COLUMN expiry_date TEXT NOT NULL DEFAULT ''");
  }
  database.exec('CREATE INDEX IF NOT EXISTS inventory_units_expiry_date ON inventory_units(expiry_date, active)');
  const balanceColumns = database.prepare('PRAGMA table_info(inventory_unit_balances)').all();
  if (balanceColumns.length && !balanceColumns.some((column) => column.name === 'position_code')) {
    database.exec(`
      CREATE TABLE inventory_unit_balances_v2 (
        inventory_unit_id TEXT NOT NULL REFERENCES inventory_units(id) ON DELETE CASCADE,
        status_id TEXT NOT NULL REFERENCES inventory_statuses(id) ON DELETE RESTRICT,
        access_scope TEXT NOT NULL CHECK (access_scope IN ('shared', 'user')),
        owner_user_id TEXT NOT NULL DEFAULT '',
        position_code TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL CHECK (quantity > 0),
        PRIMARY KEY (inventory_unit_id, status_id, access_scope, owner_user_id, position_code),
        CHECK ((access_scope = 'shared' AND owner_user_id = '') OR (access_scope = 'user' AND owner_user_id <> ''))
      ) STRICT, WITHOUT ROWID;
      INSERT INTO inventory_unit_balances_v2 (inventory_unit_id, status_id, access_scope, owner_user_id, position_code, quantity)
        SELECT inventory_unit_id, status_id, access_scope, owner_user_id, '', quantity FROM inventory_unit_balances;
      DROP TABLE inventory_unit_balances;
      ALTER TABLE inventory_unit_balances_v2 RENAME TO inventory_unit_balances;
      CREATE INDEX inventory_unit_balances_status_id ON inventory_unit_balances(status_id);
    `);
  }
  const inventoryEventColumns = database.prepare('PRAGMA table_info(inventory_events)').all();
  const inventoryEventsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_events'").get()?.sql ?? '';
  const inventoryEventsNeedRebuild = inventoryEventColumns.length && (
    !inventoryEventsSql.includes("'use'")
    || !inventoryEventColumns.some((column) => column.name === 'from_position_code')
    || !inventoryEventColumns.some((column) => column.name === 'to_position_code')
    || !inventoryEventColumns.some((column) => column.name === 'counterparty')
    || !inventoryEventColumns.some((column) => column.name === 'correction_of_id')
  );
  if (inventoryEventsNeedRebuild) {
    const existingColumns = new Set(inventoryEventColumns.map((column) => column.name));
    const source = (columnName) => existingColumns.has(columnName) ? columnName : "''";
    database.exec(`
      CREATE TABLE inventory_events_v9 (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        material_name TEXT NOT NULL,
        inventory_unit_id TEXT NOT NULL,
        inventory_unit_label TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL CHECK (quantity > 0),
        event_type TEXT NOT NULL CHECK (event_type IN ('use', 'use_correction', 'state_change', 'access_change', 'transfer', 'dispose', 'adjustment')),
        from_status_id TEXT NOT NULL DEFAULT '',
        from_status_name TEXT NOT NULL DEFAULT '',
        to_status_id TEXT NOT NULL DEFAULT '',
        to_status_name TEXT NOT NULL DEFAULT '',
        from_access_scope TEXT NOT NULL DEFAULT '',
        from_owner_user_id TEXT NOT NULL DEFAULT '',
        from_owner_name TEXT NOT NULL DEFAULT '',
        from_position_code TEXT NOT NULL DEFAULT '',
        to_access_scope TEXT NOT NULL DEFAULT '',
        to_owner_user_id TEXT NOT NULL DEFAULT '',
        to_owner_name TEXT NOT NULL DEFAULT '',
        to_position_code TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        counterparty TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        correction_of_id TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO inventory_events_v9 (
        id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
        from_status_id, from_status_name, to_status_id, to_status_name,
        from_access_scope, from_owner_user_id, from_owner_name, from_position_code,
        to_access_scope, to_owner_user_id, to_owner_name, to_position_code,
        user_id, user_name, group_id, group_name, counterparty, note, correction_of_id, occurred_at
      )
      SELECT
        id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
        from_status_id, from_status_name, to_status_id, to_status_name,
        from_access_scope, from_owner_user_id, from_owner_name, ${source('from_position_code')},
        to_access_scope, to_owner_user_id, to_owner_name, ${source('to_position_code')},
        user_id, user_name, group_id, group_name, ${source('counterparty')}, note, ${source('correction_of_id')}, occurred_at
      FROM inventory_events;
      DROP TABLE inventory_events;
      ALTER TABLE inventory_events_v9 RENAME TO inventory_events;
    `);
  }
  if (previousSchemaVersion < 11) {
    database.exec(`
      DROP INDEX IF EXISTS inventory_events_occurred_at;
      CREATE INDEX inventory_events_occurred_at ON inventory_events(occurred_at DESC, id DESC);
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS inventory_events_occurred_at ON inventory_events(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS inventory_events_material_id ON inventory_events(material_id, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_events_one_correction
      ON inventory_events(correction_of_id)
      WHERE correction_of_id <> '';
  `);
  const transactionColumns = database.prepare('PRAGMA table_info(transactions)').all();
  if (!transactionColumns.some((column) => column.name === 'group_id')) {
    database.exec("ALTER TABLE transactions ADD COLUMN group_id TEXT NOT NULL DEFAULT ''");
  }
  if (!transactionColumns.some((column) => column.name === 'group_name')) {
    database.exec("ALTER TABLE transactions ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
  }
  if (!transactionColumns.some((column) => column.name === 'source_type')) {
    database.exec("ALTER TABLE transactions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'inventory_adjustment'))");
  }
  const transactionColumnMigrations = [
    ["operation", "ALTER TABLE transactions ADD COLUMN operation TEXT NOT NULL DEFAULT 'stock' CHECK (operation IN ('stock', 'dispose'))"],
    ['inventory_unit_id', "ALTER TABLE transactions ADD COLUMN inventory_unit_id TEXT NOT NULL DEFAULT ''"],
    ['inventory_unit_label', "ALTER TABLE transactions ADD COLUMN inventory_unit_label TEXT NOT NULL DEFAULT ''"],
    ['status_id', "ALTER TABLE transactions ADD COLUMN status_id TEXT NOT NULL DEFAULT ''"],
    ['status_name', "ALTER TABLE transactions ADD COLUMN status_name TEXT NOT NULL DEFAULT ''"],
    ['access_scope', "ALTER TABLE transactions ADD COLUMN access_scope TEXT NOT NULL DEFAULT ''"],
    ['owner_user_id', "ALTER TABLE transactions ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''"],
    ['owner_name', "ALTER TABLE transactions ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''"],
    ['position_code', "ALTER TABLE transactions ADD COLUMN position_code TEXT NOT NULL DEFAULT ''"],
    ['correction_of_id', "ALTER TABLE transactions ADD COLUMN correction_of_id TEXT NOT NULL DEFAULT ''"],
  ];
  const refreshedTransactionColumns = database.prepare('PRAGMA table_info(transactions)').all();
  for (const [columnName, sql] of transactionColumnMigrations) {
    if (!refreshedTransactionColumns.some((column) => column.name === columnName)) database.exec(sql);
  }
  if (previousSchemaVersion < 11) {
    database.exec(`
      DROP INDEX IF EXISTS transactions_occurred_at;
      CREATE INDEX transactions_occurred_at ON transactions(occurred_at DESC, id DESC);
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS transactions_occurred_at ON transactions(occurred_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_correction
      ON transactions(correction_of_id)
      WHERE correction_of_id <> '';
  `);
  database.exec(`
    UPDATE transactions
    SET group_id = COALESCE((SELECT users.group_id FROM users WHERE users.id = transactions.user_id), '')
    WHERE group_id = '';
    UPDATE transactions
    SET group_name = COALESCE((
      SELECT groups.name
      FROM users JOIN groups ON groups.id = users.group_id
      WHERE users.id = transactions.user_id
    ), '')
    WHERE group_name = '';
    UPDATE transactions
    SET source_type = 'inventory_adjustment'
    WHERE counterparty = 'Excel 批量导入';
  `);
  if (previousSchemaVersion < 12) {
    database.prepare("UPDATE settings SET app_name = 'OpenLabStock' WHERE app_name = 'SYSULab'").run();
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'admin', 'inventory', 'member', 'system')),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_logs_occurred_at ON audit_logs(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_actor ON audit_logs(actor_user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_target ON audit_logs(target_type, target_id, occurred_at DESC);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS stocktakes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_by_user_id TEXT NOT NULL DEFAULT '',
      completed_by_name TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      cancelled_by_user_id TEXT NOT NULL DEFAULT '',
      cancelled_by_name TEXT NOT NULL DEFAULT '',
      cancelled_at TEXT NOT NULL DEFAULT '',
      cancellation_reason TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id TEXT PRIMARY KEY,
      stocktake_id TEXT NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('material', 'inventory_unit')),
      material_id TEXT NOT NULL,
      material_name TEXT NOT NULL,
      material_unit TEXT NOT NULL,
      tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('quantity', 'stateful', 'tracked')),
      inventory_unit_id TEXT NOT NULL DEFAULT '',
      inventory_unit_label TEXT NOT NULL DEFAULT '',
      expected_quantity REAL NOT NULL CHECK (expected_quantity >= 0),
      counted_quantity REAL CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
      reason TEXT NOT NULL DEFAULT '',
      resolution_note TEXT NOT NULL DEFAULT '',
      counted_by_user_id TEXT NOT NULL DEFAULT '',
      counted_by_name TEXT NOT NULL DEFAULT '',
      counted_at TEXT NOT NULL DEFAULT '',
      adjustment_transaction_id TEXT NOT NULL DEFAULT '',
      resolved_at TEXT NOT NULL DEFAULT '',
      UNIQUE(stocktake_id, scope_type, material_id, inventory_unit_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS stocktakes_created_at ON stocktakes(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS stocktake_items_stocktake ON stocktake_items(stocktake_id, material_name, inventory_unit_label);
  `);
  database.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(CURRENT_SCHEMA_VERSION));
}

export function validateBackupDatabase(databasePath, { clearSessions = false } = {}) {
  const database = new DatabaseSync(databasePath, { readOnly: !clearSessions });
  try {
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
    const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error(`数据库完整性校验失败：${integrity ?? '未知错误'}`);
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) throw new Error('数据库存在无效的外键关系');

    const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const tables = new Set(objects.filter((item) => item.type === 'table').map((item) => item.name));
    const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name));
    if (missingTables.length) throw new Error(`数据库缺少必要数据表：${missingTables.join('、')}`);
    if (objects.some((item) => item.type === 'trigger' || item.type === 'view')) {
      throw new Error('数据库包含不受支持的触发器或视图');
    }

    const initialized = database.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get()?.value;
    if (!initialized) throw new Error('数据库缺少初始化标记');
    const schemaVersion = Number(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`数据库结构版本不受支持：${Number.isFinite(schemaVersion) ? schemaVersion : '未知'}`);
    }
    if (schemaVersion >= 5 && (!tables.has('tags') || !tables.has('user_tags'))) {
      throw new Error('数据库缺少成员标签数据表');
    }
    if (schemaVersion >= 6 && ENHANCED_INVENTORY_TABLES.some((name) => !tables.has(name))) {
      throw new Error('数据库缺少状态化库存数据表');
    }
    if (schemaVersion >= 13 && !tables.has('audit_logs')) {
      throw new Error('数据库缺少管理员审计日志表');
    }
    if (schemaVersion >= 14 && (!tables.has('stocktakes') || !tables.has('stocktake_items'))) {
      throw new Error('数据库缺少盘点任务数据表');
    }
    if (schemaVersion >= 15 && !database.prepare('PRAGMA table_info(inventory_units)').all().some((column) => column.name === 'expiry_date')) {
      throw new Error('数据库缺少库存单元有效期字段');
    }

    const settings = database.prepare('SELECT COUNT(*) AS count FROM settings').get().count;
    const groups = database.prepare('SELECT COUNT(*) AS count FROM groups').get().count;
    const defaultGroups = database.prepare('SELECT COUNT(*) AS count FROM groups WHERE is_default = 1').get().count;
    const users = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const materials = database.prepare('SELECT COUNT(*) AS count FROM materials').get().count;
    const transactions = database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    const activeAdmins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count;
    const ownerUserId = database.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get()?.value ?? '';
    const validOwner = ownerUserId
      ? database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ? AND role = 'admin' AND active = 1").get(ownerUserId).count === 1
      : false;
    if (settings !== 1 || groups < 1 || defaultGroups !== 1 || users < 1 || activeAdmins < 1 || !validOwner) {
      throw new Error('数据库缺少有效的系统设置、默认分组或系统所有者');
    }

    if (clearSessions) {
      database.exec('PRAGMA journal_mode = DELETE;');
      database.prepare('DELETE FROM sessions').run();
    }
    return { schemaVersion, users, materials, transactions, ownerUserId };
  } finally {
    database.close();
  }
}

function rowsToStore(database, { includeHistory = true } = {}) {
  const settings = database.prepare('SELECT app_name, lab_name, brand_icon FROM settings WHERE id = 1').get();
  const ownerUserId = database.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get()?.value ?? '';
  const tagIdsByUser = new Map();
  for (const row of database.prepare('SELECT user_id, tag_id FROM user_tags ORDER BY tag_id').all()) {
    const tagIds = tagIdsByUser.get(row.user_id) ?? [];
    tagIds.push(row.tag_id);
    tagIdsByUser.set(row.user_id, tagIds);
  }
  return {
    settings: settings ? { appName: settings.app_name, labName: settings.lab_name, brandIcon: settings.brand_icon } : {},
    groups: database.prepare('SELECT id, name, is_default FROM groups').all().map((row) => ({
      id: row.id,
      name: row.name,
      isDefault: Boolean(row.is_default),
    })),
    tags: database.prepare('SELECT id, name FROM tags ORDER BY name COLLATE NOCASE').all().map((row) => ({
      id: row.id,
      name: row.name,
    })),
    users: database.prepare('SELECT id, username, name, note, role, group_id, active, salt, password_hash, last_login_at FROM users').all().map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      note: row.note,
      role: row.role,
      groupId: row.group_id,
      tagIds: tagIdsByUser.get(row.id) ?? [],
      active: Boolean(row.active),
      salt: row.salt,
      passwordHash: row.password_hash,
      lastLoginAt: row.last_login_at,
      isOwner: row.id === ownerUserId,
    })),
    materials: database.prepare('SELECT id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode, position_code_help, usage_context_help, active, updated_at FROM materials').all().map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      quantity: row.quantity,
      safetyStock: row.safety_stock,
      unit: row.unit,
      spec: row.spec,
      expiryWarningDays: row.expiry_warning_days,
      trackingMode: row.tracking_mode,
      positionCodeHelp: row.position_code_help,
      usageContextHelp: row.usage_context_help,
      active: Boolean(row.active),
      updatedAt: row.updated_at,
    })),
    inventoryStatuses: database.prepare('SELECT id, material_id, code, name, usable, terminal, active, sort_order FROM inventory_statuses').all().map((row) => ({
      id: row.id,
      materialId: row.material_id,
      code: row.code,
      name: row.name,
      usable: Boolean(row.usable),
      terminal: Boolean(row.terminal),
      active: Boolean(row.active),
      sortOrder: row.sort_order,
    })),
    inventoryUnits: database.prepare('SELECT id, material_id, unit_type, label, position_code, capacity, expiry_date, note, active, created_at, updated_at FROM inventory_units').all().map((row) => ({
      id: row.id,
      materialId: row.material_id,
      unitType: row.unit_type,
      label: row.label,
      positionCode: row.position_code,
      capacity: row.capacity,
      expiryDate: row.expiry_date,
      note: row.note,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    inventoryUnitBalances: database.prepare('SELECT inventory_unit_id, status_id, access_scope, owner_user_id, position_code, quantity FROM inventory_unit_balances').all().map((row) => ({
      inventoryUnitId: row.inventory_unit_id,
      statusId: row.status_id,
      accessScope: row.access_scope,
      ownerUserId: row.owner_user_id,
      positionCode: row.position_code,
      quantity: row.quantity,
    })),
    inventoryEvents: includeHistory
      ? database.prepare('SELECT id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type, from_status_id, from_status_name, to_status_id, to_status_name, from_access_scope, from_owner_user_id, from_owner_name, from_position_code, to_access_scope, to_owner_user_id, to_owner_name, to_position_code, user_id, user_name, group_id, group_name, counterparty, note, correction_of_id, occurred_at FROM inventory_events').all().map(inventoryEventFromRow)
      : [],
    transactions: includeHistory
      ? database.prepare('SELECT id, type, material_id, material_name, quantity, unit, user_id, user_name, group_id, group_name, source_type, counterparty, note, occurred_at, operation, inventory_unit_id, inventory_unit_label, status_id, status_name, access_scope, owner_user_id, owner_name, position_code, correction_of_id FROM transactions').all().map(transactionFromRow)
      : [],
  };
}

function rowsToSettings(database) {
  const settings = database.prepare('SELECT app_name, lab_name, brand_icon FROM settings WHERE id = 1').get();
  return settings
    ? { appName: settings.app_name, labName: settings.lab_name, brandIcon: settings.brand_icon }
    : null;
}

function materialFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    safetyStock: row.safety_stock,
    unit: row.unit,
    spec: row.spec,
    expiryWarningDays: row.expiry_warning_days,
    trackingMode: row.tracking_mode,
    positionCodeHelp: row.position_code_help,
    usageContextHelp: row.usage_context_help,
    active: Boolean(row.active),
    updatedAt: row.updated_at,
  };
}

function rowsToMaterials(database) {
  return database.prepare(`
    SELECT id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode,
      position_code_help, usage_context_help, active, updated_at
    FROM materials
  `).all().map(materialFromRow);
}

function rowToGroup(database, groupId) {
  const row = database.prepare('SELECT id, name, is_default FROM groups WHERE id = ?').get(groupId);
  return row ? { id: row.id, name: row.name, isDefault: Boolean(row.is_default) } : null;
}

function activeUserFromRow(database, row) {
  if (!row) return null;
  const ownerUserId = database.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get()?.value ?? '';
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    note: row.note,
    role: row.role,
    groupId: row.group_id,
    tagIds: database.prepare('SELECT tag_id FROM user_tags WHERE user_id = ? ORDER BY tag_id').all(row.id).map((item) => item.tag_id),
    active: true,
    salt: row.salt,
    passwordHash: row.password_hash,
    lastLoginAt: row.last_login_at,
    isOwner: row.id === ownerUserId,
  };
}

function rowToActiveUser(database, userId) {
  const row = database.prepare(`
    SELECT id, username, name, note, role, group_id, active, salt, password_hash, last_login_at
    FROM users
    WHERE id = ? AND active = 1
  `).get(userId);
  return activeUserFromRow(database, row);
}

function rowToActiveUserByUsername(database, username) {
  const row = database.prepare(`
    SELECT id, username, name, note, role, group_id, active, salt, password_hash, last_login_at
    FROM users
    WHERE username = ? AND active = 1
  `).get(username);
  return activeUserFromRow(database, row);
}

function transactionFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    materialId: row.material_id,
    materialName: row.material_name,
    quantity: row.quantity,
    unit: row.unit,
    userId: row.user_id,
    userName: row.user_name,
    groupId: row.group_id,
    groupName: row.group_name,
    sourceType: row.source_type,
    counterparty: row.counterparty,
    note: row.note,
    occurredAt: row.occurred_at,
    operation: row.operation,
    inventoryUnitId: row.inventory_unit_id,
    inventoryUnitLabel: row.inventory_unit_label,
    statusId: row.status_id,
    statusName: row.status_name,
    accessScope: row.access_scope,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    positionCode: row.position_code,
    correctionOfId: row.correction_of_id,
  };
}

function rowToTransaction(database, transactionId) {
  const row = database.prepare(`
    SELECT id, type, material_id, material_name, quantity, unit, user_id, user_name, group_id, group_name,
      source_type, counterparty, note, occurred_at, operation, inventory_unit_id, inventory_unit_label,
      status_id, status_name, access_scope, owner_user_id, owner_name, position_code, correction_of_id
    FROM transactions
    WHERE id = ?
  `).get(transactionId);
  return row ? transactionFromRow(row) : null;
}

function hasTransactionCorrection(database, transactionId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM transactions WHERE correction_of_id = ? LIMIT 1
  `).get(transactionId));
}

function inventoryEventFromRow(row) {
  return {
    id: row.id,
    materialId: row.material_id,
    materialName: row.material_name,
    inventoryUnitId: row.inventory_unit_id,
    inventoryUnitLabel: row.inventory_unit_label,
    quantity: row.quantity,
    eventType: row.event_type,
    fromStatusId: row.from_status_id,
    fromStatusName: row.from_status_name,
    toStatusId: row.to_status_id,
    toStatusName: row.to_status_name,
    fromAccessScope: row.from_access_scope,
    fromOwnerUserId: row.from_owner_user_id,
    fromOwnerName: row.from_owner_name,
    fromPositionCode: row.from_position_code,
    toAccessScope: row.to_access_scope,
    toOwnerUserId: row.to_owner_user_id,
    toOwnerName: row.to_owner_name,
    toPositionCode: row.to_position_code,
    userId: row.user_id,
    userName: row.user_name,
    groupId: row.group_id,
    groupName: row.group_name,
    counterparty: row.counterparty,
    note: row.note,
    correctionOfId: row.correction_of_id,
    occurredAt: row.occurred_at,
  };
}

function prepareTransactionInsert(database) {
  return database.prepare(`
    INSERT INTO transactions (
      id, type, material_id, material_name, quantity, unit, user_id, user_name,
      group_id, group_name, source_type, counterparty, note, occurred_at, operation,
      inventory_unit_id, inventory_unit_label, status_id, status_name, access_scope,
      owner_user_id, owner_name, position_code, correction_of_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function insertTransaction(statement, transaction) {
  statement.run(
    transaction.id, transaction.type, transaction.materialId, transaction.materialName,
    transaction.quantity, transaction.unit, transaction.userId, transaction.userName,
    transaction.groupId, transaction.groupName, transaction.sourceType, transaction.counterparty,
    transaction.note, transaction.occurredAt, transaction.operation ?? 'stock',
    transaction.inventoryUnitId ?? '', transaction.inventoryUnitLabel ?? '', transaction.statusId ?? '',
    transaction.statusName ?? '', transaction.accessScope ?? '', transaction.ownerUserId ?? '',
    transaction.ownerName ?? '', transaction.positionCode ?? '', transaction.correctionOfId ?? '',
  );
}

function recordQuantityTransaction(database, mutation) {
  const { material, transaction, createdMaterial } = mutation;
  if (!material || !transaction || material.id !== transaction.materialId) {
    throw new Error('Invalid quantity transaction mutation');
  }
  if (material.trackingMode !== 'quantity' || material.active === false) {
    throw new Error('Quantity transactions require an active quantity-tracked material');
  }

  if (createdMaterial) {
    database.prepare(`
      INSERT INTO materials (
        id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode,
        position_code_help, usage_context_help, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      material.id, material.name, material.category, material.quantity, material.safetyStock,
      material.unit, material.spec, material.expiryWarningDays ?? 30, material.trackingMode, material.positionCodeHelp ?? '',
      material.usageContextHelp ?? '', Number(material.active !== false), material.updatedAt,
    );
  } else {
    const result = database.prepare(`
      UPDATE materials
      SET quantity = ?, updated_at = ?
      WHERE id = ? AND active = 1 AND tracking_mode = 'quantity'
    `).run(material.quantity, material.updatedAt, material.id);
    if (result.changes !== 1) throw new Error('Quantity-tracked material changed before it could be recorded');
  }

  insertTransaction(prepareTransactionInsert(database), transaction);
}

function recordQuantityImport(database, mutation) {
  const { materials, transactions } = mutation;
  if (!Array.isArray(materials) || materials.length === 0 || !Array.isArray(transactions)) {
    throw new Error('Invalid quantity import mutation');
  }
  const materialIds = new Set();
  const upsertMaterial = database.prepare(`
    INSERT INTO materials (
      id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode,
      position_code_help, usage_context_help, active, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, category = excluded.category, quantity = excluded.quantity,
      safety_stock = excluded.safety_stock, unit = excluded.unit, spec = excluded.spec,
      expiry_warning_days = excluded.expiry_warning_days,
      position_code_help = excluded.position_code_help, usage_context_help = excluded.usage_context_help,
      updated_at = excluded.updated_at
    WHERE materials.active = 1 AND materials.tracking_mode = 'quantity'
  `);
  for (const material of materials) {
    if (!material?.id || materialIds.has(material.id) || material.trackingMode !== 'quantity' || material.active === false) {
      throw new Error('Quantity import contains an invalid material');
    }
    materialIds.add(material.id);
    const result = upsertMaterial.run(
      material.id, material.name, material.category, material.quantity, material.safetyStock,
      material.unit, material.spec, material.expiryWarningDays ?? 30, material.trackingMode, material.positionCodeHelp ?? '',
      material.usageContextHelp ?? '', Number(material.active !== false), material.updatedAt,
    );
    if (result.changes !== 1) throw new Error('Quantity import material changed before it could be recorded');
  }
  const insertAdjustment = prepareTransactionInsert(database);
  for (const transaction of transactions) {
    if (!materialIds.has(transaction.materialId) || transaction.sourceType !== 'inventory_adjustment') {
      throw new Error('Quantity import contains an invalid adjustment transaction');
    }
    insertTransaction(insertAdjustment, transaction);
  }
}

function queryTransactions(database, { userId = '' } = {}) {
  const where = userId ? 'WHERE user_id = ?' : '';
  const statement = database.prepare(`
    SELECT id, type, material_id, material_name, quantity, unit, user_id, user_name, group_id, group_name,
      source_type, counterparty, note, occurred_at, operation, inventory_unit_id, inventory_unit_label,
      status_id, status_name, access_scope, owner_user_id, owner_name, position_code, correction_of_id
    FROM transactions
    ${where}
    ORDER BY occurred_at DESC, id DESC
  `);
  return (userId ? statement.all(userId) : statement.all()).map(transactionFromRow);
}

function queryInventoryEvents(database, { userId = '' } = {}) {
  const where = userId ? 'WHERE user_id = ?' : '';
  const statement = database.prepare(`
    SELECT id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
      from_status_id, from_status_name, to_status_id, to_status_name,
      from_access_scope, from_owner_user_id, from_owner_name, from_position_code,
      to_access_scope, to_owner_user_id, to_owner_name, to_position_code,
      user_id, user_name, group_id, group_name, counterparty, note, correction_of_id, occurred_at
    FROM inventory_events
    ${where}
    ORDER BY occurred_at DESC, id DESC
  `);
  return (userId ? statement.all(userId) : statement.all()).map(inventoryEventFromRow);
}

function auditLogFromRow(row) {
  const parseSnapshot = (value) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    summary: row.summary,
    before: parseSnapshot(row.before_json),
    after: parseSnapshot(row.after_json),
    sourceIp: row.source_ip,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
  };
}

function queryAuditLogs(database, { pageSize = 60, query = '', targetType = 'all', actorUserId = '', from = '', cursor = null, exportAll = false } = {}) {
  const conditions = [];
  const parameters = [];
  if (targetType !== 'all') {
    conditions.push('target_type = ?');
    parameters.push(targetType);
  }
  if (actorUserId) {
    conditions.push('actor_user_id = ?');
    parameters.push(actorUserId);
  }
  if (from) {
    conditions.push('occurred_at >= ?');
    parameters.push(from);
  }
  if (query) {
    conditions.push("(actor_name || ' ' || action || ' ' || target_type || ' ' || target_name || ' ' || summary || ' ' || source_ip || ' ' || request_id) LIKE ? ESCAPE '\\'");
    parameters.push(escapedLikeTerm(query));
  }
  const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${countWhere}`).get(...parameters).count);
  const pageConditions = [...conditions];
  const pageParameters = [...parameters];
  if (cursor) {
    pageConditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
    pageParameters.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  const pageWhere = pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : '';
  const limitSql = exportAll ? '' : 'LIMIT ?';
  const queryParameters = exportAll ? pageParameters : [...pageParameters, pageSize + 1];
  const rows = database.prepare(`
    SELECT id, actor_user_id, actor_name, actor_role, action, target_type, target_id, target_name,
      summary, before_json, after_json, source_ip, request_id, occurred_at
    FROM audit_logs
    ${pageWhere}
    ORDER BY occurred_at DESC, id DESC
    ${limitSql}
  `).all(...queryParameters);
  const hasMore = !exportAll && rows.length > pageSize;
  const visibleRows = exportAll ? rows : hasMore ? rows.slice(0, pageSize) : rows;
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(auditLogFromRow),
    total,
    hasMore,
    nextCursor: hasMore && last ? { occurredAt: last.occurred_at, id: last.id } : null,
  };
}

function insertAuditLog(database, log) {
  database.prepare(`
    INSERT INTO audit_logs (
      id, actor_user_id, actor_name, actor_role, action, target_type, target_id, target_name,
      summary, before_json, after_json, source_ip, request_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.id, log.actorUserId, log.actorName, log.actorRole, log.action, log.targetType,
    log.targetId ?? '', log.targetName ?? '', log.summary,
    log.before == null ? '' : JSON.stringify(log.before),
    log.after == null ? '' : JSON.stringify(log.after),
    log.sourceIp ?? '', log.requestId, log.occurredAt,
  );
}

function stocktakeFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    completedByUserId: row.completed_by_user_id,
    completedByName: row.completed_by_name,
    completedAt: row.completed_at,
    cancelledByUserId: row.cancelled_by_user_id,
    cancelledByName: row.cancelled_by_name,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    itemCount: Number(row.item_count ?? 0),
    countedCount: Number(row.counted_count ?? 0),
    differenceCount: Number(row.difference_count ?? 0),
    adjustmentCount: Number(row.adjustment_count ?? 0),
  };
}

function stocktakeItemFromRow(row) {
  return {
    id: row.id,
    stocktakeId: row.stocktake_id,
    scopeType: row.scope_type,
    materialId: row.material_id,
    materialName: row.material_name,
    materialUnit: row.material_unit,
    trackingMode: row.tracking_mode,
    inventoryUnitId: row.inventory_unit_id,
    inventoryUnitLabel: row.inventory_unit_label,
    expectedQuantity: Number(row.expected_quantity),
    countedQuantity: row.counted_quantity == null ? null : Number(row.counted_quantity),
    currentQuantity: row.current_quantity == null ? null : Number(row.current_quantity),
    reason: row.reason,
    resolutionNote: row.resolution_note,
    countedByUserId: row.counted_by_user_id,
    countedByName: row.counted_by_name,
    countedAt: row.counted_at,
    adjustmentTransactionId: row.adjustment_transaction_id,
    resolvedAt: row.resolved_at,
  };
}

function queryStocktakes(database) {
  return database.prepare(`
    SELECT stocktakes.*,
      COUNT(stocktake_items.id) AS item_count,
      SUM(CASE WHEN stocktake_items.counted_quantity IS NOT NULL THEN 1 ELSE 0 END) AS counted_count,
      SUM(CASE WHEN stocktake_items.counted_quantity IS NOT NULL
        AND ABS(stocktake_items.counted_quantity - stocktake_items.expected_quantity) > 0.000000001 THEN 1 ELSE 0 END) AS difference_count,
      SUM(CASE WHEN stocktake_items.adjustment_transaction_id <> '' THEN 1 ELSE 0 END) AS adjustment_count
    FROM stocktakes
    LEFT JOIN stocktake_items ON stocktake_items.stocktake_id = stocktakes.id
    GROUP BY stocktakes.id
    ORDER BY CASE stocktakes.status WHEN 'open' THEN 0 ELSE 1 END, stocktakes.created_at DESC, stocktakes.id DESC
  `).all().map(stocktakeFromRow);
}

function readStocktake(database, stocktakeId) {
  const row = database.prepare(`
    SELECT stocktakes.*,
      COUNT(stocktake_items.id) AS item_count,
      SUM(CASE WHEN stocktake_items.counted_quantity IS NOT NULL THEN 1 ELSE 0 END) AS counted_count,
      SUM(CASE WHEN stocktake_items.counted_quantity IS NOT NULL
        AND ABS(stocktake_items.counted_quantity - stocktake_items.expected_quantity) > 0.000000001 THEN 1 ELSE 0 END) AS difference_count,
      SUM(CASE WHEN stocktake_items.adjustment_transaction_id <> '' THEN 1 ELSE 0 END) AS adjustment_count
    FROM stocktakes
    LEFT JOIN stocktake_items ON stocktake_items.stocktake_id = stocktakes.id
    WHERE stocktakes.id = ?
    GROUP BY stocktakes.id
  `).get(stocktakeId);
  if (!row) return null;
  const items = database.prepare(`
    SELECT stocktake_items.*,
      CASE stocktake_items.scope_type
        WHEN 'material' THEN (SELECT materials.quantity FROM materials WHERE materials.id = stocktake_items.material_id)
        ELSE CASE
          WHEN EXISTS(SELECT 1 FROM inventory_units WHERE inventory_units.id = stocktake_items.inventory_unit_id)
          THEN COALESCE((SELECT SUM(inventory_unit_balances.quantity)
            FROM inventory_unit_balances
            WHERE inventory_unit_balances.inventory_unit_id = stocktake_items.inventory_unit_id), 0)
          ELSE NULL
        END
      END AS current_quantity
    FROM stocktake_items
    WHERE stocktake_items.stocktake_id = ?
    ORDER BY stocktake_items.material_name COLLATE NOCASE, stocktake_items.inventory_unit_label COLLATE NOCASE, stocktake_items.id
  `).all(stocktakeId).map(stocktakeItemFromRow);
  return { ...stocktakeFromRow(row), items };
}

function createStocktake(database, stocktake, items) {
  if (!stocktake?.id || !Array.isArray(items) || !items.length) throw new Error('Invalid stocktake creation command');
  database.prepare(`
    INSERT INTO stocktakes (
      id, title, status, created_by_user_id, created_by_name, created_at,
      completed_by_user_id, completed_by_name, completed_at,
      cancelled_by_user_id, cancelled_by_name, cancelled_at, cancellation_reason
    ) VALUES (?, ?, 'open', ?, ?, ?, '', '', '', '', '', '', '')
  `).run(stocktake.id, stocktake.title, stocktake.createdByUserId, stocktake.createdByName, stocktake.createdAt);
  const insertItem = database.prepare(`
    INSERT INTO stocktake_items (
      id, stocktake_id, scope_type, material_id, material_name, material_unit, tracking_mode,
      inventory_unit_id, inventory_unit_label, expected_quantity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(
      item.id, stocktake.id, item.scopeType, item.materialId, item.materialName, item.materialUnit,
      item.trackingMode, item.inventoryUnitId ?? '', item.inventoryUnitLabel ?? '', item.expectedQuantity,
    );
  }
}

function updateStocktakeItem(database, mutation) {
  const result = database.prepare(`
    UPDATE stocktake_items
    SET counted_quantity = ?, reason = ?, resolution_note = ?, counted_by_user_id = ?, counted_by_name = ?, counted_at = ?
    WHERE id = ? AND stocktake_id = ?
      AND EXISTS(SELECT 1 FROM stocktakes WHERE stocktakes.id = stocktake_items.stocktake_id AND stocktakes.status = 'open')
  `).run(
    mutation.countedQuantity, mutation.reason, mutation.resolutionNote, mutation.countedByUserId,
    mutation.countedByName, mutation.countedAt, mutation.itemId, mutation.stocktakeId,
  );
  if (result.changes !== 1) throw new Error('Stocktake item changed before it could be recorded');
}

function completeStocktake(database, mutation) {
  if (!Array.isArray(mutation.resolutions) || !mutation.resolutions.length) throw new Error('Invalid stocktake completion command');
  for (const resolution of mutation.resolutions) {
    if (resolution.transaction) {
      recordQuantityTransaction(database, {
        material: resolution.material,
        transaction: resolution.transaction,
        createdMaterial: false,
      });
    }
    const itemResult = database.prepare(`
      UPDATE stocktake_items
      SET adjustment_transaction_id = ?, resolved_at = ?
      WHERE id = ? AND stocktake_id = ?
    `).run(resolution.transaction?.id ?? '', mutation.completedAt, resolution.itemId, mutation.stocktakeId);
    if (itemResult.changes !== 1) throw new Error('Stocktake item changed before completion');
  }
  const result = database.prepare(`
    UPDATE stocktakes
    SET status = 'completed', completed_by_user_id = ?, completed_by_name = ?, completed_at = ?
    WHERE id = ? AND status = 'open'
  `).run(mutation.completedByUserId, mutation.completedByName, mutation.completedAt, mutation.stocktakeId);
  if (result.changes !== 1) throw new Error('Stocktake changed before completion');
}

function cancelStocktake(database, mutation) {
  const result = database.prepare(`
    UPDATE stocktakes
    SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_name = ?,
      cancelled_at = ?, cancellation_reason = ?
    WHERE id = ? AND status = 'open'
  `).run(
    mutation.cancelledByUserId, mutation.cancelledByName, mutation.cancelledAt,
    mutation.cancellationReason, mutation.stocktakeId,
  );
  if (result.changes !== 1) throw new Error('Stocktake changed before cancellation');
}

function readStoreSnapshot(database) {
  database.exec('BEGIN');
  try {
    database.prepare('SELECT 1 FROM metadata LIMIT 1').get();
    const exportedAt = new Date().toISOString();
    const store = rowsToStore(database);
    database.exec('COMMIT');
    return { store, exportedAt };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function escapedLikeTerm(value) {
  return `%${String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function recordSourceWhere({ sourceOrder, userId = '', query = '', type = 'all', from = '', cursor = null, includeCursor = false }) {
  const conditions = [];
  const parameters = [];
  const transactionSource = sourceOrder === 2;
  if (transactionSource && !['all', 'in', 'out'].includes(type)) conditions.push('0');
  if (!transactionSource && !['all', 'use', 'inventory_event'].includes(type)) conditions.push('0');
  if (transactionSource && ['in', 'out'].includes(type)) {
    conditions.push('type = ?');
    parameters.push(type);
  }
  if (!transactionSource && type === 'use') conditions.push("event_type IN ('use', 'use_correction')");
  if (!transactionSource && type === 'inventory_event') conditions.push("event_type NOT IN ('use', 'use_correction')");
  if (userId) {
    conditions.push('user_id = ?');
    parameters.push(userId);
  }
  if (from) {
    conditions.push('occurred_at >= ?');
    parameters.push(from);
  }
  if (query) {
    const searchable = transactionSource
      ? "material_name || ' ' || inventory_unit_label || ' ' || position_code || ' ' || status_name || ' ' || owner_name || ' ' || user_name || ' ' || group_name || ' ' || counterparty || ' ' || note"
      : "material_name || ' ' || inventory_unit_label || ' ' || from_position_code || ' ' || to_position_code || ' ' || from_status_name || ' ' || to_status_name || ' ' || from_owner_name || ' ' || to_owner_name || ' ' || user_name || ' ' || group_name || ' ' || counterparty || ' ' || note || ' ' || CASE from_access_scope WHEN 'shared' THEN '开放使用' WHEN 'user' THEN '成员自用' ELSE '' END || ' ' || CASE to_access_scope WHEN 'shared' THEN '开放使用' WHEN 'user' THEN '成员自用' ELSE '' END";
    conditions.push(`(${searchable}) LIKE ? ESCAPE '\\'`);
    parameters.push(escapedLikeTerm(query));
  }
  if (includeCursor && cursor) {
    conditions.push(`(occurred_at < ? OR (occurred_at = ? AND (${sourceOrder} < ? OR (${sourceOrder} = ? AND id < ?))))`);
    parameters.push(cursor.occurredAt, cursor.occurredAt, cursor.sourceOrder, cursor.sourceOrder, cursor.id);
  }
  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    parameters,
  };
}

function rowsByIds(database, table, ids, select) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return database.prepare(`${select} FROM ${table} WHERE id IN (${placeholders})`).all(...ids);
}

function queryRecordPage(database, options = {}) {
  const pageSize = options.pageSize ?? 60;
  const transactionCountWhere = recordSourceWhere({ ...options, sourceOrder: 2 });
  const eventCountWhere = recordSourceWhere({ ...options, sourceOrder: 1 });
  const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM transactions ${transactionCountWhere.sql}`).get(...transactionCountWhere.parameters).count)
    + Number(database.prepare(`SELECT COUNT(*) AS count FROM inventory_events ${eventCountWhere.sql}`).get(...eventCountWhere.parameters).count);
  const referenceLimit = pageSize + 1;
  const transactionPageWhere = recordSourceWhere({ ...options, sourceOrder: 2, includeCursor: true });
  const eventPageWhere = recordSourceWhere({ ...options, sourceOrder: 1, includeCursor: true });
  const transactionReferences = database.prepare(`
    SELECT 'transaction' AS kind, id, occurred_at, 2 AS source_order
    FROM transactions ${transactionPageWhere.sql}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(...transactionPageWhere.parameters, referenceLimit);
  const eventReferences = database.prepare(`
    SELECT 'event' AS kind, id, occurred_at, 1 AS source_order
    FROM inventory_events ${eventPageWhere.sql}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(...eventPageWhere.parameters, referenceLimit);
  const references = [...transactionReferences, ...eventReferences].sort((left, right) => {
    if (left.occurred_at !== right.occurred_at) return left.occurred_at < right.occurred_at ? 1 : -1;
    if (left.source_order !== right.source_order) return right.source_order - left.source_order;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
  const hasMore = references.length > pageSize;
  const visibleReferences = hasMore ? references.slice(0, pageSize) : references;
  const transactionIds = visibleReferences.filter((item) => item.kind === 'transaction').map((item) => item.id);
  const eventIds = visibleReferences.filter((item) => item.kind === 'event').map((item) => item.id);
  const transactionRows = rowsByIds(database, 'transactions AS transactions', transactionIds, `
    SELECT transactions.id, transactions.type, transactions.material_id, transactions.material_name, transactions.quantity, transactions.unit,
      transactions.user_id, transactions.user_name, transactions.group_id, transactions.group_name, transactions.source_type,
      transactions.counterparty, transactions.note, transactions.occurred_at, transactions.operation, transactions.inventory_unit_id,
      transactions.inventory_unit_label, transactions.status_id, transactions.status_name, transactions.access_scope,
      transactions.owner_user_id, transactions.owner_name, transactions.position_code, transactions.correction_of_id,
      (SELECT correction.quantity FROM transactions AS correction WHERE correction.correction_of_id = transactions.id AND correction.correction_of_id <> '' LIMIT 1) AS corrected_quantity
  `);
  const eventRows = rowsByIds(database, 'inventory_events AS inventory_events', eventIds, `
    SELECT inventory_events.id, inventory_events.material_id, inventory_events.material_name, inventory_events.inventory_unit_id,
      inventory_events.inventory_unit_label, inventory_events.quantity, inventory_events.event_type,
      inventory_events.from_status_id, inventory_events.from_status_name, inventory_events.to_status_id, inventory_events.to_status_name,
      inventory_events.from_access_scope, inventory_events.from_owner_user_id, inventory_events.from_owner_name, inventory_events.from_position_code,
      inventory_events.to_access_scope, inventory_events.to_owner_user_id, inventory_events.to_owner_name, inventory_events.to_position_code,
      inventory_events.user_id, inventory_events.user_name, inventory_events.group_id, inventory_events.group_name,
      inventory_events.counterparty, inventory_events.note, inventory_events.correction_of_id, inventory_events.occurred_at,
      EXISTS(SELECT 1 FROM inventory_events AS correction WHERE correction.correction_of_id = inventory_events.id AND correction.correction_of_id <> '') AS corrected
  `);
  const transactionsById = new Map(transactionRows.map((row) => [row.id, {
    ...transactionFromRow(row),
    correctedQuantity: row.corrected_quantity == null ? null : Number(row.corrected_quantity),
  }]));
  const eventsById = new Map(eventRows.map((row) => [row.id, {
    ...inventoryEventFromRow(row),
    corrected: Boolean(row.corrected),
  }]));
  const items = visibleReferences.map((reference) => reference.kind === 'transaction'
    ? { kind: 'transaction', occurredAt: reference.occurred_at, record: transactionsById.get(reference.id) }
    : { kind: 'event', occurredAt: reference.occurred_at, event: eventsById.get(reference.id) });
  const last = visibleReferences.at(-1);
  return {
    items,
    total: Number(total),
    hasMore,
    nextCursor: hasMore && last ? { occurredAt: last.occurred_at, sourceOrder: last.source_order, id: last.id } : null,
  };
}

function replaceStore(database, store) {
  database.exec(`
    DELETE FROM transactions;
    DELETE FROM inventory_events;
    DELETE FROM inventory_unit_balances;
    DELETE FROM inventory_units;
    DELETE FROM inventory_statuses;
    DELETE FROM materials;
    DELETE FROM user_tags;
    DELETE FROM users;
    DELETE FROM tags;
    DELETE FROM groups;
    DELETE FROM settings;
  `);

  database.prepare('INSERT INTO settings (id, app_name, lab_name, brand_icon) VALUES (1, ?, ?, ?)')
    .run(store.settings.appName, store.settings.labName, store.settings.brandIcon);

  const insertGroup = database.prepare('INSERT INTO groups (id, name, is_default) VALUES (?, ?, ?)');
  for (const group of store.groups) insertGroup.run(group.id, group.name, Number(group.isDefault));

  const insertTag = database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)');
  for (const tag of store.tags) insertTag.run(tag.id, tag.name);

  const insertUser = database.prepare(`
    INSERT INTO users (id, username, name, note, role, group_id, active, salt, password_hash, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const user of store.users) {
    insertUser.run(user.id, user.username, user.name, user.note ?? '', user.role, user.groupId, Number(user.active), user.salt, user.passwordHash, user.lastLoginAt);
  }
  const insertUserTag = database.prepare('INSERT INTO user_tags (user_id, tag_id) VALUES (?, ?)');
  for (const user of store.users) {
    for (const tagId of user.tagIds ?? []) insertUserTag.run(user.id, tagId);
  }

  const insertMaterial = database.prepare(`
    INSERT INTO materials (id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode, position_code_help, usage_context_help, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const material of store.materials) {
    insertMaterial.run(
      material.id, material.name, material.category, material.quantity, material.safetyStock, material.unit,
      material.spec, material.expiryWarningDays ?? 30, material.trackingMode, material.positionCodeHelp ?? '', material.usageContextHelp ?? '',
      Number(material.active !== false), material.updatedAt,
    );
  }

  const insertStatus = database.prepare(`
    INSERT INTO inventory_statuses (id, material_id, code, name, usable, terminal, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const status of store.inventoryStatuses) {
    insertStatus.run(status.id, status.materialId, status.code, status.name, Number(status.usable), Number(status.terminal), Number(status.active !== false), status.sortOrder ?? 0);
  }

  const insertUnit = database.prepare(`
    INSERT INTO inventory_units (id, material_id, unit_type, label, position_code, capacity, expiry_date, note, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const unit of store.inventoryUnits) {
    insertUnit.run(unit.id, unit.materialId, unit.unitType, unit.label, unit.positionCode, unit.capacity ?? 0, unit.expiryDate ?? '', unit.note ?? '', Number(unit.active !== false), unit.createdAt, unit.updatedAt);
  }

  const insertBalance = database.prepare(`
    INSERT INTO inventory_unit_balances (inventory_unit_id, status_id, access_scope, owner_user_id, position_code, quantity)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const balance of store.inventoryUnitBalances) {
    insertBalance.run(balance.inventoryUnitId, balance.statusId, balance.accessScope, balance.ownerUserId ?? '', balance.positionCode ?? '', balance.quantity);
  }

  const insertEvent = database.prepare(`
    INSERT INTO inventory_events (
      id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
      from_status_id, from_status_name, to_status_id, to_status_name,
      from_access_scope, from_owner_user_id, from_owner_name, from_position_code,
      to_access_scope, to_owner_user_id, to_owner_name, to_position_code,
      user_id, user_name, group_id, group_name, counterparty, note, correction_of_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of store.inventoryEvents) {
    insertEvent.run(
      event.id, event.materialId, event.materialName, event.inventoryUnitId, event.inventoryUnitLabel, event.quantity, event.eventType,
      event.fromStatusId ?? '', event.fromStatusName ?? '', event.toStatusId ?? '', event.toStatusName ?? '',
      event.fromAccessScope ?? '', event.fromOwnerUserId ?? '', event.fromOwnerName ?? '', event.fromPositionCode ?? '',
      event.toAccessScope ?? '', event.toOwnerUserId ?? '', event.toOwnerName ?? '', event.toPositionCode ?? '',
      event.userId, event.userName, event.groupId ?? '', event.groupName ?? '', event.counterparty ?? '', event.note ?? '', event.correctionOfId ?? '', event.occurredAt,
    );
  }

  const insertTransaction = database.prepare(`
    INSERT INTO transactions (id, type, material_id, material_name, quantity, unit, user_id, user_name, group_id, group_name, source_type, counterparty, note, occurred_at, operation, inventory_unit_id, inventory_unit_label, status_id, status_name, access_scope, owner_user_id, owner_name, position_code, correction_of_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const record of store.transactions) {
    insertTransaction.run(
      record.id, record.type, record.materialId, record.materialName, record.quantity, record.unit,
      record.userId, record.userName, record.groupId, record.groupName, record.sourceType,
      record.counterparty, record.note, record.occurredAt, record.operation ?? 'stock', record.inventoryUnitId ?? '', record.inventoryUnitLabel ?? '',
      record.statusId ?? '', record.statusName ?? '', record.accessScope ?? '', record.ownerUserId ?? '', record.ownerName ?? '', record.positionCode ?? '', record.correctionOfId ?? '',
    );
  }
}

function changed(before, after, fields) {
  return !before || fields.some((field) => before[field] !== after[field]);
}

function syncStore(database, before, after) {
  if (changed(before.settings, after.settings, ['appName', 'labName', 'brandIcon'])) {
    database.prepare('UPDATE settings SET app_name = ?, lab_name = ?, brand_icon = ? WHERE id = 1')
      .run(after.settings.appName, after.settings.labName, after.settings.brandIcon);
  }

  const oldGroups = new Map(before.groups.map((group) => [group.id, group]));
  const nextGroups = new Map(after.groups.map((group) => [group.id, group]));
  const oldDefaultId = before.groups.find((group) => group.isDefault)?.id;
  const nextDefaultId = after.groups.find((group) => group.isDefault)?.id;
  const defaultChanged = oldDefaultId !== nextDefaultId;
  if (defaultChanged) database.prepare('UPDATE groups SET is_default = 0 WHERE is_default = 1').run();
  const upsertGroup = database.prepare(`
    INSERT INTO groups (id, name, is_default) VALUES (?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `);
  for (const group of after.groups) {
    if (changed(oldGroups.get(group.id), group, ['name'])) upsertGroup.run(group.id, group.name);
  }
  if (defaultChanged) database.prepare('UPDATE groups SET is_default = 1 WHERE id = ?').run(nextDefaultId);

  const oldTags = new Map(before.tags.map((tag) => [tag.id, tag]));
  const nextTags = new Map(after.tags.map((tag) => [tag.id, tag]));
  const upsertTag = database.prepare(`
    INSERT INTO tags (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `);
  for (const tag of after.tags) {
    if (changed(oldTags.get(tag.id), tag, ['name'])) upsertTag.run(tag.id, tag.name);
  }

  const oldUsers = new Map(before.users.map((user) => [user.id, user]));
  const nextUsers = new Map(after.users.map((user) => [user.id, user]));
  const upsertUser = database.prepare(`
    INSERT INTO users (id, username, name, note, role, group_id, active, salt, password_hash, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      name = excluded.name,
      note = excluded.note,
      role = excluded.role,
      group_id = excluded.group_id,
      active = excluded.active,
      salt = excluded.salt,
      password_hash = excluded.password_hash,
      last_login_at = excluded.last_login_at
  `);
  const userFields = ['username', 'name', 'note', 'role', 'groupId', 'active', 'salt', 'passwordHash', 'lastLoginAt'];
  for (const user of after.users) {
    if (!changed(oldUsers.get(user.id), user, userFields)) continue;
    upsertUser.run(user.id, user.username, user.name, user.note ?? '', user.role, user.groupId, Number(user.active), user.salt, user.passwordHash, user.lastLoginAt);
  }
  const previousOwnerId = before.users.find((user) => user.isOwner)?.id ?? '';
  const nextOwners = after.users.filter((user) => user.isOwner);
  if (nextOwners.length !== 1 || nextOwners[0].role !== 'admin' || !nextOwners[0].active) throw new Error('Store must have exactly one active system owner role');
  if (previousOwnerId !== nextOwners[0].id) {
    database.prepare("INSERT INTO metadata (key, value) VALUES ('owner_user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(nextOwners[0].id);
  }
  const deleteSessions = database.prepare('DELETE FROM sessions WHERE user_id = ?');
  const deleteUser = database.prepare('DELETE FROM users WHERE id = ?');
  for (const user of before.users) {
    if (nextUsers.has(user.id)) continue;
    deleteSessions.run(user.id);
    deleteUser.run(user.id);
  }

  database.prepare('DELETE FROM user_tags').run();
  const insertUserTag = database.prepare('INSERT INTO user_tags (user_id, tag_id) VALUES (?, ?)');
  for (const user of after.users) {
    for (const tagId of user.tagIds ?? []) insertUserTag.run(user.id, tagId);
  }
  const deleteTag = database.prepare('DELETE FROM tags WHERE id = ?');
  for (const tag of before.tags) if (!nextTags.has(tag.id)) deleteTag.run(tag.id);

  const deleteGroup = database.prepare('DELETE FROM groups WHERE id = ?');
  for (const group of before.groups) if (!nextGroups.has(group.id)) deleteGroup.run(group.id);

  const oldMaterials = new Map(before.materials.map((material) => [material.id, material]));
  const nextMaterials = new Map(after.materials.map((material) => [material.id, material]));
  const upsertMaterial = database.prepare(`
    INSERT INTO materials (id, name, category, quantity, safety_stock, unit, spec, expiry_warning_days, tracking_mode, position_code_help, usage_context_help, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      quantity = excluded.quantity,
      safety_stock = excluded.safety_stock,
      unit = excluded.unit,
      spec = excluded.spec,
      expiry_warning_days = excluded.expiry_warning_days,
      tracking_mode = excluded.tracking_mode,
      position_code_help = excluded.position_code_help,
      usage_context_help = excluded.usage_context_help,
      active = excluded.active,
      updated_at = excluded.updated_at
  `);
  const materialFields = ['name', 'category', 'quantity', 'safetyStock', 'unit', 'spec', 'expiryWarningDays', 'trackingMode', 'positionCodeHelp', 'usageContextHelp', 'active', 'updatedAt'];
  for (const material of after.materials) {
    if (!changed(oldMaterials.get(material.id), material, materialFields)) continue;
    upsertMaterial.run(
      material.id, material.name, material.category, material.quantity, material.safetyStock,
      material.unit, material.spec, material.expiryWarningDays ?? 30, material.trackingMode, material.positionCodeHelp ?? '', material.usageContextHelp ?? '',
      Number(material.active !== false), material.updatedAt,
    );
  }
  const deleteMaterial = database.prepare('DELETE FROM materials WHERE id = ?');
  for (const material of before.materials) if (!nextMaterials.has(material.id)) deleteMaterial.run(material.id);

  database.prepare('DELETE FROM inventory_unit_balances').run();
  database.prepare('DELETE FROM inventory_units').run();
  database.prepare('DELETE FROM inventory_statuses').run();

  const insertStatus = database.prepare(`
    INSERT INTO inventory_statuses (id, material_id, code, name, usable, terminal, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const status of after.inventoryStatuses) {
    insertStatus.run(status.id, status.materialId, status.code, status.name, Number(status.usable), Number(status.terminal), Number(status.active !== false), status.sortOrder ?? 0);
  }

  const insertUnit = database.prepare(`
    INSERT INTO inventory_units (id, material_id, unit_type, label, position_code, capacity, expiry_date, note, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const unit of after.inventoryUnits) {
    insertUnit.run(unit.id, unit.materialId, unit.unitType, unit.label, unit.positionCode, unit.capacity ?? 0, unit.expiryDate ?? '', unit.note ?? '', Number(unit.active !== false), unit.createdAt, unit.updatedAt);
  }

  const insertBalance = database.prepare(`
    INSERT INTO inventory_unit_balances (inventory_unit_id, status_id, access_scope, owner_user_id, position_code, quantity)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const balance of after.inventoryUnitBalances) {
    insertBalance.run(balance.inventoryUnitId, balance.statusId, balance.accessScope, balance.ownerUserId ?? '', balance.positionCode ?? '', balance.quantity);
  }

  const oldInventoryEvents = new Map(before.inventoryEvents.map((event) => [event.id, event]));
  const nextInventoryEventIds = new Set(after.inventoryEvents.map((event) => event.id));
  for (const event of before.inventoryEvents) {
    if (!nextInventoryEventIds.has(event.id)) throw new Error('Historical inventory events are immutable');
  }
  const insertInventoryEvent = database.prepare(`
    INSERT INTO inventory_events (
      id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
      from_status_id, from_status_name, to_status_id, to_status_name,
      from_access_scope, from_owner_user_id, from_owner_name, from_position_code,
      to_access_scope, to_owner_user_id, to_owner_name, to_position_code,
      user_id, user_name, group_id, group_name, counterparty, note, correction_of_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const inventoryEventFields = [
    'materialId', 'materialName', 'inventoryUnitId', 'inventoryUnitLabel', 'quantity', 'eventType',
    'fromStatusId', 'fromStatusName', 'toStatusId', 'toStatusName',
    'fromAccessScope', 'fromOwnerUserId', 'fromOwnerName', 'fromPositionCode',
    'toAccessScope', 'toOwnerUserId', 'toOwnerName', 'toPositionCode',
    'userId', 'userName', 'groupId', 'groupName', 'counterparty', 'note', 'correctionOfId', 'occurredAt',
  ];
  for (const event of after.inventoryEvents) {
    const previous = oldInventoryEvents.get(event.id);
    if (previous) {
      if (changed(previous, event, inventoryEventFields)) throw new Error('Historical inventory events are immutable');
      continue;
    }
    insertInventoryEvent.run(
      event.id, event.materialId, event.materialName, event.inventoryUnitId, event.inventoryUnitLabel, event.quantity, event.eventType,
      event.fromStatusId ?? '', event.fromStatusName ?? '', event.toStatusId ?? '', event.toStatusName ?? '',
      event.fromAccessScope ?? '', event.fromOwnerUserId ?? '', event.fromOwnerName ?? '', event.fromPositionCode ?? '',
      event.toAccessScope ?? '', event.toOwnerUserId ?? '', event.toOwnerName ?? '', event.toPositionCode ?? '',
      event.userId, event.userName, event.groupId ?? '', event.groupName ?? '', event.counterparty ?? '', event.note ?? '', event.correctionOfId ?? '', event.occurredAt,
    );
  }

  const oldTransactions = new Map(before.transactions.map((record) => [record.id, record]));
  const insertTransaction = database.prepare(`
    INSERT INTO transactions (id, type, material_id, material_name, quantity, unit, user_id, user_name, group_id, group_name, source_type, counterparty, note, occurred_at, operation, inventory_unit_id, inventory_unit_label, status_id, status_name, access_scope, owner_user_id, owner_name, position_code, correction_of_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transactionFields = [
    'type', 'materialId', 'materialName', 'quantity', 'unit', 'userId',
    'userName', 'groupId', 'groupName', 'sourceType', 'counterparty', 'note', 'occurredAt', 'operation',
    'inventoryUnitId', 'inventoryUnitLabel', 'statusId', 'statusName', 'accessScope', 'ownerUserId', 'ownerName', 'positionCode', 'correctionOfId',
  ];
  for (const record of after.transactions) {
    const previous = oldTransactions.get(record.id);
    if (previous) {
      if (changed(previous, record, transactionFields)) throw new Error('Historical transactions are immutable');
      continue;
    }
    insertTransaction.run(
      record.id, record.type, record.materialId, record.materialName, record.quantity, record.unit,
      record.userId, record.userName, record.groupId, record.groupName, record.sourceType,
      record.counterparty, record.note, record.occurredAt, record.operation ?? 'stock', record.inventoryUnitId ?? '', record.inventoryUnitLabel ?? '',
      record.statusId ?? '', record.statusName ?? '', record.accessScope ?? '', record.ownerUserId ?? '', record.ownerName ?? '', record.positionCode ?? '', record.correctionOfId ?? '',
    );
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function openStorage({ dataDir, createDefaultStore, normalizeStore, busyTimeoutMs = 10000 }) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 100 || busyTimeoutMs > 60000) {
    throw new Error('SQLITE_BUSY_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  await mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, DATABASE_FILE);
  const legacyPath = path.join(dataDir, LEGACY_FILE);
  const writeDatabase = new DatabaseSync(databasePath);
  configure(writeDatabase, busyTimeoutMs);
  createSchema(writeDatabase);

  let migratedLegacy = false;
  writeDatabase.exec('BEGIN IMMEDIATE');
  try {
    const initialized = writeDatabase.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get();
    if (!initialized) {
      const hasLegacy = await exists(legacyPath);
      const initialStore = hasLegacy
        ? JSON.parse(await readFile(legacyPath, 'utf8'))
        : createDefaultStore();
      replaceStore(writeDatabase, normalizeStore(initialStore));
      writeDatabase.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?), ('initialized', ?)")
        .run(String(CURRENT_SCHEMA_VERSION), new Date().toISOString());
      migratedLegacy = hasLegacy;
    }
    migrateSchema(writeDatabase);
    const ownerMetadata = writeDatabase.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get();
    if (!ownerMetadata) {
      const owner = writeDatabase.prepare(`
        SELECT id FROM users
        WHERE role = 'admin'
        ORDER BY CASE WHEN username = 'admin' THEN 0 ELSE 1 END, rowid
        LIMIT 1
      `).get();
      if (owner) writeDatabase.prepare("INSERT INTO metadata (key, value) VALUES ('owner_user_id', ?)").run(owner.id);
    }
    writeDatabase.exec('COMMIT');
  } catch (error) {
    writeDatabase.exec('ROLLBACK');
    writeDatabase.close();
    throw error;
  }

  if (migratedLegacy) {
    const archivePath = path.join(dataDir, `store.migrated-${new Date().toISOString().replace(/[-:.]/g, '')}.json`);
    await rename(legacyPath, archivePath);
    console.log(`Migrated legacy JSON data to SQLite: ${archivePath}`);
  }

  const readDatabase = new DatabaseSync(databasePath, { readOnly: true });
  configure(readDatabase, busyTimeoutMs);

  let transactionSnapshot = null;

  const readView = {
    readStore: () => rowsToStore(readDatabase),
    readCurrentInventoryStore: () => rowsToStore(readDatabase, { includeHistory: false }),
    readStoreSnapshot: () => readStoreSnapshot(readDatabase),
    readSettings: () => rowsToSettings(readDatabase),
    readMaterials: () => rowsToMaterials(readDatabase),
    readGroup: (groupId) => rowToGroup(readDatabase, groupId),
    readActiveUser: (userId) => rowToActiveUser(readDatabase, userId),
    readActiveUserByUsername: (username) => rowToActiveUserByUsername(readDatabase, username),
    readTransaction: (transactionId) => rowToTransaction(readDatabase, transactionId),
    hasTransactionCorrection: (transactionId) => hasTransactionCorrection(readDatabase, transactionId),
    queryTransactions: (options) => queryTransactions(readDatabase, options),
    queryInventoryEvents: (options) => queryInventoryEvents(readDatabase, options),
    queryRecordPage: (options) => queryRecordPage(readDatabase, options),
    queryAuditLogs: (options) => queryAuditLogs(readDatabase, options),
    queryStocktakes: () => queryStocktakes(readDatabase),
    readStocktake: (stocktakeId) => readStocktake(readDatabase, stocktakeId),
    getSession: (token) => readDatabase.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash(token)),
  };

  const writeView = {
    readStore: () => {
      const current = rowsToStore(writeDatabase);
      transactionSnapshot = structuredClone(current);
      return current;
    },
    readCurrentInventoryStore: () => {
      const current = rowsToStore(writeDatabase, { includeHistory: false });
      transactionSnapshot = structuredClone(current);
      return current;
    },
    readSettings: () => rowsToSettings(writeDatabase),
    readMaterials: () => rowsToMaterials(writeDatabase),
    readGroup: (groupId) => rowToGroup(writeDatabase, groupId),
    readActiveUser: (userId) => rowToActiveUser(writeDatabase, userId),
    readActiveUserByUsername: (username) => rowToActiveUserByUsername(writeDatabase, username),
    readTransaction: (transactionId) => rowToTransaction(writeDatabase, transactionId),
    hasTransactionCorrection: (transactionId) => hasTransactionCorrection(writeDatabase, transactionId),
    queryTransactions: (options) => queryTransactions(writeDatabase, options),
    queryInventoryEvents: (options) => queryInventoryEvents(writeDatabase, options),
    queryRecordPage: (options) => queryRecordPage(writeDatabase, options),
    queryAuditLogs: (options) => queryAuditLogs(writeDatabase, options),
    queryStocktakes: () => queryStocktakes(writeDatabase),
    readStocktake: (stocktakeId) => readStocktake(writeDatabase, stocktakeId),
    writeStore: (command) => {
      if (!command || typeof command !== 'object') throw new Error('Invalid write command');
      if (command.operation === 'syncStore') {
        if (!transactionSnapshot) throw new Error('Store was not read inside the current transaction');
        if (!command.store || typeof command.store !== 'object') throw new Error('Invalid Store sync command');
        syncStore(writeDatabase, transactionSnapshot, command.store);
        transactionSnapshot = structuredClone(command.store);
        return;
      }
      if (command.operation === 'quantityTransaction') {
        recordQuantityTransaction(writeDatabase, command);
        return;
      }
      if (command.operation === 'quantityImport') {
        recordQuantityImport(writeDatabase, command);
        return;
      }
      if (command.operation === 'auditLog') {
        insertAuditLog(writeDatabase, command.log);
        return;
      }
      if (command.operation === 'stocktakeCreate') {
        createStocktake(writeDatabase, command.stocktake, command.items);
        return;
      }
      if (command.operation === 'stocktakeItemUpdate') {
        updateStocktakeItem(writeDatabase, command);
        return;
      }
      if (command.operation === 'stocktakeComplete') {
        completeStocktake(writeDatabase, command);
        return;
      }
      if (command.operation === 'stocktakeCancel') {
        cancelStocktake(writeDatabase, command);
        return;
      }
      throw new Error('Unsupported write command');
    },
    getSession: (token) => writeDatabase.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash(token)),
    createSession: (token, userId, expiresAt) => {
      writeDatabase.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      writeDatabase.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(tokenHash(token), userId, expiresAt);
    },
    deleteSession: (token) => writeDatabase.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)),
    clearSessionsForUser: (userId, exceptToken = '') => {
      if (exceptToken) {
        writeDatabase.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, tokenHash(exceptToken));
      } else {
        writeDatabase.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      }
    },
    updateUserLastLogin: (userId, occurredAt) => {
      const result = writeDatabase.prepare('UPDATE users SET last_login_at = ? WHERE id = ? AND active = 1').run(occurredAt, userId);
      if (result.changes !== 1) throw new Error('Active user changed before login completed');
    },
  };

  return {
    databasePath,
    readView,
    writeView,
    beginWrite: () => {
      transactionSnapshot = null;
      writeDatabase.exec('BEGIN IMMEDIATE');
    },
    commitWrite: () => {
      writeDatabase.exec('COMMIT');
      transactionSnapshot = null;
    },
    rollbackWrite: () => {
      writeDatabase.exec('ROLLBACK');
      transactionSnapshot = null;
    },
    createBackup: (destinationPath) => {
      writeDatabase.exec(`VACUUM INTO ${quoteSqlString(destinationPath)}`);
    },
    close: () => {
      readDatabase.close();
      writeDatabase.close();
    },
  };
}
