const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const SLOT_HOURS = [8, 14, 20];

type LocalDate = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function parts(date: Date, format: Intl.DateTimeFormat): LocalDate {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid calendar date');
  const fields = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
    hour: Number(fields.hour), minute: Number(fields.minute), second: Number(fields.second),
  };
}

function wallTime(date: LocalDate) {
  return Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second);
}

/** ISO week of the local calendar date, not the UTC date of the invocation. */
export function isoWeek(date: Date, timezone = DEFAULT_TIMEZONE): string {
  const local = parts(date, formatter(timezone));
  const thursday = new Date(Date.UTC(local.year, local.month - 1, local.day));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The next three 08:00, 14:00, or 20:00 wall-clock slots, strictly after date. */
export function nextSlots(date: Date, timezone = DEFAULT_TIMEZONE): Date[] {
  const format = formatter(timezone);
  const local = parts(date, format);
  const candidates = new Set<number>();
  const firstDay = Date.UTC(local.year, local.month - 1, local.day);
  // Resolve calendar days independently: adding 24 hours to a slot fails at DST.
  for (let day = 0; day < 7; day++) {
    const midnight = firstDay + day * 86_400_000;
    const offsets = new Set<number>();
    for (const hours of [-24, 12, 48]) {
      const sample = midnight + hours * 3_600_000;
      offsets.add(wallTime(parts(new Date(sample), format)) - sample);
    }
    for (const hour of SLOT_HOURS) {
      const desired = midnight + hour * 3_600_000;
      for (const offset of offsets) {
        const actual = desired - offset;
        // Nonexistent local times are skipped; duplicated local times remain real slots.
        if (actual > date.getTime() && wallTime(parts(new Date(actual), format)) === desired) candidates.add(actual);
      }
    }
    if (candidates.size >= 3) break;
  }
  const slots = [...candidates].sort((a, b) => a - b).slice(0, 3).map(value => new Date(value));
  if (slots.length !== 3) throw new Error(`Unable to resolve three cron slots in ${timezone}`);
  return slots;
}
