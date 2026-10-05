'use strict';

// 采访整理包（JSON）导入：只读预览 + 事务确认。
//
// 整理包格式：
//   {
//     batchId: '批次标识（已成功导入过的批次不可再次导入）',
//     events: [
//       { key: '包内唯一键', title, description?,
//         claims: [{ precision: 'year'|'month'|'day', year, month?, day?, source, note? }] }
//     ],
//     relations: [{ earlierKey, laterKey, source?, note? }]   // 按键引用事件
//   }
//
// 预览（buildImportPreview）只读：校验整包并一次性列出全部问题
// （键重复 / 关系引用缺失 / 日期或出处非法等），有任何问题即整包拒绝（422）；
// 通过时返回待写入内容、数量、内容指纹 fingerprint 与当前草稿修订号，不写任何数据。
//
// 确认（confirmImport）须提交原包、预览返回的指纹与预览时的草稿修订号：
//   - 包内容与指纹不符 → 409 BUNDLE_CONTENT_MISMATCH（内容被替换）；
//   - 批次标识曾成功导入 → 409 BATCH_ALREADY_IMPORTED；
//   - 草稿修订号已变化 → 409 DRAFT_REVISION_CONFLICT；
//   以上均不写入。全部通过时在一个事务内追加整包（事件、主张、关系、批次记录），
//   整包只算一次草稿修订；既有草稿、历史快照与访客视图不受影响，
//   导入内容仍须按现有「选定主张 + 先后校验」流程发布才会公开。

const crypto = require('crypto');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { draftRevisionNo } = require('./restore');

