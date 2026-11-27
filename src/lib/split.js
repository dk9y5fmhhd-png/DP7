'use strict';

// Even auto-split — customers ko callers me barabar baantna, priority ka mix rakhte hue.
//
// Kyun round-robin per bucket: agar sirf "pehle 600 isko, agle 600 usko" karte to
// ek caller ke paas saare P1 (VIP inactive) chale jaate aur doosre ke paas saare
// P2/P4. Isliye har priority bucket (P1, P2, P3, P4) ko alag-alag round-robin
// karte hain — har caller ko har bucket se barabar hissa milta hai.

const db = require('../db');

const PRIORITY_ORDER = ['PD', 'P1', 'P2', 'P3', 'P4'];

const SCOPES = {
  unassigned: {
    label: 'Unassigned',
    where: 'b.assigned_to IS NULL',
    params: () => [],
  },
  all: {
    label: 'All customers (re-split)',
    where: 'b.do_not_contact = FALSE',
    params: () => [],
  },
};

/**
 * Split plan banao — DB ko chhue bina.
 * @returns {Promise<{plan: Map<number, string[]>, counts: Object, total: number, perCaller: number}>}
 */
async function buildPlan({ callerIds, scope = 'unassigned', priority = '', perCaller = 0, take = 0 }) {
  if (!Array.isArray(callerIds) || !callerIds.length) throw new Error('Choose at least one caller.');

  const ids = [...new Set(callerIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) throw new Error('The caller IDs are wrong.');

  const sc = SCOPES[scope] || SCOPES.unassigned;
  const params = [...sc.params()];
  let where = sc.where;

  if (priority && PRIORITY_ORDER.includes(priority)) {
    params.push(priority);
    where += ` AND b.priority = $${params.length}`;
  }
  // P0 (Do Not Contact) kabhi assign nahi
  if (scope !== 'all') where += " AND b.do_not_contact = FALSE";

  // Priority ke hisaab se order — P1 pehle, phir zyada deposits wale
  const rows = await db.rows(
    `SELECT b.id, b.username, b.priority
       FROM customer_board b
      WHERE ${where}
      ORDER BY
        CASE b.priority WHEN 'PD' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2
                             WHEN 'P3' THEN 3 ELSE 4 END,
        b.deposit_count DESC, b.username`,
    params
  );

  // Bucket me daalo
  const buckets = new Map(PRIORITY_ORDER.map((p) => [p, []]));
  for (const r of rows) {
    if (r.priority === 'P0') continue;
    const arr = buckets.get(r.priority) || buckets.get('P4');
    arr.push(r);
  }

  // Har caller ka cap — perCaller diya ho to wahi, warna barabar bantwara
  const available = rows.filter((r) => r.priority !== 'P0').length;
  const capBase = perCaller > 0
    ? perCaller
    : Math.ceil(available / ids.length);

  const plan = new Map(ids.map((id) => [id, []]));
  const filled = new Map(ids.map((id) => [id, 0]));
  const priorityCount = new Map(ids.map((id) => [id, Object.fromEntries(PRIORITY_ORDER.map((p) => [p, 0]))]));

  // Round-robin per bucket, bucket ke hisaab se start offset (remainder fair ho)
  let remainingTotal = take > 0 ? take : Infinity;

  for (let bi = 0; bi < PRIORITY_ORDER.length; bi++) {
    const key = PRIORITY_ORDER[bi];
    const list = buckets.get(key) || [];
    if (!list.length) continue;

    let cursor = bi % ids.length; // har bucket doosre caller se shuru
    let placed = 0;

    while (placed < list.length && remainingTotal > 0) {
      // Aisa caller dhoondo jiska cap poora na hua ho
      let found = -1;
      for (let step = 0; step < ids.length; step++) {
        const idx = (cursor + step) % ids.length;
        const id = ids[idx];
        if (filled.get(id) < capBase) { found = idx; break; }
      }
      if (found === -1) break; // sab callers bhar gaye

      const id = ids[found];
      const item = list[placed];
      plan.get(id).push(item.username);
      filled.set(id, filled.get(id) + 1);
      priorityCount.get(id)[key] += 1;
      placed++;
      remainingTotal--;
      cursor = (found + 1) % ids.length;
    }

    if (remainingTotal <= 0) break;
  }

  let total = 0;
  const counts = {};
  for (const id of ids) {
    const n = plan.get(id).length;
    total += n;
    counts[id] = { count: n, ...priorityCount.get(id) };
  }

  return { plan, counts, total, perCaller: capBase, available, callers: ids };
}

/**
 * Plan ko DB me lagao — ek transaction.
 */
async function applyPlan({ plan, runBy, scope, callers, perCaller, total }) {
  let applied = 0;

  await db.tx(async (client) => {
    for (const [callerId, usernames] of plan.entries()) {
      if (!usernames.length) continue;
      // 500-500 chunk, taaki query na phaile
      const CHUNK = 400;
      for (let i = 0; i < usernames.length; i += CHUNK) {
        const slice = usernames.slice(i, i + CHUNK).map((u) => u.toLowerCase());
        const out = await client.query(
          `UPDATE customers SET assigned_to = $1 WHERE LOWER(username) = ANY($2::text[])`,
          [callerId, slice]
        );
        applied += out.rowCount;
      }
    }

    await client.query(
      `INSERT INTO split_runs (run_by, scope, total, callers, per_caller, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runBy || null, scope, applied, callers, perCaller, JSON.stringify(
        Object.fromEntries([...plan.entries()].map(([k, v]) => [k, v.length]))
      )]
    );
  });

  return applied;
}

/**
 * Caller load — kis caller ke paas kitna kaam hai.
 */
async function callerLoad({ team = '' } = {}) {
  const params = [];
  let teamWhere = '';
  if (team) {
    params.push(team);
    teamWhere = ` AND u.team = $${params.length}`;
  }

  const rows = await db.rows(
    `SELECT u.id, u.name, u.login_id, u.team, u.daily_target, u.last_login_at,
            u.require_approval, u.totp_enabled,
            COUNT(b.id) FILTER (WHERE b.do_not_contact = FALSE)::int AS assigned,
            COUNT(b.id) FILTER (WHERE b.do_not_contact = TRUE)::int  AS dnc,
            COUNT(b.id) FILTER (WHERE b.priority = 'P1')::int AS p1,
            COUNT(b.id) FILTER (WHERE b.priority = 'P2')::int AS p2,
            COUNT(b.id) FILTER (WHERE b.priority = 'P3')::int AS p3,
            COUNT(b.id) FILTER (WHERE b.priority = 'P4')::int AS p4,
            COALESCE(cdw.customers, 0)::int AS done_today,
            COALESCE(lf.pending, 0)::int AS pending,
            COALESCE(lf.overdue, 0)::int AS overdue,
            COALESCE(lf.snoozed, 0)::int AS snoozed
       FROM users u
       LEFT JOIN customer_board b ON b.assigned_to = u.id
       LEFT JOIN caller_daily_work cdw
              ON cdw.caller_id = u.id AND cdw.work_date = CURRENT_DATE
       LEFT JOIN (
            SELECT bb.assigned_to,
                   COUNT(*) FILTER (WHERE lfs.follow_up_on IS NULL
                                      OR lfs.follow_up_on <= CURRENT_DATE)::int AS pending,
                   COUNT(*) FILTER (WHERE lfs.follow_up_on < CURRENT_DATE)::int   AS overdue,
                   COUNT(*) FILTER (WHERE lfs.follow_up_on > CURRENT_DATE)::int   AS snoozed
              FROM customer_board bb
              LEFT JOIN latest_followup lfs ON lfs.uname = LOWER(bb.username)
             WHERE bb.assigned_to IS NOT NULL AND bb.do_not_contact = FALSE
             GROUP BY bb.assigned_to
       ) lf ON lf.assigned_to = u.id
      WHERE u.role <> 'super_admin'${teamWhere}
      GROUP BY u.id, u.name, u.login_id, u.team, u.daily_target, u.last_login_at,
               u.require_approval, u.totp_enabled, cdw.customers, lf.pending, lf.overdue, lf.snoozed
      ORDER BY assigned DESC, u.name`,
    params
  );

  // Load health — 4 days cycle par 150/din
  const CYCLE_DAYS = 4;
  for (const r of rows) {
    const capacity = Number(r.daily_target || 40) * CYCLE_DAYS;
    r.capacity = capacity;
    r.utilisation = capacity ? Math.min(999, Math.round((r.assigned / capacity) * 100)) : 0;
    if (r.assigned === 0) r.health = 'empty';
    else if (r.utilisation > 130) r.health = 'over';
    else if (r.utilisation > 105) r.health = 'heavy';
    else if (r.utilisation < 50) r.health = 'light';
    else r.health = 'ok';
  }

  return {
    rows,
    totals: {
      assigned: rows.reduce((a, r) => a + r.assigned, 0),
      pending: rows.reduce((a, r) => a + r.pending, 0),
      overdue: rows.reduce((a, r) => a + r.overdue, 0),
      done: rows.reduce((a, r) => a + r.done_today, 0),
      callers: rows.length,
      empty: rows.filter((r) => r.assigned === 0).length,
      over: rows.filter((r) => r.health === 'over' || r.health === 'heavy').length,
    },
  };
}

module.exports = { buildPlan, applyPlan, callerLoad, PRIORITY_ORDER, SCOPES };

