// Usage: node scripts/verify-function-fixes-sql.cjs <path-to-pglite-package>
// Runs only against a disposable in-memory PostgreSQL database.
const { PGlite } = require(process.argv[2] || '@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('request.user_id',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as
        $$ select jsonb_build_object('email',current_setting('request.email',true)) $$;
      create table members(id uuid primary key,name text,email text,joined_at date,
        base_amount integer not null,is_active boolean not null default true);
      create table annual_settlements(id uuid primary key default gen_random_uuid(),year integer unique,
        winner_id uuid references members(id),prize_amount integer,total_before bigint,total_after bigint,
        new_base_amount integer,member_count integer,note text);
      grant all on annual_settlements to authenticated,anon;
      insert into members(id,name,base_amount,joined_at) values
        ('00000000-0000-0000-0000-000000000001','A',600000,'2026-01-01'),
        ('00000000-0000-0000-0000-000000000002','B',400000,'2026-01-01');
      set request.user_id='00000000-0000-0000-0000-000000000099';
      set request.email='batiinvestment@gmail.com';
    `);
    const migration = fs.readFileSync(path.join(__dirname, '../sql/20261030-function-fixes.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const snapshot = async () => (await db.query('select id,base_amount from members where is_active order by id')).rows;
    const original = await snapshot();
    const call = (id, expected = original, year = 2026) => db.query(
      'select sss_annual_settle($1,$2,$3,$4,$5) as result', [id,year,100000,'test',JSON.stringify(expected)]);
    const request = '00000000-0000-0000-0000-000000000010';

    await db.exec(`create function fail_update() returns trigger language plpgsql as $$
      begin if new.name='B' then raise exception 'injected member failure'; end if; return new; end $$;
      create trigger fail_update before update on members for each row execute function fail_update();`);
    await assert.rejects(call(request), /injected member failure/);
    assert.deepEqual(await snapshot(), original);
    assert.equal((await db.query('select count(*)::int n from annual_settlements')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int n from sss_audit.annual_requests')).rows[0].n, 0);
    await db.exec('drop trigger fail_update on members');
    console.log('PASS: mid-update failure rolls back balances, settlement, and request');

    await db.exec('update members set base_amount=base_amount+1000 where name=\'A\'');
    await assert.rejects(call(request), /기준금액이 변경/);
    await db.exec('update members set base_amount=base_amount-1000 where name=\'A\'');
    console.log('PASS: stale preview rejects changed balance');

    await db.exec("set request.email='ordinary@example.test'; set role authenticated");
    await assert.rejects(call(request), /관리자만/);
    await assert.rejects(db.exec('insert into annual_settlements(year) values(2026)'), /permission denied/);
    await db.exec("reset role; set request.email='batiinvestment@gmail.com'");
    console.log('PASS: ordinary user and direct table writes are denied');

    const first = (await call(request)).rows[0].result;
    assert.equal(first.total_before, 1000000);
    assert.equal(first.new_base_amount, 450000);
    assert.deepEqual((await snapshot()).map(row => row.base_amount), [450000,450000]);
    assert.deepEqual((await call(request)).rows[0].result, first);
    assert.equal((await db.query('select count(*)::int n from annual_settlements')).rows[0].n, 1);
    await assert.rejects(call(request, original, 2025), /요청 식별자/);
    await assert.rejects(call('00000000-0000-0000-0000-000000000011', await snapshot()), /이미 결산/);
    console.log('PASS: success updates everyone once; retry, payload conflict, and duplicate year are safe');

    await db.exec("update members set is_active=false where name='A'");
    const departed = (await db.query("select deactivated_at from members where name='A'")).rows[0];
    assert.ok(departed.deactivated_at);
    await assert.rejects(db.exec("update members set is_active=true where name='A'"), /재가입/);
    console.log('PASS: old-client departure records cutoff and reactivation cannot erase history');

    // Equivalent to the PostgREST conditional UPDATE used by the member editor.
    await db.exec("update members set base_amount=451000 where name='B'");
    const conflict = await db.query("update members set base_amount=600000,name='Changed' where name='B' and base_amount=450000 returning id");
    assert.equal(conflict.rows.length, 0);
    await db.exec("update members set name='Renamed' where name='B'");
    assert.equal((await db.query("select base_amount from members where name='Renamed'")).rows[0].base_amount, 451000);
    const changed = await db.query("update members set base_amount=600000 where name='Renamed' and base_amount=451000 returning id");
    assert.equal(changed.rows.length, 1);
    console.log('PASS: conditional member UPDATE rejects stale balance; profile-only edit preserves current balance');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
