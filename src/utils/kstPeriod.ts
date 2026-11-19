// 관리자 통계용 날짜 계산 (ADMIN-03·04·05)
// DB에는 UTC로 저장돼 있고, 화면의 날짜·구간은 한국 시간(KST, UTC+9) 기준이다.

export type Interval = "day" | "week" | "month";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// "2026-10-16" → 그날 KST 0시의 UTC 시각
export function kstDayStart(date: string): Date {
    return new Date(Date.parse(`${date}T00:00:00.000Z`) - KST_OFFSET_MS);
}

// UTC 시각 → KST 날짜 문자열 "YYYY-MM-DD"
export function toKstDate(at: Date): string {
    return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 날짜 문자열에 일 수를 더한다 ("2026-10-31" + 1 → "2026-11-01")
export function addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// 오늘 날짜 (KST)
export function kstToday(): string {
    return toKstDate(new Date());
}

// 조회 기간을 DB 조건으로: from 0시 이상, to 다음 날 0시 미만 (from·to 모두 포함)
export function toUtcRange(from: string, to: string) {
    return { gte: kstDayStart(from), lt: kstDayStart(addDays(to, 1)) };
}

// 날짜가 속한 구간의 시작일. week는 월요일, month는 1일
function bucketStart(date: string, interval: Interval): string {
    if (interval === "day") return date;
    if (interval === "month") return `${date.slice(0, 7)}-01`;
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 일요일 ~ 6 토요일
    return addDays(date, -((weekday + 6) % 7));
}

// 차트용 구간 키. 첫 구간이 from보다 앞(예: 주 중간에 시작)이면 from을 시작일로 쓴다
export function bucketKey(date: string, interval: Interval, from: string): string {
    const start = bucketStart(date, interval);
    return start < from ? from : start;
}

// 기간 안의 모든 구간 시작일 (빈 구간도 0으로 채우려고 미리 만든다)
export function listBuckets(from: string, to: string, interval: Interval): string[] {
    const keys: string[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        const key = bucketKey(date, interval, from);
        if (keys[keys.length - 1] !== key) keys.push(key);
    }
    return keys;
}

// 비율·평균은 소수 셋째 자리까지. 대상이 없으면 null('집계 대상 없음')
export function ratio(numerator: number, denominator: number): number | null {
    return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000;
}
