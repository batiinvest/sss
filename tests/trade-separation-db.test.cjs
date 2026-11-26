const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/^\uFEFF/, '');

test('real PostgreSQL: separate trades from ideas without changing the original ledger', async () => {
  const db = new PGlite();
  try {
    const schema = JSON.parse(read('sql/pre-corporate-schema.json'));
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email',current_setting('test.email',true)) $$;
      create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
      set test.uid='11111111-1111-4111-8111-111111111111'; set test.email='owner@example.com';`);
    const tables = ['members','picks','trades','settlements'];
    await db.exec('create table stock_prices(stock_code text primary key,stock_name text,market text,price integer);');
    for (const table of tables) {
      const columns = schema.columns.filter(c => c.table_name === table).map(c =>
        `${c.column_name} ${c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type}` +
        (c.column_default ? ` default ${c.column_default}` : '') + (c.is_nullable === 'NO' ? ' not null' : ''));
      await db.exec(`create table public.${table} (${columns.join(',')});`);
    }
    for (const c of schema.constraints.filter(c => tables.includes(c.table_name)))
      await db.exec(`alter table ${c.table_name} add constraint ${c.conname} ${c.definition};`);
    for (const trigger of schema.triggers.filter(t => tables.includes(t.table_name))) {
      await db.exec(trigger.function_definition);
      await db.exec(trigger.definition);
    }
    // Simulate the existing authenticated read grants / policies.
    await db.exec(`grant usage on schema public,auth to authenticated;
      grant select on all tables in schema public to authenticated;`);
    await db.exec(read('sql/20260920-corporate-actions.sql'));
    const owner = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    const pick = '44444444-4444-4444-8444-444444444444';
    await db.exec(`insert into members(id,name,email,is_active,base_amount) values
      ('${owner}','Owner','owner@example.com',true,500000),('${other}','Other','other@example.com',true,500000);
      insert into stock_prices(stock_code,stock_name,market,price) values
      ('005930','Samsung','KOSPI',70000),('000660','Hynix','KOSPI',150000),('035420','Naver','KOSPI',200000);
      insert into picks(id,member_id,month,stock_name,stock_code,market,reason,price_at,target_price)
      values('${pick}','${owner}','2026-01','Samsung','005930','KOSPI','original idea',100,200);`);
    let request = 0;
    const call = async (payload, id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++request).padStart(12,'0')}`) =>
      (await db.query('select sss_submit_trade($1::jsonb,$2::uuid) as result',[JSON.stringify(payload),id])).rows[0].result;
    const trade = (more = {}) => ({ member_id:owner, trade_type:'buy', price:100, quantity:10, traded_at:'2026-01-05T03:00:00Z', ...more });
    await call(trade({pick_id:pick}));
    await call(trade({pick_id:pick,trade_type:'sell',price:150,quantity:3,traded_at:'2026-01-06T03:00:00Z'}));
    const state = async id => (await db.query('select sss_ca_state($1) as s',[id])).rows[0].s;
    const before = await state(pick);
    const snapshot = async () => JSON.stringify((await db.query(`select jsonb_build_object(
      'trades',(select jsonb_agg(t order by id) from trades t),
      'settlements',(select jsonb_agg(s order by id) from settlements s),
      'members',(select jsonb_agg(m order by id) from members m)) as data`)).rows[0].data);
    const ledgerBefore = await snapshot();
    await db.exec(read('sql/20261126-separate-trades-and-ideas.sql'));
    await db.exec(read('sql/20261126-separate-trades-and-ideas.sql')); // repeatable
    assert.equal(await snapshot(),ledgerBefore);
    assert.deepEqual(await state(pick),before);
    const idea = (await db.query('select status,buy_quantity,buy_price from investment_ideas where pick_id=$1',[pick])).rows[0];
    assert.equal(idea.status,'idea');
    assert.equal(Number(idea.buy_quantity),0);
    assert.equal(idea.buy_price,null);

    // Changing/deleting a top pick cannot rename/delete its real position or settlements.
    await db.exec(`update picks set stock_name='Hynix',stock_code='000660',reason='changed idea' where id='${pick}';`);
    assert.equal((await db.query(`select stock_name from trade_positions where id='${pick}'`)).rows[0].stock_name,'Samsung');
    assert.deepEqual(await state(pick),before);
    await db.exec(`delete from picks where id='${pick}';`);
    assert.equal(await snapshot(),ledgerBefore);

    // No monthly pick exists: buy two different stocks, then add to one holding.
    const payload = trade({stock_code:'000660',price:200,quantity:22});
    const retryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const first = await call(payload,retryId);
    assert.deepEqual(await call(payload,retryId),first);
    await assert.rejects(call({...payload,quantity:23},retryId),/요청 식별자/);
    const second = await call(trade({stock_code:'035420',quantity:5}));
    assert.notEqual(first.pick_id,second.pick_id);
    assert.equal((await db.query('select count(*)::int as n from picks')).rows[0].n,0);
    const added = await call(trade({stock_code:'000660',price:100,quantity:2}));
    assert.equal(added.pick_id,first.pick_id);
    assert.equal(Number((await state(first.pick_id)).quantity),24);
    assert.equal(Number((await state(first.pick_id)).cost),4600);
    await call(trade({position_id:first.pick_id,trade_type:'sell',quantity:4,price:300,traded_at:'2026-01-07T03:00:00Z'}));
    assert.equal(Number((await state(first.pick_id)).quantity),20);
    const beforeBad = await snapshot();
    await assert.rejects(call(trade({position_id:first.pick_id,trade_type:'sell',quantity:21,traded_at:'2026-01-08T03:00:00Z'})));
    await assert.rejects(call(trade({member_id:other,stock_code:'000660'})),/본인의 거래/);
    for (const quantity of [0,-1,1.5,null]) await assert.rejects(call(trade({stock_code:'035420',quantity})));
    await assert.rejects(call(trade({stock_code:'999999'})),/검색 결과/);
    await assert.rejects(call(trade({position_id:second.pick_id,trade_type:'sell',quantity:1,traded_at:'2026-01-01T03:00:00Z'})));
    assert.equal(await snapshot(),beforeBad);
    // Direct financial writes stay blocked for signed-in clients.
    await db.exec('set role authenticated');
    await assert.rejects(db.exec(`insert into trade_accounts(member_id,stock_name) values('${owner}','Forbidden')`),/permission denied/);
    const visible = await db.query('select count(*)::int as n from trade_positions');
    assert.equal(visible.rows[0].n,3);
    await db.exec('reset role');
    // Bonus shares and their reversal use independent accounts, including stocks with no idea.
    await db.exec("set test.email='batiinvestment@gmail.com'");
    const action={stock_code:'000660',stock_name:'Hynix',existing_shares:1,new_shares:1,
      ex_date:'2026-01-10',record_date:'2026-01-12',source_url:'https://example.com/test-disclosure'};
    const preview=(await db.query('select sss_preview_bonus($1::jsonb) as p',[JSON.stringify(action)])).rows[0].p;
    const bonus=(await db.query('select sss_apply_bonus($1::jsonb,$2,$3::uuid) as a',
      [JSON.stringify(action),preview.token,'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])).rows[0].a;
    assert.equal(Number((await state(first.pick_id)).quantity),40);
    assert.equal(Number((await state(first.pick_id)).tradableQuantity),20);
    await db.query('select sss_credit_bonus($1::uuid,$2::date,$3::uuid)',
      [bonus.id,'2026-01-12','dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
    assert.equal(Number((await state(first.pick_id)).tradableQuantity),40);
    await db.query('select sss_reverse_bonus($1::uuid,$2,$3::uuid)',
      [bonus.id,'test reversal','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
    assert.equal(Number((await state(first.pick_id)).quantity),20);
  } finally { await db.close(); }
});
