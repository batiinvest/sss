(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SSSFeeAutomation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const AUTO_FEE_NOTE = '자동 반영 · 월 정기 회비';
  const AUTO_ROOM_PREFIX = '자동 반복 · ';

  function normalizeMonth(value) {
    const text = String(value || '');
    return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : '';
  }

  function monthRange(startMonth, endMonth) {
    const start = normalizeMonth(startMonth);
    const end = normalizeMonth(endMonth);
    if (!start || !end || start > end) return [];

    const [startYear, startIndex] = start.split('-').map(Number);
    const [endYear, endIndex] = end.split('-').map(Number);
    const months = [];
    let year = startYear;
    let month = startIndex;

    while (year < endYear || (year === endYear && month <= endIndex)) {
      months.push(year + '-' + String(month).padStart(2, '0'));
      month += 1;
      if (month > 12) {
        year += 1;
        month = 1;
      }
    }
    return months;
  }

  function getMembersForMonth(members, month) {
    const targetMonth = normalizeMonth(month);
    if (!targetMonth) return [];
    return (members || []).filter(member => {
      if (!member || !member.id || member.is_active === false) return false;
      const joinedMonth = normalizeMonth(member.joined_at);
      return !joinedMonth || joinedMonth <= targetMonth;
    });
  }

  function compareFeeRecency(a, b) {
    for (const field of ['paid_at', 'created_at', 'id']) {
      const comparison = String(a?.[field] || '').localeCompare(String(b?.[field] || ''));
      if (comparison !== 0) return comparison;
    }
    return 0;
  }

  function buildEffectiveFees(persistedFees, members, options = {}) {
    const copied = (persistedFees || []).map(persistedFee => ({ ...persistedFee }));
    const latestRegularByKey = new Map();
    copied.forEach(fee => {
      const month = normalizeMonth(fee.month);
      if (fee.fee_type !== 'regular' || !fee.member_id || !month) return;

      const key = fee.member_id + '|' + month;
      const current = latestRegularByKey.get(key);
      if (!current || compareFeeRecency(fee, current) > 0) latestRegularByKey.set(key, fee);
    });
    const stored = copied.filter(fee => {
      const month = normalizeMonth(fee.month);
      if (fee.fee_type !== 'regular' || !fee.member_id || !month) return true;
      return latestRegularByKey.get(fee.member_id + '|' + month) === fee;
    });
    const throughMonth = normalizeMonth(options.throughMonth);
    const monthlyFee = Number(options.monthlyFee) || 0;
    if (!throughMonth || monthlyFee <= 0) return stored;

    const regularMonths = stored
      .filter(fee => fee.fee_type === 'regular')
      .map(fee => normalizeMonth(fee.month))
      .filter(Boolean)
      .sort();
    const startMonth = normalizeMonth(options.startMonth) || regularMonths[0] || throughMonth;
    const existingKeys = new Set(
      stored
        .filter(fee => fee.fee_type === 'regular' && fee.member_id && normalizeMonth(fee.month))
        .map(fee => fee.member_id + '|' + normalizeMonth(fee.month))
    );
    const automatic = [];

    monthRange(startMonth, throughMonth).forEach(month => {
      getMembersForMonth(members, month).forEach(member => {
        const key = member.id + '|' + month;
        if (existingKeys.has(key)) return;
        automatic.push({
          id: 'auto-fee-' + month + '-' + member.id,
          member_id: member.id,
          month,
          amount: monthlyFee,
          fee_type: 'regular',
          note: AUTO_FEE_NOTE,
          paid_at: month + '-01',
          members: { name: member.name },
          is_auto: true,
        });
        existingKeys.add(key);
      });
    });

    return stored.concat(automatic);
  }

  function daysInMonth(month) {
    const [year, monthIndex] = normalizeMonth(month).split('-').map(Number);
    if (!year || !monthIndex) return 31;
    return new Date(year, monthIndex, 0).getDate();
  }

  function repeatDate(month, sourceDate) {
    const sourceDay = Number(String(sourceDate || '').slice(8, 10)) || 1;
    const day = Math.min(sourceDay, daysInMonth(month));
    return month + '-' + String(day).padStart(2, '0');
  }

  function cleanRoomNote(note) {
    const text = String(note || '').trim();
    return text.startsWith(AUTO_ROOM_PREFIX) ? text.slice(AUTO_ROOM_PREFIX.length) : text;
  }

  function buildEffectiveExpenses(persistedExpenses, options = {}) {
    const stored = (persistedExpenses || []).map(expense => ({ ...expense }));
    const throughMonth = normalizeMonth(options.throughMonth);
    if (!throughMonth) return stored;

    const roomEntries = stored
      .filter(expense => expense.category === 'room' && normalizeMonth(expense.spent_at))
      .sort((a, b) => String(a.spent_at).localeCompare(String(b.spent_at)));
    if (!roomEntries.length) return stored;

    const firstRoomMonth = normalizeMonth(roomEntries[0].spent_at);
    const startMonth = normalizeMonth(options.startMonth) || firstRoomMonth;
    const byMonth = new Map();
    roomEntries.forEach(expense => {
      const month = normalizeMonth(expense.spent_at);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(expense);
    });

    const automatic = [];
    let template = null;

    monthRange(startMonth, throughMonth).forEach(month => {
      const actual = (byMonth.get(month) || [])
        .slice()
        .sort((a, b) => String(a.spent_at).localeCompare(String(b.spent_at)));

      if (actual.length) {
        const latest = actual[actual.length - 1];
        const stopEntry = actual.find(expense => Number(expense.amount) === 0);
        template = {
          amount: stopEntry
            ? 0
            : actual.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0),
          spent_at: stopEntry?.spent_at || latest.spent_at,
          note: stopEntry
            ? cleanRoomNote(stopEntry.note) || '스터디룸 자동 반복 중지'
            : (actual.length === 1 ? cleanRoomNote(latest.note) : '스터디룸 월 이용료'),
          source_month: month,
        };
        return;
      }

      if (!template || template.amount <= 0) return;
      automatic.push({
        id: 'auto-room-' + month,
        category: 'room',
        amount: template.amount,
        spent_at: repeatDate(month, template.spent_at),
        note: AUTO_ROOM_PREFIX + (template.note || '스터디룸 월 이용료'),
        is_auto: true,
        source_month: template.source_month,
      });
    });

    return stored.concat(automatic);
  }

  return {
    AUTO_FEE_NOTE,
    AUTO_ROOM_PREFIX,
    normalizeMonth,
    monthRange,
    getMembersForMonth,
    compareFeeRecency,
    buildEffectiveFees,
    buildEffectiveExpenses,
  };
});
