export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}

export async function one(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}
