const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

// Isolated storage: production helpers run unchanged, without network/DB access.
function scenario(memberCount = 8) {
  const tables = { app_config: [], schedules: [], presentations: [] };
  const people = Array.from({ length: memberCount }, (_, i) => ({ id: 'member-' + (i + 1), name: '테스트회원 ' + (i + 1), joined_at: '2026-01-01', is_active: true }));
  let nextId = 0;
  const state = { tables, people, lostInsertResponse: false, failPresentationReads: false };
  const client = { from(table) {
    if (!tables[table]) throw Error('Unexpected table: ' + table);
    let operation = 'select', payload, options, promise;
    const predicates = [];
    const query = {
      select() { return this; },
      order() { return this; },
      eq(key, value) { predicates.push(row => key === 'value->>revision' ? String(row.value?.revision) === value : row[key] === value); return this; },
      in(key, values) { predicates.push(row => values.includes(row[key])); return this; },
      like(key, pattern) { predicates.push(row => String(row[key]).startsWith(pattern.replace(/%$/, ''))); return this; },
      update(value) { operation = 'update'; payload = clone(value); return this; },
      insert(value) { operation = 'insert'; payload = clone(value); return this; },
      upsert(value, opts) { operation = 'upsert'; payload = clone(value); options = opts; return this; },
      delete() { operation = 'delete'; return this; },
      execute() {
        if (promise) return promise;
        promise = Promise.resolve().then(() => {
          if (table === 'presentations' && operation === 'select' && state.failPresentationReads) return { error: Error('Read offline') };
          let rows = tables[table].filter(row => predicates.every(predicate => predicate(row)));
          if (operation === 'insert' || operation === 'upsert') {
            rows = (Array.isArray(payload) ? payload : [payload]).map(value => {
              const key = table === 'app_config' ? 'key' : 'id';
              const existing = tables[table].find(row => value[key] && row[key] === value[key]);
              if (existing && operation === 'upsert') {
                if (!options?.ignoreDuplicates) Object.assign(existing, value);
                return existing;
              }
              if (existing) throw Object.assign(Error('duplicate key'), { code: '23505' });
              const row = table === 'app_config' ? value : { id: 'row-' + ++nextId, ...value };
              if (table === 'presentations') Object.assign(row, { edit_revision: 0, created_at: '2026-01-01T00:00:00Z' });
              tables[table].push(row);
              return row;
            });
          } else if (operation === 'update') {
            for (const row of rows) {
              Object.assign(row, payload);
              if (table === 'presentations') row.edit_revision += 1;
            }
          } else if (operation === 'delete') {
            tables[table] = tables[table].filter(row => !rows.includes(row));
          }
          if (table === 'presentations' && operation === 'insert' && state.lostInsertResponse) {
            state.lostInsertResponse = false;
            return { error: new Error('Response lost after server committed insert') };
          }
          return { data: clone(rows), error: null };
        }).catch(error => ({ error }));
        return promise;
      },
      then(resolve, reject) { return this.execute().then(resolve, reject); },
      async maybeSingle() { const result = await this.execute(); return { ...result, data: result.data?.[0] ?? null }; },
      async single() { return this.maybeSingle(); },
    };
    return query;
  } };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, dataset: {}, focus() {} });
    return elements.get(id);
  };
  const ctx = vm.createContext({ console, crypto: require('node:crypto').webcrypto, sb: client, document: { getElementById: element, activeElement: { focus() {} } },
    confirm: () => true, toast() {},
    getConfigStrict: async key => clone(tables.app_config.find(row => row.key === key)?.value ?? null),
    setConfig: async (key, value) => { const result = await client.from('app_config').upsert({ key, value }); if (result.error) throw result.error; },
  });
  vm.runInContext(read('js/utils/presentation.js'), ctx);
  vm.runInContext(read('js/schedule-shared.js'), ctx);
  const section = (file, start, end) => { const source = read(file); return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); };
  vm.runInContext(section('schedule-order.html', 'async function persistTurnIndustryName', 'async function ensureIndustryNameSaved'), ctx);
  ctx.industrySaveToken = 1; ctx.presOrder = people.map(row => row.id);
  ctx.setIndustryNameSaveStatus = () => {};
  ctx.notifyPresentationOrderChanged = () => {};
  const reload = () => {
    ctx.fixtureSchedules = clone(tables.schedules); ctx.fixtureRows = clone(tables.presentations); ctx.fixtureMembers = people;
    vm.runInContext('schedules = fixtureSchedules; presentations = fixtureRows; members = fixtureMembers;', ctx);
  };
  const config = key => clone(tables.app_config.find(row => row.key === key)?.value);
  let scheduleId = 0;
  async function addCycle(startDate) {
    const plan = ctx.planStudyCycle(tables.schedules, { event_date: startDate, event_time: '20:00', location: '테스트 회의실' }, people,
      { today: '2026-01-01', presentations: tables.presentations });
    const rows = await ctx.prepareStudyCycleRosters(plan, tables.presentations, { createId: () => 'schedule-' + ++scheduleId });
    const result = await client.from('schedules').insert(rows);
    if (result.error) throw result.error;
    reload();
    return { plan, rows: clone(rows) };
  }
  async function fillCycle(cycle, number) {
    const roster = config('presentation_manual_rosters_v1');
    const names = ['클라우드', '삼성전자', '반도체', 'Microsoft', '수요 > 공급', '원익IPS', '화장품', '2차전지'];
    const saved = [];
    for (const schedule of cycle.rows) {
      for (const memberId of roster[schedule.id]) {
        const index = people.findIndex(member => member.id === memberId);
        const free = ![1, 3, 5].includes(index % names.length);
        const title = names[index % names.length] + ' ' + number;
        const draft = ctx.buildPresentationDraftStoragePayload({ member_id: memberId, schedule_id: schedule.id,
          presented_at: schedule.event_date, status: 'planned', category: cycle.plan.category,
          topic: free ? '[자유 주제] ' + title : title });
        const values = { format: free ? 'free' : 'stock', title,
          reason: '사이클 ' + number + '의 분석 근거', risk: '주요 변수', market_cap_at: 10000, target_cap: 15000 };
        const request = ctx.createPresentationInsertRequest(draft, values, draft);
        saved.push(await ctx.savePresentationEdit(client, null, draft, values, draft, request));
      }
    }
    reload();
    return saved;
  }
  async function renameCycle(cycle, name) {
    reload();
    const saved = ctx.getPresentationIndustryCycle(cycle.rows[0].id, tables.schedules, people);
    const input = element('thisTurnIndustry'); input.value = name; input.dataset.contextKey = saved.key;
    return ctx.persistTurnIndustryName({ key: saved.key, name, scheduleId: cycle.rows[0].id, scheduleIds: saved.scheduleIds, requestToken: 1, opts: { silent: true } });
  }
  return Object.assign(state, { ctx, client, config, reload, addCycle, fillCycle, renameCycle, element, section });
}
module.exports = { scenario, clone, read };
