export interface HistoryDateRange {
  readonly createdFrom?: number;
  readonly createdTo?: number;
}

/** datetime-local values are interpreted in the device's local time zone. */
export function parseHistoryDateRange(from: string, to: string): HistoryDateRange {
  const parse = (value: string): number | undefined => {
    if (!value) return undefined;
    const normalizedValue = value.trim().replace(" ", "T");
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      normalizedValue,
    );
    if (!parts) {
      throw new Error("请输入有效的日期和时间。");
    }
    const [year, month, day, hour, minute, second] = [
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6] ?? 0),
    ];
    const millisecond = Number((parts[7] ?? "").padEnd(3, "0"));
    if (!Number.isFinite(millisecond) || millisecond < 0 || millisecond > 999) {
      throw new Error("请输入有效的日期和时间。");
    }
    const timestamp = new Date(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
    ).getTime();
    const parsed = new Date(timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      parsed.getFullYear() !== year ||
      parsed.getMonth() + 1 !== month ||
      parsed.getDate() !== day ||
      parsed.getHours() !== hour ||
      parsed.getMinutes() !== minute ||
      parsed.getSeconds() !== second ||
      parsed.getMilliseconds() !== millisecond
    ) {
      throw new Error("请输入 1970 年以后的有效日期和时间。");
    }
    return timestamp;
  };
  const createdFrom = parse(from);
  const end = parse(to);
  if (createdFrom != null && end != null && createdFrom > end) {
    throw new Error("开始时间不能晚于结束时间。");
  }
  return {
    ...(createdFrom != null ? { createdFrom } : {}),
    ...(end != null ? { createdTo: end + 999 } : {}),
  };
}