const MAX_LEN = { batchId: 200, key: 100, title: 200, description: 5000, source: 1000, note: 2000 };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------- 收集式校验：尽可能列完全部问题，整包拒绝 ----------
// 返回问题数组（空数组 = 校验通过）。每个问题 { type, message, ...定位信息 }。
function validateBundle(bundle) {
  const problems = [];

  if (!isPlainObject(bundle)) {
    problems.push({ type: 'invalid_structure', message: '整理包必须是一个 JSON 对象，含 batchId、events、relations' });
    return problems;
  }

  // 批次标识
  if (typeof bundle.batchId !== 'string' || bundle.batchId.trim() === '') {
    problems.push({ type: 'invalid_structure', message: 'batchId（批次标识）必须是非空字符串' });
  } else if (bundle.batchId.length > MAX_LEN.batchId) {
    problems.push({ type: 'invalid_structure', message: `batchId 长度不能超过 ${MAX_LEN.batchId} 字符` });
  }

  // 事件与主张
  const keyToIndex = new Map(); // 包内唯一键 → 首次出现下标
  const eventsOk = Array.isArray(bundle.events) && bundle.events.length > 0;
  if (!eventsOk) {
    problems.push({ type: 'invalid_structure', message: 'events 必须是非空数组（至少一个事件）' });
  } else {
    bundle.events.forEach((ev, eventIndex) => {
      const at = `events[${eventIndex}]`;
      if (!isPlainObject(ev)) {
        problems.push({ type: 'invalid_structure', eventIndex, message: `${at} 必须是对象（含 key、title、claims）` });
        return;
      }
      const key = typeof ev.key === 'string' ? ev.key.trim() : '';
      if (!key) {
        problems.push({ type: 'invalid_structure', eventIndex, message: `${at}.key（包内唯一键）必须是非空字符串` });
      } else if (key.length > MAX_LEN.key) {
        problems.push({ type: 'invalid_structure', eventIndex, key, message: `事件键「${key}」长度不能超过 ${MAX_LEN.key} 字符` });
      } else if (keyToIndex.has(key)) {
        problems.push({
          type: 'duplicate_key',
          eventIndex,
          key,
          message: `事件键「${key}」重复：首次出现于 events[${keyToIndex.get(key)}]，又在 ${at} 出现`,
        });
      } else {
        keyToIndex.set(key, eventIndex);
      }
      const where = key ? `事件「${key}」` : at;

      const title = typeof ev.title === 'string' ? ev.title.trim() : '';
      if (!title) {
        problems.push({ type: 'invalid_structure', eventIndex, key: key || undefined, message: `${where} 的 title 必须是非空字符串` });
      } else if (title.length > MAX_LEN.title) {
        problems.push({ type: 'invalid_structure', eventIndex, key, message: `${where} 的 title 长度不能超过 ${MAX_LEN.title} 字符` });
      }
      if (ev.description != null && (typeof ev.description !== 'string' || ev.description.length > MAX_LEN.description)) {
        problems.push({ type: 'invalid_structure', eventIndex, key: key || undefined, message: `${where} 的 description 必须是不超过 ${MAX_LEN.description} 字符的字符串` });
      }

      if (!Array.isArray(ev.claims) || ev.claims.length === 0) {
        problems.push({ type: 'invalid_structure', eventIndex, key: key || undefined, message: `${where} 必须至少有一条时间主张（claims 为非空数组）` });
      } else {
        ev.claims.forEach((c, claimIndex) => {
          const nth = `${where} 第 ${claimIndex + 1} 条主张`;
          if (!isPlainObject(c)) {
            problems.push({ type: 'invalid_structure', eventIndex, claimIndex, key: key || undefined, message: `${nth} 必须是对象` });
            return;
          }
          try {
            parseClaimDate(c);
          } catch (err) {
            problems.push({ type: 'invalid_date', eventIndex, claimIndex, key: key || undefined, message: `${nth} 日期非法：${err.message}` });
          }
          if (typeof c.source !== 'string' || c.source.trim() === '') {
            problems.push({ type: 'invalid_source', eventIndex, claimIndex, key: key || undefined, message: `${nth} 缺少出处（source 为必填，注明受访人 / 档案 / 页码）` });
          } else if (c.source.length > MAX_LEN.source) {
            problems.push({ type: 'invalid_source', eventIndex, claimIndex, key: key || undefined, message: `${nth} 出处长度不能超过 ${MAX_LEN.source} 字符` });
          }
          if (c.note != null && (typeof c.note !== 'string' || c.note.length > MAX_LEN.note)) {
            problems.push({ type: 'invalid_structure', eventIndex, claimIndex, key: key || undefined, message: `${nth} 的 note 必须是不超过 ${MAX_LEN.note} 字符的字符串` });
          }
        });
      }
    });
  }

  // 「先于」关系（可省略）
  if (bundle.relations != null) {
    if (!Array.isArray(bundle.relations)) {
      problems.push({ type: 'invalid_structure', message: 'relations 必须是数组（也可省略该字段）' });
    } else {
      bundle.relations.forEach((r, relationIndex) => {
        const at = `relations[${relationIndex}]`;
        if (!isPlainObject(r)) {
          problems.push({ type: 'invalid_structure', relationIndex, message: `${at} 必须是对象（含 earlierKey、laterKey）` });
          return;
        }
        const earlierKey = typeof r.earlierKey === 'string' ? r.earlierKey.trim() : '';
        const laterKey = typeof r.laterKey === 'string' ? r.laterKey.trim() : '';
        if (!earlierKey || !laterKey) {
          problems.push({ type: 'invalid_structure', relationIndex, message: `${at} 必须含非空的 earlierKey 与 laterKey` });
          return;
        }
        if (earlierKey === laterKey) {
          problems.push({ type: 'self_relation', relationIndex, key: earlierKey, message: `${at}：事件「${earlierKey}」不能先于自身` });
        }
        // 事件清单本身非法时，引用检查无意义，避免噪音
        if (eventsOk) {
          for (const [role, k] of [['earlierKey', earlierKey], ['laterKey', laterKey]]) {
            if (!keyToIndex.has(k)) {
              problems.push({ type: 'missing_reference', relationIndex, key: k, message: `${at} 的 ${role} 引用了包内不存在的事件键「${k}」` });
            }
          }
        }
        if (r.source != null && (typeof r.source !== 'string' || r.source.length > MAX_LEN.source)) {
          problems.push({ type: 'invalid_structure', relationIndex, message: `${at} 的 source 必须是不超过 ${MAX_LEN.source} 字符的字符串` });
        }
        if (r.note != null && (typeof r.note !== 'string' || r.note.length > MAX_LEN.note)) {
          problems.push({ type: 'invalid_structure', relationIndex, message: `${at} 的 note 必须是不超过 ${MAX_LEN.note} 字符的字符串` });
        }
      });
    }
  }

  return problems;
}

