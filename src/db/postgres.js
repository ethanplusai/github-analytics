// int8 and numeric arrive from Neon as strings. Unconverted they reach the
// charts and format as garbage, so every row is coerced by column type before
// it leaves the driver — which is what makes a Neon row indistinguishable
// from a SQLite one.
const NUMERIC_OIDS = new Set([20, 700, 701, 1700]);

export function toDollarPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '?') { n += 1; out += `$${n}`; continue; }
    out += ch;
  }
  return out;
}

export function coerceRow(row, fields) {
  const out = {};
  for (const field of fields) {
    const value = row[field.name];
    out[field.name] = value != null && NUMERIC_OIDS.has(field.dataTypeID)
      ? Number(value)
      : value;
  }
  return out;
}

export async function createPostgresDriver(connectionString) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(connectionString, { fullResults: true });

  const exec = async (text, params = []) => {
    const result = await sql.query(toDollarPlaceholders(text), params);
    return {
      rows: (result.rows ?? []).map((row) => coerceRow(row, result.fields ?? [])),
      rowCount: result.rowCount ?? 0,
    };
  };

  return {
    dialect: 'postgres',
    async query(text, params = []) { return (await exec(text, params)).rows; },
    async run(text, params = []) { return { rowCount: (await exec(text, params)).rowCount }; },
    async transaction(statements) {
      // Build the array of sql.query(...) calls WITHOUT awaiting them
      // individually — awaiting here would execute each one outside the
      // transaction and silently destroy atomicity. sql.transaction() is
      // handed the array of lazily-executed promise-likes and runs them
      // together.
      const results = await sql.transaction(
        statements.map(({ sql: text, params = [] }) => sql.query(toDollarPlaceholders(text), params)),
        { fullResults: true },
      );
      return results.map((r) => (r.rows ?? []).map((row) => coerceRow(row, r.fields ?? [])));
    },
    async close() {},
  };
}
