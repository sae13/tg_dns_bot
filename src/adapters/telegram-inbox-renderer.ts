import type {
  InboxQueryEvidence,
  InboxReconstructionProblem,
  InboxState,
  MalformedManagedRecord,
  ReconstructedManagedMessage
} from '../application/reconstruct-inbox';
import type { ManagedMessageEnvelope } from '../domain/managed-message';

export const TELEGRAM_MESSAGE_CHARACTER_LIMIT = 4_096;

/**
 * Render an inbox result as plain Telegram text.
 *
 * Values that may contain user supplied text are always emitted on their own
 * line. In particular, managed message text and raw TXT values are never
 * escaped or interpreted as Markdown/HTML.
 */
export function renderInboxState(state: InboxState): string {
  const lines: string[] = [];
  appendValue(lines, 'صندوق:', state.name);
  appendValue(lines, 'وضعیت:', statusLabel(state));

  switch (state.status) {
    case 'absent':
      appendValue(lines, 'علت:', queryStatusLabel(state.reason));
      break;
    case 'raw_only':
      lines.push('تفسیر مدیریتشده:');
      lines.push('یافت نشد؛ فقط رکوردهای خام نمایش داده می‌شوند.');
      break;
    case 'complete':
      lines.push('تفسیر مدیریتشده:');
      appendMessage(lines, state.message);
      break;
    case 'ambiguous':
      lines.push('ریشه‌های مدیریتشده:');
      if (state.roots.length === 0) lines.push('موردی یافت نشد.');
      state.roots.forEach((root, index) => {
        appendValue(lines, 'شماره ریشه:', String(index + 1));
        appendEnvelope(lines, root);
      });
      break;
    case 'incomplete':
      lines.push('مانیفست مدیریتشده:');
      appendEnvelope(lines, state.manifest);
      lines.push('قطعه‌های معتبر موجود:');
      if (state.chunks.length === 0) lines.push('موردی یافت نشد.');
      state.chunks.forEach((chunk, index) => {
        appendValue(lines, 'شماره شاهد قطعه:', String(index + 1));
        appendEnvelope(lines, chunk);
      });
      lines.push('مشکلات بازسازی:');
      state.problems.forEach((problem, index) => {
        appendValue(lines, 'شماره مشکل:', String(index + 1));
        appendProblem(lines, problem);
      });
      break;
  }

  lines.push('شواهد پرس‌وجو:');
  if (state.queries.length === 0) lines.push('موردی ثبت نشد.');
  state.queries.forEach((query, index) => appendQuery(lines, index + 1, query));

  lines.push('رکوردهای خراب مدیریتشده:');
  if (state.malformed.length === 0) lines.push('موردی یافت نشد.');
  state.malformed.forEach((malformed, index) => appendMalformed(lines, index + 1, malformed));

  return lines.join('\n');
}

/**
 * Split text into Telegram-safe numbered chunks.
 *
 * The split is measured in Unicode code points (Array.from), so a surrogate
 * pair such as an emoji is never cut in half. Number headers are included in
 * the limit and are added only when more than one chunk is required.
 */
export function splitTelegramText(
  text: string,
  maximumCharacters = TELEGRAM_MESSAGE_CHARACTER_LIMIT
): readonly string[] {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new RangeError('Invalid Telegram message limit');
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= maximumCharacters) return [text];

  // Find the smallest stable chunk count. Header width depends on the number
  // of digits in the total, so each candidate is evaluated using its headers.
  let candidate = 2;
  while (candidate <= codePoints.length + 1) {
    const chunks = partition(codePoints, candidate, maximumCharacters);
    if (chunks.length === candidate) return chunks;
    candidate = chunks.length > candidate ? chunks.length : candidate + 1;
  }
  // The loop is mathematically guaranteed to converge, but retain a safe
  // fallback for unusual custom limits.
  const fallback = partition(codePoints, candidate, maximumCharacters);
  return partition(codePoints, fallback.length, maximumCharacters);
}

function partition(
  codePoints: readonly string[],
  total: number,
  maximumCharacters: number
): string[] {
  const chunks: string[] = [];
  let offset = 0;
  for (let index = 1; offset < codePoints.length; index += 1) {
    const header = `[${index}/${total}]\n`;
    const capacity = maximumCharacters - Array.from(header).length;
    if (capacity < 1) throw new RangeError('Telegram message limit is too small for numbering');
    const end = Math.min(offset + capacity, codePoints.length);
    chunks.push(`${header}${codePoints.slice(offset, end).join('')}`);
    offset = end;
  }
  return chunks;
}