// 仅在 validateBundle 通过（无问题）后调用：规整为可入库结构，
// 日期区间与展示标签复用现有 dates 工具，与手工录入路径完全一致。
function normalizeBundle(bundle) {
  const events = bundle.events.map((ev) => ({
    key: ev.key.trim(),
    title: ev.title.trim(),
    description: typeof ev.description === 'string' ? ev.description : '',
    claims: ev.claims.map((c) => {
      const { precision, year, month, day } = parseClaimDate(c);
      const iv = claimInterval(precision, year, month, day);
      return {
        precision,
        year,
        month,
        day,
        dateLabel: formatClaimDate(precision, year, month, day),
        intervalStart: iv.start,
        intervalEnd: iv.end,
        source: c.source,
        note: typeof c.note === 'string' ? c.note : '',
      };
    }),
  }));
  const titleByKey = new Map(events.map((e) => [e.key, e.title]));
  const relations = (bundle.relations || []).map((r) => {
    const earlierKey = r.earlierKey.trim();
    const laterKey = r.laterKey.trim();
    return {
      earlierKey,
      laterKey,
      earlierTitle: titleByKey.get(earlierKey),
      laterTitle: titleByKey.get(laterKey),
      source: typeof r.source === 'string' ? r.source : '',
      note: typeof r.note === 'string' ? r.note : '',
    };
  });
  return { batchId: bundle.batchId.trim(), events, relations };
}

function countsOf(normalized) {
  return {
    eventCount: normalized.events.length,
    claimCount: normalized.events.reduce((n, e) => n + e.claims.length, 0),
    relationCount: normalized.relations.length,
  };
}

// ---------- 内容指纹 ----------
// 规范化 JSON（对象键递归排序）后取 SHA-256：同一整理包与键序无关，
// 任何内容改动都会改变指纹。确认时重算并与预览指纹比对，防止「内容被替换」。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) || 'null';
}

function fingerprintBundle(bundle) {
  return crypto.createHash('sha256').update(canonicalJson(bundle)).digest('hex');
}

// ---------- 只读预览：不写任何数据 ----------
// 有问题时抛 422 { code: 'BUNDLE_INVALID', problems }（整包拒绝）。
function buildImportPreview(bundle) {
  const problems = validateBundle(bundle);
  if (problems.length) {
    throw {
      status: 422,
      code: 'BUNDLE_INVALID',
      message: `采访整理包有 ${problems.length} 处问题，已整包拒绝，未写入任何数据`,
      problems,
    };
  }
  const normalized = normalizeBundle(bundle);
  const dup = getDb()
    .prepare('SELECT imported_at AS importedAt FROM import_batches WHERE batch_id = ?')
    .get(normalized.batchId);
  return {
    batchId: normalized.batchId,
    fingerprint: fingerprintBundle(bundle),
    draftRevisionNo: draftRevisionNo(),
    // 仅供界面提示；真正的防重以确认时事务内检查为准
    alreadyImported: dup ? { importedAt: dup.importedAt } : null,
    counts: countsOf(normalized),
    events: normalized.events,
    relations: normalized.relations,
  };
}