function appendMessage(lines: string[], message: ReconstructedManagedMessage): void {
  appendValue(lines, 'شناسه پیام:', message.id);
  appendValue(lines, 'نسخه:', String(message.v));
  appendValue(lines, 'تعداد قطعهها:', String(message.n));
  appendValue(lines, 'شناسه فرستنده:', String(message.uid));
  appendValue(lines, 'نام کاربری:', message.username === null ? 'ندارد' : message.username);
  appendValue(lines, 'زمان معیار:', message.ts);
  appendValue(lines, 'متن پیام:', message.text);
}

function appendEnvelope(lines: string[], envelope: ManagedMessageEnvelope): void {
  appendValue(lines, 'شناسه پیام:', envelope.id);
  appendValue(lines, 'شماره قطعه:', String(envelope.i));
  appendValue(lines, 'تعداد قطعهها:', String(envelope.n));
  appendValue(lines, 'شناسه فرستنده:', String(envelope.uid));
  appendValue(lines, 'نام کاربری:', envelope.username === null ? 'ندارد' : envelope.username);
  appendValue(lines, 'زمان معیار:', envelope.ts);
  appendValue(lines, 'متن قطعه:', envelope.text);
}

function appendQuery(lines: string[], index: number, query: InboxQueryEvidence): void {
  appendValue(lines, 'شماره پرسوجو:', String(index));
  appendValue(lines, 'نام:', query.name);
  appendValue(lines, 'نتیجه:', queryStatusLabel(query.resolution.status));
  if (query.resolution.status === 'dns_error') {
    appendValue(lines, 'کد پاسخ دامنه:', String(query.resolution.responseCode));
  }
  if (query.resolution.status !== 'found') return;

  lines.push('رکوردهای خام:');
  if (query.resolution.records.length === 0) lines.push('موردی یافت نشد.');
  query.resolution.records.forEach((record, recordIndex) => {
    appendValue(lines, 'شماره رکورد:', String(recordIndex + 1));
    appendValue(lines, 'نام:', record.name);
    appendValue(lines, 'زمان ماندگاری:', String(record.ttl));
    appendValue(lines, 'مقدار خام:', record.value);
  });
}

function appendMalformed(lines: string[], index: number, malformed: MalformedManagedRecord): void {
  appendValue(lines, 'شماره رکورد خراب:', String(index));
  appendValue(lines, 'نام:', malformed.name);
  appendValue(lines, 'نوع خرابی:', malformed.error);
  appendValue(lines, 'مقدار خام:', malformed.record.value);
}

function appendValue(lines: string[], label: string, value: string): void {
  lines.push(label, '', value, '');
}

function statusLabel(state: InboxState): string {
  switch (state.status) {
    case 'absent': return 'بدون پاسخ';
    case 'raw_only': return 'فقط خام';
    case 'complete': return 'کامل';
    case 'ambiguous': return 'مبهم';
    case 'incomplete': return 'ناقص';
  }
}

function queryStatusLabel(status: InboxQueryEvidence['resolution']['status']): string {
  switch (status) {
    case 'found': return 'یافت شد';
    case 'nxdomain': return 'نام دامنه وجود ندارد';
    case 'nodata': return 'بدون داده';
    case 'dns_error': return 'خطای دامنه';
    case 'network_error': return 'خطای شبکه';
    case 'timeout': return 'پایان مهلت';
    case 'invalid_response': return 'پاسخ نامعتبر';
    case 'resolver_error': return 'خطای حلکننده';
  }
}

function appendProblem(lines: string[], problem: InboxReconstructionProblem): void {
  switch (problem.kind) {
    case 'missing_chunk':
      lines.push('قطعه پیدا نشد.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'duplicate_chunk':
      lines.push('قطعه تکراری است.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'conflicting_chunk':
      lines.push('قطعه متعارض است.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'incompatible_chunk':
      lines.push('قطعه با مانیفست سازگار نیست.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'malformed_chunk':
      lines.push('قطعه خراب است.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'malformed_root':
      lines.push('ریشه خراب است.');
      appendValue(lines, 'نام ریشه:', problem.name);
      break;
    case 'incompatible_root':
      lines.push('ریشه ناسازگار است.');
      appendValue(lines, 'نام ریشه:', problem.name);
      break;
    case 'chunk_count_exceeded':
      lines.push('تعداد قطعهها بیش از حد مجاز است.');
      appendValue(lines, 'تعداد قطعهها:', String(problem.count));
      appendValue(lines, 'حد مجاز:', String(problem.maximum));
      break;
    case 'invalid_chunk_name':
      lines.push('نام قطعه نامعتبر است.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      break;
    case 'chunk_lookup_failed':
      lines.push('پرسوجوی قطعه شکست خورد.');
      appendValue(lines, 'شماره قطعه:', String(problem.index));
      appendValue(lines, 'نام قطعه:', problem.name);
      appendValue(lines, 'نتیجه:', queryStatusLabel(problem.resolution));
      break;
  }
}