// ---------- 确认导入：一个事务追加整包 ----------
// 抛 { status, ...body } 表示 HTTP 错误；成功返回键 → 草稿 id 映射与新修订号。
function confirmImport({ bundle, fingerprint, expectedRevision }) {
  const db = getDb();

  // 内容被替换：提交的包与预览指纹不符
  const actual = fingerprintBundle(bundle);
  if (actual !== fingerprint) {
    throw {
      status: 409,
      code: 'BUNDLE_CONTENT_MISMATCH',
      message: '内容冲突：提交的整理包与预览时不一致（内容被替换）。请重新预览后再确认。',
      expectedFingerprint: fingerprint,
      actualFingerprint: actual,
    };
  }

  // 防御性再校验：指纹相符时必然通过（指纹只发给合法包），但指纹可伪造，不能跳过
  const problems = validateBundle(bundle);
  if (problems.length) {
    throw {
      status: 422,
      code: 'BUNDLE_INVALID',
      message: `采访整理包有 ${problems.length} 处问题，已整包拒绝，未写入任何数据`,
      problems,
    };
  }
  const normalized = normalizeBundle(bundle);
  const counts = countsOf(normalized);

  const tx = db.transaction(() => {
    // 批次标识曾成功导入 → 冲突（失败的导入不留记录，可重试）
    const dup = db
      .prepare('SELECT imported_at AS importedAt FROM import_batches WHERE batch_id = ?')
      .get(normalized.batchId);
    if (dup) {
      throw {
        status: 409,
        code: 'BATCH_ALREADY_IMPORTED',
        message: `批次冲突：批次标识「${normalized.batchId}」已于 ${dup.importedAt} UTC 成功导入过，不能重复导入。`,
        batchId: normalized.batchId,
        importedAt: dup.importedAt,
      };
    }
    // 事务内重新确认草稿修订号，避免并发下的静默叠加
    const revision = draftRevisionNo();
    if (Number(expectedRevision) !== revision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：你预览导入时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再确认。`,
        currentRevisionNo: revision,
        expectedRevisionNo: Number(expectedRevision),
      };
    }

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const eventIdByKey = new Map();
    const eventMap = [];
    for (const ev of normalized.events) {
      const eventId = insEvent.run(ev.title, ev.description).lastInsertRowid;
      const claimIds = ev.claims.map(
        (c) =>
          insClaim.run(
            eventId, c.precision, c.year, c.month, c.day,
            c.dateLabel, c.intervalStart, c.intervalEnd, c.source, c.note
          ).lastInsertRowid
      );
      eventIdByKey.set(ev.key, eventId);
      eventMap.push({ key: ev.key, eventId, claimIds });
    }

    const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
    const relationMap = normalized.relations.map((r) => ({
      earlierKey: r.earlierKey,
      laterKey: r.laterKey,
      relationId: insRel.run(eventIdByKey.get(r.earlierKey), eventIdByKey.get(r.laterKey), r.source, r.note).lastInsertRowid,
    }));

    db.prepare(
      'INSERT INTO import_batches (batch_id, fingerprint, event_count, claim_count, relation_count) VALUES (?, ?, ?, ?, ?)'
    ).run(normalized.batchId, actual, counts.eventCount, counts.claimCount, counts.relationCount);

    // 每条 INSERT 都触发了修订号自增；整包导入作为一次原子变更，
    // 最终把修订号校正为预览时的值 + 1（与恢复草稿同一约定）。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(Number(expectedRevision) + 1);

    return { eventMap, relationMap };
  });

  const { eventMap, relationMap } = tx();

  return {
    batchId: normalized.batchId,
    fingerprint: actual,
    revisionNo: draftRevisionNo(),
    counts,
    idMap: { events: eventMap, relations: relationMap },
  };
}

module.exports = {
  validateBundle,
  fingerprintBundle,
  buildImportPreview,
  confirmImport,
};
